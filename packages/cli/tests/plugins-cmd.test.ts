import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDefaultRegistry } from "@apicc/core";
import { runCli } from "../src/main.js";

const fixturesDir = fileURLToPath(new URL("./fixtures", import.meta.url));

/** 在注入的用户级目录写清单 <home>/.apicc/plugins.json（规格 D1 形状）。 */
function writeManifest(home: string, entries: string[]): void {
  mkdirSync(join(home, ".apicc"), { recursive: true });
  writeFileSync(join(home, ".apicc", "plugins.json"), JSON.stringify({ plugins: entries }));
}

describe("plugins list 与启动接线", () => {
  it("plugins list 输出已加载插件（名称/版本/贡献计数）与失败项原因，退出码 0", async () => {
    const home = mkdtempSync(join(tmpdir(), "apicc-cli-plugins-"));
    writeManifest(home, [join(fixturesDir, "sample-plugin"), join(fixturesDir, "broken-plugin")]);
    const logs: string[] = [];
    const code = await runCli(["plugins", "list"], createDefaultRegistry(), (l) => logs.push(l), {
      pluginsHomeDir: home,
    });
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("sample-plugin@1.0.0");
    expect(out).toContain("断言 1");
    expect(out).toContain("[加载失败]");
    expect(out).toContain("broken-plugin");
  }, 30000);

  it("命令分发前完成插件加载：setup 注册的断言操作符进入同一 registry", async () => {
    const home = mkdtempSync(join(tmpdir(), "apicc-cli-plugins-"));
    writeManifest(home, [join(fixturesDir, "sample-plugin")]);
    const registry = createDefaultRegistry();
    const code = await runCli(["plugins", "list"], registry, () => {}, { pluginsHomeDir: home });
    expect(code).toBe(0);
    expect(registry.getAssert("sampleEq")).toBeDefined();
  }, 30000);

  it("--no-plugins 逃生开关跳过加载（清单存在也不加载）", async () => {
    const home = mkdtempSync(join(tmpdir(), "apicc-cli-plugins-"));
    writeManifest(home, [join(fixturesDir, "sample-plugin")]);
    const logs: string[] = [];
    const code = await runCli(["plugins", "list", "--no-plugins"], createDefaultRegistry(), (l) => logs.push(l), {
      pluginsHomeDir: home,
    });
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("插件加载已关闭");
    expect(out).not.toContain("sample-plugin@");
  }, 30000);

  it("deps.loadPlugins=false 注入关闭——既有测试/嵌入方零扰动通道", async () => {
    const home = mkdtempSync(join(tmpdir(), "apicc-cli-plugins-"));
    writeManifest(home, [join(fixturesDir, "sample-plugin"), join(fixturesDir, "broken-plugin")]);
    const logs: string[] = [];
    const code = await runCli(["plugins", "list"], createDefaultRegistry(), (l) => logs.push(l), {
      pluginsHomeDir: home,
      loadPlugins: false,
    });
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("未加载任何插件");
    expect(out).not.toContain("[加载失败]");
  }, 30000);

  it("清单缺失时 plugins list 零加载退出码 0（不报错）", async () => {
    const home = mkdtempSync(join(tmpdir(), "apicc-cli-plugins-"));
    const logs: string[] = [];
    const code = await runCli(["plugins", "list"], createDefaultRegistry(), (l) => logs.push(l), {
      pluginsHomeDir: home,
    });
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("未加载任何插件");
  }, 30000);
});
