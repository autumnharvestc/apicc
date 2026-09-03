// @vitest-environment jsdom
// 注：pinia/vue 响应式需要 DOM 环境，渲染层 store 测试用文件级 pragma 指定 jsdom。
import { describe, expect, it } from "vitest";
import { isReactive } from "vue";
import type { Workflow, WorkflowRunResult } from "@apicc/core";
import type { WfSetStatusResult } from "../../../src/shared/types.js";
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

  // —— 审查 Minor 采纳：编辑+保存后旧运行着色残留与新内容不符，成功落盘即清空 ——
  it("save 成功清空 runResult（旧运行结果不再着色新内容）；save 失败保留", async () => {
    const { api, design, projectNode, apiNode } = await seeded();
    const wf = await seedWorkflow(api, projectNode.id, "着色流", {
      nodes: [await validNode(api, apiNode.id)],
    });
    await design.load(wf.id);
    await design.setStatus("published");
    await design.setStatus("enabled");
    await design.run();
    expect(design.runResult).not.toBeNull();
    design.update({ ...design.workflow!, name: "着色流改" });
    await design.save();
    expect(design.runResult).toBeNull();
    expect(design.dirty).toBe(false);

    // save 失败（未落盘成功）：缓冲内容未换基线，旧运行结果保留不误清
    const wf2 = await seedWorkflow(api, projectNode.id, "着色流乙", {
      nodes: [await validNode(api, apiNode.id)],
    });
    await design.load(wf2.id);
    await design.setStatus("published");
    await design.setStatus("enabled");
    await design.run();
    expect(design.runResult).not.toBeNull();
    api.wfSave = async () => {
      throw new Error("落盘失败");
    };
    design.update({ ...design.workflow!, name: "着色流乙改" });
    await expect(design.save()).rejects.toThrow(/落盘失败/);
    expect(design.runResult).not.toBeNull();
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

  it("save 在途期间 load 切流：旧流落盘结果不回写，缓冲保持新流（竞态守卫）", async () => {
    const { api, design, projectNode } = await seeded();
    const wfA = await seedWorkflow(api, projectNode.id, "流甲");
    const wfB = await seedWorkflow(api, projectNode.id, "流乙");
    await design.load(wfA.id);
    design.update({ ...design.workflow!, name: "流甲改动" });
    let release: (value: Workflow) => void = () => {};
    api.wfSave = async () =>
      new Promise<Workflow>((resolve) => {
        release = resolve;
      });
    const saving = design.save();
    // 落盘在途时切到流乙
    await design.load(wfB.id);
    expect(design.workflowId).toBe(wfB.id);
    release({ ...wfA, name: "流甲改动" }); // 模拟旧流的落盘返回值
    await saving;
    // 守卫：旧流返回值不得覆盖——workflowId 与缓冲均保持流乙，不出现「id 是 B、内容是 A」错位
    expect(design.workflowId).toBe(wfB.id);
    expect(design.workflow!.name).toBe("流乙");
    expect(design.dirty).toBe(false);
    expect(design.saving).toBe(false);
  });

  it("setStatus/run 在途期间 load 切流：状态刷新与运行结果均不回写（竞态守卫）", async () => {
    const { api, design, projectNode, apiNode } = await seeded();
    const wfA = await seedWorkflow(api, projectNode.id, "流甲", {
      nodes: [await validNode(api, apiNode.id)],
    });
    const wfB = await seedWorkflow(api, projectNode.id, "流乙");
    await design.load(wfA.id);
    // setStatus 在途切流：迁移成功结果（A published）丢弃，缓冲保持流乙 draft
    const originalSetStatus = api.wfSetStatus.bind(api);
    let releaseStatus: () => void = () => {};
    api.wfSetStatus = async (_id, next) =>
      new Promise<WfSetStatusResult>((resolve) => {
        releaseStatus = () => resolve({ workflow: { ...wfA, status: next }, errors: [], warnings: [] });
      });
    const migrating = design.setStatus("published");
    await design.load(wfB.id);
    releaseStatus();
    await migrating;
    expect(design.workflowId).toBe(wfB.id);
    expect(design.workflow!.name).toBe("流乙");
    expect(design.workflow!.status).toBe("draft");
    // run 在途切流：旧流运行结果不回填（恢复原 api 把流甲启用后加载）
    api.wfSetStatus = originalSetStatus;
    await api.wfSetStatus(wfA.id, "published");
    await api.wfSetStatus(wfA.id, "enabled");
    await design.load(wfA.id);
    const finished: WorkflowRunResult = {
      workflowId: wfA.id, workflowName: "流甲", status: "enabled", nodeResults: [],
      total: 0, passed: 0, failed: 0, skipped: 0, warnings: [],
      startedAt: "2026-09-03T00:00:00.000Z", finishedAt: "2026-09-03T00:00:00.000Z",
    };
    let releaseRun: () => void = () => {};
    api.wfRun = async () =>
      new Promise<WorkflowRunResult>((resolve) => {
        releaseRun = () => resolve(finished);
      });
    const running = design.run();
    await design.load(wfB.id);
    releaseRun();
    await running;
    expect(design.runResult).toBeNull();
    expect(design.running).toBe(false);
    expect(design.workflow!.name).toBe("流乙");
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

// —— 审查修复 3：卸载编辑会话（离开设计器/切换项目的最小语义） ——
describe("unload", () => {
  it("载入并编辑后卸载 → 回到未选工作流空态（dirty 复位、会话态清空）", async () => {
    const { api, design, projectNode } = await seeded();
    const wf = await seedWorkflow(api, projectNode.id, "流甲");
    await design.load(wf.id);
    design.update({ ...design.workflow!, nodes: [{ id: "nX", kind: "noop", label: "占位" }], edges: [] });
    expect(design.dirty).toBe(true);
    design.unload();
    expect(design.workflowId).toBeNull();
    expect(design.workflow).toBeNull();
    expect(design.snapshot).toBe("");
    expect(design.dirty).toBe(false);
    expect(design.runResult).toBeNull();
    expect(design.validationErrors).toEqual([]);
  });
});
