import { createDefaultRegistry } from "@apicc/core";
import type { PluginsListResult } from "../../shared/plugins/contract.js";

/**
 * 渲染层内存替身专用的 plugins:list 样例（M7-B 任务 2 起 **main 侧已切 core loadUserPlugins
 * 真实现**（main/plugins/runtime.ts），本样例仅被 renderer/src/api/memory.ts 消费——替身
 * 钉渲染面契约（混合 loaded/failed 清单 + 导入器枚举），渲染层组件/装配测试据此开发）。
 * 与真实实现的出口形状一致（shared/plugins/contract.ts）；随渲染层测试策略调整可整体移除。
 *
 * 形状即契约：
 * - loaded 样例：内置 + 插件贡献「各一」的最小浮现面——一个示例插件贡献一个报告器
 *   （example-md）与一个导入器（example-csv），导入向导/插件视图据此展示扩展浮现；
 * - failed 样例：坏插件（D3 失败隔离诊断可见），仅 name + error。
 * 内置导入器名取自 core 默认注册中心（非硬编码字符串），与真实现语义连续。
 */
export function createPluginsListFixture(): PluginsListResult {
  return {
    plugins: [
      {
        kind: "loaded",
        name: "apicc-plugin-example",
        version: "1.0.0",
        contributions: {
          protocols: [],
          auths: [],
          asserts: [],
          scripts: [],
          reporters: ["example-md"],
          importers: ["example-csv"],
        },
      },
      {
        kind: "failed",
        name: "apicc-plugin-broken",
        error: "入口模块语法错误: Unexpected token (1:0)",
      },
    ],
    importers: [
      ...createDefaultRegistry().listImporters().map((i) => i.name),
      "example-csv",
    ],
  };
}
