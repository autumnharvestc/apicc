// @vitest-environment jsdom
// 注：pinia/vue 响应式需要 DOM 环境，渲染层 store 测试用文件级 pragma 指定 jsdom。
import { describe, expect, it } from "vitest";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useEnvsStore } from "../../../src/renderer/src/stores/envs.js";

async function seeded() {
  const api = createMemoryApi();
  api.seedWorkspace();
  const ws = useWorkspaceStore(api);
  await ws.open("/tmp/ws");
  const envs = useEnvsStore(api);
  // 种子树：根 → 分组[0] → 项目[0]
  const projectNode = ws.tree!.children![0]!.children![0]!;
  return { api, ws, envs, projectNode };
}

describe("envs store", () => {
  it("load 从 treeGet 的 project 节点 envs 取列表（api 无 envList 通道）", async () => {
    const { api, envs, projectNode } = await seeded();
    const created = await api.envCreate({ projectId: projectNode.id, name: "dev" });
    await envs.load(projectNode.id);
    expect(envs.envs).toEqual([{ id: created.id, name: "dev" }]);
    expect(envs.projectId).toBe(projectNode.id);
    expect(envs.selectedEnvId).toBeNull();
  });

  it("create 后刷新列表并选中新环境，extends 透传", async () => {
    const { envs, projectNode } = await seeded();
    await envs.create({ projectId: projectNode.id, name: "dev" });
    const sit = await envs.create({ projectId: projectNode.id, name: "sit", extends: "dev" });
    expect(sit.extends).toBe("dev");
    expect(envs.envs.map((e) => e.name)).toEqual(["dev", "sit"]);
    expect(envs.selectedEnvId).toBe(sit.id);
  });

  it("saveVars 委托 api.envVarsSave；未命中环境时上抛（与 session「未找到」语义对齐）", async () => {
    const { api, envs, projectNode } = await seeded();
    const created = await envs.create({ projectId: projectNode.id, name: "dev" });
    let received: { envId: string; variables: Record<string, string> } | null = null;
    const original = api.envVarsSave.bind(api);
    api.envVarsSave = async (envId, variables) => {
      await original(envId, variables);
      received = { envId, variables };
    };
    await envs.saveVars(created.id, { baseUrl: "http://s" });
    expect(received).toEqual({ envId: created.id, variables: { baseUrl: "http://s" } });
    await expect(envs.saveVars("不存在", { a: "b" })).rejects.toThrow(/未找到环境/);
  });

  it("remove 确认放行后删除、清选中并刷新；确认取消则不动", async () => {
    const { envs, projectNode } = await seeded();
    const dev = await envs.create({ projectId: projectNode.id, name: "dev" });
    await envs.create({ projectId: projectNode.id, name: "sit", extends: "dev" });
    // 取消：不删除
    await envs.remove("environment", dev.id, async () => false);
    expect(envs.envs.map((e) => e.name)).toEqual(["dev", "sit"]);
    // 放行：删除 + 选中清理 + 列表刷新
    let asked = false;
    await envs.remove("environment", dev.id, async () => {
      asked = true;
      return true;
    });
    expect(asked).toBe(true);
    expect(envs.envs.map((e) => e.name)).toEqual(["sit"]);
    expect(envs.selectedEnvId).not.toBe(dev.id);
  });

  it("remove 未命中时上抛（与 session/memory 未命中语义一致）", async () => {
    const { envs } = await seeded();
    await expect(envs.remove("environment", "不存在", async () => true)).rejects.toThrow(/未找到/);
  });
});
