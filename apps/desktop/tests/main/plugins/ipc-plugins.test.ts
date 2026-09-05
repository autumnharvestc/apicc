// M7-B 任务 1（规格 §2 D3/D5）：plugins:list 频道 fixture 桩——混合 loaded/failed 清单
// + registry 导入器枚举（选择面动态枚举数据源）。契约形状钉在 shared/plugins/contract.ts
//（两阶段约束：main 基线 core 无加载器，fixture 自建；任务 2 同步 main 后切真加载器，
// 出口形状不变）。
import { describe, expect, it } from "vitest";
import { createIpcDeps } from "../../../src/main/ipc.js";
import { createSession } from "../../../src/main/session.js";
import type { PluginsListResult } from "../../../src/shared/plugins/contract.js";

function setup() {
  return createIpcDeps({
    session: createSession(),
    pickDirectory: async () => "",
    saveFile: async () => "",
  });
}

describe("IPC plugins:list（fixture 桩，M7-B 任务 1）", () => {
  it("返回 loaded/failed 混合清单：loaded 带 version 与六类贡献名称，failed 带原因且无贡献", async () => {
    const result = (await setup().handle("plugins:list", {})) as PluginsListResult;
    // 混合清单：两类都在（D3 失败隔离的桌面可见面）
    const loaded = result.plugins.filter((p) => p.kind === "loaded");
    const failed = result.plugins.filter((p) => p.kind === "failed");
    expect(loaded.length).toBeGreaterThanOrEqual(1);
    expect(failed.length).toBeGreaterThanOrEqual(1);
    // loaded 契约：name + version + 六类贡献名称清单（计数由视图按长度派生）
    const sample = loaded[0]!;
    expect(sample.name).toMatch(/^apicc-plugin-/);
    expect(sample.version).toBeTruthy();
    expect(sample.contributions).toBeDefined();
    for (const key of ["protocols", "auths", "asserts", "scripts", "reporters", "importers"] as const) {
      expect(Array.isArray(sample.contributions![key]), `缺少贡献分类: ${key}`).toBe(true);
    }
    // fixture 至少贡献一个报告器与一个导入器（UI 扩展浮现可见，D5）
    expect(sample.contributions!.reporters.length).toBeGreaterThanOrEqual(1);
    expect(sample.contributions!.importers.length).toBeGreaterThanOrEqual(1);
    // failed 契约：name + error（原因），不带贡献
    const broken = failed[0]!;
    expect(broken.name).toBeTruthy();
    expect(broken.error).toBeTruthy();
    expect(broken.contributions).toBeUndefined();
  });

  it("importers 枚举 = 内置 registry 导入器 + 插件贡献导入器（导入向导选择面数据源）", async () => {
    const result = (await setup().handle("plugins:list", {})) as PluginsListResult;
    // 内置：core 默认注册中心的导入器名
    expect(result.importers).toContain("collection-v21");
    expect(result.importers).toContain("openapi");
    // 插件贡献：loaded 插件的 importers 全部出现在枚举中（内置 + 插件贡献各一的最小要求）
    const pluginImporters = result.plugins
      .filter((p) => p.kind === "loaded")
      .flatMap((p) => p.contributions?.importers ?? []);
    expect(pluginImporters.length).toBeGreaterThanOrEqual(1);
    for (const name of pluginImporters) expect(result.importers).toContain(name);
  });

  it("重复调用返回等价快照（桩语义稳定；任务 2 切真实现时出口形状不变）", async () => {
    const deps = setup();
    const first = await deps.handle("plugins:list", {});
    const second = await deps.handle("plugins:list", {});
    expect(second).toEqual(first);
  });
});
