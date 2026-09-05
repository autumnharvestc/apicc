import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createPluginRegistry } from "../../src/plugin/registry.js";
import { loadUserPlugins } from "../../src/plugins/loader.js";
import type { PluginDefinition } from "../../src/plugin/types.js";

const fixturesDir = fileURLToPath(new URL("./fixtures", import.meta.url));

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
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, private: true, type: "module" }));
  writeFileSync(
    join(dir, "index.js"),
    `export const plugin = { name: ${JSON.stringify(name)}, version: "2.0.0",`
    + ` setup(ctx) { ctx.registry.registerAssert({ op: ${JSON.stringify(op)},`
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
    expect(registry.getAssert("fixtureEq")).toBeDefined();
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
    expect(registry.getReporter("fixture-text")).toBeDefined();
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
    expect(registry.getAssert("relEq")).toBeDefined();
    expect(dir).toBeDefined();
  });

  it("npm 包名（非 ./ 开头）按裸导入解析——specifier 原样传给 import", async () => {
    const home = mkdtempSync(join(tmpdir(), "apicc-plugins-"));
    writeManifest(home, JSON.stringify({ plugins: ["apicc-plugin-demo"] }));
    const imported: string[] = [];
    const fakeDef: PluginDefinition = { name: "bare-plugin", version: "1.0.0", setup: () => {} };
    const importFn = async (specifier: string): Promise<unknown> => {
      imported.push(specifier);
      return { plugin: fakeDef };
    };
    const res = await loadUserPlugins(createPluginRegistry(), { homeDir: home, importFn });
    expect(res.problems).toEqual([]);
    expect(res.loaded).toHaveLength(1);
    expect(res.loaded[0]!.name).toBe("bare-plugin");
    expect(imported).toEqual(["apicc-plugin-demo"]);
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
    writeManifest(home2, JSON.stringify({ plugins: ["any-specifier"] }));
    const res2 = await loadUserPlugins(createPluginRegistry(), {
      homeDir: home2,
      importFn: async () => ({ default: { name: "injected", version: "0.1.0", setup: () => {} } }),
    });
    expect(res2.problems).toEqual([]);
    expect(res2.loaded).toHaveLength(1);
    expect(res2.loaded[0]!.name).toBe("injected");
  });
});
