import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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
  it("plugins list --json 保留版本、停用来源与显式绑定，且不公开配置树或运行快照", async () => {
    const home = mkdtempSync(join(tmpdir(), "apicc-cli-plugin-summary-"));
    try {
      const source = join(home, "configured-plugin"), disabledSource = join(home, "not-loaded");
      mkdirSync(source);
      const manifest = JSON.parse(readFileSync(join(fixturesDir, "sample-plugin", "apicc-plugin.json"), "utf8"));
      manifest.capabilities.push("protocol", "auth");
      manifest.contributions.push({ kind: "protocol", id: "example.demo/protocol.http" }, { kind: "auth", id: "example.demo/auth.bearer" });
      manifest.configSchema = { fields: { marker: { type: "string", required: true } } };
      writeFileSync(join(source, "package.json"), JSON.stringify({ name: manifest.name, version: manifest.version, type: "module" }));
      writeFileSync(join(source, "apicc-plugin.json"), JSON.stringify(manifest));
      writeFileSync(join(source, "index.js"), `export default {manifest:${JSON.stringify(manifest)},setup(ctx){
        ctx.register({kind:'assert',id:'example.demo/assert.has-field',evaluate:()=>({pass:true,message:'summary fixture'})});
        ctx.register({kind:'protocol',id:'example.demo/protocol.http',supports:['http'],execute:(request,context)=>context.transport.execute(request)});
        ctx.register({kind:'auth',id:'example.demo/auth.bearer',supports:['bearer'],apply:()=>({headers:{}})});
      }};`);
      mkdirSync(join(home, ".apicc"));
      writeFileSync(join(home, ".apicc", "plugins.json"), JSON.stringify({
        plugins: [{ source, config: { marker: "do-not-export-config-value" } }, { source: disabledSource, enabled: false }, join(fixturesDir, "broken-plugin")],
        bindings: { protocols: { http: "example.demo/protocol.http" }, auths: { bearer: "example.demo/auth.bearer" } },
      }));
      const logs: string[] = [];
      expect(await runCli(["plugins", "list", "--json"], createDefaultRegistry(), line => logs.push(line), { pluginsHomeDir: home })).toBe(0);
      expect(logs).toHaveLength(1);
      const summary = JSON.parse(logs[0]!);
      const productVersion = JSON.parse(readFileSync(join(fixturesDir, "..", "..", "package.json"), "utf8")).version;
      expect(summary).toMatchObject({ enabled: true, hostVersion: productVersion,
        loaded: [{ source, pluginId: "example.demo", version: "0.1.0", apiVersion: 1, engines: { apicc: ">=0.1.0 <0.2.0" } }],
        disabled: [{ source: disabledSource }],
        bindings: { protocols: { http: "example.demo/protocol.http" }, auths: { bearer: "example.demo/auth.bearer" } },
      });
      expect(summary.loaded[0].contributionIds).toEqual(expect.arrayContaining(["example.demo/assert.has-field", "example.demo/protocol.http", "example.demo/auth.bearer"]));
      expect(summary.loaded[0].contributions).toMatchObject({ asserts: 1, protocols: 1, auths: 1 });
      expect(summary.problems).toHaveLength(1);
      expect(summary.problems[0]).toMatchObject({ file: join(fixturesDir, "broken-plugin"), code: "manifest_missing", stage: "manifest" });
      expect(logs[0]).not.toContain('"config"');
      expect(logs[0]).not.toContain("do-not-export-config-value");
      expect(summary).not.toHaveProperty("snapshot");
      expect(summary).not.toHaveProperty("pluginRuntimeVersion");
      expect(summary.loaded[0]).not.toHaveProperty("manifestDigest");
      expect(summary.loaded[0]).not.toHaveProperty("entryDigest");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it("plugins list 输出已加载插件（名称/版本/贡献计数）与失败项原因，退出码 0", async () => {
    const home = mkdtempSync(join(tmpdir(), "apicc-cli-plugins-"));
    writeManifest(home, [join(fixturesDir, "sample-plugin"), join(fixturesDir, "broken-plugin")]);
    const logs: string[] = [];
    const code = await runCli(["plugins", "list"], createDefaultRegistry(), (l) => logs.push(l), {
      pluginsHomeDir: home,
    });
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("sample-plugin@0.1.0");
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
    expect(registry.getAssert("example.demo/assert.has-field")?.evaluate({}, "requiredField")).toEqual({ pass: false, message: "缺少字段" });
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
