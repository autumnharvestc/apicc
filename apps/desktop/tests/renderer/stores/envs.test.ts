// @vitest-environment jsdom
// 注：pinia/vue 响应式需要 DOM 环境，渲染层 store 测试用文件级 pragma 指定 jsdom。
import { describe, expect, it } from "vitest";
import type { EnvironmentLocator } from "../../../src/shared/locations.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useEnvsStore } from "../../../src/renderer/src/stores/envs.js";

async function seeded() {
  const api = createMemoryApi();
  api.seedWorkspace();
  const ws = useWorkspaceStore(api);
  await ws.open("/tmp/ws");
  const group = ws.tree!.children.find((node) => node.kind === "group" && node.children.some((child) => child.kind === "project" && child.children.some((item) => item.kind === "collection")));
  if (!group || group.kind !== "group") throw new Error("Memory workspace is missing the seeded project group");
  const projectNode = group.children.find((node) => node.kind === "project" && node.children.some((item) => item.kind === "collection"));
  if (!projectNode || projectNode.kind !== "project") throw new Error("Memory group is missing the seeded project");
  const context = () => ({ root: ws.root, readOnly: ws.readOnly });
  const envs = useEnvsStore(api, context);
  await envs.load(projectNode.locator);
  return { api, ws, envs, group, projectNode };
}

function environmentLocator(project: { workspaceId: string; groupId: string; projectId: string }, environmentId: string): EnvironmentLocator {
  return { ...project, environmentId };
}

const missingEnvironment = (project: { workspaceId: string; groupId: string; projectId: string }): EnvironmentLocator => ({
  ...project,
  environmentId: "00000000-0000-4000-8000-000000000000",
});

describe("envs store", () => {
  it("load 从完整 project locator 水合环境列表（含 variables/baseUrls）", async () => {
    const { api, envs, projectNode } = await seeded();
    const created = await api.envCreate({ locator: projectNode.locator, name: "dev" });
    const locator = environmentLocator(projectNode.locator, created.id);
    await api.envVarsSave(locator, { baseUrl: "http://d" });
    await api.envBaseUrlsSave(locator, { api: "http://d/api" });
    await envs.load(projectNode.locator);
    expect(envs.envs).toEqual([{
      id: created.id,
      name: "dev",
      extends: undefined,
      variables: { baseUrl: "http://d" },
      baseUrls: { api: "http://d/api" },
      locator,
    }]);
    expect(envs.projectLocator).toEqual(projectNode.locator);
    expect(envs.selectedEnvId).toBeNull();
  });

  it("load 跨完整 project locator 切换时清理悬空 selectedEnvironment", async () => {
    const { api, envs, group, projectNode } = await seeded();
    const dev = await envs.create({ locator: projectNode.locator, name: "dev" });
    const devItem = envs.envs.find((item) => item.id === dev.id)!;
    expect(envs.selectedEnvironment).toEqual(devItem.locator);
    const p2 = await api.nodeCreate({ kind: "project", parent: group.locator, name: "p2" });
    if (p2.kind !== "project") throw new Error("Memory project creation did not return a project node");
    await envs.load(p2.locator);
    expect(envs.selectedEnvironment).toBeNull();
    expect(envs.envs).toEqual([]);
  });

  it("create 后刷新列表并选中新环境，extends 透传", async () => {
    const { envs, projectNode } = await seeded();
    await envs.create({ locator: projectNode.locator, name: "dev" });
    const sit = await envs.create({ locator: projectNode.locator, name: "sit", extends: "dev" });
    const sitItem = envs.envs.find((item) => item.id === sit.id)!;
    expect(sit.extends).toBe("dev");
    expect(envs.envs.map((env) => env.name)).toEqual(["dev", "sit"]);
    expect(envs.selectedEnvironment).toEqual(sitItem.locator);
  });

  it("saveVars 委托完整环境身份并同步本地项；未命中环境时上抛", async () => {
    const { api, envs, projectNode } = await seeded();
    const created = await envs.create({ locator: projectNode.locator, name: "dev" });
    const createdItem = envs.envs.find((item) => item.id === created.id)!;
    let received: { locator: EnvironmentLocator; variables: Record<string, string> } | null = null;
    const original = api.envVarsSave.bind(api);
    api.envVarsSave = async (locator, variables) => {
      const saved = await original(locator, variables);
      received = { locator, variables };
      return saved;
    };
    await envs.saveVars(createdItem.locator, { baseUrl: "http://s" });
    expect(received).toEqual({ locator: createdItem.locator, variables: { baseUrl: "http://s" } });
    expect(envs.envs.find((env) => env.locator.environmentId === createdItem.locator.environmentId)!.variables).toEqual({ baseUrl: "http://s" });
    await expect(envs.saveVars(missingEnvironment(projectNode.locator), { a: "b" })).rejects.toThrow(/Environment not found|未找到环境/);
  });

  it("remove 确认放行后删除、清选中并刷新；确认取消则不动", async () => {
    const { envs, projectNode } = await seeded();
    const dev = await envs.create({ locator: projectNode.locator, name: "dev" });
    const devItem = envs.envs.find((item) => item.id === dev.id)!;
    await envs.create({ locator: projectNode.locator, name: "sit", extends: "dev" });
    await envs.remove(devItem.locator, async () => false);
    expect(envs.envs.map((env) => env.name)).toEqual(["dev", "sit"]);
    let asked = false;
    await envs.remove(devItem.locator, async () => {
      asked = true;
      return true;
    });
    expect(asked).toBe(true);
    expect(envs.envs.map((env) => env.name)).toEqual(["sit"]);
    expect(envs.selectedEnvId).not.toBe(devItem.locator.environmentId);
  });

  it("remove 未命中时上抛（与 memory 未命中语义一致）", async () => {
    const { envs, projectNode } = await seeded();
    await expect(envs.remove(missingEnvironment(projectNode.locator), async () => true)).rejects.toThrow(/not found|未找到/);
  });

  it("确认期间切换工作区时不把旧环境删除请求发往新根", async () => {
    const { api, ws, envs, projectNode } = await seeded();
    const created = await envs.create({ locator: projectNode.locator, name: "dev" });
    const item = envs.envs.find((env) => env.id === created.id)!;
    let settle!: (accepted: boolean) => void;
    const confirmation = new Promise<boolean>((resolve) => { settle = resolve; });
    let deleted: unknown = null;
    const originalDelete = api.nodeDelete.bind(api);
    api.nodeDelete = async (input) => {
      deleted = input;
      await originalDelete(input);
    };
    const removal = envs.remove(item.locator, () => confirmation);
    try {
      ws.root = "/tmp/ws-other";
      settle(true);
      await removal;
      expect(deleted).toBeNull();
    } finally {
      settle(true);
      await removal;
    }
  });
});
