import { createProjectAssetContext } from "@apicc/core/assets/context";
import type { ApiAsset, ApiTestCase, ContractProject } from "@apicc/core";
import type { ApiDetail, WorkspaceRefreshResult } from "../../../shared/types.js";
import type { EditorSession } from "./editor.js";
import { diskProject, jsonCopy, sameDiskValue, type DiskDraftReason } from "./diskDrafts.js";
import { workspaceCaseDependencies, workspaceRequestDependencies } from "../../../shared/workspace-api-dependencies.js";

export interface EditorDiskConflict {
  reason: DiskDraftReason;
  disk: ApiDetail | null;
}
export interface ExtraEditorDrafts { request: boolean; asset: boolean; cases?: readonly EditorUnit[] }

export type EditorUnit = "asset" | "request" | `case:${string}`;
export function caseUnit(identity: { caseId: string; scope: string }): EditorUnit {
  return `case:${JSON.stringify([identity.caseId, identity.scope])}`;
}
function caseKey(item: ApiTestCase): EditorUnit { return caseUnit({ caseId: item.id, scope: item.scope }); }
function byCase(cases: ApiTestCase[]) { return new Map(cases.map((item) => [caseKey(item), item])); }

function dependencies(project: ContractProject | undefined, draft: ApiAsset): unknown {
  if (!project) return null;
  const closure = createProjectAssetContext({
    projectId: project.id, assets: [jsonCopy(draft)], models: project.models, components: project.components, datasets: project.datasets,
  }).dependencyClosure(draft.contract.id);
  return { models: closure.models, components: closure.components, datasets: closure.datasets };
}

function documentPart(asset: ApiAsset) {
  const { request: _request, ...contract } = asset.contract;
  return { contract, documentation: asset.documentation };
}

function narrowAsset(asset: ApiAsset, cases: ApiTestCase[]): ApiAsset {
  return { ...asset, contract: { ...asset.contract, responses: [] }, cases };
}

