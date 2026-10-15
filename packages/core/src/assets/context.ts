import type { ApiAsset, ApiContract, ApiRequest, ComponentAsset, ModelAsset } from "../contract/model.js";
import {
  collectProjectAssetReferences,
  referencesFromApiAsset,
  referencesFromApiRequest,
  referencesFromComponentAsset,
  referencesFromModelAsset,
  type AssetReference,
  type ProjectAssetGraphInput,
} from "./graph.js";

export interface AssetDiagnostic {
  code: string;
  ownerId: string;
  path: string;
  targetId?: string;
}

export interface AssetBundle {
  assets: ApiAsset[];
  models: ModelAsset[];
  components: ComponentAsset[];
}

export type AssetMutationResult =
  | { ok: true }
  | { ok: false; code: "ASSET_REFERENCED" | "ASSET_NOT_FOUND"; references: AssetDiagnostic[] };

export type AssetGate = "publish" | "execution";

export interface AssetGateResult {
  ok: boolean;
  diagnostics: AssetDiagnostic[];
}

export type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export interface ProjectAssetContextInput extends ProjectAssetGraphInput {
  projectId: string;
}

export interface ProjectAssetContextReadView {
  getContract(id: string): DeepReadonly<ApiContract> | undefined;
  getModel(id: string): DeepReadonly<ModelAsset> | undefined;
  getComponent(id: string): DeepReadonly<ComponentAsset> | undefined;
  readonly diagnostics: AssetDiagnostic[];
  referencesTo(id: string): AssetDiagnostic[];
  dependencyClosure(id: string): AssetBundle;
  checkGate(gate: AssetGate, contractId?: string, effectiveRequest?: DeepReadonly<ApiRequest>): AssetGateResult;
}

export interface ProjectAssetContext extends ProjectAssetContextReadView {
  rename(id: string, name: string): AssetMutationResult;
  delete(id: string): AssetMutationResult;
}

interface AssetIndexes {
  assetIds: Map<string, ApiAsset>;
  modelIds: Map<string, ModelAsset>;
  componentIds: Map<string, ComponentAsset>;
  counts: Map<string, number>;
}

type GraphNode =
  | { kind: "contract"; id: string; asset: ApiAsset }
  | { kind: "model"; id: string; model: ModelAsset }
  | { kind: "component"; id: string; component: ComponentAsset };

export function cloneDefinitionValue<T>(value: T): T {
  const ancestors = new WeakSet<object>();

  const clone = (item: unknown): unknown => {
    if (item === null || typeof item !== "object") return item;
    if (ancestors.has(item)) throw new TypeError("Definitions must not contain direct object cycles.");

    if (Array.isArray(item)) {
      const output: unknown[] = new Array(item.length);
      ancestors.add(item);
      try {
        for (const key of Reflect.ownKeys(item)) {
          if (key === "length") continue;
          if (typeof key !== "string" || !isArrayIndex(key, item.length)) throw new TypeError("Definition arrays must contain only indexed data entries.");
          const descriptor = Object.getOwnPropertyDescriptor(item, key);
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError("Definition arrays must contain enumerable data entries.");
          Object.defineProperty(output, key, { value: clone(descriptor.value), enumerable: true, configurable: true, writable: true });
        }
        for (let index = 0; index < output.length; index += 1) {
          if (!Object.hasOwn(output, index)) throw new TypeError("Definition arrays must not contain holes.");
        }
      } finally {
        ancestors.delete(item);
      }
      return output;
    }

    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Definitions must contain only plain objects.");
    const output = Object.create(prototype) as Record<string, unknown>;
    ancestors.add(item);
    try {
      for (const key of Reflect.ownKeys(item)) {
        if (typeof key !== "string") throw new TypeError("Definition objects must not contain symbol keys.");
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError("Definitions must contain enumerable data properties.");
        Object.defineProperty(output, key, { value: clone(descriptor.value), enumerable: true, configurable: true, writable: true });
      }
    } finally {
      ancestors.delete(item);
    }
    return output;
  };

  return clone(value) as T;
}

export function createProjectAssetContext(input: ProjectAssetContextInput): ProjectAssetContext {
  return createContext({
    projectId: input.projectId,
    assets: cloneDefinitionValue(input.assets),
    models: cloneDefinitionValue(input.models),
    components: cloneDefinitionValue(input.components),
  }, false);
}

