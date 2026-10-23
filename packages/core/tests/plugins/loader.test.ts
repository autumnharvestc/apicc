import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createPluginRegistry } from "../../src/plugin/registry.js";
import { loadUserPlugins as coreLoadUserPlugins } from "../../src/plugins/loader.js";
import { assertPluginRuntimeSnapshot, createUserPluginHost, createUserPluginHostFromSnapshot } from "../../src/plugins/runtime.js";
import type { PluginDefinitionV1, PluginManifestV1 } from "@apicc/plugin-sdk";

const fixturesDir = fileURLToPath(new URL("./fixtures", import.meta.url));
// This fixture is a product composition root with its own actual product version.
const loadUserPlugins: typeof coreLoadUserPlugins = (registry, options) => coreLoadUserPlugins(registry, { hostVersion: "0.1.0", ...options });

const demoManifest: PluginManifestV1 = {
  manifestVersion: 1, id: "example.demo", name: "apicc-plugin-demo", version: "0.1.0",
  apiVersion: 1, engines: { apicc: ">=0.1.0 <0.2.0" }, entry: "./index.js",
  capabilities: ["assert"], contributions: [{ kind: "assert", id: "example.demo/assert.has-field" }],
};

describe("loadUserPlugins 静态准入", () => {
  it.each([
    ["api_incompatible", { apiVersion: 2 }],
    ["host_incompatible", { engines: { apicc: ">=0.2.0 <0.3.0" } }],
    ["unsupported_capability", { capabilities: ["future"] }],
  ])("%s 在 import/setup 前拒绝", async (code, override) => {
    const home = mkdtempSync(join(tmpdir(), "apicc-f7a-loader-"));
    const dir = join(home, "demo"); mkdirSync(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: demoManifest.name, version: "0.1.0", type: "module" }));
    writeFileSync(join(dir, "apicc-plugin.json"), JSON.stringify({ ...demoManifest, ...override }));
    writeFileSync(join(dir, "index.js"), "export const plugin = {};\n");
    writeManifest(home, JSON.stringify({ plugins: [dir] }));
    let imports = 0; let setups = 0;
    const result = await loadUserPlugins(createPluginRegistry(), { homeDir: home, hostVersion: "0.1.0",
      importFn: async () => { imports++; return { plugin: { name: "demo", version: "0.1.0", setup() { setups++; } } }; },
    });
    expect(imports).toBe(0); expect(setups).toBe(0);
    expect(result.problems[0]?.code).toBe(code);
  });

  it("同一插件静态冲突不再次 import/setup，摘要仅计算已提交贡献", async () => {
    const home = mkdtempSync(join(tmpdir(), "apicc-f7a-loader-"));
    const source = join(fixturesDir, "named-plugin");
    writeManifest(home, JSON.stringify({ plugins: [source, source] }));
    let imports = 0; let setups = 0;
    const registry = createPluginRegistry();
    const manifest = { ...demoManifest, id: "fixture.named", name: "named-fixture", version: "1.0.0", contributions: [{ kind: "assert" as const, id: "fixture.named/assert.eq" as const }] };
    const result = await loadUserPlugins(registry, { homeDir: home, hostVersion: "0.1.0", importFn: async () => {
      imports++; return { plugin: { manifest, setup(ctx: import("@apicc/plugin-sdk").PluginSetupContextV1) {
        setups++; ctx.register({ kind: "assert", id: "fixture.named/assert.eq", evaluate: () => ({ pass: true, message: "ok" }) });
      } } };
    } });
    expect(imports).toBe(1); expect(setups).toBe(1);
    expect(result.problems[0]?.code).toBe("contribution_conflict");
    expect(result.loaded).toHaveLength(1); expect(result.loaded[0]?.contributions.asserts).toBe(1);
    expect(registry.getAssert("fixture.named/assert.eq")).toBeDefined();
  });

  it.each(["throw", "thenable", "missing", "extra", "mismatch"])("%s 失败后无贡献残留并继续后续好插件", async failure => {
    const home = mkdtempSync(join(tmpdir(), "apicc-f7a-loader-"));
    const dir = join(home, "demo"); mkdirSync(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: demoManifest.name, version: "0.1.0" }));
    writeFileSync(join(dir, "apicc-plugin.json"), JSON.stringify(demoManifest));
    writeFileSync(join(dir, "index.js"), "// injected\n");
    writeManifest(home, JSON.stringify({ plugins: [dir, join(fixturesDir, "named-plugin")] }));
    const registry = createPluginRegistry(); let calls = 0; let setups = 0;
    const result = await loadUserPlugins(registry, { homeDir: home, hostVersion: "0.1.0", importFn: async specifier => {
      if (calls++ > 0) return import(specifier);
      return { plugin: { manifest: failure === "mismatch" ? { ...demoManifest, version: "0.1.1" } : demoManifest,
        setup(ctx: import("@apicc/plugin-sdk").PluginSetupContextV1) {
          setups++;
          if (failure !== "missing") ctx.register({ kind: "assert", id: "example.demo/assert.has-field", evaluate: () => ({ pass: true, message: "bad" }) });
          if (failure === "throw") throw Error("boom");
          if (failure === "thenable") return { then() {} };
          if (failure === "extra") ctx.register({ kind: "assert", id: "example.demo/assert.extra", evaluate: () => ({ pass: true, message: "bad" }) });
        } } };
    } });
    expect(result.loaded.map(p => p.name)).toEqual(["named-fixture"]);
    expect(registry.getAssert("example.demo/assert.has-field")).toBeUndefined();
    expect(registry.getAssert("fixture.named/assert.eq")).toBeDefined();
    expect(result.problems[0]?.code).toBe(failure === "mismatch" ? "definition_mismatch" : failure === "missing" || failure === "extra" ? "contribution_invalid" : "setup_failed");
    expect(setups).toBe(failure === "mismatch" ? 0 : 1);
  });

  it("旧 JS 入口无静态清单明确拒绝，禁用项在定位/import前跳过", async () => {
    const home = mkdtempSync(join(tmpdir(), "apicc-f7a-loader-"));
    const legacy = join(home, "old.js"); writeFileSync(legacy, "throw Error('must not import');");
    writeManifest(home, JSON.stringify({ plugins: [{ source: "absent", enabled: false }, legacy] }));
    let imports = 0;
    const result = await loadUserPlugins(createPluginRegistry(), { homeDir: home, hostVersion: "0.1.0", importFn: async () => { imports++; return {}; } });
    expect(imports).toBe(0); expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.code).toBe("manifest_missing");
  });

  it("显式null配置在import前拒绝，不能被当作默认空配置", async () => {
    const home = mkdtempSync(join(tmpdir(), "apicc-f7a-loader-")); let imports = 0;
    writeManifest(home, JSON.stringify({ plugins: [{ source: join(fixturesDir, "named-plugin"), config: null }] }));
    const result = await loadUserPlugins(createPluginRegistry(), { homeDir: home, importFn: async () => { imports++; return {}; } });
    expect(result.problems[0]?.code).toBe("invalid_config"); expect(imports).toBe(0);
  });
});

