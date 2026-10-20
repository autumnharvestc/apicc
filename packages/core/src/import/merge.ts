import { randomUUID } from "node:crypto";
import type { ApiAsset } from "../contract/model.js";
import { ContractProjectSchema, type ContractCollection, type ContractFolder, type ContractProject } from "../contract/workspace.js";
import { createProjectAssetContext } from "../assets/context.js";
import { cloneAssetBundle } from "../assets/clone.js";
import { sanitizeNodeName } from "../storage/sanitize.js";

export type ImportMergeAction = "skip" | "rename" | "overwrite" | "cancel";

export interface ImportMergeItemDecision {
  action: ImportMergeAction;
  targetApiId?: string;
  name?: string;
}

export interface ImportMergeDecisions {
  targetCollectionId: string;
  sourceCollectionIds: string[];
  decisions: Record<string, ImportMergeItemDecision>;
}

export interface ImportExchangeDiagnostic {
  severity: "warning" | "error";
  code: string;
  path: string;
  message: string;
  lossy: boolean;
  ownerId?: string;
}

export interface ImportMergeEntry {
  sourceApiId: string;
  sourceName: string;
  sourcePath: string;
  method: string;
  path: string;
  status: "added" | "overwritten" | "skipped";
  targetApiIds: string[];
  targetName?: string;
}

export interface ImportMergePlan {
  project: ContractProject;
  summary: { added: number; overwritten: number; skipped: number };
  entries: ImportMergeEntry[];
  diagnostics: ImportExchangeDiagnostic[];
  cancelled: boolean;
}

interface ApiLocation {
  api: ApiAsset;
  sourcePath: string;
  replace(api: ApiAsset): void;
}