/** Indexes definitions already frozen by a project snapshot without making a second copy. */
export function createReadonlyProjectAssetContext(input: ProjectAssetContextInput): ProjectAssetContextReadView {
  return createContext(input, true);
}

function createContext(input: ProjectAssetContextInput, sharedReadOnly: false): ProjectAssetContext;
function createContext(input: ProjectAssetContextInput, sharedReadOnly: true): ProjectAssetContextReadView;
function createContext(input: ProjectAssetContextInput, sharedReadOnly: boolean): ProjectAssetContext | ProjectAssetContextReadView {
  let assets = input.assets;
  let models = input.models;
  let components = input.components;

  const currentInput = (): ProjectAssetGraphInput => ({ assets, models, components });
  const indexes = (): AssetIndexes => buildIndexes(currentInput());
  const diagnostics = (): AssetDiagnostic[] => buildDiagnostics(currentInput());
  const copy = <T extends object>(value: T): T => sharedReadOnly ? value : cloneDefinitionValue(value);

  const view: ProjectAssetContextReadView = {
    getContract(id) {
      const asset = indexes().assetIds.get(id);
      return asset ? copy(asset.contract) : undefined;
    },
    getModel(id) {
      const model = indexes().modelIds.get(id);
      return model ? copy(model) : undefined;
    },
    getComponent(id) {
      const component = indexes().componentIds.get(id);
      return component ? copy(component) : undefined;
    },
    get diagnostics() {
      return diagnostics();
    },
    referencesTo(id) {
      return inboundReferences(currentInput(), id);
    },
    dependencyClosure(id) {
      return buildDependencyClosure(currentInput(), id, copy);
    },
    checkGate(gate, contractId, effectiveRequest) {
      if (gate === "publish") {
        const publishDiagnostics = contractId === undefined
          ? diagnostics()
          : publishDiagnosticsFor(currentInput(), contractId);
        return { ok: publishDiagnostics.length === 0, diagnostics: publishDiagnostics };
      }
      if (contractId === undefined) {
        const noContract: AssetDiagnostic[] = [{ code: "ASSET_NOT_FOUND", ownerId: input.projectId, path: "contractId", targetId: input.projectId }];
        return { ok: false, diagnostics: noContract };
      }
      const executionDiagnostics = executionDiagnosticsFor(currentInput(), contractId, effectiveRequest);
      return { ok: executionDiagnostics.length === 0, diagnostics: executionDiagnostics };
    },
  };

  if (sharedReadOnly) return view;

  const editable: ProjectAssetContext = {
    ...view,
    get diagnostics() {
      return diagnostics();
    },
    referencesTo(id) {
      return inboundReferences(currentInput(), id);
    },
    dependencyClosure(id) {
      return buildDependencyClosure(currentInput(), id, copy);
    },
    checkGate(gate, contractId, effectiveRequest) {
      return view.checkGate(gate, contractId, effectiveRequest);
    },
    rename(id, name) {
      const index = indexes();
      const count = index.counts.get(id) ?? 0;
      if (count !== 1) return { ok: false, code: "ASSET_NOT_FOUND", references: [] };
      const asset = index.assetIds.get(id);
      if (asset) {
        asset.contract.metadata.name = name;
        return { ok: true };
      }
      const model = index.modelIds.get(id);
      if (model) {
        model.name = name;
        return { ok: true };
      }
      const component = index.componentIds.get(id);
      if (component) {
        component.name = name;
        return { ok: true };
      }
      return { ok: false, code: "ASSET_NOT_FOUND", references: [] };
    },
    delete(id) {
      const index = indexes();
      if ((index.counts.get(id) ?? 0) !== 1) return { ok: false, code: "ASSET_NOT_FOUND", references: [] };
      const references = inboundReferences(currentInput(), id);
      if (references.length > 0) return { ok: false, code: "ASSET_REFERENCED", references };

      const assetIndex = assets.findIndex((asset) => asset.contract.id === id);
      if (assetIndex >= 0) {
        assets = assets.filter((_asset, currentIndex) => currentIndex !== assetIndex);
        return { ok: true };
      }
      const modelIndex = models.findIndex((model) => model.id === id);
      if (modelIndex >= 0) {
        models = models.filter((_model, currentIndex) => currentIndex !== modelIndex);
        return { ok: true };
      }
      const componentIndex = components.findIndex((component) => component.id === id);
      if (componentIndex >= 0) {
        components = components.filter((_component, currentIndex) => currentIndex !== componentIndex);
        return { ok: true };
      }
      return { ok: false, code: "ASSET_NOT_FOUND", references: [] };
    },
  };
  return editable;
}

