// @vitest-environment node
// 注：需要 window（api/index.ts 模块求值读 window.apicc）。
// 回归背景：memory.ts 依赖 node:fs 等内置模块，若在 api/index.ts 里被静态 import，
// vite 会把它 externalize 成「访问即抛」的浏览器 stub，模块求值即炸掉 Electron 生产包
// （任务 8 冒烟实测）。正确形态是「动态 import + 异步转发 Proxy」；本文件钉住该链路：
// 无 preload 的环境走 memory 回退，任一方法经 Proxy 异步转发到动态 import 的实现且可 resolve。
// 局限说明：vitest 在 node 运行时下，静态 import 同样能解析（node:fs 可用），
// 因此「静态引用是否混入入口产物」由 bundle-isolation.test.ts 在构建产物层把守，
// 本文件只负责回退单例的转发语义。
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApiccApi } from "../../../src/shared/types.js";

let api: ApiccApi | null = null;

beforeAll(async () => {
  // api/index reads window.apicc while its module is evaluated. Install only that
  // boundary before the real import; the memory implementation remains dynamic.
  vi.stubGlobal("window", {});
  api = (await import("../../../src/renderer/src/api/index.js")).apicc;
});

afterAll(() => vi.unstubAllGlobals());

function getApi(): ApiccApi {
  if (!api) throw new Error("api/index was not initialized");
  return api;
}

// seedWorkspace 是 memory 替身的测试扩展（不在 ApiccApi 契约上），经 Proxy 转发同样可用；
// Proxy 的方法调用恒返回 Promise，与契约方法签名天然吻合。
type SeededApi = ApiccApi & { seedWorkspace(): Promise<void> };
const seed = () => (getApi() as SeededApi).seedWorkspace();

describe("api/index 生产包隔离单例（memory 回退）", () => {
  it("无 window.apicc 时回退内存替身：方法经动态 import + Proxy 转发可 resolve", async () => {
    expect(window.apicc).toBeUndefined(); // 前置：jsdom 无 preload，走回退分支
    await seed();
    const apicc = getApi();
    const tree = await apicc.treeGet();
    expect(tree.kind).toBe("root");
    expect(tree.children?.length).toBeGreaterThan(0);
  });

  it("Proxy 转发入参与返回值：nodeCreate 创建的结果在 treeGet 中可见", async () => {
    await seed();
    const apicc = getApi();
    const before = await apicc.treeGet();
    if (before.source !== "local" || before.kind !== "root") throw new Error("Expected local tree root");
    const node = await apicc.nodeCreate({ kind: "group", parent: before.locator, name: "回退分组" });
    expect(node).toMatchObject({ kind: "group", source: "local", id: expect.any(String), key: expect.any(String), locator: { workspaceId: before.locator.workspaceId } });
    const refreshed = await apicc.treeGet();
    expect(refreshed.children?.some((group) => group.kind === "group" && group.locator.groupId === node.locator.groupId)).toBe(true);
  });

  it("production 环境没有 preload 时拒绝，不加载内存替身", async () => {
    vi.resetModules();
    vi.stubEnv("DEV", false);
    const productionApi = (await import("../../../src/renderer/src/api/index.js")).apicc;

    await expect(productionApi.treeGet()).rejects.toThrow("The Electron preload API is unavailable");

    vi.unstubAllEnvs();
  });
  it("returns an immediate disposer for the lazy stress progress subscription", () => {
    const unsubscribe = getApi().onStressProgress(() => { throw new Error("disposed listener"); });
    expect(typeof unsubscribe).toBe("function"); unsubscribe();
  });
});
