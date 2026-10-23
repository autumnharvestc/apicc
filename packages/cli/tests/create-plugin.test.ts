import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createDefaultRegistry } from "@apicc/core";
import { runCli } from "../src/main.js";

const require = createRequire(import.meta.url);
/** CLI 的显式 SDK 依赖；生成物只链接公开 SDK，不借 Core 的传递依赖。 */
const sdkDir = dirname(dirname(require.resolve("@apicc/plugin-sdk")));
/** @types/node 包目录（resolve 命中 package.json 文件，一层 dirname 即包根）。 */
const typesNodeDir = dirname(require.resolve("@types/node/package.json"));
const typescriptLib = dirname(require.resolve("typescript"));

/**
 * 为生成物补 node_modules 链接（junction，零网络零安装）：公开 SDK 类型与运行时、
 * @types/node——使生成物可经本地 tsc 构建（等价 README 的 pnpm build 口径）并被加载器加载。
 */
function linkWorkspaceDeps(genDir: string): void {
  const nm = join(genDir, "node_modules");
  mkdirSync(join(nm, "@apicc"), { recursive: true });
  symlinkSync(sdkDir, join(nm, "@apicc", "plugin-sdk"), "junction");
  mkdirSync(join(nm, "@types"), { recursive: true });
  symlinkSync(typesNodeDir, join(nm, "@types", "node"), "junction");
}