function buildIndexes(input: ProjectAssetGraphInput): AssetIndexes {
  const counts = new Map<string, number>();
  for (const asset of input.assets) increment(counts, asset.contract.id);
  for (const model of input.models) increment(counts, model.id);
  for (const component of input.components) increment(counts, component.id);

  const assetIds = new Map<string, ApiAsset>();
  const modelIds = new Map<string, ModelAsset>();
  const componentIds = new Map<string, ComponentAsset>();
  for (const asset of input.assets) if (counts.get(asset.contract.id) === 1) assetIds.set(asset.contract.id, asset);
  for (const model of input.models) if (counts.get(model.id) === 1) modelIds.set(model.id, model);
  for (const component of input.components) if (counts.get(component.id) === 1) componentIds.set(component.id, component);
  return { assetIds, modelIds, componentIds, counts };
}

function buildDiagnostics(input: ProjectAssetGraphInput): AssetDiagnostic[] {
  const duplicateDiagnostics: AssetDiagnostic[] = [];
  const seen = new Set<string>();
  input.assets.forEach((asset, index) => pushDuplicate(seen, duplicateDiagnostics, asset.contract.id, `assets[${index}].contract.id`));
  input.models.forEach((model, index) => pushDuplicate(seen, duplicateDiagnostics, model.id, `models[${index}].id`));
  input.components.forEach((component, index) => pushDuplicate(seen, duplicateDiagnostics, component.id, `components[${index}].id`));

  const allById = new Map<string, Array<{ kind: "contract" | "model" | "component"; componentKind?: ComponentAsset["kind"] }>>();
  for (const asset of input.assets) addKinds(allById, asset.contract.id, { kind: "contract" });
  for (const model of input.models) addKinds(allById, model.id, { kind: "model" });
  for (const component of input.components) addKinds(allById, component.id, { kind: "component", componentKind: component.kind });

  const referenceDiagnostics = collectProjectAssetReferences(input).flatMap((reference) => diagnoseReference(reference, allById));
  const cycleDiagnostics = modelReferenceCycleDiagnostics(input.models);
  return [
    ...duplicateDiagnostics,
    ...referenceDiagnostics,
    ...parameterDesignDiagnostics(input),
    ...responseDesignDiagnostics(input),
    ...cycleDiagnostics,
  ];
}

function publishDiagnosticsFor(input: ProjectAssetGraphInput, contractId: string): AssetDiagnostic[] {
  const index = buildIndexes(input);
  const count = index.counts.get(contractId) ?? 0;
  if (count !== 1 || !index.assetIds.has(contractId)) {
    return [{
      code: count > 1 ? "ASSET_ID_DUPLICATE" : "ASSET_NOT_FOUND",
      ownerId: contractId,
      path: "contract.id",
      targetId: contractId,
    }];
  }

  const identity = <T extends object>(value: T): T => value;
  const closure = buildDependencyClosure(input, contractId, identity);
  const owners = new Set([
    ...closure.assets.map((asset) => asset.contract.id),
    ...closure.models.map((model) => model.id),
    ...closure.components.map((component) => component.id),
  ]);
  return buildDiagnostics(input).filter((diagnostic) => owners.has(diagnostic.ownerId));
}

function parameterDesignDiagnostics(input: ProjectAssetGraphInput): AssetDiagnostic[] {
  const indexes = buildIndexes(input);
  const diagnostics: AssetDiagnostic[] = [];
  for (const asset of input.assets) {
    diagnostics.push(...parameterDesignDiagnosticsForRequest(
      asset.contract.request,
      asset.contract.id,
      indexes,
      "contract.request",
    ));
    asset.cases.forEach((testCase, caseIndex) => {
      if (!testCase.requestOverride) return;
      diagnostics.push(...parameterDesignDiagnosticsForRequest(
        testCase.requestOverride,
        asset.contract.id,
        indexes,
        `cases[${caseIndex}].requestOverride`,
      ));
    });
  }
  return diagnostics;
}