/** 在注入的用户级目录写清单 <home>/.apicc/plugins.json（规格 D1 形状）。 */
function writeManifest(home: string, content: string): string {
  mkdirSync(join(home, ".apicc"), { recursive: true });
  const file = join(home, ".apicc", "plugins.json");
  writeFileSync(file, content);
  return file;
}

/** 在 home 下造一个仅具名 plugin 导出的极简本地插件目录，返回绝对路径。 */
function makeLocalPlugin(home: string, dirName: string, name: string, op: string): string {
  const dir = join(home, "my-plugins", dirName);
  mkdirSync(dir, { recursive: true });
  const manifest = { ...demoManifest, id: `fixture.${dirName}`, name, version: "2.0.0",
    contributions: [{ kind: "assert", id: `fixture.${dirName}/assert.${op.toLowerCase()}` }] };
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "2.0.0", private: true, type: "module" }));
  writeFileSync(join(dir, "apicc-plugin.json"), JSON.stringify(manifest));
  writeFileSync(
    join(dir, "index.js"),
    `export const plugin = { manifest: ${JSON.stringify(manifest)},`
    + ` setup(ctx) { ctx.register({ kind: "assert", id: ${JSON.stringify(manifest.contributions[0].id)},`
    + " evaluate: () => ({ pass: true, message: \"local\" }) }); } };",
  );
  return dir;
}