/** 用工作树自带的 typescript 执行生成物的 tsc -p（镜像 README 的 build 步骤）。 */
function buildGenerated(genDir: string): void {
  const res = spawnSync(process.execPath, [join(typescriptLib, "..", "bin", "tsc"), "-p", genDir], {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (res.status !== 0) {
    throw new Error(`生成物构建失败：\n${res.stdout}\n${res.stderr}`);
  }
}

function writeManifest(home: string, entries: string[]): void {
  mkdirSync(join(home, ".apicc"), { recursive: true });
  writeFileSync(join(home, ".apicc", "plugins.json"), JSON.stringify({ plugins: entries }));
}

describe("create-plugin 脚手架", () => {
  it("生成 V1 作者包：公开 SDK 依赖、静态清单和可发布入口", async () => {
    const target = mkdtempSync(join(tmpdir(), "apicc-create-"));
    const logs: string[] = [];
    const code = await runCli(["create-plugin", "apicc-plugin-demo", "--dir", target], createDefaultRegistry(), (l) => logs.push(l), { loadPlugins: false });
    expect(code).toBe(0);
    const genDir = join(target, "apicc-plugin-demo");
    expect(existsSync(genDir)).toBe(true);

    const pkg = JSON.parse(readFileSync(join(genDir, "package.json"), "utf8")) as {
      name: string; type: string; keywords: string[]; peerDependencies: Record<string, string>;
      devDependencies: Record<string, string>; exports: Record<string, unknown>; files: string[];
    };
    expect(pkg.name).toBe("apicc-plugin-demo");
    expect(pkg.type).toBe("module");
    expect(pkg.keywords).toContain("apicc-plugin");
    expect(pkg.peerDependencies).toEqual({ "@apicc/plugin-sdk": "^0.1.0" });
    expect(pkg.devDependencies["@apicc/plugin-sdk"]).toBe("^0.1.0");
    expect(pkg.exports["./apicc-plugin.json"]).toBe("./apicc-plugin.json");
    expect(pkg.files).toEqual(expect.arrayContaining(["dist", "apicc-plugin.json"]));
    const manifest = JSON.parse(readFileSync(join(genDir, "apicc-plugin.json"), "utf8"));
    expect(manifest).toEqual({
      manifestVersion: 1, id: "local.apicc-plugin-demo", name: "apicc-plugin-demo", version: "0.1.0",
      apiVersion: 1, engines: { apicc: ">=0.1.0 <0.2.0" }, entry: "./dist/index.js",
      capabilities: ["assert", "reporter"],
      contributions: [
        { kind: "assert", id: "local.apicc-plugin-demo/assert.has-field" },
        { kind: "reporter", id: "local.apicc-plugin-demo/reporter.text" },
      ],
    });
    expect(existsSync(join(genDir, "test", "contract.test.ts"))).toBe(true);
    expect(existsSync(join(genDir, "tsconfig.json"))).toBe(true);

    const readme = readFileSync(join(genDir, "README.md"), "utf8");
    expect(readme).toContain("plugins.json");
    expect(logs.join("\n")).toContain("apicc-plugin-demo");
  });

  it("端到端：生成 → 仅 SDK 构建 → 实际贡献回调 → 静态清单登记后加载", async () => {
    const target = mkdtempSync(join(tmpdir(), "apicc-create-e2e-"));
    const code = await runCli(["create-plugin", "apicc-plugin-demo", "--dir", target], createDefaultRegistry(), () => {}, { loadPlugins: false });
    expect(code).toBe(0);
    const genDir = join(target, "apicc-plugin-demo");
    const pkg = JSON.parse(readFileSync(join(genDir, "package.json"), "utf8"));
    expect(pkg.peerDependencies).toEqual({ "@apicc/plugin-sdk": "^0.1.0" });
    linkWorkspaceDeps(genDir);
    buildGenerated(genDir);
    expect(existsSync(join(genDir, "dist", "index.js"))).toBe(true);
    const behavior = spawnSync(process.execPath, ["--input-type=module", "--eval", `
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      const { plugin } = await import(${JSON.stringify(pathToFileURL(join(genDir, "dist", "index.js")).href)});
      const { checkPluginContract } = await import(${JSON.stringify(pathToFileURL(join(sdkDir, "dist", "testing.js")).href)});
      const manifest = JSON.parse(readFileSync(${JSON.stringify(join(genDir, "apicc-plugin.json"))}, 'utf8'));
      assert.deepEqual(plugin.manifest, manifest);
      const checked = checkPluginContract(plugin, { config: {} });
      assert.deepEqual(checked.problems, []);
      const assertion = checked.contributions.find(item => item.kind === 'assert');
      assert.equal(assertion.evaluate({ id: 1 }, 'id', { found: true, getModel: () => undefined }).pass, true);
      assert.equal(assertion.evaluate({}, 'id', { found: true, getModel: () => undefined }).pass, false);
      const reporter = checked.contributions.find(item => item.kind === 'reporter');
      const report = {
        formatVersion: 1, kind: 'workflow', title: 'recovered run',
        startedAt: '2026-10-23T00:00:00.000Z', finishedAt: '2026-10-23T00:00:01.000Z',
        rows: { total: 2, passed: 1, failed: 1, skipped: 0 },
        logical: { total: 1, passed: 1, failed: 0, skipped: 0 },
        requestFacts: { started: 2, completed: 2, httpExchanges: 2 },
        cases: [
          { caseId: 'case-passed', caseName: '有效响应', passed: true, assertions: [{ pass: true, message: '已包含 id' }] },
          { caseId: 'case-failed', caseName: '缺少标识字段', passed: false, failureKind: 'assertion', error: '响应校验未通过',
            assertions: [{ pass: false, message: '缺少必需字段 id', differencePath: '$.id', schemaPath: '#/required' }] },
        ], diagnostics: [],
      };
      const file = await reporter.render(report, ${JSON.stringify(genDir)});
      const text = readFileSync(file, 'utf8');
      assert.match(text, /执行行.*总计 2.*通过 1.*失败 1.*跳过 0/);
      assert.match(text, /逻辑结果.*总计 1.*通过 1.*失败 0.*跳过 0/);
      assert.match(text, /请求事实.*开始 2.*完成 2.*HTTP 交换 2/);
      assert.match(text, /失败用例：缺少标识字段.*case-failed/);
      assert.match(text, /类别：断言失败/);
      assert.match(text, /原因：响应校验未通过/);
      assert.match(text, /断言：缺少必需字段 id/);
      assert.ok(text.includes('差异路径：$.id'));
      assert.ok(text.includes('Schema 路径：#/required'));
      assert.doesNotMatch(text, /失败用例：有效响应/);
      const limitedFile = await reporter.render({ ...report, rows: { total: 1, passed: 0, failed: 1, skipped: 0 },
        cases: [{ caseId: 'case-withheld', passed: false }] }, ${JSON.stringify(genDir)});
      assert.match(readFileSync(limitedFile, 'utf8'), /case-withheld/);
      assert.match(readFileSync(limitedFile, 'utf8'), /本次投影未提供详细失败原因/);
    `], { encoding: "utf8" });
    expect({ status: behavior.status, stdout: behavior.stdout, stderr: behavior.stderr }).toEqual({ status: 0, stdout: "", stderr: "" });

    const home = mkdtempSync(join(tmpdir(), "apicc-create-home-"));
    writeManifest(home, [genDir]);
    const logs: string[] = [];
    const registry = createDefaultRegistry();
    const listCode = await runCli(["plugins", "list"], registry, (l) => logs.push(l), { pluginsHomeDir: home });
    expect(listCode).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("apicc-plugin-demo@0.1.0");
    expect(out).toContain("断言 1");
    expect(out).toContain("报告 1");
    // setup 贡献真实生效：模板断言操作符与报告器进入同一 registry
    expect(registry.getAssert("local.apicc-plugin-demo/assert.has-field")).toBeDefined();
    expect(registry.getReporter("local.apicc-plugin-demo/reporter.text")).toBeDefined();
  }, 60_000);

  it("目标目录已存在 → 可读拒绝（退出非零）", async () => {
    const target = mkdtempSync(join(tmpdir(), "apicc-create-dup-"));
    const first = await runCli(["create-plugin", "apicc-plugin-demo", "--dir", target], createDefaultRegistry(), () => {}, { loadPlugins: false });
    expect(first).toBe(0);
    const pkgBefore = readFileSync(join(target, "apicc-plugin-demo", "package.json"), "utf8");
    await expect(
      runCli(["create-plugin", "apicc-plugin-demo", "--dir", target], createDefaultRegistry(), () => {}, { loadPlugins: false }),
    ).rejects.toThrow(/已存在/);
    expect(readFileSync(join(target, "apicc-plugin-demo", "package.json"), "utf8")).toBe(pkgBefore);
  });

  it("名称无 apicc-plugin- 前缀 → 警告不阻断（约定非强制），照常生成", async () => {
    const target = mkdtempSync(join(tmpdir(), "apicc-create-prefix-"));
    const logs: string[] = [];
    const code = await runCli(["create-plugin", "demo", "--dir", target], createDefaultRegistry(), (l) => logs.push(l), { loadPlugins: false });
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("[警告]");
    expect(out).toContain("apicc-plugin-");
    expect(existsSync(join(target, "demo", "package.json"))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(target, "demo", "apicc-plugin.json"), "utf8"));
    expect(manifest.id).toBe("local.demo");
  });

  it("非法名称在写入任何文件前拒绝", async () => {
    const target = mkdtempSync(join(tmpdir(), "apicc-create-invalid-"));
    await expect(runCli(["create-plugin", "../escape", "--dir", target], createDefaultRegistry(), () => {}, { loadPlugins: false })).rejects.toThrow(/不合法/);
    expect(existsSync(join(target, "package.json"))).toBe(false);
  });

  it("完整包名小写派生 namespace，无法形成 V1 namespace 的名称写入前拒绝", async () => {
    const target = mkdtempSync(join(tmpdir(), "apicc-create-namespace-"));
    expect(await runCli(["create-plugin", "Apicc-Plugin-Custom", "--dir", target], createDefaultRegistry(), () => {}, { loadPlugins: false })).toBe(0);
    expect(existsSync(join(target, "Apicc-Plugin-Custom", "apicc-plugin.json"))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(target, "Apicc-Plugin-Custom", "apicc-plugin.json"), "utf8"));
    expect(manifest.id).toBe("local.apicc-plugin-custom");
    await expect(runCli(["create-plugin", "apicc_plugin_custom", "--dir", target], createDefaultRegistry(), () => {}, { loadPlugins: false })).rejects.toThrow(/命名空间/);
    expect(existsSync(join(target, "apicc_plugin_custom"))).toBe(false);
  });
});
