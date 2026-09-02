// @vitest-environment jsdom
// 注：需要 window（api/index.ts 模块求值读 window.apicc）。
// 回归背景：memory.ts 依赖 node:fs 等内置模块，若在 api/index.ts 里被静态 import，
// vite 会把它 externalize 成「访问即抛」的浏览器 stub，模块求值即炸掉 Electron 生产包
// （任务 8 冒烟实测）。正确形态是「动态 import + 异步转发 Proxy」；本文件钉住该链路：
// 无 preload 的环境走 memory 回退，任一方法经 Proxy 异步转发到动态 import 的实现且可 resolve。
// 局限说明：vitest 在 node 运行时下，静态 import 同样能解析（node:fs 可用），
// 因此「静态引用是否混入入口产物」由 bundle-isolation.test.ts 在构建产物层把守，
// 本文件只负责回退单例的转发语义。
import { describe, expect, it } from "vitest";
import { apicc } from "../../../src/renderer/src/api/index.js";
import type { ApiccApi } from "../../../src/shared/types.js";

// seedWorkspace 是 memory 替身的测试扩展（不在 ApiccApi 契约上），经 Proxy 转发同样可用；
// Proxy 的方法调用恒返回 Promise，与契约方法签名天然吻合。
type SeededApi = ApiccApi & { seedWorkspace(): Promise<void> };
const seed = () => (apicc as SeededApi).seedWorkspace();

describe("api/index 生产包隔离单例（memory 回退）", () => {
  it("无 window.apicc 时回退内存替身：方法经动态 import + Proxy 转发可 resolve", async () => {
    expect(window.apicc).toBeUndefined(); // 前置：jsdom 无 preload，走回退分支
    await seed();
    const tree = await apicc.treeGet();
    expect(tree.kind).toBe("root");
    expect(tree.children?.length).toBeGreaterThan(0);
  });

  it("Proxy 转发入参与返回值：nodeCreate 创建的结果在 treeGet 中可见", async () => {
    await seed();
    const node = await apicc.nodeCreate({ kind: "group", parentId: null, name: "回退分组" });
    expect(node.id).toBeTruthy();
    const tree = await apicc.treeGet();
    expect(tree.children?.some((g) => g.id === node.id)).toBe(true);
  });
});
