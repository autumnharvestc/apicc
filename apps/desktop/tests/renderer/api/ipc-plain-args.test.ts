// @vitest-environment jsdom
// 注：需要 window（api/index.ts 模块求值读 window.apicc）。
// 回归背景（2026-09-06 用户导入实测）：Pinia/Vue 状态是 Proxy，跨 Electron contextBridge
// 结构化克隆即抛「An object could not be cloned」——importW.apply 把 preview.project
// （响应式）直接传 api.importApply，预览正常、落库必炸。jsdom 内存替身路径无克隆限制，
// 既有测试测不出；本文件钉住 Electron 路径的修复：withPlainArgs 对全部入参深平化。
// 断言机理：Node 全局 structuredClone 与 Electron 同源（HTML 结构化克隆），对 Proxy
// 同样抛 DataCloneError——用它模拟「过不过得了 IPC」的判定器。
import { describe, expect, it, vi } from "vitest";
import { reactive } from "vue";
import { toPlain, withPlainArgs } from "../../../src/renderer/src/api/index.js";
import type { ApiccApi } from "../../../src/shared/types.js";

/** importApply 的 project 形参类型（契约锚定，避免依赖 types.ts 内部导出名）。 */
type ImportProject = Parameters<ApiccApi["importApply"]>[0]["project"];

describe("IPC 入参深平化（withPlainArgs，回归：An object could not be cloned）", () => {
  it("前置假设：structuredClone 对 Vue 响应式 Proxy 抛错（与 Electron 同源的判定器）", () => {
    expect(typeof structuredClone).toBe("function");
    const proxy = reactive({ project: { name: "商店 API", apis: [{ name: "updatePet" }] } });
    expect(() => structuredClone(proxy)).toThrow();
  });

  it("toPlain：Proxy → 深度普通对象，structuredClone 可过；undefined 原样保留", () => {
    const proxy = reactive({ a: { b: [{ c: 1 }] } });
    const plain = toPlain(proxy);
    expect(() => structuredClone(plain)).not.toThrow();
    expect(plain).toEqual({ a: { b: [{ c: 1 }] } });
    expect(plain).not.toBe(proxy);
    expect(toPlain(undefined)).toBeUndefined();
  });

  it("withPlainArgs：importApply 收到的 project 是可结构化克隆的普通对象（用户导入回归）", async () => {
    const received: unknown[] = [];
    const fake = {
      importApply: async (input: unknown) => {
        received.push(input);
      },
    } as unknown as ApiccApi;
    const wrapped = withPlainArgs(fake);
    // 模拟 store 状态：preview 从 IPC 返回后入 Pinia 即成响应式 Proxy。
    // 形状非完整 Project 契约（schema 校验在 main 侧，与克隆无关），断言用即可。
    const preview = reactive({
      format: "openapi",
      project: reactive({ name: "商店 API", apis: [{ name: "updatePet", method: "PUT" }] }),
    });
    await wrapped.importApply({ mode: "project", groupId: "group-1", name: "商店 API", project: preview.project as unknown as ImportProject });
    expect(received).toHaveLength(1);
    // 判定器：入参能过结构化克隆（真实 Electron 场景即不再抛 An object could not be cloned）
    expect(() => structuredClone(received[0])).not.toThrow();
    expect(received[0]).toEqual({ mode: "project", groupId: "group-1", name: "商店 API", project: { name: "商店 API", apis: [{ name: "updatePet", method: "PUT" }] } });
  });

  it("withPlainArgs：多参/基本类型/undefined 参原样透传；属性动态取（中途换实现仍生效）", async () => {
    const spy = vi.fn(async () => undefined);
    const fake = { nodeDelete: spy, envVarsSave: spy } as unknown as ApiccApi;
    const wrapped = withPlainArgs(fake);
    await wrapped.nodeDelete("collection", "c1");
    await wrapped.envVarsSave("e1", { k: "v" });
    expect(spy).toHaveBeenNthCalledWith(1, "collection", "c1");
    expect(spy).toHaveBeenNthCalledWith(2, "e1", { k: "v" });
    // 中途换实现（App.test 场景：failingApi.nodeCreate 事后替换）：动态取属性不缓存
    const replacement = vi.fn(async () => undefined);
    (fake as unknown as Record<string, unknown>).nodeDelete = replacement;
    await wrapped.nodeDelete("api", "a1");
    expect(replacement).toHaveBeenCalledWith("api", "a1");
  });

  it("withPlainArgs：函数型入参原样透传（onDirtyCheck 应答器回调——JSON 平化会把函数抹成 undefined）", () => {
    const handler = () => true;
    const received: unknown[] = [];
    const fake = {
      onDirtyCheck: (h: () => boolean) => {
        received.push(h);
      },
    } as unknown as ApiccApi;
    withPlainArgs(fake).onDirtyCheck(handler);
    expect(received[0]).toBe(handler); // 同一引用：回调直通不克隆
  });

  it("withPlainArgs：目标为普通空对象——冻结对象（contextBridge 不可配置属性）可包装（打开工作区回归）", async () => {
    // 复现场景：preload 经 contextBridge 暴露的属性不可配置，直接 Proxy 其本体时
    // get 陷阱返回新函数触发不变式报错（'get' on proxy: … read-only and
    // non-configurable …）。冻结对象复现同款属性描述符，钉住「空对象目标 + 动态转发」。
    const pick = vi.fn(async () => "D:/ws");
    const frozen = Object.freeze({ wsPickDirectory: pick }) as unknown as ApiccApi;
    const wrapped = withPlainArgs(frozen);
    await expect(wrapped.wsPickDirectory()).resolves.toBe("D:/ws");
    expect(pick).toHaveBeenCalledTimes(1);
  });
});
