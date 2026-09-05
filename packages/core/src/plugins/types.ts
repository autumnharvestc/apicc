import type { LoadProblem } from "../plugin/types.js";

/**
 * 用户级插件清单形状（规格 M7 D1）：~/.apicc/plugins.json。
 * 仅用户级——不支持工作区级清单（工作区文件会进 Git，克隆即执行任意代码是供应链陷阱）。
 */
export interface PluginManifest {
  plugins: string[];
}

/**
 * 单插件贡献摘要（规格 D5 分类口径）：该插件 setup 执行期间经注册面注册的各类贡献计数。
 * 经注册面包装代理统计（先计数再原样委托同一 registry，注册语义不变）。
 */
export interface PluginContributionSummary {
  protocols: number;
  auths: number;
  asserts: number;
  scriptEngines: number;
  reporters: number;
  importers: number;
  storage: number;
}

/** 已成功加载并注册的插件条目（CLI `plugins list` 与桌面插件视图的展示口径）。 */
export interface PluginLoadEntry {
  name: string;
  version: string;
  /** 清单登记的原始条目（npm 包名或本地路径），诊断时可回溯到用户写法。 */
  source: string;
  contributions: PluginContributionSummary;
}

/** loadUserPlugins 结果：成功条目与失败问题（失败已隔离，不抛出）。 */
export interface PluginLoadResult {
  loaded: PluginLoadEntry[];
  problems: LoadProblem[];
}

export interface PluginLoaderOptions {
  /**
   * 用户级目录（清单位于 <homeDir>/.apicc/plugins.json）；缺省 os.homedir()。
   * 测试注入临时目录，免真写 HOME。
   */
  homeDir?: string;
  /**
   * 动态 import 注入（规格 D4：纯函数化便于测试）；缺省经 new Function 规避转译改写，
   * 走真实 ESM 动态 import（裁定②）。
   */
  importFn?: (specifier: string) => Promise<unknown>;
}
