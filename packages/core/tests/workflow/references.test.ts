import { describe, expect, it } from "vitest";
import type { ApiDefinition, Collection, Project, TestCase } from "../../src/domain/model.js";
import { findProjectApi, selectWorkflowCollection } from "../../src/workflow/references.js";

const testCase = (id: string): TestCase => ({ id, name: id, scope: "base", parameters: {}, assertions: [] });
const api = (id: string): ApiDefinition => ({
  id, name: id, version: "1", deprecated: false, method: "GET", url: "/", headers: [], query: [], cases: [testCase(`case-${id}`)],
});

describe("workflow project references", () => {
  it("递归定位目标 API 并保留从集合到两层文件夹的祖先链", () => {
    const target = api("target");
    const inner = { id: "inner", name: "inner", apis: [target], folders: [], preOperations: [{ id: "inner-pre", type: "script" as const, content: "" }], postOperations: [{ id: "inner-post", type: "script" as const, content: "" }] };
    const outer = { id: "outer", name: "outer", apis: [], folders: [inner], preOperations: [{ id: "outer-pre", type: "script" as const, content: "" }], postOperations: [{ id: "outer-post", type: "script" as const, content: "" }] };
    const collection: Collection = {
      id: "module", name: "module", variables: { moduleVar: "yes" }, preOperations: [{ id: "module-pre", type: "script", content: "" }], postOperations: [{ id: "module-post", type: "script", content: "" }],
      apis: [], folders: [outer],
    };
    const project: Project = { id: "project", name: "project", variables: {}, environments: [], collections: [collection], workflows: [] };
    const location = findProjectApi(project, "target");
    expect(location?.api).toBe(target);
    expect(location?.collection).toBe(collection);
    expect(location?.folders.map((folder) => folder.id)).toEqual(["outer", "inner"]);
  });

  it("裁剪为唯一目标 API/用例而不原地修改源模块，并保留容器操作与模块 ID", () => {
    const target = api("target");
    const other = api("other");
    const inner = { id: "inner", name: "inner", apis: [target, other], folders: [], preOperations: [{ id: "inner-pre", type: "script" as const, content: "" }], postOperations: [{ id: "inner-post", type: "script" as const, content: "" }] };
    const collection: Collection = {
      id: "module", name: "module", variables: { moduleVar: "yes" }, preOperations: [{ id: "module-pre", type: "script", content: "" }], postOperations: [{ id: "module-post", type: "script", content: "" }],
      apis: [api("top")], folders: [{ id: "outer", name: "outer", apis: [], folders: [inner], preOperations: [{ id: "outer-pre", type: "script", content: "" }], postOperations: [{ id: "outer-post", type: "script", content: "" }] }],
    };
    const project: Project = { id: "project", name: "project", variables: {}, environments: [], collections: [collection], workflows: [] };
    const location = findProjectApi(project, "target")!;
    const selected = selectWorkflowCollection(location, target.cases[0]!);
    expect(selected.id).toBe("module");
    expect(selected.variables).toEqual(collection.variables);
    expect(selected.preOperations).toEqual(collection.preOperations);
    expect(selected.postOperations).toEqual(collection.postOperations);
    expect(selected.apis).toHaveLength(0);
    expect(selected.folders).toHaveLength(1);
    expect(selected.folders[0]!.preOperations).toEqual(collection.folders[0]!.preOperations);
    expect(selected.folders[0]!.folders?.[0]!.postOperations).toEqual(inner.postOperations);
    expect(selected.folders[0]!.folders?.[0]!.apis.map((candidate) => candidate.id)).toEqual(["target"]);
    expect(selected.folders[0]!.folders?.[0]!.apis[0]!.cases).toEqual([target.cases[0]]);
    expect(collection.folders[0]!.folders?.[0]!.apis.map((candidate) => candidate.id)).toEqual(["target", "other"]);
  });
});