function parameterDesignDiagnosticsForRequest(
  request: DeepReadonly<ApiRequest>,
  ownerId: string,
  indexes: AssetIndexes,
  rootPath: string,
): AssetDiagnostic[] {
  const diagnostics: AssetDiagnostic[] = [];
  const groups = [
    { location: "path", path: `${rootPath}.pathParams`, bindings: request.pathParams },
    { location: "query", path: `${rootPath}.query`, bindings: request.query },
    { location: "header", path: `${rootPath}.headers`, bindings: request.headers },
    { location: "cookie", path: `${rootPath}.cookies`, bindings: request.cookies },
  ] as const;

  for (const group of groups) {
    const seenNames = new Set<string>();
    group.bindings.forEach((binding, bindingIndex) => {
      let name: string;
      if (binding.kind === "inline") name = binding.name;
      else {
        const component = indexes.componentIds.get(binding.componentId);
        if (component?.kind !== "parameter") return;
        if (component.definition.location !== group.location) {
          diagnostics.push({
            code: "ASSET_PARAMETER_LOCATION_MISMATCH",
            ownerId,
            path: `${group.path}[${bindingIndex}].componentId`,
            targetId: component.id,
          });
          return;
        }
        name = component.definition.name;
      }

      const key = group.location === "header" ? name.toLowerCase() : name;
      if (seenNames.has(key)) {
        const field = binding.kind === "inline" ? "name" : "componentId";
        diagnostics.push({
          code: "ASSET_PARAMETER_NAME_DUPLICATE",
          ownerId,
          path: `${group.path}[${bindingIndex}].${field}`,
        });
      } else seenNames.add(key);
    });
  }
  return diagnostics;
}

function responseDesignDiagnostics(input: ProjectAssetGraphInput): AssetDiagnostic[] {
  const indexes = buildIndexes(input);
  const diagnostics: AssetDiagnostic[] = [];
  for (const asset of input.assets) {
    const seen = new Set<string>();
    asset.contract.responses.forEach((binding, responseIndex) => {
      const response = binding.kind === "inline"
        ? binding
        : indexes.componentIds.get(binding.componentId)?.kind === "response"
          ? (indexes.componentIds.get(binding.componentId) as Extract<ComponentAsset, { kind: "response" }>).definition
          : undefined;
      if (!response) return;
      for (const contentType of Object.keys(response.content)) {
        const key = JSON.stringify([response.status, contentType]);
        if (seen.has(key)) {
          diagnostics.push({
            code: "ASSET_RESPONSE_STATUS_CONTENT_TYPE_DUPLICATE",
            ownerId: asset.contract.id,
            path: `contract.responses[${responseIndex}]`,
            ...(binding.kind === "componentRef" ? { targetId: binding.componentId } : {}),
          });
        } else seen.add(key);
      }
    });
  }
  return diagnostics;
}

function inboundReferences(input: ProjectAssetGraphInput, id: string): AssetDiagnostic[] {
  return collectProjectAssetReferences(input)
    .filter((reference) => reference.targetId === id)
    .map((reference) => ({
      code: "ASSET_REFERENCE",
      ownerId: reference.ownerId,
      path: reference.path,
      targetId: reference.targetId,
    }));
}

function diagnoseReference(
  reference: AssetReference,
  allById: Map<string, Array<{ kind: "contract" | "model" | "component"; componentKind?: ComponentAsset["kind"] }>>,
): AssetDiagnostic[] {
  const targets = allById.get(reference.targetId);
  if (!targets || targets.length === 0) {
    return [{ code: "ASSET_REFERENCE_MISSING", ownerId: reference.ownerId, path: reference.path, targetId: reference.targetId }];
  }
  if (targets.length > 1) {
    return [{ code: "ASSET_ID_DUPLICATE", ownerId: reference.ownerId, path: reference.path, targetId: reference.targetId }];
  }
  const expectedExists = reference.expectedKind === "model"
    ? targets.some((target) => target.kind === "model")
    : targets.some((target) => target.kind === "component" && target.componentKind === reference.expectedKind);
  if (!expectedExists) {
    return [{ code: "ASSET_REFERENCE_KIND_MISMATCH", ownerId: reference.ownerId, path: reference.path, targetId: reference.targetId }];
  }
  return [];
}

