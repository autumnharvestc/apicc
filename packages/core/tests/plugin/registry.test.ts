import { describe, expect, it } from "vitest";
import { createPluginRegistry } from "../../src/plugin/registry.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProtocolClient } from "../../src/plugin/types.js";
import { fileStorage } from "../../src/storage/fileStorage.js";
import { ContractWorkspaceSchema } from "../../src/contract/workspace.js";
import { workspaceFixture } from "../helpers/contractFixtures.js";
import { createPluginCatalog } from "../../src/plugin/catalog.js";
import { installSdkContributions } from "../../src/plugin/sdkAdapter.js";
import type { AssertContributionV1, PluginManifestV1 } from "@apicc/plugin-sdk";

const demoManifest: PluginManifestV1 = {
  manifestVersion: 1, id: "example.demo", name: "apicc-plugin-demo", version: "0.1.0",
  apiVersion: 1, engines: { apicc: ">=0.1.0 <0.2.0" }, entry: "./dist/index.js",
  capabilities: ["assert"], contributions: [{ kind: "assert", id: "example.demo/assert.has-field" }],
};
const demoAssert: AssertContributionV1 = {
  kind: "assert", id: "example.demo/assert.has-field",
  evaluate(actual, expected) {
    const pass = actual !== null && typeof actual === "object" && !Array.isArray(actual)
      && expected !== undefined && Object.hasOwn(actual, expected);
    return { pass, message: pass ? "包含字段" : "缺少字段" };
  },
};

const fakeAssert = {
  op: "eq",
  evaluate: (actual: unknown, expected?: string) => ({
    pass: String(actual) === expected,
    message: "eq",
  }),
};

describe("PluginRegistry", () => {
  it("publishes only complete SDK transactions and preserves prior contributions", () => {
    const reg = createPluginRegistry();
    reg.registerAssert(fakeAssert);
    const catalog = createPluginCatalog();
    installSdkContributions(reg, catalog, {});
    const failed = catalog.begin(demoManifest, {});
    try { failed.context.register(demoAssert); throw new Error("setup failed"); }
    catch { failed.abort(); }
    expect(reg.getAssert(demoAssert.id)).toBeUndefined();
    expect(reg.getAssert("eq")).toBe(fakeAssert);
    expect(() => failed.context.register(demoAssert)).toThrow();
    expect.soft(() => failed.context.register(demoAssert)).toThrowError(expect.objectContaining({ code: "registration_closed" }));
    const missing = catalog.begin(demoManifest, {});
    expect.soft(() => missing.commit()).toThrowError(expect.objectContaining({ code: "contribution_invalid" }));
    const poisoned = catalog.begin(demoManifest, {});
    poisoned.context.register(demoAssert);
    expect(() => poisoned.context.register(demoAssert)).toThrow();
    expect(() => poisoned.commit()).toThrow();
    expect(catalog.summary()).toEqual([]);
    const good = catalog.begin(demoManifest, {});
    const competing = catalog.begin(demoManifest, {});
    competing.context.register(demoAssert);
    good.context.register(demoAssert);
    const original = demoAssert.evaluate;
    demoAssert.evaluate = () => ({ pass: false, message: "mutated" });
    good.commit();
    demoAssert.evaluate = original;
    expect(() => competing.commit()).toThrow();
    expect(reg.getAssert(demoAssert.id)?.evaluate({ name: "Ada" }, "name").pass).toBe(true);
    expect(() => catalog.begin(demoManifest, {}).commit()).toThrow();
    expect(reg.listAsserts()).toHaveLength(2);
    expect(catalog.contributions()).toEqual([{ kind: "assert", id: demoAssert.id }]);
  });
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