/** Build a side-effect-free import merge candidate for one explicitly selected target module. */
export function buildImportMergePlan(
  targetProjectValue: ContractProject,
  importedProjectValue: ContractProject,
  decisions: ImportMergeDecisions,
): ImportMergePlan {
  const targetProject = ContractProjectSchema.parse(structuredClone(targetProjectValue));
  const importedProject = ContractProjectSchema.parse(structuredClone(importedProjectValue));
  const targetCollection = targetProject.collections.find((collection) => collection.id === decisions.targetCollectionId);
  if (!targetCollection) throw new Error("Import merge target collection was not found in the selected project.");
  if (decisions.sourceCollectionIds.length === 0) throw new Error("Select at least one source module to merge.");

  const targetApis = collectionApiLocations(targetCollection);
  const sourceCollectionIds = new Set(decisions.sourceCollectionIds);
  const sourceCollections = importedProject.collections.filter((collection) => sourceCollectionIds.has(collection.id));
  if (sourceCollections.length !== sourceCollectionIds.size) throw new Error("A selected source module no longer exists in the import preview.");
  const sourceApis = sourceCollections.flatMap((collection) => collectionApiLocations(collection));
  const sourceIds = new Set(sourceApis.map(({ api }) => api.contract.id));
  const diagnostics: ImportExchangeDiagnostic[] = [];
  for (const sourceId of Object.keys(decisions.decisions)) {
    if (!sourceIds.has(sourceId)) diagnostics.push(diagnostic("error", "IMPORT_MERGE_SOURCE_NOT_SELECTED", `apis/${sourceId}`, "A decision referred to an API outside the selected source modules.", sourceId));
  }

  const duplicateSourceRoutes = duplicateRouteIds(sourceApis);
  for (const sourceId of duplicateSourceRoutes) {
    diagnostics.push(diagnostic("error", "IMPORT_MERGE_SOURCE_ROUTE_DUPLICATE", `apis/${sourceId}`, "The selected source modules contain the same protocol, method, and path more than once.", sourceId));
  }

  const planned: Array<{ source: ApiAsset; action: "add" | "overwrite" | "rename"; target?: ApiAsset; name?: string }> = [];
  const entries: ImportMergeEntry[] = [];
  let cancelled = false;
  for (const source of sourceApis) {
    const api = source.api;
    const request = api.contract.request;
    const method = request.protocol === "websocket" ? "WS" : request.method;
    const matches = targetApis.filter((candidate) => sameRoute(candidate.api, api));
    const decision = decisions.decisions[api.contract.id];
    const action = decision?.action ?? (matches.length > 0 ? "skip" : "rename");

    if (action === "cancel") {
      cancelled = true;
      break;
    }
    if (action === "skip") {
      entries.push(entry(api, source.sourcePath, "skipped", matches));
      continue;
    }
    if (action === "overwrite") {
      const target = decision.targetApiId
        ? matches.find((candidate) => candidate.api.contract.id === decision.targetApiId)
        : matches.length === 1 ? matches[0] : undefined;
      if (!target) {
        diagnostics.push(diagnostic(
          "error",
          matches.length > 1 ? "IMPORT_MERGE_AMBIGUOUS_TARGET" : "IMPORT_MERGE_TARGET_NOT_MATCHED",
          `apis/${api.contract.id}`,
          matches.length > 1
            ? "Choose one matching target API explicitly before overwriting."
            : "Overwrite requires an API with the same protocol, method, and path.",
          api.contract.id,
        ));
        entries.push(entry(api, source.sourcePath, "skipped", matches));
        continue;
      }
      const mockRule = targetProject.mock?.rules.find((rule) => rule.contractId === target.api.contract.id);
      if (mockRule) {
        diagnostics.push(diagnostic(
          "error",
          "IMPORT_MERGE_MOCK_REFERENCE_PROTECTED",
          `mock/rules/${mockRule.id}`,
          "The target API is referenced by a Mock rule; overwrite would replace response bindings used by that rule.",
          target.api.contract.id,
        ));
        entries.push(entry(api, source.sourcePath, "skipped", matches));
        continue;
      }
      planned.push({ source: api, action: "overwrite", target: target.api });
      entries.push(entry(api, source.sourcePath, "overwritten", matches, target.api.contract.id));
      continue;
    }

    if (matches.length > 0 && action !== "rename") {
      diagnostics.push(diagnostic("error", "IMPORT_MERGE_CONFLICT_POLICY_INVALID", `apis/${api.contract.id}`, "A route conflict must be skipped, renamed, or explicitly overwritten.", api.contract.id));
      entries.push(entry(api, source.sourcePath, "skipped", matches));
      continue;
    }
    const requestedName = decision?.name?.trim();
    const name = sanitizeNodeName(requestedName || (matches.length > 0 ? `${api.contract.metadata.name} (imported)` : api.contract.metadata.name));
    planned.push({ source: api, action: matches.length > 0 ? "rename" : "add", name });
    entries.push(entry(api, source.sourcePath, "added", matches));
  }

  if (cancelled) {
    return {
      project: targetProject,
      summary: { added: 0, overwritten: 0, skipped: sourceApis.length },
      entries: sourceApis.map(({ api, sourcePath }) => entry(api, sourcePath, "skipped", [])),
      diagnostics,
      cancelled: true,
    };
  }

  if (diagnostics.some((item) => item.severity === "error")) {
    return {
      project: targetProject,
      summary: { added: 0, overwritten: 0, skipped: sourceApis.length },
      entries: entries.map((item) => item.status === "skipped" ? item : { ...item, status: "skipped" }),
      diagnostics,
      cancelled: false,
    };
  }

  const includedSourceApis = planned.map((item) => item.source);
  if (includedSourceApis.length === 0) {
    return { project: targetProject, summary: { added: 0, overwritten: 0, skipped: sourceApis.length }, entries, diagnostics, cancelled: false };
  }

  const sourceContext = createProjectAssetContext({
    projectId: importedProject.id,
    assets: sourceApis.map(({ api }) => api),
    models: importedProject.models,
    components: importedProject.components,
  });
  const models = new Map<string, ImportMergePlan["project"]["models"][number]>();
  const components = new Map<string, ImportMergePlan["project"]["components"][number]>();
  for (const api of includedSourceApis) {
    const closure = sourceContext.dependencyClosure(api.contract.id);
    for (const model of closure.models) models.set(model.id, model);
    for (const component of closure.components) components.set(`${component.kind}:${component.id}`, component);
  }
  const sourceDiagnostics = sourceContext.diagnostics;
  if (sourceDiagnostics.length > 0) {
    return {
      project: targetProject,
      summary: { added: 0, overwritten: 0, skipped: sourceApis.length },
      entries: entries.map((item) => item.status === "skipped" ? item : { ...item, status: "skipped" }),
      diagnostics: [...diagnostics, ...sourceDiagnostics.map((item) => diagnostic("error", item.code, item.path, "A selected source API has an unresolved or invalid asset reference.", item.ownerId))],
      cancelled: false,
    };
  }

  const sourceBundle = {
    assets: includedSourceApis,
    models: [...models.values()],
    components: [...components.values()],
  };
  const cloned = cloneAssetBundle(sourceBundle, { newProjectId: targetProject.id, newId: () => randomUUID() }).bundle;
  const cloneBySourceId = new Map(includedSourceApis.map((api, index) => [api.contract.id, cloned.assets[index]! ]));
  const targetCollectionCopy = targetProject.collections.find((collection) => collection.id === decisions.targetCollectionId)!;
  const targetLocations = collectionApiLocations(targetCollectionCopy);
  const additions: ApiAsset[] = [];

  for (const item of planned) {
    const imported = cloneBySourceId.get(item.source.contract.id)!;
    if (item.action === "overwrite" && item.target) {
      const existing = targetLocations.find((location) => location.api.contract.id === item.target!.contract.id);
      if (!existing) {
        diagnostics.push(diagnostic("error", "IMPORT_MERGE_TARGET_CHANGED", `apis/${item.target.contract.id}`, "The selected target API changed while building the merge plan.", item.target.contract.id));
        continue;
      }
      const result: ApiAsset = {
        ...imported,
        contract: { ...imported.contract, id: item.target.contract.id },
        cases: structuredClone(item.target.cases),
        documentation: item.target.documentation,
      };
      existing.replace(result);
    } else {
      if (item.name) imported.contract.metadata.name = item.name;
      additions.push(imported);
    }
  }

  if (diagnostics.some((item) => item.severity === "error")) {
    return {
      project: targetProject,
      summary: { added: 0, overwritten: 0, skipped: sourceApis.length },
      entries: entries.map((item) => item.status === "skipped" ? item : { ...item, status: "skipped" }),
      diagnostics,
      cancelled: false,
    };
  }

  targetCollectionCopy.apis.push(...additions);
  targetProject.models.push(...cloned.models);
  targetProject.components.push(...cloned.components);
  const parsed = ContractProjectSchema.parse(targetProject);
  const added = planned.filter((item) => item.action !== "overwrite").length;
  const overwritten = planned.length - added;
  const skipped = sourceApis.length - planned.length;
  return { project: parsed, summary: { added, overwritten, skipped }, entries, diagnostics, cancelled: false };
}

