// @vitest-environment jsdom
// 注：与 App.test.ts 相同，渲染层测试使用文件级 pragma 指定 jsdom 环境（i18n 初值依赖 localStorage/navigator）。
import { describe, expect, it } from "vitest";
// 注：本文件位于 tests/renderer/i18n/（两层），需三层向上才到 src/renderer/src/。
import zh from "../../../src/renderer/src/i18n/zh-CN.json";
import en from "../../../src/renderer/src/i18n/en.json";

function flatKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === "object" && v !== null ? flatKeys(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

describe("i18n 键位齐全性", () => {
  it("zh-CN 与 en 键集合完全一致", () => {
    expect(flatKeys(en).sort()).toEqual(flatKeys(zh).sort());
  });
  it("包含任务 5-7 需要的核心键", () => {
    const keys = flatKeys(zh);
    for (const key of ["app.openWorkspace", "app.newWorkspace", "app.language", "app.theme",
      "tree.newGroup", "tree.newProject", "tree.newCollection", "tree.newApi", "tree.delete",
      "editor.send", "editor.method", "editor.url", "editor.params", "editor.headers",
      "editor.auth", "editor.body", "editor.save", "response.status", "response.body",
      "response.headers", "response.assertions", "response.empty", "workspace.problems"]) {
      expect(keys, `缺少键: ${key}`).toContain(key);
    }
  });
  it("包含任务 8 视图切换与详细设计的核心键", () => {
    const keys = flatKeys(zh);
    for (const key of ["nav.debug", "nav.cases", "nav.envs", "nav.run", "nav.import", "nav.design",
      "design.save", "design.saved", "design.export", "design.exported", "design.empty"]) {
      expect(keys, `缺少键: ${key}`).toContain(key);
    }
  });
  it("包含 M6-C AI 配置与建议采用的核心键（zh/en 成对由第一条用例保证）", () => {
    const keys = flatKeys(zh);
    for (const key of ["ai.suggestBtn", "ai.configBtn", "ai.configTitle", "ai.baseUrl", "ai.model",
      "ai.apiKey", "ai.keyPlaceholder", "ai.keySavedPlaceholder", "ai.hasKey", "ai.save", "ai.saved",
      "ai.test", "ai.testOk", "ai.testFail", "ai.baseUrlRequired", "ai.modelRequired",
      "ai.drawerTitle", "ai.sourceTag", "ai.colName", "ai.colScope", "ai.colAssertions",
      "ai.adopt", "ai.empty"]) {
      expect(keys, `缺少键: ${key}`).toContain(key);
    }
  });
});
