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

  it("previewFile 调 api.importPreview 并把返回结构入状态", async () => {
    const { api } = await seeded();
    const importW = useImportWizardStore(api);
    const preview = await importW.previewFile("sample.yaml", "openapi: 3.0.0");
    expect(importW.preview).toEqual(preview);
    // memory 替身固定样例：importerName/project.name/warnings 可断言
    expect(importW.preview!.importerName).toBe("sample");
    expect(importW.preview!.project.name).toBe("导入示例项目");
    expect(importW.preview!.warnings).toEqual(["示例警告"]);
  });

  it("apply 调 api.importApply（记录调用可断言）后触发 workspace.refresh，树中出现导入项目", async () => {
    const { api, ws } = await seeded();
    const importW = useImportWizardStore(api, ws);
    await importW.previewFile("sample.yaml", "x");
    await importW.apply("导入分组");
    // memory.importApply 记录调用（可断言）
    expect(api.importApplyCalls).toEqual([{ groupName: "导入分组", projectName: "导入示例项目" }]);
    // workspace.refresh 被触发：树中出现新分组与导入项目
    const groupNode = ws.tree!.children!.find((n) => n.label === "导入分组");
    expect(groupNode).toBeDefined();
    expect(groupNode!.children!.map((n) => n.label)).toContain("导入示例项目");
    expect(importW.applying).toBe(false);
  });

  it("apply 未先 preview 时抛「尚无预览」；applying 状态不残留", async () => {
    const { api } = await seeded();
    const importW = useImportWizardStore(api);
    await expect(importW.apply("g")).rejects.toThrow(/预览/);
    expect(importW.applying).toBe(false);
  });

  it("apply 目标分组已有同名项目时上抛「项目已存在」（与 session 语义对齐）", async () => {
    const { api } = await seeded();
    const importW = useImportWizardStore(api);
    await importW.previewFile("a.yaml", "x");
    await importW.apply("g");
    await expect(importW.apply("g")).rejects.toThrow(/项目已存在/);
  });

  it("reset 清空 preview（取消向导回第一步）", async () => {
    const { api } = await seeded();
    const importW = useImportWizardStore(api);
    await importW.previewFile("sample.yaml", "x");
    importW.reset();
    expect(importW.preview).toBeNull();
  });
});
