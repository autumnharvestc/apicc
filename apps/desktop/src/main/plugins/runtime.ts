import { loadUserPlugins, createDefaultRegistry, type PluginRegistry } from "@apicc/core";
import type { PluginContributions, PluginLoadEntry, PluginsListResult } from "../../shared/plugins/contract.js";

/**
 * 插件运行时注入面（M7-B 任务 2，规格 §2 D4/D8，与 CLI deps 对齐口径）：
 * - homeDir：用户级目录（清单 <homeDir>/.apicc/plugins.json）；缺省 os.homedir()（core 加载器默认）；
 * - loadPlugins：false = 编程关闭通道（CLI --no-plugins / deps.loadPlugins 同口径，供嵌入方与测试零扰动）。
 * createIpcDeps 未配置 plugins 时按 loadPlugins:false 处理（桌面测试默认零加载零扰动，
 * 不读真实 HOME——与 CLI「缺省启用」的差异在组合根：桌面由 main.ts 显式传入，报告注明）。
 */
export interface PluginsRuntimeOptions {
  homeDir?: string;
  loadPlugins?: boolean;
}

export interface PluginsRuntime {
  /** plugins:list 摘要（loaded/failed 混合清单 + registry 导入器枚举，T1 契约形状不变）。 */
  summary(): Promise<PluginsListResult>;
  /** 运行频道消费的 registry（内置 + 用户插件贡献；关闭通道时仅内置）。 */
  registry(): Promise<PluginRegistry>;
}

const emptyContributions = (): PluginContributions => ({
  protocols: [], auths: [], asserts: [], scripts: [], reporters: [], importers: [],
});

/**
 * 桌面插件运行时（M7-B 任务 2）：首次消费时经 core loadUserPlugins 装载用户级清单并
 * memoize（清单只读一次，插件 setup 只执行一次）；失败隔离由加载器保证（problems 收集，
 * 启动不阻断，D3）。
 *
 * 贡献名称收集（T1 契约沿用「各类名称清单」口径）：core PluginContributionSummary 只给
 * 计数，而渲染层出口钉的是名称数组——故在把 registry 交给加载器前，包装其 register*
 * 方法按插件分段收集贡献名称（loader 的计数包装委托到本包装，两层正交）；按
 * registry.plugin 调用边界切换收集桶，setup 抛错的插件桶随 failed 行丢弃。
 * 已知口径：同类别同名的重复注册（Map 覆盖语义）在名称清单中会重复出现，MVP 不去重。
 */
export function createPluginsRuntime(options: PluginsRuntimeOptions = {}): PluginsRuntime {
  let loaded: Promise<{ registry: PluginRegistry; entries: PluginLoadEntry[] }> | null = null;

  function load(): Promise<{ registry: PluginRegistry; entries: PluginLoadEntry[] }> {
    loaded ??= doLoad();
    return loaded;
  }

  async function doLoad(): Promise<{ registry: PluginRegistry; entries: PluginLoadEntry[] }> {
    const registry = createDefaultRegistry();
    if (options.loadPlugins === false) return { registry, entries: [] };

    // —— 贡献名称收集包装：register* 先记名再委托原实现 ——
    const originals = {
      registerProtocol: registry.registerProtocol.bind(registry),
      registerAuth: registry.registerAuth.bind(registry),
      registerAssert: registry.registerAssert.bind(registry),
      registerScriptEngine: registry.registerScriptEngine.bind(registry),
      registerReporter: registry.registerReporter.bind(registry),
      registerImporter: registry.registerImporter.bind(registry),
      plugin: registry.plugin.bind(registry),
    };
    let bucket: PluginContributions | null = null;
    registry.registerProtocol = (client) => { bucket?.protocols.push(client.name); originals.registerProtocol(client); };
    registry.registerAuth = (provider) => { bucket?.auths.push(provider.type); originals.registerAuth(provider); };
    registry.registerAssert = (operator) => { bucket?.asserts.push(operator.op); originals.registerAssert(operator); };
    registry.registerScriptEngine = (engine) => { bucket?.scripts.push(engine.language); originals.registerScriptEngine(engine); };
    registry.registerReporter = (reporter) => { bucket?.reporters.push(reporter.format); originals.registerReporter(reporter); };
    registry.registerImporter = (importer) => { bucket?.importers.push(importer.name); originals.registerImporter(importer); };
    /** 按插件分段：plugin(def) 调用边界即收集桶边界（加载器逐插件调用一次）。 */
    const byPlugin = new Map<string, PluginContributions>();
    registry.plugin = (def) => {
      bucket = emptyContributions();
      try {
        originals.plugin(def);
      } finally {
        byPlugin.set(def.name, bucket);
        bucket = null;
      }
    };

    const result = await loadUserPlugins(registry, { homeDir: options.homeDir });
    const entries: PluginLoadEntry[] = [
      ...result.loaded.map((entry): PluginLoadEntry => ({
        kind: "loaded",
        name: entry.name,
        version: entry.version,
        contributions: byPlugin.get(entry.name) ?? emptyContributions(),
      })),
      ...result.problems.map((problem): PluginLoadEntry => ({
        kind: "failed",
        name: problem.file,
        error: problem.message,
      })),
    ];
    return { registry, entries };
  }

  return {
    async summary(): Promise<PluginsListResult> {
      const { registry, entries } = await load();
      // 快照出口（与 T1 structuredClone 桩同口径）：返回值改动不污染 memoized 状态。
      return structuredClone({ plugins: entries, importers: registry.listImporters().map((i) => i.name) });
    },
    async registry(): Promise<PluginRegistry> {
      return (await load()).registry;
    },
  };
}
