// @vitest-environment jsdom
// 注：pinia/vue 响应式需要 DOM 环境，渲染层 store 测试用文件级 pragma 指定 jsdom。
import { describe, expect, it } from "vitest";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useImportWizardStore } from "../../../src/renderer/src/stores/importW.js";

async function seeded() {
  const api = createMemoryApi();
  api.seedWorkspace();
  const ws = useWorkspaceStore(api);
  await ws.open("/tmp/ws");
  return { api, ws };
}

describe("importW store", () => {
  it("初始状态 preview=null、applying=false", () => {
    const importW = useImportWizardStore(createMemoryApi());
    expect(importW.preview).toBeNull();
    expect(importW.applying).toBe(false);
  });

  it("previewFile 调 api.importPreview 并把返回结构入状态；旧根迟到预览不覆盖当前状态", async () => {
    const { api, ws } = await seeded();
    const importW = useImportWizardStore(api, ws);
    const preview = await importW.previewFile("sample.yaml", "openapi: 3.0.0");
    expect(importW.preview).toEqual(preview);
    // Renderer receives a host token and public summary only.
    expect(importW.preview!.importerName).toBe("sample");
    expect(importW.preview!.summary.projectName).toBe("导入示例项目");
    expect(importW.preview).not.toHaveProperty("project");

    let release!: () => void;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const originalPreview = api.importPreview.bind(api);
    api.importPreview = async (input) => {
      notifyStarted();
      await gate;
      return originalPreview(input);
    };
    const context = importW.capturePreviewContext();
    const pending = importW.previewFile("late.yaml", "openapi: 3.0.0", context);
    await started;
    await ws.open("/tmp/ws-context-switched");
    release();
    await expect(pending).rejects.toThrow(/工作区已变更/);
    expect(importW.preview).toBeNull();
  });

  it("apply(project 模式) 调 api.importApply（记录调用可断言）后触发 workspace.refresh，树中出现导入项目", async () => {
    const { api, ws } = await seeded();
    const importW = useImportWizardStore(api, ws);
    await importW.previewFile("sample.yaml", "x");
    // 先建一个目标分组拿 id（轨二：分组按 id 选择，不再按名称缺省创建）
    const groupCandidate = ws.tree!.children!.find((n) => n.kind === "group");
    if (!groupCandidate || groupCandidate.kind !== "group") throw new Error("Expected the group fixture to be present in the tree.");
    ws.readOnly = true;
    await expect(importW.apply({ mode: "project", target: groupCandidate.locator, name: "只读导入" })).rejects.toThrow(/只读/);
    expect(api.importApplyCalls).toEqual([]);
    ws.readOnly = false;
    await expect(importW.apply({
      mode: "project",
      target: { ...groupCandidate.locator, workspaceId: "00000000-0000-4000-8000-000000000001" },
      name: "错误工作区导入",
    })).rejects.toThrow(/不属于当前工作区/);
    expect(api.importApplyCalls).toEqual([]);
    const applyInputs: Parameters<typeof api.importApply>[0][] = [];
    const originalImportApply = api.importApply.bind(api);
    api.importApply = async (input) => {
      applyInputs.push(input);
      return originalImportApply(input);
    };
    const target = { mode: "project" as const, target: groupCandidate.locator, name: "导入示例项目" };
    await importW.makePlan(target);
    await importW.apply(target);
    expect(applyInputs).toHaveLength(1);
    expect(applyInputs[0]).toMatchObject({ planToken: expect.any(String), allowLossy: false });
    // memory.importApply 记录调用（可断言）
    expect(api.importApplyCalls).toEqual([
      { mode: "project", groupId: groupCandidate.id, name: "导入示例项目" },
    ]);
    // workspace.refresh 被触发：树中出现导入项目
    const refreshed = ws.tree!.children!.find((n) => n.id === groupCandidate.id)!;
    expect(refreshed.children!.map((n) => n.label)).toContain("导入示例项目");
    expect(importW.applying).toBe(false);

    let releaseOld!: () => void;
    let releaseCurrent!: () => void;
    let notifyOld!: () => void;
    let notifyCurrent!: () => void;
    const oldStarted = new Promise<void>((resolve) => { notifyOld = resolve; });
    const currentStarted = new Promise<void>((resolve) => { notifyCurrent = resolve; });
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    const currentGate = new Promise<void>((resolve) => { releaseCurrent = resolve; });
    const originalApply = api.importApply.bind(api);
    let delayedApply = 0;
    api.importApply = async (input) => {
      const result = await originalApply(input);
      if (delayedApply++ === 0) {
        notifyOld();
        await oldGate;
      } else {
        notifyCurrent();
        await currentGate;
      }
      return result;
    };
    const refreshedRoots: string[] = [];
    const originalRefresh = ws.refresh.bind(ws);
    ws.refresh = async () => {
      refreshedRoots.push(ws.root);
      await originalRefresh();
    };
    await importW.previewFile("old-root.yaml", "x");
    const oldTarget = { mode: "project" as const, target: groupCandidate.locator, name: "旧根迟到导入" };
    await importW.makePlan(oldTarget);
    const oldApply = importW.apply(oldTarget);
    await oldStarted;
    await ws.open("/tmp/ws-import-root-switch");
    importW.reset();
    await importW.previewFile("current-root.yaml", "x");
    const currentTarget = { mode: "project" as const, target: groupCandidate.locator, name: "当前根导入" };
    await importW.makePlan(currentTarget);
    const currentApply = importW.apply(currentTarget);
    await currentStarted;
    releaseOld();
    await expect(oldApply).rejects.toThrow(/工作区已变更/);
    expect(importW.applying).toBe(true);
    expect(refreshedRoots).toEqual([]);
    releaseCurrent();
    await currentApply;
    expect(refreshedRoots).toEqual([ws.root]);
    expect(importW.applying).toBe(false);
  });

  it("apply(module 模式) 把预览产物的集合并入目标项目并记录调用", async () => {
    const { api, ws } = await seeded();
    const importW = useImportWizardStore(api, ws);
    await importW.previewFile("sample.yaml", "x");
    const projectCandidate = ws.tree!.children
      .filter((group) => group.kind === "group")
      .flatMap((group) => group.children)
      .find((node) => node.kind === "project");
    if (!projectCandidate || projectCandidate.kind !== "project") throw new Error("Expected the project fixture to be present in the tree.");
    const applyInputs: Parameters<typeof api.importApply>[0][] = [];
    const originalImportApply = api.importApply.bind(api);
    api.importApply = async (input) => {
      applyInputs.push(input);
      return originalImportApply(input);
    };
    const target = { mode: "module" as const, target: projectCandidate.locator, name: "导入示例集合" };
    await importW.makePlan(target);
    await importW.apply(target);
    expect(applyInputs).toHaveLength(1);
    expect(applyInputs[0]).toMatchObject({ planToken: expect.any(String), allowLossy: false });
    expect(api.importApplyCalls).toEqual([
      { mode: "module", projectId: projectCandidate.id, name: "导入示例集合" },
    ]);
  });

  it("apply 未先 preview 时抛「尚无预览」；applying 状态不残留", async () => {
    const { api, ws } = await seeded();
    const importW = useImportWizardStore(api);
    const groupCandidate = ws.tree!.children!.find((n) => n.kind === "group");
    if (!groupCandidate || groupCandidate.kind !== "group") throw new Error("Expected the group fixture to be present in the tree.");
    await expect(importW.apply({ mode: "project", target: groupCandidate.locator, name: "x" })).rejects.toThrow(/预览/);
    expect(importW.applying).toBe(false);
  });

  it("apply(project 模式) 目标分组不存在时上抛「未找到分组」（轨二：分组按 id 选择）", async () => {
    const { api, ws } = await seeded();
    const importW = useImportWizardStore(api);
    await importW.previewFile("a.yaml", "x");
    await expect(importW.apply({ mode: "project", target: { workspaceId: ws.tree!.locator.workspaceId, groupId: "00000000-0000-4000-8000-000000000001" }, name: "x" })).rejects.toThrow(/Target group not found/);
  });

  it("reset 清空 preview（取消向导回第一步）", async () => {
    const { api } = await seeded();
    const importW = useImportWizardStore(api);
    await importW.previewFile("sample.yaml", "x");
    importW.reset();
    expect(importW.preview).toBeNull();
  });
});
