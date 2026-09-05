import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultRegistry } from "@apicc/core";
import { runCli } from "../src/main.js";

const require = createRequire(import.meta.url);
/** 工作树内已构建的 @apicc/core 包目录（cli test 流程先 build core，dist 必在）。 */
const coreDir = dirname(dirname(require.resolve("@apicc/core")));
/** @types/node 包目录（resolve 命中 package.json 文件，一层 dirname 即包根）。 */
const typesNodeDir = dirname(require.resolve("@types/node/package.json"));
const typescriptLib = dirname(require.resolve("typescript"));

/**
 * 为生成物补 node_modules 链接（junction，零网络零安装）：@apicc/core 类型与运行时、
 * @types/node——使生成物可经本地 tsc 构建（等价 README 的 pnpm build 口径）并被加载器加载。
 */
function linkWorkspaceDeps(genDir: string): void {
  const nm = join(genDir, "node_modules");
  mkdirSync(join(nm, "@apicc"), { recursive: true });
  symlinkSync(coreDir, join(nm, "@apicc", "core"), "junction");
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
  it("生成完整可开发目录：package.json（名/关键词/type）、src 示例（断言+报告器）、test/tsconfig/README", async () => {
    const target = mkdtempSync(join(tmpdir(), "apicc-create-"));
    const logs: string[] = [];
    const code = await runCli(["create-plugin", "apicc-plugin-demo", "--dir", target], createDefaultRegistry(), (l) => logs.push(l));
    expect(code).toBe(0);
    const genDir = join(target, "apicc-plugin-demo");
    expect(existsSync(genDir)).toBe(true);

    const pkg = JSON.parse(readFileSync(join(genDir, "package.json"), "utf8")) as {
      name: string; type: string; keywords: string[]; peerDependencies: Record<string, string>;
    };
    expect(pkg.name).toBe("apicc-plugin-demo");
    expect(pkg.type).toBe("module");
    expect(pkg.keywords).toContain("apicc-plugin");
    expect(Object.keys(pkg.peerDependencies)).toContain("@apicc/core");

    const src = readFileSync(join(genDir, "src", "index.ts"), "utf8");
    expect(src).toContain("registerAssert");
    expect(src).toContain("registerReporter");
    expect(src).toContain("setup");
    expect(existsSync(join(genDir, "test", "contract.test.ts"))).toBe(true);
    expect(existsSync(join(genDir, "tsconfig.json"))).toBe(true);

    const readme = readFileSync(join(genDir, "README.md"), "utf8");
    expect(readme).toContain("plugins.json");
    expect(logs.join("\n")).toContain("apicc-plugin-demo");
  });

  it("端到端：生成 → 本地构建（junction 零安装）→ 清单登记 dist → plugins list 显示已加载且贡献生效", async () => {
    const target = mkdtempSync(join(tmpdir(), "apicc-create-e2e-"));
    const code = await runCli(["create-plugin", "apicc-plugin-demo", "--dir", target], createDefaultRegistry(), () => {});
    expect(code).toBe(0);
    const genDir = join(target, "apicc-plugin-demo");
    linkWorkspaceDeps(genDir);
    buildGenerated(genDir);
    expect(existsSync(join(genDir, "dist", "index.js"))).toBe(true);

    const home = mkdtempSync(join(tmpdir(), "apicc-create-home-"));
    writeManifest(home, [join(genDir, "dist")]);
    const logs: string[] = [];
    const registry = createDefaultRegistry();
    const listCode = await runCli(["plugins", "list"], registry, (l) => logs.push(l), { pluginsHomeDir: home });
    expect(listCode).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("apicc-plugin-demo@0.1.0");
    expect(out).toContain("断言 1");
    expect(out).toContain("报告 1");
    // setup 贡献真实生效：模板断言操作符与报告器进入同一 registry
    expect(registry.getAssert("hasField")).toBeDefined();
    expect(registry.getReporter("apicc-plugin-demo-txt")).toBeDefined();
  }, 60_000);

  it("目标目录已存在 → 可读拒绝（退出非零）", async () => {
    const target = mkdtempSync(join(tmpdir(), "apicc-create-dup-"));
    const first = await runCli(["create-plugin", "apicc-plugin-demo", "--dir", target], createDefaultRegistry(), () => {});
    expect(first).toBe(0);
    await expect(
      runCli(["create-plugin", "apicc-plugin-demo", "--dir", target], createDefaultRegistry(), () => {}),
    ).rejects.toThrow(/已存在/);
  });

  it("名称无 apicc-plugin- 前缀 → 警告不阻断（约定非强制），照常生成", async () => {
    const target = mkdtempSync(join(tmpdir(), "apicc-create-prefix-"));
    const logs: string[] = [];
    const code = await runCli(["create-plugin", "demo", "--dir", target], createDefaultRegistry(), (l) => logs.push(l));
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("[警告]");
    expect(out).toContain("apicc-plugin-");
    expect(existsSync(join(target, "demo", "package.json"))).toBe(true);
  });
});
