import { createHash } from "node:crypto";

import type { ApiAsset } from "../contract/model.js";
import { ContractProjectSchema, type ContractFolder, type ContractProject } from "../contract/workspace.js";
import { cloneDefinitionValue, createReadonlyProjectAssetContext, type ProjectAssetContextReadView } from "./context.js";

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export interface ProjectSnapshot {
  project: DeepReadonly<ContractProject>;
  context: ProjectAssetContextReadView;
  definitionRevision: string;
}

export function createProjectSnapshot(project: ContractProject): ProjectSnapshot {
  const frozenProject = cloneDefinitionValue(project);
  if (!ContractProjectSchema.safeParse(frozenProject).success) {
    throw new TypeError("Project snapshots require a valid contract project definition.");
  }
  canonicalJson(frozenProject);
  const normalized = ContractProjectSchema.parse(frozenProject);
  const definitionRevision = createHash("sha256").update(canonicalJson(normalized)).digest("hex");
  deepFreeze(normalized);
  const assets = collectProjectApis(normalized);
  const context = createReadonlyProjectAssetContext({
    projectId: normalized.id,
    assets,
    models: normalized.models,
    components: normalized.components,
    datasets: normalized.datasets,
    suites: normalized.suites,
    project: normalized,
  });
  return { project: normalized, context, definitionRevision };
}

function collectProjectApis(project: ContractProject): ApiAsset[] {
  const assets: ApiAsset[] = [];
  for (const collection of project.collections) {
    assets.push(...collection.apis);
    for (const folder of collection.folders) collectFolderApis(folder, assets);
  }
  return assets;
}

function collectFolderApis(folder: ContractFolder, assets: ApiAsset[]): void {
  assets.push(...folder.apis);
  for (const child of folder.folders) collectFolderApis(child, assets);
}

function canonicalJson(value: unknown): string {
  return canonicalize(value, new WeakSet<object>());
}

function canonicalize(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Project snapshots require finite numbers.");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError("Project snapshots require JSON-compatible definitions.");
  if (ancestors.has(value)) throw new TypeError("Project definitions must not contain direct object cycles.");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      assertPlainArray(value);
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError("Project arrays must be dense enumerable data arrays.");
        entries.push(canonicalize(descriptor.value, ancestors));
      }
      return `[${entries.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Project definitions must contain only plain objects.");
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) throw new TypeError("Project definitions must not contain symbol keys.");
    const keys = (ownKeys as string[]).sort();
    const entries: string[] = [];
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError("Project objects must contain enumerable data properties.");
      if (descriptor.value === undefined) {
        if (isFormalOptionalProjectField(value as Record<string, unknown>, key)) continue;
        throw new TypeError("Project snapshots only omit schema-optional undefined properties.");
      }
      entries.push(`${JSON.stringify(key)}:${canonicalize(descriptor.value, ancestors)}`);
    }
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function isFormalOptionalProjectField(parent: Record<string, unknown>, key: string): boolean {
  const kind = parent.kind;
  if (["mock", "datasets", "suites"].includes(key) && Object.hasOwn(parent, "globals") && Object.hasOwn(parent, "stressPolicy") && Object.hasOwn(parent, "collections")) return true;
  if (isSchemaNodeKind(kind) && ["description", "default", "examples", "enum"].includes(key)) return true;
  if (key === "extends" && Object.hasOwn(parent, "baseUrls") && Object.hasOwn(parent, "variables")) return true;
  if (parent.protocol === "websocket" && key === "message") return true;
  if (parent.protocol === "soap" && key === "soapAction") return true;
  if (parent.kind === "inline" && Object.hasOwn(parent, "schema") && key === "value") return true;
  if (parent.kind === "componentRef" && parent.expectedKind === "parameter" && (key === "value" || key === "enabled")) return true;
  if (parent.kind === "graphql" && Object.hasOwn(parent, "query") && (key === "variables" || key === "operationName")) return true;
  if ((kind === "json" || kind === "xml" || kind === "text") && Object.hasOwn(parent, "content") && key === "schema") return true;
  if (parent.kind === "file" && Object.hasOwn(parent, "file") && ["contentType", "filename"].includes(key)) return true;
  if (Array.isArray(parent.examples) && key === "schema") return true;
  if (Object.hasOwn(parent, "id") && Object.hasOwn(parent, "target") && Object.hasOwn(parent, "op")
    && ["expected", "headerName", "path", "cookieName", "namespaces", "match", "options"].includes(key)) return true;
  if (Object.hasOwn(parent, "selector") && ["pattern", "flags", "group", "regexMatch", "required", "defaultValue", "sensitive"].includes(key)) return true;
  if (Object.hasOwn(parent, "target") && ["path", "headerName", "cookieName", "namespaces", "match"].includes(key)) return true;
  if (parent.formatVersion === 1 && Object.hasOwn(parent, "selection") && ["description", "tags", "environmentId", "datasetId", "failFast", "reporters"].includes(key)) return true;
  if (parent.formatVersion === 1 && Array.isArray(parent.columns) && key === "description") return true;
  if (parent.kind === "query" && ["collectionIds", "caseTags"].includes(key)) return true;
  if ((kind === "request" || kind === "noop") && ["apiId", "caseId", "label", "position"].includes(key)) return true;
  if (Object.hasOwn(parent, "from") && Object.hasOwn(parent, "to") && key === "condition") return true;
  if (Array.isArray(parent.assertions) && Object.hasOwn(parent, "parameters")
    && ["dataDriver", "requestOverride", "requestSettingsOverride", "tags", "extractors"].includes(key)) return true;
  if (Array.isArray(parent.trustedOrigins) && Array.isArray(parent.deniedOrigins)
    && (key === "maxConcurrency" || key === "maxRps")) return true;
  return false;
}

function isSchemaNodeKind(value: unknown): boolean {
  return value === "scalar" || value === "object" || value === "array"
    || value === "allOf" || value === "oneOf" || value === "anyOf" || value === "modelRef";
}

function assertPlainArray(value: unknown[]): void {
  if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError("Project arrays must use the standard array prototype.");
  const ownKeys = Reflect.ownKeys(value);
  for (const key of ownKeys) {
    if (typeof key !== "string" || key === "length") continue;
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
      throw new TypeError("Project arrays must not contain extra properties.");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError("Project arrays must contain enumerable data entries.");
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) || lengthDescriptor.value !== value.length) {
    throw new TypeError("Project arrays must have a valid length property.");
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}