function executionDiagnosticsFor(
  input: ProjectAssetGraphInput,
  contractId: string,
  effectiveRequest?: DeepReadonly<ApiRequest>,
): AssetDiagnostic[] {
  const index = buildIndexes(input);
  const root = index.assetIds.get(contractId);
  if (!root) {
    const isDuplicate = (index.counts.get(contractId) ?? 0) > 1;
    return [{
      code: isDuplicate ? "ASSET_ID_DUPLICATE" : "ASSET_NOT_FOUND",
      ownerId: contractId,
      path: "contract.id",
      targetId: contractId,
    }];
  }

  const nodes: GraphNode[] = [{ kind: "contract", id: root.contract.id, asset: root }];
  const visited = new Set<string>();
  const issues: AssetDiagnostic[] = [];
  const reachableModelIds = new Set<string>();
  const requestToCheck = effectiveRequest ?? root.contract.request;
  const caseIndex = effectiveRequest === undefined
    ? -1
    : root.cases.findIndex((testCase) => testCase.requestOverride === effectiveRequest);
  const requestRootPath = caseIndex < 0 ? "contract.request" : `cases[${caseIndex}].requestOverride`;
  const allById = new Map<string, Array<{ kind: "contract" | "model" | "component"; componentKind?: ComponentAsset["kind"] }>>();
  for (const asset of input.assets) addKinds(allById, asset.contract.id, { kind: "contract" });
  for (const model of input.models) addKinds(allById, model.id, { kind: "model" });
  for (const component of input.components) addKinds(allById, component.id, { kind: "component", componentKind: component.kind });

  while (nodes.length > 0) {
    const node = nodes.shift();
    if (!node) continue;
    const nodeKey = `${node.kind}:${node.id}`;
    if (visited.has(nodeKey)) continue;
    visited.add(nodeKey);
    if (node.kind === "model") reachableModelIds.add(node.id);

    const references = node.kind === "contract"
      ? referencesFromApiRequest(requestToCheck, node.id, requestRootPath)
      : node.kind === "model"
        ? referencesFromModelAsset(node.model)
        : referencesFromComponentAsset(node.component);

    for (const reference of references) {
      const referenceIssues = diagnoseReference(reference, allById);
      issues.push(...referenceIssues);
      if (referenceIssues.length > 0) continue;
      if (reference.expectedKind === "model") {
        const target = index.modelIds.get(reference.targetId);
        if (target) nodes.push({ kind: "model", id: target.id, model: target });
      } else {
        const target = index.componentIds.get(reference.targetId);
        if (target && target.kind === reference.expectedKind) nodes.push({ kind: "component", id: target.id, component: target });
      }
    }
  }
  issues.push(...parameterDesignDiagnosticsForRequest(requestToCheck, root.contract.id, index, requestRootPath));
  issues.push(...modelReferenceCycleDiagnostics(input.models, reachableModelIds));
  return issues;
}

