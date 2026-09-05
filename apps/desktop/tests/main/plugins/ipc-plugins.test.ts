// M7-B 任务 2（规格 §2 D3/D5/D8）：plugins:list 切真实现——main 经 core loadUserPlugins
// 装载用户级清单（~/.apicc/plugins.json），loaded/failed 混合摘要 + registry 导入器枚举。
// 测试注入 homeDir 夹具（登记本地路径示例插件 + 一个坏插件），零真实网络、零真写 HOME。
// 注入面与 CLI 对齐口径（D8/报告注明）：homeDir 注入 + loadPlugins:false 编程关闭通道；
// createIpcDeps 未配置 plugins 时零加载零扰动（既有桌面测试保持机器无关）。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createIpcDeps } from "../../../src/main/ipc.js";
import { createSession } from "../../../src/main/session.js";
import type { PluginsListResult } from "../../../src/shared/plugins/contract.js";

let pluginSeq = 0;

/** 本地插件目录夹具（对齐 core fixtures 形态：type:module + 免构建直写 ESM JS）。 */
function makePluginDir(indexJs: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), "apicc-plugin-")), "pkg");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `apicc-plugin-${++pluginSeq}`, private: true, type: "module" }));
  writeFileSync(join(dir, "index.js"), indexJs);
  return dir;
}

/** 用户级清单夹具：<home>/.apicc/plugins.json。 */
function makeHome(entries: string[]): string {
  const home = mkdtempSync(join(tmpdir(), "apicc-plugins-home-"));
  mkdirSync(join(home, ".apicc"), { recursive: true });
  writeFileSync(join(home, ".apicc", "plugins.json"), JSON.stringify({ plugins: entries }));
  return home;
}

/** 示例插件：注册报告器/导入器/断言操作符各一（贡献名称可在摘要与运行面核验）。 */
const EXAMPLE_PLUGIN = `
export default {
  name: "apicc-plugin-example",
  version: "2.0.0",
  setup(ctx) {
    ctx.registry.registerReporter({ format: "example-md", render: async () => "example-report" });
    ctx.registry.registerImporter({
      name: "example-csv",
      detect: () => false,
      parse: () => ({ id: "p-x", name: "x", variables: {}, environments: [], workflows: [], collections: [] }),
    });
    ctx.registry.registerAssert({
      op: "exampleEq",
      evaluate: (actual, expected) => ({ pass: String(actual) === expected, message: "exampleEq" }),
    });
  },
};
`;

/** 坏插件：语法错误——动态 import 抛错，须被隔离为 failed 行而非中断加载（D3）。 */
const BROKEN_PLUGIN = `export const plugin = { name: "broken-fixture", version:`;

describe("IPC plugins:list（真加载，M7-B 任务 2）", () => {
  it("登记示例插件 + 坏插件：loaded 带 version 与贡献名称清单，failed 带原因且无贡献", async () => {
    const home = makeHome([makePluginDir(EXAMPLE_PLUGIN), makePluginDir(BROKEN_PLUGIN)]);
    const deps = createIpcDeps({ session: createSession(), pickDirectory: async () => "", saveFile: async () => "", plugins: { homeDir: home } });
    const result = (await deps.handle("plugins:list", {})) as PluginsListResult;

    // 混合清单（D3 失败隔离的桌面可见面）
    const loaded = result.plugins.filter((p) => p.kind === "loaded");
    const failed = result.plugins.filter((p) => p.kind === "failed");
    expect(loaded).toHaveLength(1);
    expect(failed).toHaveLength(1);

    // loaded 契约（沿用 T1 名称数组口径）：贡献名称回溯插件注册面
    const entry = loaded[0]!;
    expect(entry.name).toBe("apicc-plugin-example");
    expect(entry.version).toBe("2.0.0");
    expect(entry.contributions!.reporters).toContain("example-md");
    expect(entry.contributions!.importers).toContain("example-csv");
    expect(entry.contributions!.asserts).toContain("exampleEq");
    expect(entry.contributions!.protocols).toEqual([]);
    expect(entry.contributions!.auths).toEqual([]);
    expect(entry.contributions!.scripts).toEqual([]);

    // failed 契约：name 回溯清单登记写法（LoadProblem.file = 原始条目），error 带原因
    const brokenEntry = failed[0]!;
    expect(brokenEntry.name).toContain("apicc-plugin-");
    expect(brokenEntry.error).toBeTruthy();
    expect(brokenEntry.contributions).toBeUndefined();
  });

  it("importers 枚举 = 内置 registry + 插件贡献（与运行/导入探测同一 registry）", async () => {
    const home = makeHome([makePluginDir(EXAMPLE_PLUGIN)]);
    const deps = createIpcDeps({ session: createSession(), pickDirectory: async () => "", saveFile: async () => "", plugins: { homeDir: home } });
    const result = (await deps.handle("plugins:list", {})) as PluginsListResult;
    expect(result.importers).toContain("collection-v21");
    expect(result.importers).toContain("openapi");
    expect(result.importers).toContain("example-csv");
  });

  it("重复调用返回等价摘要（memoized 装载：清单只读一次，不重复执行插件 setup）", async () => {
    const home = makeHome([makePluginDir(EXAMPLE_PLUGIN)]);
    const deps = createIpcDeps({ session: createSession(), pickDirectory: async () => "", saveFile: async () => "", plugins: { homeDir: home } });
    const first = (await deps.handle("plugins:list", {})) as PluginsListResult;
    const second = (await deps.handle("plugins:list", {})) as PluginsListResult;
    expect(second).toEqual(first);
  });

  it("未配置 plugins（既有桌面测试默认）：零加载零扰动——空清单 + 内置枚举，不读真实 HOME", async () => {
    const deps = createIpcDeps({ session: createSession(), pickDirectory: async () => "", saveFile: async () => "" });
    const result = (await deps.handle("plugins:list", {})) as PluginsListResult;
    expect(result.plugins).toEqual([]);
    expect(result.importers).toEqual(expect.arrayContaining(["collection-v21", "openapi"]));
    expect(result.importers).not.toContain("example-csv");
  });

  it("loadPlugins:false 关闭通道（与 CLI --no-plugins / deps.loadPlugins 同口径）：有清单也不加载", async () => {
    const home = makeHome([makePluginDir(EXAMPLE_PLUGIN)]);
    const deps = createIpcDeps({ session: createSession(), pickDirectory: async () => "", saveFile: async () => "", plugins: { homeDir: home, loadPlugins: false } });
    const result = (await deps.handle("plugins:list", {})) as PluginsListResult;
    expect(result.plugins).toEqual([]);
    expect(result.importers).not.toContain("example-csv");
  });

  it("运行面消费插件扩展 registry：插件报告器/断言操作符在运行频道可选（贡献浮现核验）", async () => {
    const home = makeHome([makePluginDir(EXAMPLE_PLUGIN)]);
    const deps = createIpcDeps({ session: createSession(), pickDirectory: async () => "", saveFile: async () => "", plugins: { homeDir: home } });
    const registry = await deps.pluginsRuntime.registry();
    expect(registry.getReporter("example-md")).toBeDefined();
    expect(registry.getAssert("exampleEq")).toBeDefined();
    // 内置面不受插件加载影响
    expect(registry.getReporter("html")).toBeDefined();
  });
});
