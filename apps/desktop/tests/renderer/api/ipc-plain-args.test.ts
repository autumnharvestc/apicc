// @vitest-environment jsdom
// 注：需要 window（api/index.ts 模块求值读 window.apicc）。
// ImportApply 现只跨 Electron IPC 发送 opaque plan token 和确认位，不允许渲染层传候选项目。
// 本文件继续钉住 withPlainArgs 的结构化克隆边界，并验证 token DTO 可安全跨 IPC。
import { describe, expect, it, vi } from "vitest";
import { reactive } from "vue";
import { toPlain, withPlainArgs } from "../../../src/renderer/src/api/index.js";
import type { EnvironmentLocator, GroupLocator, NodeLocator, ProjectLocator } from "../../../src/shared/locations.js";
import type { ApiccApi } from "../../../src/shared/types.js";

/** importApply only transfers opaque confirmation tokens across the IPC boundary. */
const groupTarget: GroupLocator = {
  workspaceId: "00000000-0000-4000-8000-000000000001",
  groupId: "00000000-0000-4000-8000-000000000002",
};
const projectLocator: ProjectLocator = {
  ...groupTarget,
  projectId: "00000000-0000-4000-8000-000000000003",
};
const environmentLocator: EnvironmentLocator = {
  ...projectLocator,
  environmentId: "00000000-0000-4000-8000-000000000004",
};
const nodeLocator: NodeLocator = { kind: "collection", locator: { ...projectLocator, collectionId: "00000000-0000-4000-8000-000000000005" } };

describe("IPC 入参深平化（withPlainArgs，回归：An object could not be cloned）", () => {
  it("keeps v2 creation and the captured run/stop identity cloneable with typed inputs", async () => {
    const received: unknown[] = [];
    const fake = { wfCreate: async (input: unknown) => { received.push(structuredClone(input)); }, wfRun: async (input: unknown) => { received.push(structuredClone(input)); }, wfCancel: async (input: unknown) => { received.push(structuredClone(input)); return true; } } as unknown as ApiccApi;
    const api = withPlainArgs(fake);
    const locator = reactive({ ...projectLocator, workflowId: '00000000-0000-4000-8000-000000000011' });
    const capture = reactive({ locator, root: 'C:/workspace', invocationId: '00000000-0000-4000-8000-000000000012' });
    await api.wfCreate(reactive({ locator: projectLocator, name: 'v2', executionVersion: 2 as const }));
    await api.wfRun(reactive({ ...capture, inputs: { flag: false, count: 0, object: { nested: null } } }));
    await api.wfCancel(capture);
    expect(received).toEqual([{ locator: projectLocator, name: 'v2', executionVersion: 2 }, { ...capture, inputs: { flag: false, count: 0, object: { nested: null } } }, { ...capture }]);
  });
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

  it("withPlainArgs：importApply 只发送可结构化克隆的 opaque token（不发送完整候选）", async () => {
    const received: unknown[] = [];
    const fake = {
      importApply: async (input: unknown) => {
        received.push(input);
      },
    } as unknown as ApiccApi;
    const wrapped = withPlainArgs(fake);
    const preview = reactive({ planToken: "00000000-0000-4000-8000-000000000010", allowLossy: false });
    await wrapped.importApply({ planToken: preview.planToken, allowLossy: preview.allowLossy });
    expect(received).toHaveLength(1);
    // 判定器：入参能过结构化克隆，且不携带任何候选项目字段。
    expect(() => structuredClone(received[0])).not.toThrow();
    expect(received[0]).toEqual({ planToken: preview.planToken, allowLossy: false });
  });

  it("withPlainArgs：多参/基本类型/undefined 参原样透传；属性动态取（中途换实现仍生效）", async () => {
    const spy = vi.fn(async () => undefined);
    const fake = { nodeDelete: spy, envVarsSave: spy } as unknown as ApiccApi;
    const wrapped = withPlainArgs(fake);
    await wrapped.nodeDelete(nodeLocator);
    await wrapped.envVarsSave(environmentLocator, { k: "v" });
    expect(spy).toHaveBeenNthCalledWith(1, nodeLocator);
    expect(spy).toHaveBeenNthCalledWith(2, environmentLocator, { k: "v" });
    // 中途换实现（App.test 场景：failingApi.nodeCreate 事后替换）：动态取属性不缓存
    const replacement = vi.fn(async () => undefined);
    (fake as unknown as Record<string, unknown>).nodeDelete = replacement;
    await wrapped.nodeDelete(nodeLocator);
    expect(replacement).toHaveBeenCalledWith(nodeLocator);
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
