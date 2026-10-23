import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { validatePluginConfig } from "@apicc/plugin-sdk";
import type { PluginDefinitionV1 } from "@apicc/plugin-sdk";
import { createPluginCatalog, PluginCatalogError } from "../plugin/catalog.js";
import { installSdkContributions } from "../plugin/sdkAdapter.js";
import type { LoadProblem } from "../plugin/types.js";
import type { PluginRegistry } from "../plugin/registry.js";
import { PluginLoadError } from "./compatibility.js";
import { canonicalJson, normalizeManifest, readJson, readStaticPlugin } from "./manifest.js";
import type { PluginLoadResult, PluginLoaderOptions, PluginLoadState, PluginRuntimeEntryV1, UserPluginBindings, UserPluginEntry } from "./types.js";

const dynamicImport = (specifier: string): Promise<unknown> => import(specifier);
export const emptyBindings = (): UserPluginBindings => ({ protocols: {}, auths: {} });
export function normalizeBindings(input: unknown): UserPluginBindings {
  if (input === undefined) return emptyBindings();
  const fail = (): never => { throw new PluginLoadError("binding_invalid", "bindings 须使用 protocols/auths 及现有协议/认证种类和完整贡献 ID", "bindings"); };
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail();
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some(k => k !== "protocols" && k !== "auths")) return fail();
  const result = emptyBindings();
  for (const [field, allowed, kind] of [["protocols", ["http", "websocket", "soap"], "protocol"], ["auths", ["bearer", "basic", "apikey"], "auth"]] as const) {
    const value = record[field]; if (value === undefined) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
    for (const [key, id] of Object.entries(value)) {
      if (!(allowed as readonly string[]).includes(key) || typeof id !== "string" || !new RegExp(`^[a-z][a-z0-9-]*(?:\\.[a-z][a-z0-9-]*)+/${kind}\\.[a-z0-9.-]+$`).test(id)) return fail();
      Object.defineProperty(result[field], key, { value: id, enumerable: true });
    }
  }
  return result;
}
const problemFrom = (file: string, error: unknown, stage: string, pluginId?: string): LoadProblem => ({
  file, pluginId, code: error instanceof PluginLoadError || error instanceof PluginCatalogError ? error.code : "setup_failed",
  stage: error instanceof PluginLoadError ? error.stage : stage,
  message: error instanceof Error ? error.message : String(error),
  ...(error instanceof PluginLoadError ? { actual: error.actual, required: error.required } : {}),
  action: "检查用户插件清单、插件版本和配置后重启宿主",
});
export function readUserPluginDocument(options: PluginLoaderOptions): { document: unknown; file: string } {
  const file = join(options.homeDir ?? homedir(), ".apicc", "plugins.json");
  if (options.enabled === false || !existsSync(file)) return { document: { plugins: [] }, file };
  return { document: readJson(file), file };
}

