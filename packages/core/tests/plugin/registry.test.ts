import { describe, expect, it } from "vitest";
import { createPluginRegistry } from "../../src/plugin/registry.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProtocolClient } from "../../src/plugin/types.js";
import { fileStorage } from "../../src/storage/fileStorage.js";
import { ContractWorkspaceSchema } from "../../src/contract/workspace.js";
import { workspaceFixture } from "../helpers/contractFixtures.js";

const fakeAssert = {
  op: "eq",
  evaluate: (actual: unknown, expected?: string) => ({
    pass: String(actual) === expected,
    message: "eq",
  }),
};

describe("PluginRegistry", () => {
  it("注册、获取、注销断言操作符", () => {
    const reg = createPluginRegistry();
    reg.registerAssert(fakeAssert);
    expect(reg.getAssert("eq")).toBe(fakeAssert);
    reg.registerAssert({ ...fakeAssert, op: "neq" });
    expect(reg.listAsserts()).toHaveLength(2);
  });

  it("同名覆盖时保留最后注册者", () => {
    const reg = createPluginRegistry();
    reg.registerScriptEngine({ language: "javascript", run: () => {} });
    const second = { language: "javascript", run: () => { /* v2 */ } };
    reg.registerScriptEngine(second);
    expect(reg.getScriptEngine("javascript")).toBe(second);
  });

  it("不同 name 的协议客户端互不覆盖", () => {
    const reg = createPluginRegistry();
    const first: ProtocolClient = {
      name: "first",
      canHandle: () => true,
      execute: async () => ({ status: 200, headers: {}, bodyText: "", timeMs: 0 }),
    };
    reg.registerProtocol(first);
    reg.registerProtocol({ name: "second", canHandle: () => false, execute: async () => ({ status: 200, headers: {}, bodyText: "", timeMs: 0 }) });
    expect(reg.getProtocol({ protocol: "http", method: "GET", url: "https://example.com", headers: {}, query: [], auth: { kind: "none" } })).toBe(first);
  });

  it("plugin(def) 执行 setup 完成自注册", () => {
    const reg = createPluginRegistry();
    reg.plugin({
      name: "my-assert", version: "1.0.0",
      setup(ctx) { ctx.registry.registerAssert(fakeAssert); },
    });
    expect(reg.getAssert("eq")).toBeDefined();
  });

  it("registers a StorageAdapter that reads and writes the versioned workspace contract", async () => {
    const reg = createPluginRegistry();
    reg.plugin({
      name: "contract-storage",
      version: "1.0.0",
      setup(ctx) { ctx.registry.registerStorage(fileStorage); },
    });
    const storage = reg.getStorage();
    expect(storage).toBe(fileStorage);
    if (!storage) throw new Error("Storage plugin did not register its adapter");

    const workspace = ContractWorkspaceSchema.parse(workspaceFixture());
    const root = mkdtempSync(join(tmpdir(), "apicc-registry-storage-"));
    const saved = await storage.save(root, workspace, { expectedRevision: "empty", deletions: [] });
    const loaded = await storage.load(root);

    expect(loaded.workspace).toEqual(workspace);
    expect(loaded.revision).toBe(saved.revision);
    expect(loaded.readOnly).toBe(false);
  });
});
