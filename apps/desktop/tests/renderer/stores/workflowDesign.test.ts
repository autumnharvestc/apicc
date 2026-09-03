// @vitest-environment jsdom
// 注：pinia/vue 响应式需要 DOM 环境，渲染层 store 测试用文件级 pragma 指定 jsdom。
import { describe, expect, it } from "vitest";
import { isReactive } from "vue";
import type { Workflow, WorkflowRunResult } from "@apicc/core";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useWorkflowDesignStore } from "../../../src/renderer/src/stores/workflowDesign.js";

async function seeded() {
  const api = createMemoryApi();
  api.seedWorkspace();
  const ws = useWorkspaceStore(api);
  await ws.open("/tmp/ws");
  // 种子树：根 → 分组[0] → 项目[0]（→ 集合[0] → 接口[0]）
  const projectNode = ws.tree!.children![0]!.children![0]!;
  const apiNode = projectNode.children![0]!.children![0]!;
  const design = useWorkflowDesignStore(api);
  return { api, ws, design, projectNode, apiNode };
}

/** 经契约 api 预置一条工作流：wfCreate 只建空 draft 流，patch 经 wfSave 落入缓冲。 */
async function seedWorkflow(
  api: ReturnType<typeof createMemoryApi>,
  projectId: string,
  name = "条件流",
  patch?: Partial<Workflow>,
): Promise<Workflow> {
  const wf = await api.wfCreate({ projectId, name });
  return api.wfSave({ ...wf, ...patch });
}

/** 引用种子接口用例的有效 request 节点（启用校验可通过）。 */
async function validNode(api: ReturnType<typeof createMemoryApi>, apiId: string) {
  const detail = await api.apiGet(apiId);
  return {
    id: "n1",
    kind: "request" as const,
    apiId,
    caseId: detail.api.cases[0]!.id,
    label: "登录",
    position: { x: 0, y: 0 },
  };
}

