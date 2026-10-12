// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { ProjectLocator, WorkflowLocator } from "../../../src/shared/locations.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useWfListStore } from "../../../src/renderer/src/stores/wfList.js";

const root = "/tmp/ws";

async function seeded() {
  const api = createMemoryApi();
  api.seedWorkspace();
  const ws = useWorkspaceStore(api);
  await ws.open(root);
  const projectNode = ws.tree!.children!.flatMap((group) => group.children ?? []).find((node) => node.kind === "project");
  if (!projectNode || projectNode.kind !== "project") throw new Error("Memory workspace is missing its project");
  const projectLocator: ProjectLocator = projectNode.locator;
  const context = { root, readOnly: false };
  const list = useWfListStore(api, () => context);
  return { api, ws, list, projectLocator, context };
}

function workflowLocator(project: ProjectLocator, workflowId: string): WorkflowLocator {
  return { ...project, workflowId };
}

describe("wfList store", () => {
  it("load(full project locator) 拉取并记录目标项目工作流列表", async () => {
    const { api, list, projectLocator } = await seeded();
    await api.wfCreate({ locator: projectLocator, name: "流甲" });
    await api.wfCreate({ locator: projectLocator, name: "流乙" });
    expect(list.items).toEqual([]);
    await list.load(root, projectLocator);
    expect(list.projectLocator).toEqual(projectLocator);
    expect(list.items.map((item) => item.name)).toEqual(["流甲", "流乙"]);
    expect(list.items[0]).toMatchObject({ name: "流甲", status: "draft", locator: { ...projectLocator } });
  });

  it("create(name, project locator) 固定创建目标并刷新列表；同名可并存", async () => {
    const { list, projectLocator } = await seeded();
    await list.load(root, projectLocator);
    const first = await list.create("新流", projectLocator);
    expect(first.status).toBe("draft");
    expect(list.items.map((item) => item.name)).toContain("新流");
    const second = await list.create("新流", projectLocator);
    expect(second.id).not.toBe(first.id);
    expect(list.items).toHaveLength(2);
  });

  it("create 使用显式目标而不读取可能过期的活动列表项目", async () => {
    const { api, list, projectLocator } = await seeded();
    await api.wfCreate({ locator: projectLocator, name: "活动列表流" });
    await list.load(root, projectLocator);
    const created = await api.nodeCreate({
      kind: "project",
      parent: { workspaceId: projectLocator.workspaceId, groupId: projectLocator.groupId },
      name: "显式目标项目",
    });
    if (created.kind !== "project") throw new Error("Memory API did not create the explicit target project");
    const other: ProjectLocator = created.locator;
    const calls: ProjectLocator[] = [];
    const original = api.wfCreate.bind(api);
    api.wfCreate = async (input) => {
      calls.push({ ...input.locator });
      return original(input);
    };
    try {
      await list.create("固定目标", other);
    } finally {
      api.wfCreate = original;
    }
    expect(calls).toEqual([other]);
    expect(list.projectLocator).toEqual(projectLocator);
    expect(list.items.map((item) => item.name)).toEqual(["活动列表流"]);
    expect((await api.wfList(other)).map((item) => item.name)).toEqual(["固定目标"]);
  });

  it("remove(full workflow locator, confirm) 删除并按完整 project locator 刷新", async () => {
    const { list, projectLocator } = await seeded();
    await list.load(root, projectLocator);
    const workflow = await list.create("待删除流", projectLocator);
    const locator = workflowLocator(projectLocator, workflow.id);
    let asked = false;
    await list.remove(locator, async () => {
      asked = true;
      return true;
    });
    expect(asked).toBe(true);
    expect(list.items.some((item) => item.id === workflow.id)).toBe(false);
  });

  it("remove 确认取消则不删除", async () => {
    const { list, projectLocator } = await seeded();
    await list.load(root, projectLocator);
    const workflow = await list.create("保留流", projectLocator);
    await list.remove(workflowLocator(projectLocator, workflow.id), async () => false);
    expect(list.items.some((item) => item.id === workflow.id)).toBe(true);
  });

  it("旧项目列表请求迟到不能覆盖新完整项目定位符", async () => {
    const { api, list, projectLocator } = await seeded();
    const other: ProjectLocator = { ...projectLocator, workspaceId: "other-workspace" };
    let releaseOld!: (value: Awaited<ReturnType<typeof api.wfList>>) => void;
    const original = api.wfList.bind(api);
    api.wfList = (locator) => locator.workspaceId === projectLocator.workspaceId
      ? new Promise((resolve) => { releaseOld = resolve; })
      : Promise.resolve([]);
    const oldRequest = list.load(root, projectLocator);
    await list.load(root, other);
    releaseOld(await original(projectLocator));
    await oldRequest;
    expect(list.projectLocator).toEqual(other);
    expect(list.items).toEqual([]);
  });

  it("工厂每调用 createPinia 隔离，新实例未绑定项目", async () => {
    const { api, list, projectLocator } = await seeded();
    await list.load(root, projectLocator);
    const other = useWfListStore(api);
    expect(other.items).toEqual([]);
    expect(other.projectLocator).toBeNull();
  });
});
