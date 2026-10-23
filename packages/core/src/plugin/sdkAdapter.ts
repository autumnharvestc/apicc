import { z } from "zod";
import type { AuthKindV1, CapabilityV1, PluginContributionV1, ProtocolKindV1, ReadonlyJsonValue, ResponseViewV1 } from "@apicc/plugin-sdk";
import type { PluginCatalog } from "./catalog.js";
import type { PluginRegistry, SdkRegistryResolver } from "./registry.js";
import type { AssertOperator, AuthProvider, Importer, ProtocolClient, Reporter, ExecutionResponse } from "./types.js";
import type { ProjectAssetContextReadView } from "../assets/context.js";
import { ProjectSchema } from "../domain/model.js";
import { createProjectSnapshot } from "../assets/snapshot.js";
import { ResponseSelectorFields } from "../testing/model.js";
import { authPatchSchema, contributionInvalid, freezeDto, jsonView, reportView, requestViews, responseView } from "./sdkViews.js";

export interface PluginBindings {
  protocol?: Partial<Record<ProtocolKindV1, string>>;
  auth?: Partial<Record<AuthKindV1, string>>;
}
export type SdkAdapter = { id: string; label?: string } & (
  | { kind: "assert"; value: AssertOperator }
  | { kind: "importer"; value: Importer }
  | { kind: "reporter"; value: Reporter }
  | { kind: "auth"; supports: readonly AuthKindV1[]; forKind(kind: AuthKindV1): AuthProvider }
  | { kind: "protocol"; supports: readonly ProtocolKindV1[]; value: ProtocolClient }
);
const assertionResultSchema = z.object({ pass: z.boolean(), message: z.string(), kind: z.enum(["config", "assertion"]).optional(),
  code: z.string().optional(), differencePath: z.string().optional(), schemaPath: z.string().optional() }).strict();
const importResultSchema = z.object({ formatVersion: z.literal(1), project: z.unknown(), diagnostics: z.array(z.object({
  code: z.string(), ownerId: z.string(), path: z.string(), reason: z.string(), targetId: z.string().optional(),
}).strict()), warnings: z.array(z.string()) }).strict();
const modelViews = new WeakMap<ProjectAssetContextReadView, Map<string, ReadonlyJsonValue | undefined>>();
function getModelView(assets: ProjectAssetContextReadView | undefined, id: string): ReadonlyJsonValue | undefined {
  if (!assets) return undefined;
  let models = modelViews.get(assets);
  if (!models) { models = new Map(); modelViews.set(assets, models); }
  if (!models.has(id)) { const model = assets.getModel(id); models.set(id, model === undefined ? undefined : jsonView(model)); }
  return models.get(id);
}

