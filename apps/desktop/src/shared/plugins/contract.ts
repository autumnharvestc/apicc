/**
 * 插件频道契约（M7-B 任务 1，规格 §2 D3/D5）。
 * 两阶段约束（计划全局）：main 基线 core 无加载器，`plugins:list` 以 fixture 桩先行；
 * 本文件只钉出口形状（IPC 结构化克隆传输，任务 2 切 core 加载器真实现时形状不变）。
 */

/**
 * 插件贡献分类清单（七个扩展点中可枚举的六类，规格 §2 D5「贡献清单分类计数与明细」）：
 * 各类为贡献名称数组，计数由消费方按数组长度派生（名称即单一事实源，不重复存计数）。
 */
export interface PluginContributions {
  protocols: string[];
  auths: string[];
  asserts: string[];
  scripts: string[];
  reporters: string[];
  importers: string[];
}

/**
 * plugins:list 行（kind 判别）：
 * - loaded：name + version + contributions（六类清单，可为空数组）；
 * - failed：name + error（加载/校验/setup 失败原因，D3 失败隔离的桌面可见面），不带贡献。
 */
export interface PluginLoadEntry {
  kind: "loaded" | "failed";
  name: string;
  version?: string;
  contributions?: PluginContributions;
  error?: string;
}

/**
 * plugins:list 出口：
 * - plugins：插件加载摘要清单（loaded/failed 混合；fixture 阶段=样例插件+坏插件）；
 * - importers：registry 导入器名枚举（内置 + 插件贡献）——导入向导选择面的动态枚举
 *   数据源（D5），随任务 2 真加载后自动纳入插件贡献。
 */
export interface PluginsListResult {
  plugins: PluginLoadEntry[];
  importers: string[];
}
