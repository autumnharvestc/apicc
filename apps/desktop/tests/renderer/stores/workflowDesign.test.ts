// @vitest-environment jsdom
// 注：pinia/vue 响应式需要 DOM 环境，渲染层 store 测试用文件级 pragma 指定 jsdom。
import { describe, expect, it } from "vitest";
import { isReactive } from "vue";
import { WorkflowSchema, type Workflow, type WorkflowRunResult } from "@apicc/core";
import type { ApiLocator, ProjectLocator, WorkflowLocator } from "../../../src/shared/locations.js";
import type { WfSetStatusResult } from "../../../src/shared/types.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useWorkflowDesignStore } from "../../../src/renderer/src/stores/workflowDesign.js";

const root = "/tmp/ws";

async function seeded() {
  const api = createMemoryApi();
  api.seedWorkspace();
  const ws = useWorkspaceStore(api);
  await ws.open(root);
  const projectNode = ws.tree!.children!.flatMap((group) => group.children ?? []).find((node) => node.kind === "project");
  if (!projectNode || projectNode.kind !== "project") throw new Error("Memory workspace is missing its project");
  const apiNode = projectNode.children!.flatMap((collection) => collection.children ?? []).find((node) => node.kind === "api");
  if (!apiNode || apiNode.kind !== "api") throw new Error("Memory project is missing its API");
  const context = { root, readOnly: false };
  const design = useWorkflowDesignStore(api, () => context);
  return { api, ws, design, context, projectNode, apiNode };
}

/** 经契约 api 预置一条工作流：wfCreate 只建空 draft 流，patch 经 wfSave 落入缓冲。 */
async function seedWorkflow(
  api: ReturnType<typeof createMemoryApi>,
  projectLocator: ProjectLocator,
  name = "条件流",
  patch?: Partial<Workflow>,
): Promise<Workflow> {
  const wf = await api.wfCreate({ locator: projectLocator, name });
  return api.wfSave({ ...projectLocator, workflowId: wf.id }, WorkflowSchema.parse({ ...wf, ...patch }));
}

/** 引用种子接口用例的有效 request 节点（启用校验可通过）。 */
async function validNode(api: ReturnType<typeof createMemoryApi>, locator: ApiLocator) {
  const detail = await api.apiGet(locator);
  return {
    id: "n1",
    kind: "request" as const,
    apiId: locator.apiId,
    caseId: detail.api.cases[0]!.id,
    label: "登录",
    position: { x: 0, y: 0 },
  };
}

function workflowLocator(project: ProjectLocator, workflowId: string): WorkflowLocator {
  return { ...project, workflowId };
}

async function loadWorkflow(
  design: ReturnType<typeof useWorkflowDesignStore>,
  project: ProjectLocator,
  workflow: Workflow,
) {
  await design.load(root, workflowLocator(project, workflow.id));
}

