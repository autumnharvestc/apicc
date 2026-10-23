import { isAbsolute } from "node:path";
import { z } from "zod";
import { createDefaultRegistry } from "../shared.js";
import { createPluginCatalog } from "../plugin/catalog.js";
import { freezeDto } from "../plugin/sdkViews.js";
import { PluginLoadError, validProductVersion } from "./compatibility.js";
import { canonicalJson, digestValue } from "./manifest.js";
import { emptyBindings, loadPluginDocument, normalizeBindings, readUserPluginDocument } from "./loader.js";
import type { PluginLoaderOptions, PluginLoadResult, PluginLoadState, PluginRuntimeSnapshotV1, UserPluginHost } from "./types.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.string().refine(validProductVersion);
const pluginId = z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/).refine(id => id !== "apicc" && !id.startsWith("apicc."));
const config = z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()]));
const bindings = z.object({
  protocols: z.object({ http: z.string().optional(), websocket: z.string().optional(), soap: z.string().optional() }).strict(),
  auths: z.object({ bearer: z.string().optional(), basic: z.string().optional(), apikey: z.string().optional() }).strict(),
}).strict().refine(value => { try { normalizeBindings(value); return true; } catch { return false; } });
const snapshotSchema = z.object({
  pluginRuntimeVersion: z.literal(1), enabled: z.boolean(), hostVersion: version, digest,
  entries: z.array(z.object({ source: z.string().refine(s => isAbsolute(s) && s.endsWith(".json")), pluginId,
    version, apiVersion: z.literal(1), manifestDigest: digest, entryDigest: digest, config }).strict()),
  bindings,
}).strict();
function mismatch(message: string): never { throw new PluginLoadError("plugin_runtime_mismatch", message, "identity"); }
function identity(snapshot: PluginRuntimeSnapshotV1): unknown {
  const { digest: _digest, ...rest } = snapshot; return rest;
}
/** Strict internal v1 envelope: older/malformed prepare payloads never acquire defaults. */
function checkedSnapshot(input: unknown): PluginRuntimeSnapshotV1 {
  const parsed = snapshotSchema.safeParse(input);
  if (!parsed.success) return mismatch("插件运行快照缺少必需字段或形状无效");
  const snapshot = parsed.data as PluginRuntimeSnapshotV1;
  if (new Set(snapshot.entries.map(e => e.pluginId)).size !== snapshot.entries.length
      || new Set(snapshot.entries.map(e => e.source)).size !== snapshot.entries.length) return mismatch("插件运行快照包含重复身份");
  if (!snapshot.enabled && (snapshot.entries.length || canonicalJson(snapshot.bindings) !== canonicalJson(emptyBindings()))) return mismatch("关闭模式快照不能包含启用插件或绑定");
  if (snapshot.digest !== digestValue(identity(snapshot))) return mismatch("插件运行快照摘要不一致");
  return snapshot;
}
export function assertPluginRuntimeSnapshot(expected: unknown, actual: unknown): asserts actual is PluginRuntimeSnapshotV1 {
  const left = checkedSnapshot(expected); const right = checkedSnapshot(actual);
  if (canonicalJson(left) !== canonicalJson(right)) mismatch("父进程与当前宿主插件运行身份不一致");
}

function createHost(options: PluginLoaderOptions & { hostVersion: string }, expectedInput?: PluginRuntimeSnapshotV1): UserPluginHost {
  let loading: Promise<{ registry: ReturnType<typeof createDefaultRegistry>; summary: PluginLoadResult; snapshot: PluginRuntimeSnapshotV1 }> | undefined;
  const ensure = () => loading ??= (async () => {
    if (!validProductVersion(options.hostVersion)) mismatch("组合根须传入实际产品 SemVer 版本");
    const expected = expectedInput === undefined ? undefined : checkedSnapshot(expectedInput);
    if (expected && expected.hostVersion !== options.hostVersion) mismatch(`实际宿主版本 ${options.hostVersion} 与父进程 ${expected.hostVersion} 不一致`);
    const enabled = expected?.enabled ?? options.enabled !== false;
    const registry = options.registry ?? createDefaultRegistry();
    const state: PluginLoadState = { catalog: createPluginCatalog(), entries: [] };
    let summary: PluginLoadResult;
    if (expected) {
      summary = await loadPluginDocument(registry, { plugins: expected.entries.map(e => ({ source: e.source, config: e.config })), bindings: expected.bindings },
        "plugin-runtime-snapshot.json", { ...options, enabled }, state, expected.entries);
      if (summary.problems.length) mismatch(`无法重建父进程插件运行身份：${summary.problems.map(p => p.code).join(", ")}`);
    } else {
      try {
        const input = readUserPluginDocument({ ...options, enabled });
        summary = await loadPluginDocument(registry, input.document, input.file, { ...options, enabled }, state);
      } catch (error) {
        summary = { loaded: [], bindings: emptyBindings(), problems: [{ file: "plugins.json", code: "manifest_invalid", stage: "manifest", message: error instanceof Error ? error.message : String(error) }] };
      }
    }
    const body = { pluginRuntimeVersion: 1 as const, enabled, hostVersion: options.hostVersion,
      entries: state.entries, bindings: summary.bindings };
    const snapshot = freezeDto(structuredClone({ ...body, digest: digestValue(body) }));
    if (expected) assertPluginRuntimeSnapshot(expected, snapshot);
    return { registry, summary: freezeDto(summary), snapshot };
  })();
  return { registry: async () => (await ensure()).registry, summary: async () => (await ensure()).summary, snapshot: async () => {
    const state = await ensure();
    if (state.summary.problems.some(p => p.code === "binding_invalid" && p.stage === "bindings")) {
      throw new PluginLoadError("binding_invalid", "无效的 bindings 结构无法生成运行快照；请修正后重启宿主", "bindings");
    }
    return state.snapshot;
  } };
}
export function createUserPluginHost(options: PluginLoaderOptions & { hostVersion: string }): UserPluginHost {
  return createHost({ ...options });
}
/** Node-only companion for worker prepare. Never reads a worker's HOME/plugins.json. */
export function createUserPluginHostFromSnapshot(expected: PluginRuntimeSnapshotV1,
  options: { hostVersion: string; importFn?: PluginLoaderOptions["importFn"] }): UserPluginHost {
  return createHost({ ...options }, structuredClone(checkedSnapshot(expected)));
}
