// M7-B 任务 1：内存替身 pluginsList 与主进程 fixture 桩同构（IPC 四件套契约一致：
// channels/ipc/preload/memory 同一出口形状）。混合 loaded/failed 清单 + importers 枚举
//（内置 + 插件贡献）。
import { describe, expect, it } from "vitest";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import type { PluginsListResult } from "../../../src/shared/plugins/contract.js";

describe("内存替身 pluginsList（与主进程 fixture 同构）", () => {
  it("返回混合 loaded/failed 清单与 importers 枚举，形状与 IPC 契约一致", async () => {
    const api = createMemoryApi();
    const result = (await api.pluginsList()) as PluginsListResult;
    const kinds = new Set(result.plugins.map((p) => p.kind));
    expect(kinds).toContain("loaded");
    expect(kinds).toContain("failed");
    // 内置 registry 导入器在枚举中
    expect(result.importers).toContain("collection-v21");
    expect(result.importers).toContain("openapi");
    // 插件贡献导入器（fixture 各一）同步在枚举中
    const pluginImporters = result.plugins
      .filter((p) => p.kind === "loaded")
      .flatMap((p) => p.contributions?.importers ?? []);
    expect(pluginImporters.length).toBeGreaterThanOrEqual(1);
    for (const name of pluginImporters) expect(result.importers).toContain(name);
  });

  it("出口为快照拷贝：改动返回值不污染后续调用（与主进程 structuredClone 同口径）", async () => {
    const api = createMemoryApi();
    const first = (await api.pluginsList()) as PluginsListResult;
    first.plugins.push({ kind: "failed", name: "apicc-plugin-mutated", error: "x" });
    const second = (await api.pluginsList()) as PluginsListResult;
    expect(second.plugins.some((p) => p.name === "apicc-plugin-mutated")).toBe(false);
  });
});
