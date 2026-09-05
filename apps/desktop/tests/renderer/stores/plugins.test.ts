// @vitest-environment jsdom
// 注：pinia/vue 响应式需要 DOM 环境，渲染层 store 测试用文件级 pragma 指定 jsdom。
//
// M7-B 任务 1：plugins store 工厂——init/refresh 拉 plugins:list 入状态（entries +
// importers 枚举）；失败 → error 上屏、既有状态保留、不向调用方抛（与 ai/online store
// 同口径）。依赖注入（api），每次工厂调用绑定独立 Pinia 实例（组合根约定）。
import { describe, expect, it } from "vitest";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { createPluginsStore } from "../../../src/renderer/src/stores/plugins.js";

describe("plugins store（M7-B 任务 1）", () => {
  it("init：拉取清单入状态（entries 混合 loaded/failed + importers 枚举），error 为空", async () => {
    const api = createMemoryApi();
    const plugins = createPluginsStore({ api });
    await plugins.init();
    expect(plugins.loading).toBe(false);
    expect(plugins.entries.length).toBeGreaterThanOrEqual(2);
    expect(plugins.entries.some((e) => e.kind === "loaded")).toBe(true);
    expect(plugins.entries.some((e) => e.kind === "failed")).toBe(true);
    expect(plugins.importers).toContain("openapi");
    expect(plugins.error).toBeNull();
  });

  it("init 拒绝：error 上屏、entries/importers 保持空、不向调用方抛", async () => {
    const api = createMemoryApi();
    api.pluginsList = async () => {
      throw new Error("清单不可用");
    };
    const plugins = createPluginsStore({ api });
    await expect(plugins.init()).resolves.toBeUndefined();
    expect(plugins.error).toBe("清单不可用");
    expect(plugins.entries).toEqual([]);
    expect(plugins.importers).toEqual([]);
  });

  it("refresh 拒绝：error 上屏、既有清单保留（诊断刷新不破坏已显示数据）", async () => {
    const api = createMemoryApi();
    const plugins = createPluginsStore({ api });
    await plugins.init();
    const before = [...plugins.entries];
    api.pluginsList = async () => {
      throw new Error("清单不可用");
    };
    await plugins.refresh();
    expect(plugins.error).toBe("清单不可用");
    expect(plugins.entries).toEqual(before);
  });

  it("refresh 成功：以最新清单覆盖状态（诊断刷新链路）", async () => {
    const api = createMemoryApi();
    const plugins = createPluginsStore({ api });
    await plugins.init();
    api.pluginsList = async () => ({ plugins: [], importers: [] });
    await plugins.refresh();
    expect(plugins.entries).toEqual([]);
    expect(plugins.importers).toEqual([]);
    expect(plugins.error).toBeNull();
  });
});
