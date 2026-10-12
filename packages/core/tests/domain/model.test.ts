import { describe, expect, it } from "vitest";
import {
  ApiAssetSchema,
  CollectionSchema,
  ContractCollectionSchema,
  ContractFolderSchema,
  ContractProjectSchema,
  ContractWorkspaceSchema,
  FolderSchema,
  ProjectSchema,
  StressPolicySchema,
  TestCaseSchema,
  WorkspaceSchema,
} from "../../src/domain/model.js";

const id = "00000000-0000-4000-8000-000000000001";

function apiAsset() {
  return {
    contract: {
      formatVersion: 1 as const,
      id,
      metadata: { name: "lookup", description: "", tags: [], version: "1.0.0", status: "draft" as const },
      request: {
        protocol: "http" as const,
        method: "GET" as const,
        baseUrl: "https://example.test",
        path: "/items",
        pathParams: [],
        query: [],
        headers: [],
        cookies: [],
        auth: { kind: "none" as const },
        body: { kind: "none" as const },
      },
      responses: [],
    },
    cases: [{
      id: "case-1",
      name: "default",
      scope: "base",
      parameters: {},
      preOperations: [],
      postOperations: [],
      assertions: [],
    }],
    documentation: "",
  };
}

describe("共享叶子域", () => {
  it("TestCase 只接受 operation 列表，拒绝旧脚本字段", () => {
    const currentShape = {
      id: "case-1",
      name: "case",
      scope: "base",
      parameters: {},
      preOperations: [{ id: "pre-1", type: "script", content: "prepare" }],
      postOperations: [],
      assertions: [],
    };

    expect(TestCaseSchema.parse(currentShape).preOperations).toEqual([
      { id: "pre-1", type: "script", content: "prepare" },
    ]);
    expect(TestCaseSchema.safeParse({ ...currentShape, preScript: "legacy" }).success).toBe(false);
    expect(TestCaseSchema.safeParse({ ...currentShape, postScript: "legacy" }).success).toBe(false);
  });

  it("共享 stress policy schema 规范化 origins 并返回校验 issue", () => {
    expect(StressPolicySchema.parse({
      trustedOrigins: ["HTTPS://Example.COM:443/path", "https://example.com"],
      deniedOrigins: ["http://127.0.0.1:80/a"],
      maxConcurrency: 4,
      maxRps: 12.5,
    })).toEqual({
      trustedOrigins: ["https://example.com"],
      deniedOrigins: ["http://127.0.0.1"],
      maxConcurrency: 4,
      maxRps: 12.5,
    });
    expect(StressPolicySchema.safeParse({ trustedOrigins: ["ftp://example.test"] }).success).toBe(false);
  });
});

describe("标准 contract 域聚合", () => {
  it("聚合入口接受 ApiAsset 而不是旧内联 API 形状", () => {
    const asset = apiAsset();

    expect(ApiAssetSchema.safeParse(asset).success).toBe(true);
    expect(ApiAssetSchema.safeParse({ ...asset, cases: [{ ...asset.cases[0], preScript: "legacy" }] }).success).toBe(false);
  });

  it("公开容器名指向同一套 versioned schema", () => {
    expect(WorkspaceSchema).toBe(ContractWorkspaceSchema);
    expect(ProjectSchema).toBe(ContractProjectSchema);
    expect(CollectionSchema).toBe(ContractCollectionSchema);
    expect(FolderSchema).toBe(ContractFolderSchema);
  });

  it("project 输出 models/components，collection 与 folder 保存 ApiAsset", () => {
    const projectInput = {
      id,
      name: "project",
      variables: {},
      globals: {},
    };
    const project = ProjectSchema.parse(projectInput);
    expect(project.models).toEqual([]);
    expect(project.components).toEqual([]);
    expect(project.stressPolicy).toEqual({ trustedOrigins: [], deniedOrigins: [] });

    const normalizedProject = ProjectSchema.parse({
      ...projectInput,
      stressPolicy: {
        trustedOrigins: ["HTTPS://Example.COM:443/path", "https://example.com"],
        deniedOrigins: ["http://127.0.0.1:80/a", "http://127.0.0.1"],
      },
    });
    expect(normalizedProject.stressPolicy).toEqual({
      trustedOrigins: ["https://example.com"],
      deniedOrigins: ["http://127.0.0.1"],
    });
    expect(ProjectSchema.safeParse({ ...projectInput, stressPolicy: { trustedOrigins: ["ftp://example.test"] } }).success).toBe(false);

    const asset = apiAsset();
    const collection = CollectionSchema.parse({
      id,
      name: "collection",
      apis: [asset],
      folders: [{ id: "00000000-0000-4000-8000-000000000002", name: "folder", apis: [asset] }],
    });
    expect(collection.apis[0]).toEqual(asset);
    expect(collection.folders[0].apis[0]).toEqual(asset);
    expect(CollectionSchema.safeParse({
      id,
      name: "legacy",
      scripts: { pre: "legacy" },
    }).success).toBe(false);
  });

  it("workspace 要求 formatVersion 1", () => {
    const parsed = WorkspaceSchema.parse({ formatVersion: 1, id, name: "workspace", variables: {} });
    expect(parsed.formatVersion).toBe(1);
    expect(WorkspaceSchema.safeParse({ ...parsed, formatVersion: 2 }).success).toBe(false);
  });
});