describe("workflowDesign store", () => {
  it("retains only the latest two complete results FIFO across loads, unloads and late workspace completion", async () => {
    const { api, ws, design, context, projectNode } = await seeded();
    const wf = await seedWorkflow(api, projectNode.locator, "bounded history", { nodes: [{ id: "n", kind: "noop" }] });
    const locator = workflowLocator(projectNode.locator, wf.id);
    await loadWorkflow(design, projectNode.locator, wf); await design.setStatus("published");
    await design.run(); const first = design.runHistory[0]!;
    await design.run(); const second = design.runHistory[1]!;
    expect(design.runHistory).toHaveLength(2);
    const trackedRun = api.wfRun.bind(api);
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    let completed!: Promise<WorkflowRunResult>;
    api.wfRun = (input) => { completed = trackedRun(input); return completed.then(async (result) => { await gate; return result; }); };
    const running = design.run(); const lateId = design.activeRun!.invocationId;
    try {
      const lateResult = await completed;
      const copyRoot = `${root}-history-copy`; await ws.open(copyRoot); context.root = copyRoot;
      design.unload(); await design.load(copyRoot, locator);
      const currentResult = await trackedRun({ locator, root: copyRoot }); design.runResult = currentResult;
      expect(design.running).toBe(true); expect(design.runHistory.map((entry) => entry.invocationId)).toEqual([first.invocationId, second.invocationId]);
      release(); await running;
      expect(design.runResult).toEqual(currentResult); expect(design.running).toBe(false); expect(design.activeRun).toBeNull();
      expect(design.runHistory.map((entry) => entry.invocationId)).toEqual([second.invocationId, lateId]);
      expect(design.runHistory[1]).toMatchObject({ locator, root, result: lateResult });
      api.wfRun = trackedRun; await design.run();
      expect(design.runHistory).toHaveLength(2);
      expect(design.runHistory[0]?.invocationId).toBe(lateId);
      expect(design.runHistory[1]).toMatchObject({ locator, root: copyRoot, result: design.runResult });
      design.unload(); await design.load(copyRoot, locator);
      expect(design.runHistory).toHaveLength(2); expect(design.runHistory[0]?.invocationId).toBe(lateId);
    } finally { release(); await running; }
  });

  it("captures one run identity for stop, waits for drain and rejects late ABA results", async () => {
    const { api, design, projectNode } = await seeded();
    const wf = await seedWorkflow(api, projectNode.locator, "stoppable", { nodes: [{ id: "n", kind: "noop" }] });
    await loadWorkflow(design, projectNode.locator, wf);
    await design.setStatus("published");
    let input: Parameters<typeof api.wfRun>[0] | undefined;
    let finish!: (value: WorkflowRunResult) => void;
    api.wfRun = (value) => { input = value; return new Promise(resolve => { finish = resolve; }); };
    const cancels: Parameters<typeof api.wfCancel>[0][] = [];
    api.wfCancel = async value => { cancels.push(value); return true; };
    const running = design.run();
    expect(input?.invocationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(input?.root).toBe(root);
    const other = await seedWorkflow(api, projectNode.locator, 'other');
    await loadWorkflow(design, projectNode.locator, other);
    await design.cancel();
    expect(cancels).toEqual([{ locator: workflowLocator(projectNode.locator, wf.id), root, invocationId: input!.invocationId }]);
    expect(design.stopping).toBe(true);
    expect(design.running).toBe(true);
    await loadWorkflow(design, projectNode.locator, wf); // A → A still changes the session generation
    expect(design.running).toBe(true);
    expect(design.stopping).toBe(true);
    finish({ workflowId: wf.id, workflowName: wf.name, status: "published", nodeResults: [], total: 0, passed: 0, failed: 0, skipped: 0,
      warnings: [], startedAt: "now", finishedAt: "now", verdict: "aborted" });
    await running;
    expect(design.runResult).toBeNull();
    expect(design.runHistory).toHaveLength(1);
    expect(design.runHistory[0]?.result.verdict).toBe("aborted");
  });
  it("拒绝只读本地编辑，并在工作区根变化后拒绝旧草稿保存", async () => {
    const { api, design, context, projectNode } = await seeded();
    const wf = await seedWorkflow(api, projectNode.locator);
    await loadWorkflow(design, projectNode.locator, wf);
    context.readOnly = true;
    expect(() => design.update({ ...design.workflow!, name: "只读改动" })).toThrow(/只读/);
    context.readOnly = false;
    design.update({ ...design.workflow!, name: "旧根改动" });

    let saves = 0;
    const save = api.wfSave.bind(api);
    api.wfSave = async (...args) => { saves++; return save(...args); };
    context.root = `${root}-copy`;
    await expect(design.save()).rejects.toThrow(/工作区上下文已变化/);
    expect(saves).toBe(0);
    expect(design.workflow?.name).toBe("旧根改动");
    expect(design.dirty).toBe(true);
  });

  it("load 拉全量建缓冲；update 整体替换缓冲，dirty 由快照比对自动生效", async () => {
    const { api, design, projectNode, apiNode } = await seeded();
    const wf = await seedWorkflow(api, projectNode.locator, "条件流", {
      nodes: [await validNode(api, apiNode.locator)],
    });
    expect(design.workflow).toBeNull();
    await loadWorkflow(design, projectNode.locator, wf);
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
    const wf = await seedWorkflow(api, projectNode.locator);
    await loadWorkflow(design, projectNode.locator, wf);
    design.update({ ...design.workflow!, name: "改名流" });
    let calls = 0;
    let savedInput: Workflow | undefined;
    const original = api.wfSave.bind(api);
    api.wfSave = async (locator, input) => {
      calls++;
      savedInput = input;
      return original(locator, input);
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
    const wf = await seedWorkflow(api, projectNode.locator);
    await loadWorkflow(design, projectNode.locator, wf);
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
    const wf = await seedWorkflow(api, projectNode.locator, "着色流", {
      nodes: [await validNode(api, apiNode.locator)],
    });
    await loadWorkflow(design, projectNode.locator, wf);
    await design.setStatus("published");
    expect(design.workflow!.status).toBe("published");
    await design.setStatus("enabled");
    await design.run();
    expect(design.runResult).not.toBeNull();
    design.update({ ...design.workflow!, name: "着色流改" });
    await design.save();
    expect(design.runResult).toBeNull();
    expect(design.dirty).toBe(false);

    // save 失败（未落盘成功）：缓冲内容未换基线，旧运行结果保留不误清
    const wf2 = await seedWorkflow(api, projectNode.locator, "着色流乙", {
      nodes: [await validNode(api, apiNode.locator)],
    });
    await loadWorkflow(design, projectNode.locator, wf2);
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
    const wf = await seedWorkflow(api, projectNode.locator, "条件流", {
      nodes: [await validNode(api, apiNode.locator)],
    });
    await loadWorkflow(design, projectNode.locator, wf);
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
    const wf = await seedWorkflow(api, projectNode.locator, "坏引用流", {
      nodes: [{ id: "n1", kind: "request", apiId: "no-api", caseId: "no-case", label: "登录" }],
    });
    await loadWorkflow(design, projectNode.locator, wf);
    expect(design.root).toBe(root);
    expect(design.locator).toEqual(workflowLocator(projectNode.locator, wf.id));
    await design.setStatus("published");
    expect(design.workflow!.status).toBe("published");
    await design.setStatus("enabled");
    expect(design.validationErrors.length).toBeGreaterThan(0);
    expect(design.workflow!.status).toBe("published");
    design.dismissValidation();
    expect(design.validationErrors).toEqual([]);
    expect(design.workflow!.status).toBe("published");
  });

  it("run：draft 直接把草稿提示存 error 不调 api（api 层同文案抛错，双保险）", async () => {
    const { api, design, projectNode } = await seeded();
    const wf = await seedWorkflow(api, projectNode.locator);
    await loadWorkflow(design, projectNode.locator, wf);
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
    const wf = await seedWorkflow(api, projectNode.locator, "条件流", {
      nodes: [await validNode(api, apiNode.locator)],
    });
    await loadWorkflow(design, projectNode.locator, wf);
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
    const wf = await seedWorkflow(api, projectNode.locator, "条件流", {
      nodes: [await validNode(api, apiNode.locator)],
    });
    await loadWorkflow(design, projectNode.locator, wf);
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
    const wf = await seedWorkflow(api, projectNode.locator, "条件流", {
      nodes: [await validNode(api, apiNode.locator)],
    });
    await loadWorkflow(design, projectNode.locator, wf);
    await design.setStatus("published");
    await design.setStatus("enabled");
    await expect(design.run("不存在环境")).rejects.toThrow(/未找到环境/);
    expect(design.running).toBe(false);
  });

  it("save 在途期间 load 切流：旧流落盘结果不回写，缓冲保持新流（竞态守卫）", async () => {
    const { api, design, projectNode } = await seeded();
    const wfA = await seedWorkflow(api, projectNode.locator, "流甲");
    const wfB = await seedWorkflow(api, projectNode.locator, "流乙");
    await loadWorkflow(design, projectNode.locator, wfA);
    design.update({ ...design.workflow!, name: "流甲改动" });
    let release: (value: Workflow) => void = () => {};
    api.wfSave = async () =>
      new Promise<Workflow>((resolve) => {
        release = resolve;
      });
    const saving = design.save();
    // 落盘在途时切到流乙
    await loadWorkflow(design, projectNode.locator, wfB);
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
    const wfA = await seedWorkflow(api, projectNode.locator, "流甲", {
      nodes: [await validNode(api, apiNode.locator)],
    });
    const wfB = await seedWorkflow(api, projectNode.locator, "流乙");
    await loadWorkflow(design, projectNode.locator, wfA);
    // setStatus 在途切流：迁移成功结果（A published）丢弃，缓冲保持流乙 draft
    const originalSetStatus = api.wfSetStatus.bind(api);
    let releaseStatus: () => void = () => {};
    api.wfSetStatus = async (_locator, next) =>
      new Promise<WfSetStatusResult>((resolve) => {
        releaseStatus = () => resolve({ workflow: { ...wfA, status: next }, errors: [], warnings: [] });
      });
    const migrating = design.setStatus("published");
    await loadWorkflow(design, projectNode.locator, wfB);
    releaseStatus();
    await migrating;
    expect(design.workflowId).toBe(wfB.id);
    expect(design.workflow!.name).toBe("流乙");
    expect(design.workflow!.status).toBe("draft");
    // run 在途切流：旧流运行结果不回填（恢复原 api 把流甲启用后加载）
    api.wfSetStatus = originalSetStatus;
    await api.wfSetStatus(workflowLocator(projectNode.locator, wfA.id), "published");
    await api.wfSetStatus(workflowLocator(projectNode.locator, wfA.id), "enabled");
    await loadWorkflow(design, projectNode.locator, wfA);
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
    await loadWorkflow(design, projectNode.locator, wfB);
    releaseRun();
    await running;
    expect(design.runResult).toBeNull();
    expect(design.running).toBe(false);
    expect(design.workflow!.name).toBe("流乙");
  });

  it("load 切换工作流重置运行结果与校验状态；工厂每调用 createPinia 隔离", async () => {
    const { api, design, projectNode } = await seeded();
    const wfA = await seedWorkflow(api, projectNode.locator, "流甲", {
      nodes: [{ id: "nA", kind: "noop", label: "占位" }],
    });
    const wfB = await seedWorkflow(api, projectNode.locator, "流乙");
    await loadWorkflow(design, projectNode.locator, wfA);
    // noop 节点也可启用（无 request 引用即无引用错误）
    await design.setStatus("published");
    await design.setStatus("enabled");
    await design.run();
    expect(design.runResult).not.toBeNull();
    await loadWorkflow(design, projectNode.locator, wfB);
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
    const wf = await seedWorkflow(api, projectNode.locator, "流甲");
    await loadWorkflow(design, projectNode.locator, wf);
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