describe("loadUserPlugins 清单读取", () => {
  it("清单不存在 → 空清单零加载、零问题、不报错", async () => {
    const home = mkdtempSync(join(tmpdir(), "apicc-plugins-"));
    const registry = createPluginRegistry();
    const res = await loadUserPlugins(registry, { homeDir: home });
    expect(res.loaded).toEqual([]);
    expect(res.problems).toEqual([]);
  });

  it("清单非法 JSON → 单条 LoadProblem（定位到清单文件），不加载", async () => {
    const home = mkdtempSync(join(tmpdir(), "apicc-plugins-"));
    const file = writeManifest(home, "{ 这不是 JSON");
    const res = await loadUserPlugins(createPluginRegistry(), { homeDir: home });
    expect(res.loaded).toEqual([]);
    expect(res.problems).toHaveLength(1);
    expect(res.problems[0]!.file).toBe(file);
    expect(res.problems[0]!.message).toContain("JSON");
  });

  it("plugins 字段非数组 → 单条 LoadProblem，不加载", async () => {
    const home = mkdtempSync(join(tmpdir(), "apicc-plugins-"));
    writeManifest(home, JSON.stringify({ plugins: "sample-plugin" }));
    const res = await loadUserPlugins(createPluginRegistry(), { homeDir: home });
    expect(res.loaded).toEqual([]);
    expect(res.problems).toHaveLength(1);
    expect(res.problems[0]!.message).toContain("plugins");
  });
});

describe("loadUserPlugins 加载与失败隔离", () => {
  it("本地路径插件（具名 plugin 导出）加载成功，setup 收到注册面且贡献生效、计数正确", async () => {
    const home = mkdtempSync(join(tmpdir(), "apicc-plugins-"));
    writeManifest(home, JSON.stringify({ plugins: [join(fixturesDir, "named-plugin")] }));
    const registry = createPluginRegistry();
    const res = await loadUserPlugins(registry, { homeDir: home });
    expect(res.problems).toEqual([]);
    expect(res.loaded).toHaveLength(1);
    expect(res.loaded[0]!.name).toBe("named-fixture");
    expect(res.loaded[0]!.version).toBe("1.0.0");
    expect(res.loaded[0]!.source).toBe(join(fixturesDir, "named-plugin"));
    expect(res.loaded[0]!.contributions.asserts).toBe(1);
    // setup 收到的是同一注册面：贡献面注册真实生效
    expect(registry.getAssert("fixture.named/assert.eq")).toBeDefined();
  });

  it("包只导出 default → 同样识别并注册", async () => {
    const home = mkdtempSync(join(tmpdir(), "apicc-plugins-"));
    writeManifest(home, JSON.stringify({ plugins: [join(fixturesDir, "default-plugin")] }));
    const registry = createPluginRegistry();
    const res = await loadUserPlugins(registry, { homeDir: home });
    expect(res.problems).toEqual([]);
    expect(res.loaded).toHaveLength(1);
    expect(res.loaded[0]!.name).toBe("default-fixture");
    expect(res.loaded[0]!.contributions.reporters).toBe(1);
    expect(registry.getReporter("fixture.default/reporter.text")).toBeDefined();
  });

  it("既无 plugin 也无 default → LoadProblem 带原因", async () => {
    const home = mkdtempSync(join(tmpdir(), "apicc-plugins-"));
    writeManifest(home, JSON.stringify({ plugins: [join(fixturesDir, "no-export-plugin")] }));
    const res = await loadUserPlugins(createPluginRegistry(), { homeDir: home });
    expect(res.loaded).toEqual([]);
    expect(res.problems).toHaveLength(1);
    expect(res.problems[0]!.file).toContain("no-export-plugin");
    expect(res.problems[0]!.message).toContain("plugin");
  });

  it("形状不符（缺 name/version 字符串或 setup 函数）→ LoadProblem 带原因", async () => {
    const home = mkdtempSync(join(tmpdir(), "apicc-plugins-"));
    writeManifest(home, JSON.stringify({ plugins: [join(fixturesDir, "bad-shape-plugin")] }));
    const res = await loadUserPlugins(createPluginRegistry(), { homeDir: home });
    expect(res.loaded).toEqual([]);
    expect(res.problems).toHaveLength(1);
    expect(res.problems[0]!.message).toContain("形状");
  });

  it("import 抛错（语法错误包）→ LoadProblem 隔离，后续插件继续加载", async () => {
    const home = mkdtempSync(join(tmpdir(), "apicc-plugins-"));
    writeManifest(home, JSON.stringify({
      plugins: [join(fixturesDir, "broken-plugin"), join(fixturesDir, "named-plugin")],
    }));
    const res = await loadUserPlugins(createPluginRegistry(), { homeDir: home });
    expect(res.loaded).toHaveLength(1);
    expect(res.loaded[0]!.name).toBe("named-fixture");
    expect(res.problems).toHaveLength(1);
    expect(res.problems[0]!.file).toContain("broken-plugin");
  });

  it("setup 抛错 → LoadProblem 隔离（失败不阻断）", async () => {
    const home = mkdtempSync(join(tmpdir(), "apicc-plugins-"));
    writeManifest(home, JSON.stringify({ plugins: [join(fixturesDir, "setup-throws-plugin")] }));
    const res = await loadUserPlugins(createPluginRegistry(), { homeDir: home });
    expect(res.loaded).toEqual([]);
    expect(res.problems).toHaveLength(1);
    expect(res.problems[0]!.file).toContain("setup-throws-plugin");
    expect(res.problems[0]!.message).toContain("setup");
  });
});

