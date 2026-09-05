import { createDefaultRegistry } from "@apicc/core";
import type { PluginsListResult } from "../../shared/plugins/contract.js";

/**
 * plugins:list 的 fixture 桩数据（M7-B 任务 1，两阶段约束：main 基线 core 无加载器）。
 * 任务 2 同步 main 后此文件随真实现（core 加载器装载用户级清单）删除。
 *
 * 形状即契约（shared/plugins/contract.ts）：
 * - loaded 样例：内置 + 插件贡献「各一」的最小浮现面——一个示例插件贡献一个报告器
 *   （example-md）与一个导入器（example-csv），导入向导/插件视图据此展示扩展浮现；
 * - failed 样例：坏插件（D3 失败隔离诊断可见），仅 name + error。
 * 内置导入器名取自 core 默认注册中心（非硬编码字符串），任务 2 切真 registry 后语义连续。
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