export function reconcileEditorSession(
  session: EditorSession,
  receipt: WorkspaceRefreshResult,
  disk: ApiDetail | null | undefined,
  extraDraft: ExtraEditorDrafts,
): void {
  const local = session.api;
  const base = JSON.parse(session.snapshot) as ApiAsset;
  const before = diskProject(receipt.previousWorkspace, session.locator);
  const after = diskProject(receipt.workspace, session.locator);
  const previousConflicts = session.diskConflicts;
  const conflicts: Partial<Record<EditorUnit, EditorDiskConflict>> = {};
  session.diskEpoch = (session.diskEpoch ?? 0) + 1;
  session.diskConflicts = conflicts;
  if (!disk) {
    const conflict: EditorDiskConflict = { reason: disk === null ? "deleted" : "unverified", disk: null };
    conflicts.asset = conflict;
    conflicts.request = conflict;
    for (const item of local.cases) conflicts[caseKey(item)] = conflict;
    return;
  }
  session.sourceApiRevision = disk.sourceApiRevision;
  session.sourceProjectRevision = disk.sourceProjectRevision;
  session.envs = jsonCopy(disk.envs);
  const incoming = disk.api;
  const next = jsonCopy(incoming);
  const baseline = jsonCopy(incoming);
  const dirtyAsset = extraDraft.asset || extraDraft.request || !!extraDraft.cases?.length || !sameDiskValue(local, base);
  const changed = (): EditorDiskConflict => ({ reason: "changed", disk });
  if (dirtyAsset && (!sameDiskValue(base, incoming) || !sameDiskValue(dependencies(before, local), dependencies(after, local))
      || !sameDiskValue(dependencies(before, base), dependencies(after, base)))) {
    conflicts.asset = changed();
  }
  if (!sameDiskValue(documentPart(local), documentPart(base))) {
    next.contract = { ...local.contract, request: next.contract.request };
    next.documentation = local.documentation;
    baseline.contract = { ...base.contract, request: baseline.contract.request };
    baseline.documentation = base.documentation;
  }
  if (extraDraft.request || !sameDiskValue(base.contract.request, local.contract.request)) {
    next.contract.request = jsonCopy(local.contract.request);
    const source = narrowAsset(local, []);
    const originalSource = narrowAsset(base, []);
    const overrideProtocols = (asset: ApiAsset) => asset.cases.flatMap((item) => item.requestOverride
      ? [[item.id, item.scope, item.requestOverride.protocol]] : []);
    const inheriting = (asset: ApiAsset) => asset.cases.filter(item => !item.requestOverride);
    const protocolChanged = base.contract.request.protocol !== local.contract.request.protocol;
    if (!sameDiskValue(base.contract.request, incoming.contract.request)
      || protocolChanged && !sameDiskValue(overrideProtocols(base), overrideProtocols(incoming))
      || !sameDiskValue(inheriting(base), inheriting(incoming))
      || !sameDiskValue(workspaceRequestDependencies(receipt.previousWorkspace, session.locator), workspaceRequestDependencies(receipt.workspace, session.locator))
      || !sameDiskValue(dependencies(before, originalSource), dependencies(after, originalSource))
      || !sameDiskValue(dependencies(before, source), dependencies(after, source))) {
      conflicts.asset = changed();
      conflicts.request = changed();
      baseline.contract.request = jsonCopy(base.contract.request);
    }
  }
  const baseCases = byCase(base.cases), localCases = byCase(local.cases), diskCases = byCase(incoming.cases);
  const reconciledCases = new Map(diskCases), confirmedCases = new Map(diskCases);
  for (const key of new Set([...baseCases.keys(), ...localCases.keys()])) {
    const original = baseCases.get(key), draft = localCases.get(key), persisted = diskCases.get(key);
    if (sameDiskValue(original, draft) && !extraDraft.cases?.includes(key)) continue;
    if (draft) reconciledCases.set(key, draft); else reconciledCases.delete(key);
    const target = draft ?? original!;
    const definition = narrowAsset(local, [target]);
    const inputs = [session.locator, base.contract.request, original ?? null, target] as const;
    const inherits = !target.requestOverride || original && !original.requestOverride;
    if (!sameDiskValue(original, persisted) || base.contract.request.protocol !== incoming.contract.request.protocol
      || inherits && !sameDiskValue(base.contract.request, incoming.contract.request)
      || !sameDiskValue(workspaceCaseDependencies(receipt.previousWorkspace, ...inputs), workspaceCaseDependencies(receipt.workspace, ...inputs))
      || !sameDiskValue(dependencies(before, definition), dependencies(after, definition))) {
      conflicts[key] = { reason: original && !persisted ? "deleted" : "changed", disk };
      conflicts.asset = changed();
      if (original) confirmedCases.set(key, original); else confirmedCases.delete(key);
    }
  }
  // A second refresh compares against the already-read workspace. Keep any
  // previously proven change attached to the draft until explicit resolution.
  for (const [unit, conflict] of Object.entries(previousConflicts ?? {}) as Array<[EditorUnit, EditorDiskConflict]>) {
    if (conflict.reason !== "unverified" && !conflicts[unit]) conflicts[unit] = { ...conflict, disk };
  }
  next.cases = [...reconciledCases.values()].map(jsonCopy);
  baseline.cases = [...confirmedCases.values()].map(jsonCopy);
  session.api = next;
  session.snapshot = JSON.stringify(baseline);
}

export function restoreEditorDiskUnit(session: EditorSession, unit: EditorUnit): boolean {
  const conflict = session.diskConflicts?.[unit];
  if (!conflict?.disk) return false;
  const disk = conflict.disk.api;
  if (unit === "asset") {
    session.api = jsonCopy(disk);
    session.snapshot = JSON.stringify(disk);
    session.protocolDrafts = {};
    session.diskConflicts = {};
    return true;
  }
  const baseline = JSON.parse(session.snapshot) as ApiAsset;
  if (unit === "request") {
    session.api.contract.request = jsonCopy(disk.contract.request);
    baseline.contract.request = jsonCopy(disk.contract.request);
    session.protocolDrafts = {};
  } else {
    const incoming = disk.cases.find((item) => caseKey(item) === unit);
    for (const asset of [session.api, baseline]) {
      const index = asset.cases.findIndex((item) => caseKey(item) === unit);
      if (index < 0) { if (incoming) asset.cases.push(jsonCopy(incoming)); }
      else if (incoming) asset.cases[index] = jsonCopy(incoming);
      else asset.cases.splice(index, 1);
    }
  }
  session.snapshot = JSON.stringify(baseline);
  delete session.diskConflicts![unit];
  if (sameDiskValue(session.api, baseline)) delete session.diskConflicts!.asset;
  return true;
}