function modelReferenceCycleDiagnostics(models: ModelAsset[], reachableIds?: ReadonlySet<string>): AssetDiagnostic[] {
  const counts = new Map<string, number>();
  models.forEach((model) => increment(counts, model.id));

  const uniqueModels = new Map<string, ModelAsset>();
  const modelIndexes = new Map<string, number>();
  models.forEach((model, index) => {
    if (counts.get(model.id) === 1) {
      uniqueModels.set(model.id, model);
      modelIndexes.set(model.id, index);
    }
  });

  const states = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const diagnostics = new Map<string, AssetDiagnostic>();

  const visit = (modelId: string): void => {
    states.set(modelId, "visiting");
    stack.push(modelId);
    const schema = uniqueModels.get(modelId)?.schema;
    if (schema?.kind === "modelRef" && uniqueModels.has(schema.modelId)
      && (reachableIds === undefined || reachableIds.has(schema.modelId))) {
      const targetState = states.get(schema.modelId);
      if (targetState === "visiting") {
        const cycleStart = stack.indexOf(schema.modelId);
        for (const cycleOwnerId of stack.slice(cycleStart)) {
          const cycleSchema = uniqueModels.get(cycleOwnerId)?.schema;
          if (cycleSchema?.kind !== "modelRef" || !stack.slice(cycleStart).includes(cycleSchema.modelId)) continue;
          const index = modelIndexes.get(cycleOwnerId);
          const diagnostic: AssetDiagnostic = {
            code: "ASSET_MODEL_REFERENCE_CYCLE",
            ownerId: cycleOwnerId,
            path: `models[${index}].schema.modelId`,
            targetId: cycleSchema.modelId,
          };
          diagnostics.set(JSON.stringify([diagnostic.ownerId, diagnostic.targetId]), diagnostic);
        }
      } else if (targetState === undefined && (reachableIds === undefined || reachableIds.has(schema.modelId))) {
        visit(schema.modelId);
      }
    }
    stack.pop();
    states.set(modelId, "visited");
  };

  for (const model of models) {
    if (!uniqueModels.has(model.id) || states.has(model.id) || (reachableIds !== undefined && !reachableIds.has(model.id))) continue;
    visit(model.id);
  }

  return [...diagnostics.values()];
}

function buildDependencyClosure(input: ProjectAssetGraphInput, id: string, copy: <T extends object>(value: T) => T): AssetBundle {
  const indexes = buildIndexes(input);
  const start: GraphNode | undefined = indexes.assetIds.has(id)
    ? { kind: "contract", id, asset: indexes.assetIds.get(id) as ApiAsset }
    : indexes.modelIds.has(id)
      ? { kind: "model", id, model: indexes.modelIds.get(id) as ModelAsset }
      : indexes.componentIds.has(id)
        ? { kind: "component", id, component: indexes.componentIds.get(id) as ComponentAsset }
        : undefined;
  if (!start) return { assets: [], models: [], components: [] };

  const nodes: GraphNode[] = [start];
  const visited = new Set<string>();
  while (nodes.length > 0) {
    const node = nodes.shift();
    if (!node) continue;
    const key = `${node.kind}:${node.id}`;
    if (visited.has(key)) continue;
    visited.add(key);

    const references = node.kind === "contract"
      ? referencesFromApiAsset(node.asset)
      : node.kind === "model"
        ? referencesFromModelAsset(node.model)
        : referencesFromComponentAsset(node.component);
    for (const reference of references) {
      if (reference.expectedKind === "model") {
        const target = indexes.modelIds.get(reference.targetId);
        if (target) nodes.push({ kind: "model", id: target.id, model: target });
      } else {
        const target = indexes.componentIds.get(reference.targetId);
        if (target && target.kind === reference.expectedKind) nodes.push({ kind: "component", id: target.id, component: target });
      }
    }
  }

  const assetIds = new Set([...visited].filter((key) => key.startsWith("contract:")).map((key) => key.slice("contract:".length)));
  const modelIds = new Set([...visited].filter((key) => key.startsWith("model:")).map((key) => key.slice("model:".length)));
  const componentIds = new Set([...visited].filter((key) => key.startsWith("component:")).map((key) => key.slice("component:".length)));
  return {
    assets: input.assets.filter((asset) => assetIds.has(asset.contract.id)).map(copy),
    models: input.models.filter((model) => modelIds.has(model.id)).map(copy),
    components: input.components.filter((component) => componentIds.has(component.id)).map(copy),
  };
}

function pushDuplicate(seen: Set<string>, diagnostics: AssetDiagnostic[], id: string, path: string): void {
  if (seen.has(id)) diagnostics.push({ code: "ASSET_ID_DUPLICATE", ownerId: id, path, targetId: id });
  else seen.add(id);
}

function increment(counts: Map<string, number>, id: string): void {
  counts.set(id, (counts.get(id) ?? 0) + 1);
}

function addKinds(
  map: Map<string, Array<{ kind: "contract" | "model" | "component"; componentKind?: ComponentAsset["kind"] }>>,
  id: string,
  target: { kind: "contract" | "model" | "component"; componentKind?: ComponentAsset["kind"] },
): void {
  const current = map.get(id) ?? [];
  current.push(target);
  map.set(id, current);
}

function isArrayIndex(key: string, length: number): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}
