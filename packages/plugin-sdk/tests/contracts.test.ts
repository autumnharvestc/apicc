import { describe, expect, it } from "vitest";
import {
  definePlugin, validatePluginConfig, validatePluginManifest,
  type AssertContributionV1, type PluginManifestV1, type PluginSetupContextV1,
} from "../src/index.js";
import { checkPluginContract } from "../src/testing.js";

const demoManifest: PluginManifestV1 = {
  manifestVersion: 1, id: "example.demo", name: "apicc-plugin-demo", version: "0.1.0",
  apiVersion: 1, engines: { apicc: ">=0.1.0 <0.2.0" }, entry: "./dist/index.js",
  capabilities: ["assert"],
  contributions: [{ kind: "assert", id: "example.demo/assert.has-field" }],
};
const demoAssert: AssertContributionV1 = {
  kind: "assert", id: "example.demo/assert.has-field",
  evaluate(actual, expected) {
    const pass = actual !== null && typeof actual === "object" && !Array.isArray(actual)
      && expected !== undefined && Object.hasOwn(actual, expected);
    return { pass, message: pass ? "包含字段" : "缺少字段" };
  },
};

describe("SDK author contracts", () => {
  it("collects a real assertion that distinguishes present and missing fields", () => {
    const check = checkPluginContract(definePlugin({
      manifest: demoManifest,
      setup(ctx) { ctx.register(demoAssert); },
    }), { config: {} });
    expect(check.ok).toBe(true);
    const operator = check.contributions.find(value => value.kind === "assert");
    expect(operator?.kind).toBe("assert");
    if (operator?.kind !== "assert") throw new Error("assert contribution missing");
    const context = { found: true, getModel: () => undefined };
    expect(operator.evaluate({ value: 1 }, "value", context).pass).toBe(true);
    expect(operator.evaluate({}, "value", context).pass).toBe(false);
  });

  it("rejects missing required config before setup and applies declared defaults", () => {
    const manifest: PluginManifestV1 = { ...demoManifest, configSchema: { fields: {
      prefix: { type: "string", required: true },
      limit: { type: "number", required: true, default: 3 },
      mode: { type: "enum", values: ["strict", "loose"], default: "strict" },
      enabled: { type: "boolean", default: true },
    } } };
    let setupCount = 0;
    const plugin = definePlugin({ manifest, setup(ctx) {
      setupCount++;
      expect(ctx.config).toEqual({ prefix: "x", limit: 3, mode: "strict", enabled: true });
      ctx.register(demoAssert);
    } });
    const missing = checkPluginContract(plugin, { config: {} });
    expect(missing.ok).toBe(false);
    expect(missing.problems).toContainEqual(expect.objectContaining({ code: "invalid_config", path: "config.prefix" }));
    expect(setupCount).toBe(0);
    expect(checkPluginContract(plugin, { config: { prefix: "x" } }).ok).toBe(true);
    expect(setupCount).toBe(1);
  });

  it("rejects unknown config, nonfinite numbers and values outside enum choices", () => {
    expect(validatePluginConfig(demoManifest, { surprise: true }).ok).toBe(false);
    expect(checkPluginContract(definePlugin({ manifest: demoManifest, setup(ctx) {
      ctx.register(demoAssert);
    } }), { config: null as never }).ok).toBe(false);
    const manifest: PluginManifestV1 = { ...demoManifest, configSchema: { fields: {
      count: { type: "number" }, mode: { type: "enum", values: ["strict"] },
    } } };
    const invalid = validatePluginConfig(manifest, { count: Infinity, mode: "loose", extra: 1 });
    expect(invalid.problems.map(problem => problem.path)).toEqual(["config.extra", "config.count", "config.mode"]);
  });

  it.each([
    { ...demoManifest, id: "apicc.reserved" },
    { ...demoManifest, contributions: [{ kind: "assert", id: "other.demo/assert.has-field" }] },
    { ...demoManifest, capabilities: ["storage"] },
    { ...demoManifest, configSchema: { fields: { mode: { type: "enum", values: [], default: "x" } } } },
    { ...demoManifest, configSchema: { fields: { mode: { type: ["string"] } } } },
  ])("rejects invalid static metadata without executing setup: %j", manifest => {
    expect(validatePluginManifest(manifest).ok).toBe(false);
  });

  it("rejects incomplete, duplicate, undeclared and malformed contributions", () => {
    for (const register of [
      (_ctx: PluginSetupContextV1) => {},
      (ctx: PluginSetupContextV1) => { ctx.register(demoAssert); ctx.register(demoAssert); },
      (ctx: PluginSetupContextV1) => { ctx.register({ ...demoAssert, id: "example.demo/assert.extra" }); },
      (ctx: PluginSetupContextV1) => { ctx.register({ kind: "assert", id: demoAssert.id } as AssertContributionV1); },
      (ctx: PluginSetupContextV1) => { ctx.register({ ...demoAssert, descriptor: { expectedFormat: ["text"] as never } }); },
    ]) {
      const checked = checkPluginContract(definePlugin({ manifest: demoManifest, setup: register }));
      expect(checked.ok).toBe(false);
      expect(checked.contributions).toEqual([]);
    }
  });

  it("rejects thrown and asynchronous setup without publishing contributions", async () => {
    const thrown = checkPluginContract(definePlugin({ manifest: demoManifest, setup(ctx) {
      ctx.register(demoAssert);
      throw new Error("fixture failure");
    } }));
    expect(thrown.ok).toBe(false);
    expect(thrown.problems).toContainEqual(expect.objectContaining({ code: "setup_failed" }));
    expect(thrown.contributions).toEqual([]);
    let lateContext: PluginSetupContextV1 | undefined;
    const asynchronous = checkPluginContract(definePlugin({ manifest: demoManifest, async setup(ctx) {
      lateContext = ctx;
      ctx.register(demoAssert);
      await Promise.resolve();
    } }));
    expect(asynchronous.ok).toBe(false);
    expect(asynchronous.contributions).toEqual([]);
    expect(() => lateContext?.register(demoAssert)).toThrow(/closed/);
    await Promise.resolve();
  });

  it("rejects a contribution changed to an undeclared id after registration", () => {
    const contribution: AssertContributionV1 = { ...demoAssert };
    const checked = checkPluginContract(definePlugin({
      manifest: demoManifest,
      setup(ctx) {
        ctx.register(contribution);
        contribution.id = "example.demo/assert.extra";
      },
    }));
    expect(checked.ok).toBe(false);
    expect(checked.problems).toContainEqual(expect.objectContaining({ code: "contribution_invalid" }));
    expect(checked.contributions).toEqual([]);
  });
});