describe("loadUserPlugins 路径解析", () => {
  it("相对路径相对清单文件所在目录解析（<home>/.apicc 为基准）", async () => {
    const home = mkdtempSync(join(tmpdir(), "apicc-plugins-"));
    const dir = makeLocalPlugin(home, "rel-plugin", "rel-plugin", "relEq");
    // 清单在 <home>/.apicc/plugins.json，登记相对路径 ../my-plugins/rel-plugin
    writeManifest(home, JSON.stringify({ plugins: ["../my-plugins/rel-plugin"] }));
    const registry = createPluginRegistry();
    const res = await loadUserPlugins(registry, { homeDir: home });
    expect(res.problems).toEqual([]);
    expect(res.loaded).toHaveLength(1);
    expect(res.loaded[0]!.name).toBe("rel-plugin");
    expect(res.loaded[0]!.source).toBe("../my-plugins/rel-plugin");
    expect(registry.getAssert("fixture.rel-plugin/assert.releq")).toBeDefined();
    expect(dir).toBeDefined();
  });

  it("Windows 反斜杠相对形态（..\\my-plugins\\x）同样按相对清单目录解析", async () => {
    const home = mkdtempSync(join(tmpdir(), "apicc-plugins-"));
    makeLocalPlugin(home, "backslash-plugin", "backslash-plugin", "backslashEq");
    // 任务 1 审查顺修②：`.\\x` / `..\\x` 反斜杠形态须归一为相对路径而非误判为裸包名。
    const entry = ["..", "my-plugins", "backslash-plugin"].join("\\");
    writeManifest(home, JSON.stringify({ plugins: [entry] }));
    const registry = createPluginRegistry();
    const res = await loadUserPlugins(registry, { homeDir: home });
    expect(res.problems).toEqual([]);
    expect(res.loaded).toHaveLength(1);
    expect(res.loaded[0]!.name).toBe("backslash-plugin");
    expect(registry.getAssert("fixture.backslash-plugin/assert.backslasheq")).toBeDefined();
  });

  it("npm 包名通过用户清单上下文定位已导出的静态清单", async () => {
    const home = mkdtempSync(join(tmpdir(), "apicc-plugins-"));
    writeManifest(home, JSON.stringify({ plugins: ["apicc-plugin-demo"] }));
    const imported: string[] = [];
    const packageDir = join(home, ".apicc", "node_modules", "apicc-plugin-demo");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: demoManifest.name, version: "0.1.0", exports: { "./apicc-plugin.json": "./apicc-plugin.json" } }));
    writeFileSync(join(packageDir, "apicc-plugin.json"), JSON.stringify(demoManifest));
    writeFileSync(join(packageDir, "index.js"), "export const plugin = {};\n");
    const fakeDef: PluginDefinitionV1 = { manifest: demoManifest, setup: ctx => ctx.register({ kind: "assert", id: "example.demo/assert.has-field", evaluate: () => ({ pass: true, message: "ok" }) }) };
    const importFn = async (specifier: string): Promise<unknown> => {
      imported.push(specifier);
      return { plugin: fakeDef };
    };
    const res = await loadUserPlugins(createPluginRegistry(), { homeDir: home, importFn });
    expect(res.problems).toEqual([]);
    expect(res.loaded).toHaveLength(1);
    expect(res.loaded[0]!.name).toBe("apicc-plugin-demo");
    expect(imported[0]).toContain("index.js");
  });
});