/** Internal worker replay uses this same admission/transaction path with fixed sources. */
export async function loadPluginDocument(registry: PluginRegistry, document: unknown, file: string,
  options: PluginLoaderOptions, state: PluginLoadState, expected?: readonly PluginRuntimeEntryV1[]): Promise<PluginLoadResult> {
  const result: PluginLoadResult = { loaded: [], problems: [], bindings: emptyBindings() };
  if (options.enabled === false) { installSdkContributions(registry, state.catalog, {}); return result; }
  const doc = document as { plugins?: unknown; bindings?: unknown } | null;
  let bindingsValid = true;
  try { result.bindings = normalizeBindings(doc?.bindings); }
  catch (error) {
    result.problems.push(problemFrom(file, error, "bindings"));
    // An explicit invalid binding must never silently send through builtin auth/transport.
    const reject = (): never => { throw new PluginLoadError("binding_invalid", "用户插件 bindings 结构无效", "bindings"); };
    registry.installSdkResolver({ getAssert: () => undefined, listAsserts: () => [], getReporter: () => undefined,
      listImporters: () => [], getAuth: reject, getProtocol: reject });
    bindingsValid = false;
  }
  if (bindingsValid) installSdkContributions(registry, state.catalog, { protocol: result.bindings.protocols, auth: result.bindings.auths });
  if (!doc || !Array.isArray(doc.plugins)) {
    result.problems.push(problemFrom(file, new PluginLoadError("manifest_invalid", "插件清单的 plugins 字段须为数组"), "manifest"));
    return result;
  }
  if (!bindingsValid) return result;
  for (const input of doc.plugins) {
    let source = file; let pluginId: string | undefined; let stage = "manifest";
    let transaction: ReturnType<PluginLoadState["catalog"]["begin"]> | undefined;
    try {
      let entry: UserPluginEntry;
      if (typeof input === "string") entry = { source: input };
      else if (input && typeof input === "object" && !Array.isArray(input)) entry = input as UserPluginEntry;
      else throw new PluginLoadError("manifest_invalid", `清单条目须为字符串或 source 对象，收到 ${typeof input}`);
      if (typeof entry.source !== "string" || !entry.source.trim() || (entry.enabled !== undefined && typeof entry.enabled !== "boolean")) throw new PluginLoadError("manifest_invalid", "插件条目 source 须为非空字符串，enabled 须为布尔值");
      source = entry.source;
      if (entry.enabled === false) { (result.disabled ??= []).push({ source }); continue; }
      const staticPlugin = readStaticPlugin(source, dirname(file), options.hostVersion ?? "未提供产品版本");
      const { manifest } = staticPlugin; pluginId = manifest.id;
      const configured = validatePluginConfig(manifest, entry.config === undefined ? {} : entry.config);
      if (!configured.ok) throw new PluginLoadError("invalid_config", configured.problems.map(p => `${p.path}: ${p.reason}`).join("; "), "config");
      if (state.catalog.hasPlugin(manifest.id) || manifest.contributions.some(c => state.catalog.hasContribution(c.id))) throw new PluginLoadError("contribution_conflict", `插件 ${manifest.id} 或贡献 ID 已提交`, "conflict");
      const runtimeEntry: PluginRuntimeEntryV1 = { source: staticPlugin.source, pluginId, version: manifest.version, apiVersion: 1,
        manifestDigest: staticPlugin.manifestDigest, entryDigest: staticPlugin.entryDigest, config: configured.config! };
      if (expected && canonicalJson(runtimeEntry) !== canonicalJson(expected[state.entries.length])) throw new PluginLoadError("plugin_runtime_mismatch", "插件静态清单、入口或配置与父进程快照不一致", "identity");
      stage = "import";
      const mod = await (options.importFn ?? dynamicImport)(pathToFileURL(staticPlugin.entry).href) as { plugin?: unknown; default?: unknown } | null;
      const definition = mod?.plugin ?? mod?.default;
      if (!definition || typeof definition !== "object" || typeof (definition as PluginDefinitionV1).setup !== "function") throw new PluginLoadError("definition_mismatch", "插件形状不符：须导出 plugin/default，包含 manifest 和同步 setup 函数", "definition");
      const def = definition as PluginDefinitionV1;
      let moduleManifest;
      try { moduleManifest = normalizeManifest(def.manifest, options.hostVersion ?? ""); }
      catch { throw new PluginLoadError("definition_mismatch", "模块 manifest 无效或与静态清单不一致", "definition"); }
      if (canonicalJson(moduleManifest) !== canonicalJson(manifest)) throw new PluginLoadError("definition_mismatch", "模块 manifest 与静态清单不一致", "definition");
      transaction = state.catalog.begin(manifest, configured.config);
      stage = "setup";
      const returned: unknown = def.setup(transaction.context);
      if (returned !== null && (typeof returned === "object" || typeof returned === "function") && typeof (returned as { then?: unknown }).then === "function") {
        // Observe an async rejection while still rejecting the unsupported async setup contract.
        void Promise.resolve(returned).catch(() => {});
        throw new PluginLoadError("setup_failed", "setup 必须同步，不能返回 Promise/thenable", "setup");
      }
      transaction.commit();
      const committed = state.catalog.summary().find(p => p.id === pluginId)!;
      const counts = { protocols: 0, auths: 0, asserts: 0, scriptEngines: 0, reporters: 0, importers: 0, storage: 0 };
      const fields = { protocol: "protocols", auth: "auths", assert: "asserts", reporter: "reporters", importer: "importers" } as const;
      for (const c of committed.contributions) counts[fields[c.kind]]++;
      result.loaded.push({ source, pluginId, name: committed.name, version: committed.version, apiVersion: committed.apiVersion,
        engines: { ...manifest.engines }, contributions: counts, contributionIds: committed.contributions.map(c => c.id) });
      state.entries.push(runtimeEntry);
    } catch (error) {
      transaction?.abort();
      result.problems.push(problemFrom(source, error, stage, pluginId));
    }
  }
  return result;
}

/** User registered local plugins only; static rejection always precedes import. */
export async function loadUserPlugins(registry: PluginRegistry, options: PluginLoaderOptions = {}): Promise<PluginLoadResult> {
  const state: PluginLoadState = { catalog: createPluginCatalog(), entries: [] };
  let input;
  try { input = readUserPluginDocument(options); }
  catch (error) { return { loaded: [], problems: [problemFrom(join(options.homeDir ?? homedir(), ".apicc", "plugins.json"), error, "manifest")], bindings: emptyBindings() }; }
  return loadPluginDocument(registry, input.document, input.file, options, state);
}
