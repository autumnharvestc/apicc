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

  it("apply(project 模式) 调 api.importApply（记录调用可断言）后触发 workspace.refresh，树中出现导入项目", async () => {
    const { api, ws } = await seeded();
    const importW = useImportWizardStore(api, ws);
    await importW.previewFile("sample.yaml", "x");
    // 先建一个目标分组拿 id（轨二：分组按 id 选择，不再按名称缺省创建）
    const groupNode = ws.tree!.children!.find((n) => n.kind === "group")!;
    await importW.apply({ mode: "project", groupId: groupNode.id, name: "导入示例项目" });
    // memory.importApply 记录调用（可断言）
    expect(api.importApplyCalls).toEqual([
      { mode: "project", groupId: groupNode.id, name: "导入示例项目" },
    ]);
    // workspace.refresh 被触发：树中出现导入项目
    const refreshed = ws.tree!.children!.find((n) => n.id === groupNode.id)!;
    expect(refreshed.children!.map((n) => n.label)).toContain("导入示例项目");
    expect(importW.applying).toBe(false);
  });

  it("apply(module 模式) 把预览产物的集合并入目标项目并记录调用", async () => {
    const { api, ws } = await seeded();
    const importW = useImportWizardStore(api, ws);
    await importW.previewFile("sample.yaml", "x");
    const projectNode = ws.tree!.children![0]!.children!.find((n) => n.kind === "project")!;
    await importW.apply({ mode: "module", projectId: projectNode.id, name: "导入示例集合" });
    expect(api.importApplyCalls).toEqual([
      { mode: "module", projectId: projectNode.id, name: "导入示例集合" },
    ]);
  });

  it("apply 未先 preview 时抛「尚无预览」；applying 状态不残留", async () => {
    const { api } = await seeded();
    const importW = useImportWizardStore(api);
    await expect(importW.apply({ mode: "project", groupId: "g", name: "x" })).rejects.toThrow(/预览/);
    expect(importW.applying).toBe(false);
  });

  it("apply(project 模式) 目标分组不存在时上抛「未找到分组」（轨二：分组按 id 选择）", async () => {
    const { api } = await seeded();
    const importW = useImportWizardStore(api);
    await importW.previewFile("a.yaml", "x");
    await expect(importW.apply({ mode: "project", groupId: "ghost", name: "x" })).rejects.toThrow(/未找到分组/);
  });

  it("reset 清空 preview（取消向导回第一步）", async () => {
    const { api } = await seeded();
    const importW = useImportWizardStore(api);
    await importW.previewFile("sample.yaml", "x");
    importW.reset();
    expect(importW.preview).toBeNull();
  });
});