describe("workflowDesign store", () => {
  it("load 拉全量建缓冲；update 整体替换缓冲，dirty 由快照比对自动生效", async () => {
    const { api, design, projectNode, apiNode } = await seeded();
    const wf = await seedWorkflow(api, projectNode.id, "条件流", {
      nodes: [await validNode(api, apiNode.id)],
    });
    expect(design.workflow).toBeNull();
    await design.load(wf.id);
    expect(design.workflowId).toBe(wf.id);
    expect(design.workflow!.name).toBe("条件流");
    expect(design.workflow!.nodes).toHaveLength(1);
    expect(design.dirty).toBe(false);
    // 整体替换缓冲即置 dirty 语义（快照比对派生，无显式标志位）
    design.update({ ...design.workflow!, name: "改名流" });
    expect(design.dirty).toBe(true);
    // 缓冲与快照一致时不误报（不经 action 标记也能跟踪）
    design.update(JSON.parse(design.snapshot) as Workflow);
    expect(design.dirty).toBe(false);
  });

  it("save 走 api.wfSave：传参剥离响应式、缓冲用返回值刷新、dirty 复位", async () => {
    const { api, design, projectNode } = await seeded();
    const wf = await seedWorkflow(api, projectNode.id);
    await design.load(wf.id);
    design.update({ ...design.workflow!, name: "改名流" });
    let calls = 0;
    let savedInput: Workflow | undefined;
    const original = api.wfSave.bind(api);
    api.wfSave = async (input) => {
      calls++;
      savedInput = input;
      return original(input);
    };
    await design.save();
    expect(calls).toBe(1);
    // 回归：直接传响应式 Proxy 会在 Electron 结构化克隆时 DataCloneError（editor 先例）。
    expect(isReactive(savedInput)).toBe(false);
    expect(savedInput).toMatchObject({ name: "改名流" });
    // wf:save 返回落盘后的工作流，store 用返回值刷新缓冲与快照基线
    expect(design.workflow!.name).toBe("改名流");
    expect(design.dirty).toBe(false);
    expect(design.saving).toBe(false);
  });

  it("save 失败上抛调用方且 saving 复位、缓冲与 dirty 不动", async () => {
    const { api, design, projectNode } = await seeded();
    const wf = await seedWorkflow(api, projectNode.id);
    await design.load(wf.id);
    design.update({ ...design.workflow!, name: "改名流" });
    api.wfSave = async () => {
      throw new Error("落盘失败");
    };
    await expect(design.save()).rejects.toThrow(/落盘失败/);
    expect(design.saving).toBe(false);
    expect(design.dirty).toBe(true);
    expect(design.workflow!.name).toBe("改名流");
  });

  it("setStatus 成功：刷新 workflow、清 validationErrors、dirty 不误报", async () => {
    const { api, design, projectNode, apiNode } = await seeded();
    const wf = await seedWorkflow(api, projectNode.id, "条件流", {
      nodes: [await validNode(api, apiNode.id)],
    });
    await design.load(wf.id);
    await design.setStatus("published");
    expect(design.workflow!.status).toBe("published");
    expect(design.dirty).toBe(false);
    await design.setStatus("enabled");
    expect(design.workflow!.status).toBe("enabled");
    expect(design.validationErrors).toEqual([]);
    expect(design.dirty).toBe(false);
  });

  it("setStatus 失败：validationErrors 可见且状态不变；dismissValidation 清除", async () => {
    const { api, design, projectNode } = await seeded();
    // 引用不存在的接口/用例 → published→enabled 启用校验失败（errors 非空、状态不变）
    const wf = await seedWorkflow(api, projectNode.id, "坏引用流", {
      nodes: [{ id: "n1", kind: "request", apiId: "no-api", caseId: "no-case", label: "登录" }],
    });
    await design.load(wf.id);
    await design.setStatus("published");
    await design.setStatus("enabled");
    expect(design.validationErrors.length).toBeGreaterThan(0);
    expect(design.workflow!.status).toBe("published");
    design.dismissValidation();
    expect(design.validationErrors).toEqual([]);
    expect(design.workflow!.status).toBe("published");
  });

  it("run：draft 直接把草稿提示存 error 不调 api（api 层同文案抛错，双保险）", async () => {
    const { api, design, projectNode } = await seeded();
    const wf = await seedWorkflow(api, projectNode.id);
    await design.load(wf.id);
    let calls = 0;
    const originalRun = api.wfRun.bind(api);
    api.wfRun = async (input) => {
      calls++;
      return originalRun(input);
    };
    await design.run();
    expect(calls).toBe(0);
    expect(design.runResult).toBeNull();
    expect(design.running).toBe(false);
    expect(design.validationErrors).toContain("工作流为草稿，请先发布启用");
  });

  it("run：enabled 走 api.wfRun 存 runResult，running 复位", async () => {
    const { api, design, projectNode, apiNode } = await seeded();
    const wf = await seedWorkflow(api, projectNode.id, "条件流", {
      nodes: [await validNode(api, apiNode.id)],
    });
    await design.load(wf.id);
    await design.setStatus("published");
    await design.setStatus("enabled");
    await design.run();
    expect(design.running).toBe(false);
    expect(design.runResult).not.toBeNull();
    expect(design.runResult!.workflowName).toBe("条件流");
    // memory 替身按实际节点 id 生成 nodeResults
    expect(design.runResult!.nodeResults.map((n) => n.nodeId)).toEqual(["n1"]);
    expect(design.runResult!.passed).toBe(1);
  });

  it("run：running 门控（运行中重复触发不并发，api 只被调一次）", async () => {
    const { api, design, projectNode, apiNode } = await seeded();
    const wf = await seedWorkflow(api, projectNode.id, "条件流", {
      nodes: [await validNode(api, apiNode.id)],
    });
    await design.load(wf.id);
    await design.setStatus("published");
    await design.setStatus("enabled");
    const finished: WorkflowRunResult = {
      workflowId: wf.id,
      workflowName: "条件流",
      status: "enabled",
      nodeResults: [],
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      warnings: [],
      startedAt: "2026-09-03T00:00:00.000Z",
      finishedAt: "2026-09-03T00:00:00.000Z",
    };
    let calls = 0;
    let release: () => void = () => {};
    api.wfRun = async () => {
      calls++;
      return new Promise<WorkflowRunResult>((resolve) => {
        release = () => resolve(finished);
      });
    };
    const first = design.run();
    const second = design.run(); // 运行中被门控忽略
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(design.running).toBe(false);
    expect(design.runResult).toEqual(finished);
  });

  it("run：环境未命中上抛调用方且 running 复位", async () => {
    const { api, design, projectNode, apiNode } = await seeded();
    const wf = await seedWorkflow(api, projectNode.id, "条件流", {
      nodes: [await validNode(api, apiNode.id)],
    });
    await design.load(wf.id);
    await design.setStatus("published");
    await design.setStatus("enabled");
    await expect(design.run("不存在环境")).rejects.toThrow(/未找到环境/);
    expect(design.running).toBe(false);
  });

  it("load 切换工作流重置运行结果与校验状态；工厂每调用 createPinia 隔离", async () => {
    const { api, design, projectNode } = await seeded();
    const wfA = await seedWorkflow(api, projectNode.id, "流甲", {
      nodes: [{ id: "nA", kind: "noop", label: "占位" }],
    });
    const wfB = await seedWorkflow(api, projectNode.id, "流乙");
    await design.load(wfA.id);
    // noop 节点也可启用（无 request 引用即无引用错误）
    await design.setStatus("published");
    await design.setStatus("enabled");
    await design.run();
    expect(design.runResult).not.toBeNull();
    await design.load(wfB.id);
    expect(design.runResult).toBeNull();
    expect(design.validationErrors).toEqual([]);
    expect(design.dirty).toBe(false);
    // 工厂每次调用绑定独立 Pinia 实例：新实例状态互不共享
    const other = useWorkflowDesignStore(api);
    expect(other.workflow).toBeNull();
    expect(other.workflowId).toBeNull();
  });
});
