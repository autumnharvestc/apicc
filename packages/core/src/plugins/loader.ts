import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type {
  LoadProblem, PluginContext, PluginDefinition, PluginRegistryApi,
} from "../plugin/types.js";
import type { PluginRegistry } from "../plugin/registry.js";
import type {
  PluginContributionSummary, PluginLoaderOptions, PluginLoadResult,
} from "./types.js";

/**
 * 默认动态 import（裁定②口径修正，报告注明）：源码写原生 import()。TS 以 NodeNext/ESNext
 * 编译时不会降级转译，产物即真实 Node ESM 动态加载；vitest 下被改写为模块运行器的
 * 动态导入，对 file:// 夹具仍走真实 ESM 加载。（new Function('return import(s)') 口径在
 * vitest 的 VM realm 中抛「A dynamic import callback was not specified」，故弃用。）
 */
const dynamicImport = (specifier: string): Promise<unknown> => import(specifier);

/** 插件形状校验（规格 D2）：name/version 字符串、setup 函数——zod 逐项判定。 */
const PluginDefinitionSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  setup: z.function(),
});

const emptyContributions = (): PluginContributionSummary => ({
  protocols: 0, auths: 0, asserts: 0, scriptEngines: 0, reporters: 0, importers: 0, storage: 0,
});

/** 注册面计数代理：先计数再原样委托同一 registry——setup 收到的注册语义不变（规格 D2）。 */
function countingRegistryApi(api: PluginRegistryApi, counts: PluginContributionSummary): PluginRegistryApi {
  return {
    registerProtocol: (client) => { counts.protocols += 1; api.registerProtocol(client); },
    registerAuth: (provider) => { counts.auths += 1; api.registerAuth(provider); },
    registerAssert: (operator) => { counts.asserts += 1; api.registerAssert(operator); },
    registerScriptEngine: (engine) => { counts.scriptEngines += 1; api.registerScriptEngine(engine); },
    registerReporter: (reporter) => { counts.reporters += 1; api.registerReporter(reporter); },
    registerImporter: (importer) => { counts.importers += 1; api.registerImporter(importer); },
    registerStorage: (adapter) => { counts.storage += 1; api.registerStorage(adapter); },
  };
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * 清单条目 → import specifier：
 * - 本地路径（绝对路径或 ./ ../ 开头的相对路径）→ 相对清单文件所在目录解析（规格 D1），
 *   目录条目按 package.json main（缺省 index.js）定位入口文件，经 pathToFileURL 保证 Windows 可用；
 * - 其余视为 npm 包名，按裸导入原样传给 import（解析交给 Node，加载器零网络行为）。
 */
function toImportSpecifier(source: string, manifestDir: string): string {
  const isLocal = isAbsolute(source) || source.startsWith("./") || source.startsWith("../");
  if (!isLocal) return source;
  const absolute = isAbsolute(source) ? resolve(source) : resolve(manifestDir, source);
  return pathToFileURL(resolveLocalEntry(absolute)).href;
}

/** 本地目录条目 → 入口文件（package.json main，缺省 index.js）；文件条目原样返回。 */
function resolveLocalEntry(absolute: string): string {
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) return absolute;
  let main = "index.js";
  const pkgFile = join(absolute, "package.json");
  if (existsSync(pkgFile)) {
    try {
      const parsed = JSON.parse(readFileSync(pkgFile, "utf8")) as { main?: unknown };
      if (typeof parsed.main === "string" && parsed.main) main = parsed.main;
    } catch {
      // package.json 不可读时回落 index.js，失败交由后续 import 抛错进 problems（隔离口径）。
    }
  }
  return join(absolute, main);
}

/** 单条目加载与形状校验（规格 D2）：动态 import → 取 plugin 具名导出或 default → zod 校验。 */
async function importPluginDefinition(
  source: string,
  manifestDir: string,
  importFn: (specifier: string) => Promise<unknown>,
): Promise<PluginDefinition> {
  let mod: { plugin?: unknown; default?: unknown };
  try {
    mod = await importFn(toImportSpecifier(source, manifestDir)) as { plugin?: unknown; default?: unknown };
  } catch (e) {
    throw new Error(`动态 import 失败: ${message(e)}`);
  }
  const candidate = mod.plugin ?? mod.default;
  if (candidate === undefined) throw new Error("插件未导出 plugin 或 default");
  const parsed = PluginDefinitionSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(`插件形状不符（须含 name/version 字符串与 setup 函数）: ${message(parsed.error)}`);
  }
  return parsed.data as PluginDefinition;
}

/**
 * 外部插件加载器（规格 M7-A 任务 1 / D1–D4）：
 * 读取用户级清单 <homeDir>/.apicc/plugins.json（仅用户级，无工作区级——D1 供应链边界），
 * 逐条动态 import 并经形状校验后注册（复用 PluginDefinition 契约，D2）。
 * 失败隔离（D3）：单条目的清单读取/解析/import/形状/setup 抛错一律收集为 LoadProblem，
 * 继续处理其余条目，启动不阻断。清单不存在 → 空结果零加载（不报错）。
 */
export async function loadUserPlugins(
  registry: PluginRegistry,
  options: PluginLoaderOptions = {},
): Promise<PluginLoadResult> {
  const importFn = options.importFn ?? dynamicImport;
  const manifestFile = join(options.homeDir ?? homedir(), ".apicc", "plugins.json");
  const loaded: PluginLoadResult["loaded"] = [];
  const problems: LoadProblem[] = [];
  if (!existsSync(manifestFile)) return { loaded, problems };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestFile, "utf8"));
  } catch (e) {
    return { loaded, problems: [{ file: manifestFile, message: `插件清单不是合法 JSON: ${message(e)}` }] };
  }
  const pluginsField = (parsed as { plugins?: unknown } | null)?.plugins;
  if (!Array.isArray(pluginsField)) {
    return { loaded, problems: [{ file: manifestFile, message: "插件清单的 plugins 字段须为字符串数组" }] };
  }
  const entries: string[] = [];
  for (const entry of pluginsField) {
    if (typeof entry !== "string") {
      problems.push({ file: manifestFile, message: `清单条目须为字符串，收到 ${typeof entry}` });
    } else {
      entries.push(entry);
    }
  }

  const manifestDir = dirname(manifestFile);
  for (const source of entries) {
    let def: PluginDefinition;
    try {
      def = await importPluginDefinition(source, manifestDir, importFn);
    } catch (e) {
      // LoadProblem.file 放插件标识（裁定③）：沿用清单登记的原始条目，诊断可直接回溯用户写法。
      problems.push({ file: source, message: message(e) });
      continue;
    }
    const contributions = emptyContributions();
    try {
      // 规格 D2 管线终点 registry.plugin(def)：setup 经包装先计数再委托同一注册面，
      // 注册语义不变，仅旁路统计该插件贡献（D5 分类口径）。
      registry.plugin({
        name: def.name,
        version: def.version,
        setup: (ctx: PluginContext) => def.setup({ registry: countingRegistryApi(ctx.registry, contributions) }),
      });
    } catch (e) {
      problems.push({ file: source, message: `插件 setup 执行失败: ${message(e)}` });
      continue;
    }
    loaded.push({ name: def.name, version: def.version, source, contributions });
  }
  return { loaded, problems };
}