function collectionApiLocations(collection: ContractCollection): ApiLocation[] {
  const locations: ApiLocation[] = [];
  const visit = (folder: ContractFolder, prefix: string): void => {
    const folderPath = `${prefix}/${folder.name}`;
    folder.apis.forEach((api, index) => locations.push({
      api,
      sourcePath: folderPath,
      replace(next) { folder.apis[index] = next; },
    }));
    folder.folders.forEach((child) => visit(child, folderPath));
  };
  collection.apis.forEach((api, index) => locations.push({
    api,
    sourcePath: collection.name,
    replace(next) { collection.apis[index] = next; },
  }));
  collection.folders.forEach((folder) => visit(folder, collection.name));
  return locations;
}

function sameRoute(left: ApiAsset, right: ApiAsset): boolean {
  const a = left.contract.request;
  const b = right.contract.request;
  return a.protocol === b.protocol
    && (a.protocol === "websocket" ? "WS" : a.method) === (b.protocol === "websocket" ? "WS" : b.method)
    && canonicalPath(a.path) === canonicalPath(b.path);
}

function canonicalPath(path: string): string {
  const value = path.split(/[?#]/, 1)[0] ?? "";
  const trimmed = value.length > 1 ? value.replace(/\/+$/, "") : value;
  return trimmed.replace(/\{[^/{}]+\}/g, "{}");
}

function duplicateRouteIds(locations: ApiLocation[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const { api } of locations) {
    const request = api.contract.request;
    const method = request.protocol === "websocket" ? "WS" : request.method;
    const key = JSON.stringify([request.protocol, method, canonicalPath(request.path)]);
    if (seen.has(key)) duplicates.add(api.contract.id);
    else seen.add(key);
  }
  return duplicates;
}

function entry(
  api: ApiAsset,
  sourcePath: string,
  status: ImportMergeEntry["status"],
  matches: ApiLocation[],
  targetApiId?: string,
): ImportMergeEntry {
  const request = api.contract.request;
  const method = request.protocol === "websocket" ? "WS" : request.method;
  const targetName = targetApiId ? matches.find((match) => match.api.contract.id === targetApiId)?.api.contract.metadata.name : undefined;
  return {
    sourceApiId: api.contract.id,
    sourceName: api.contract.metadata.name,
    sourcePath,
    method,
    path: request.path,
    status,
    targetApiIds: matches.map((match) => match.api.contract.id),
    ...(targetName === undefined ? {} : { targetName }),
  };
}

function diagnostic(
  severity: ImportExchangeDiagnostic["severity"],
  code: string,
  path: string,
  message: string,
  ownerId?: string,
): ImportExchangeDiagnostic {
  return { severity, code, path, message, lossy: false, ...(ownerId === undefined ? {} : { ownerId }) };
}