describe("loadUserPlugins 注入", () => {
  it("homeDir 注入决定清单读取位置（不触碰真实 HOME）；importFn 注入覆盖真实 import", async () => {
    const home = mkdtempSync(join(tmpdir(), "apicc-plugins-"));
    writeManifest(home, JSON.stringify({ plugins: [join(fixturesDir, "named-plugin")] }));
    // 若实现误读真实 HOME（无清单），loaded 会为空——此断言同时验证注入生效
    const res = await loadUserPlugins(createPluginRegistry(), { homeDir: home });
    expect(res.loaded).toHaveLength(1);
    // importFn 注入覆盖真实 import：default 导出经同一识别路径
    const home2 = mkdtempSync(join(tmpdir(), "apicc-plugins-"));
    writeManifest(home2, JSON.stringify({ plugins: [join(fixturesDir, "named-plugin")] }));
    const res2 = await loadUserPlugins(createPluginRegistry(), {
      homeDir: home2,
      importFn: async () => ({ default: { manifest: { ...demoManifest, id: "fixture.named", name: "named-fixture", version: "1.0.0", contributions: [{ kind: "assert", id: "fixture.named/assert.eq" }] }, setup: (ctx: import("@apicc/plugin-sdk").PluginSetupContextV1) => ctx.register({ kind: "assert", id: "fixture.named/assert.eq", evaluate: () => ({ pass: true, message: "injected" }) }) } }),
    });
    expect(res2.problems).toEqual([]);
    expect(res2.loaded).toHaveLength(1);
    expect(res2.loaded[0]!.name).toBe("named-fixture");
  });
});