/** Capture callback references and all metadata before an atomic catalog publication. */
export function prepareSdkContribution(contribution: PluginContributionV1): SdkAdapter {
  const { id, kind, label } = contribution;
  const base = { id, ...(label === undefined ? {} : { label }) };
  switch (kind) {
    case "assert": {
      const evaluate = contribution.evaluate;
      const descriptor = contribution.descriptor === undefined ? undefined : structuredClone(contribution.descriptor);
      if (descriptor?.targets) descriptor.targets.forEach(target => ResponseSelectorFields.target.parse(target));
      const value: AssertOperator = { op: id, ...(descriptor ? { descriptor: descriptor as AssertOperator["descriptor"] } : {}), evaluate(actual, expected, context) {
        const result = evaluate(actual === undefined ? undefined : jsonView(actual), expected, freezeDto({ found: context?.found ?? actual !== undefined,
          ...(context?.options === undefined ? {} : { options: jsonView(context.options) as import("@apicc/plugin-sdk").ReadonlyJsonObject }),
          ...(context?.schema === undefined ? {} : { schema: jsonView(context.schema) }),
          getModel: (modelId: string) => getModelView(context?.assets, modelId) }));
        return assertionResultSchema.parse(result);
      } };
      return freezeDto({ ...base, kind, value });
    }
    case "importer": {
      const detect = contribution.detect; const parse = contribution.parse;
      return freezeDto({ ...base, kind, value: { name: id,
        detect(fileName: string, content: string) { return z.boolean().parse(detect(fileName, content)); },
        parse(content: string) {
          const result = importResultSchema.parse(parse(content));
          const project = ProjectSchema.parse(structuredClone(result.project));
          const diagnostics = createProjectSnapshot(project).context.diagnostics.map(d => ({ code: d.code, ownerId: d.ownerId, path: d.path,
            ...(d.targetId === undefined ? {} : { targetId: d.targetId }), reason: `项目资产诊断：${d.code}` }));
          return { project, diagnostics: [...result.diagnostics, ...diagnostics], warnings: [...result.warnings] };
        } } });
    }
    case "reporter": {
      const render = contribution.render;
      const value: Reporter = { format: id, async render(result, outDir, output) { return z.string().parse(await render(reportView(result, output), outDir)); } };
      return freezeDto({ ...base, kind, value });
    }
    case "auth": {
      const apply = contribution.apply; const supports = [...contribution.supports];
      return freezeDto({ ...base, kind, supports, forKind(type: AuthKindV1): AuthProvider {
        const value: AuthProvider = { type, apply(request, auth) {
          if (auth.kind !== type) throw new Error("SDK auth kind does not match the selected binding");
          const patch = authPatchSchema.parse(apply(requestViews(request).view, freezeDto(structuredClone(auth))));
          // Validate the entire patch before changing the caller's per-attempt request.
          const nextHeaders = { ...request.headers };
          for (const [name, value] of Object.entries(patch.headers ?? {})) {
            for (const existing of Object.keys(nextHeaders)) if (existing.toLowerCase() === name.toLowerCase()) delete nextHeaders[existing];
            Object.defineProperty(nextHeaders, name, { value, enumerable: true, configurable: true, writable: true });
          }
          const nextQuery = [...request.query, ...(patch.query ?? []).map(p => ({ ...p, enabled: true }))];
          request.headers = nextHeaders; request.query = nextQuery;
        } };
        return Object.freeze(value);
      } });
    }
    case "protocol": {
      const execute = contribution.execute; const supports = [...contribution.supports];
      const value: ProtocolClient = { sdkProtocol: true, name: id, canHandle: request => supports.includes(request.protocol), async execute(request, options) {
        const transport = options.runtime?.pluginTransport;
        if (!transport || transport === value) throw contributionInvalid("SDK protocol requires this execution's original managed transport");
        if (!transport.canHandle(request)) throw contributionInvalid("SDK managed transport cannot handle this request");
        const codec = requestViews(request, options);
        let count = 0; let closed = false; let violated = false;
        let pending: Promise<ResponseViewV1> | undefined;
        let actual: ExecutionResponse | undefined;
        const delegate = (input: import("@apicc/plugin-sdk").RequestViewV1): Promise<ResponseViewV1> => {
          const operation = (async () => {
            if (closed || count !== 0) { violated = true; throw contributionInvalid("SDK protocol must delegate exactly once during execute"); }
            count++;
            const restored = codec.restore(input);
            if (options.signal?.aborted) throw options.signal.reason ?? new Error("Execution aborted");
            // Keep runtime ownership and all original options in the host client.
            actual = await transport.execute(restored, options);
            return responseView(actual);
          })();
          // Observe the exact Promise returned to plugins immediately, including its
          // restore/response projection steps; the original Promise still rejects to awaiters.
          void operation.catch(() => undefined);
          pending ??= operation;
          return operation;
        };
        try {
          await execute(codec.view, { signal: options.signal, runId: options.runtime?.pluginRunId, vuId: options.runtime?.pluginVuId,
            transport: Object.freeze({ execute: delegate }) });
          closed = true;
          if (pending) await pending;
          if (count !== 1 || violated || !actual) throw contributionInvalid("SDK protocol must successfully delegate exactly once");
          // The plugin's return cannot forge execution facts or replace the host response.
          return actual;
        } finally {
          closed = true;
          // Observe an in-flight delegated rejection even if the plugin returned/threw early.
          if (pending) await pending.catch(() => undefined);
        }
      } };
      return freezeDto({ ...base, kind, supports, value });
    }
  }
}

function bindingError(kind: CapabilityV1, id: string): never {
  throw Object.assign(new Error(`无效的 ${kind} 插件绑定：${id}`), { code: "binding_invalid", caseFailureKind: "config" });
}
export function installSdkContributions(registry: PluginRegistry, catalog: PluginCatalog, input: PluginBindings): void {
  const bindings = freezeDto(structuredClone(input));
  const select = (kind: "protocol" | "auth", type: ProtocolKindV1 | AuthKindV1): SdkAdapter | undefined => {
    const id = (bindings[kind] as Record<string, string> | undefined)?.[type];
    if (id === undefined) return undefined;
    const adapter = catalog.adapter(id);
    if (!adapter || adapter.kind !== kind || !(adapter.supports as readonly string[]).includes(type)) bindingError(kind, id);
    return adapter;
  };
  const resolver: SdkRegistryResolver = {
    getAssert: id => { const a = catalog.adapter(id); return a?.kind === "assert" ? a.value : undefined; },
    listAsserts: () => catalog.adapters().flatMap(a => a.kind === "assert" ? [a.value] : []),
    getReporter: id => { const a = catalog.adapter(id); return a?.kind === "reporter" ? a.value : undefined; },
    listImporters: () => catalog.adapters().flatMap(a => a.kind === "importer" ? [a.value] : []),
    getAuth(type) { const a = select("auth", type); return a?.kind === "auth" ? a.forKind(type) : undefined; },
    getProtocol(request) { const a = select("protocol", request.protocol); return a?.kind === "protocol" ? a.value : undefined; },
  };
  registry.installSdkResolver(resolver);
}