describe("用户插件 host 与固定运行身份", () => {
  it("plugins字段错误仍保留显式绑定并拒绝内置回退，非法绑定不能生成快照", async () => {
    const home = mkdtempSync(join(tmpdir(), "apicc-f7a-loader-")); let imports = 0;
    const bindings = { protocols: { http: "example.demo/protocol.missing" }, auths: { bearer: "example.demo/auth.missing" } };
    writeManifest(home, JSON.stringify({ plugins: null, bindings }));
    const host = createUserPluginHost({ hostVersion: "0.1.0", homeDir: home, importFn: async () => { imports++; return {}; } });
    const registry = await host.registry();
    expect(() => registry.getAuth("bearer")).toThrow(expect.objectContaining({ code: "binding_invalid" }));
    const request = { protocol: "http" as const, method: "GET" as const, url: "http://localhost/", headers: {}, query: [], auth: { kind: "none" as const } };
    expect(() => registry.getProtocol(request)).toThrow(expect.objectContaining({ code: "binding_invalid" }));
    const summary = await host.summary();
    expect(summary.problems.map(p => p.code)).toEqual(["manifest_invalid"]);
    expect(summary.bindings).toEqual(bindings);
    const snapshot = await host.snapshot();
    expect(snapshot.bindings).toEqual(bindings);
    const replay = createUserPluginHostFromSnapshot(snapshot, { hostVersion: "0.1.0" });
    expect(registry.getAuth("basic")?.type).toBe("basic");
    const replayRegistry = await replay.registry();
    expect(() => replayRegistry.getAuth("bearer")).toThrow(expect.objectContaining({ code: "binding_invalid" }));
    assertPluginRuntimeSnapshot(snapshot, await replay.snapshot());
    writeManifest(home, JSON.stringify({ plugins: null, bindings: { auths: { bearer: 7 } } }));
    const invalid = createUserPluginHost({ hostVersion: "0.1.0", homeDir: home });
    expect((await invalid.summary()).problems.map(p => p.code)).toEqual(expect.arrayContaining(["manifest_invalid", "binding_invalid"]));
    await expect(invalid.snapshot()).rejects.toMatchObject({ code: "binding_invalid" });
    expect(imports).toBe(0);
  });

  it("一次加载共用registry/摘要，配置默认值只进私有快照；按固定source重建", async () => {
    const home = mkdtempSync(join(tmpdir(), "apicc-f7a-loader-"));
    const dir = join(home, "demo"); mkdirSync(dir);
    const manifest = { ...demoManifest, configSchema: { fields: { greeting: { type: "string" as const, default: "private-value" } } } };
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: manifest.name, version: manifest.version }));
    writeFileSync(join(dir, "apicc-plugin.json"), JSON.stringify(manifest));
    writeFileSync(join(dir, "index.js"), "// controlled entry identity\n");
    writeManifest(home, JSON.stringify({ plugins: [{ source: "../demo/apicc-plugin.json", config: {} }], bindings: { auths: { bearer: "example.demo/auth.missing" } } }));
    let imports = 0; let setups = 0; let observedConfig: unknown;
    const importFn = async () => { imports++; return { default: { manifest: { ...manifest, capabilities: [...manifest.capabilities].reverse() }, setup(ctx: import("@apicc/plugin-sdk").PluginSetupContextV1) {
      setups++; observedConfig = ctx.config;
      ctx.register({ kind: "assert", id: "example.demo/assert.has-field", evaluate: (actual: unknown, expected: string | undefined) => ({ pass: typeof actual === "object" && actual !== null && expected !== undefined && Object.hasOwn(actual, expected), message: ctx.config.greeting as string }) });
    } } }; };
    const host = createUserPluginHost({ hostVersion: "0.1.0", homeDir: home, importFn });
    const [registry, summary, snapshot] = await Promise.all([host.registry(), host.summary(), host.snapshot()]);
    expect(imports).toBe(1); expect(setups).toBe(1); expect(await host.registry()).toBe(registry); expect(await host.summary()).toBe(summary);
    expect(observedConfig).toEqual({ greeting: "private-value" });
    expect(snapshot.entries[0]?.config).toEqual({ greeting: "private-value" });
    expect(snapshot.entries[0]?.source).toBe(join(dir, "apicc-plugin.json"));
    expect(JSON.stringify(summary)).not.toContain("private-value");
    expect(registry.getAssert("example.demo/assert.has-field")?.evaluate({ a: 1 }, "a").pass).toBe(true);
    expect(() => registry.getAuth("bearer")).toThrow(expect.objectContaining({ code: "binding_invalid" }));
    // Editing the user list cannot affect this session or worker replay.
    writeManifest(home, JSON.stringify({ plugins: ["definitely-absent"] }));
    expect(await host.snapshot()).toBe(snapshot);
    const replay = createUserPluginHostFromSnapshot(snapshot, { hostVersion: "0.1.0", importFn });
    expect((await replay.registry()).getAssert("example.demo/assert.has-field")).toBeDefined();
    assertPluginRuntimeSnapshot(snapshot, await replay.snapshot());
    expect(imports).toBe(2);
    // A changed entry must be rejected before importing it.
    writeFileSync(join(dir, "index.js"), "throw Error('changed');\n");
    await expect(createUserPluginHostFromSnapshot(snapshot, { hostVersion: "0.1.0", importFn }).registry()).rejects.toMatchObject({ code: "plugin_runtime_mismatch" });
    expect(imports).toBe(2);
    await expect(createUserPluginHostFromSnapshot(snapshot, { hostVersion: "0.2.0", importFn }).registry()).rejects.toMatchObject({ code: "plugin_runtime_mismatch" });
    expect(imports).toBe(2);
  });

  it("关闭模式不读取损坏清单、不import，身份确定且内部旧缺字段配置拒绝", async () => {
    const home = mkdtempSync(join(tmpdir(), "apicc-f7a-loader-"));
    writeManifest(home, "broken JSON"); let imports = 0;
    const host = createUserPluginHost({ hostVersion: "0.1.0", homeDir: home, enabled: false, importFn: async () => { imports++; return {}; } });
    const snapshot = await host.snapshot();
    expect(snapshot.enabled).toBe(false); expect(snapshot.entries).toEqual([]); expect(imports).toBe(0);
    expect((await host.summary()).problems).toEqual([]);
    const replay = createUserPluginHostFromSnapshot(snapshot, { hostVersion: "0.1.0" });
    assertPluginRuntimeSnapshot(snapshot, await replay.snapshot());
    const { bindings: _bindings, ...old } = snapshot;
    expect(() => assertPluginRuntimeSnapshot(old, snapshot)).toThrow(/快照/);
    expect(() => assertPluginRuntimeSnapshot(snapshot, { ...snapshot, digest: "0".repeat(64) })).toThrow(/摘要/);
    // A malformed binding cannot become an empty/builtin binding in worker replay.
    writeManifest(home, JSON.stringify({ plugins: [], bindings: { protocols: { http: 7 } } }));
    const invalid = createUserPluginHost({ hostVersion: "0.1.0", homeDir: home });
    expect((await invalid.summary()).problems[0]?.code).toBe("binding_invalid");
    await expect(invalid.snapshot()).rejects.toMatchObject({ code: "binding_invalid" });
  });

  it("bindings复数字段映射到真实auth/protocol选择，未绑定仍无外部替代", async () => {
    const home = mkdtempSync(join(tmpdir(), "apicc-f7a-loader-")); const dir = join(home, "demo"); mkdirSync(dir);
    const manifest: PluginManifestV1 = { ...demoManifest, capabilities: ["auth", "protocol"], contributions: [
      { kind: "auth", id: "example.demo/auth.bearer" }, { kind: "protocol", id: "example.demo/protocol.http" },
    ] };
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: manifest.name, version: manifest.version }));
    writeFileSync(join(dir, "apicc-plugin.json"), JSON.stringify(manifest)); writeFileSync(join(dir, "index.js"), "// injected");
    writeManifest(home, JSON.stringify({ plugins: [dir], bindings: { protocols: { http: "example.demo/protocol.http" }, auths: { bearer: "example.demo/auth.bearer" } } }));
    const registry = createPluginRegistry();
    const result = await loadUserPlugins(registry, { homeDir: home, importFn: async () => ({ plugin: { manifest, setup(ctx: import("@apicc/plugin-sdk").PluginSetupContextV1) {
      ctx.register({ kind: "auth", id: "example.demo/auth.bearer", supports: ["bearer"], apply: () => ({ headers: { "X-Plugin": "yes" } }) });
      ctx.register({ kind: "protocol", id: "example.demo/protocol.http", supports: ["http"], execute: (request, context) => context.transport.execute(request) });
    } } }) });
    expect(result.problems).toEqual([]); expect(registry.getAuth("bearer")).toBeDefined(); expect(registry.getAuth("basic")).toBeUndefined();
    const request = { protocol: "http" as const, method: "GET" as const, url: "http://localhost/", headers: {}, query: [], auth: { kind: "bearer" as const, token: "private-token" } };
    registry.getAuth("bearer")!.apply(request, request.auth);
    expect(request.headers).toEqual({ "X-Plugin": "yes" });
    expect(registry.getProtocol(request)?.name).toBe("example.demo/protocol.http");
    expect(JSON.stringify(result)).not.toContain("private-token");
  });
});
