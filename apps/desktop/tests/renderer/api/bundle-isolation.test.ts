// node 环境即可（无需 DOM）：跑一次真实 renderer 构建，在产物层把守「生产包隔离」——
// api/index.ts 若退化为静态 import memory.ts，vite 会把 memory 模块（含 node:fs 的
// externalize stub）内联进入口 chunk，模块求值即炸掉 Electron 生产包（任务 8 冒烟实测）。
// 同时检查实际发出 chunk 的完整模块依赖：其它静态 Core barrel 也可能把 Node-only
// 模块带入启动图，且 minification/browser stubs 会抹掉 node:* 文本。不能仅靠 memory 前缀。
import { describe, expect, it } from "vitest";
import { build } from "vite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "../../.."); // apps/desktop
const MARKER = "apicc-memory-";

describe("渲染层产物 memory 隔离（生产包拓扑回归）", () => {
  it("生产产物不包含 memory/Node 宿主链，入口保留无 preload 拒绝", async () => {
    const outDir = join(mkdtempSync(join(tmpdir(), "apicc-bundle-")), "dist-renderer");
    mkdirSync(outDir, { recursive: true });
    const emittedModules = new Set<string>();
    try {
      await build({
        configFile: join(desktopRoot, "vite.config.ts"),
        root: join(desktopRoot, "src/renderer"),
        logLevel: "error", // 静态引用场景仅产生 warn，不改变构建成败——判据靠下方产物断言
        // Vitest sets NODE_ENV=test; spell out Vite's browser flags so this is a real
        // production-branch build without mutating NODE_ENV for the surrounding suite.
        define: { "import.meta.env.DEV": "false", "import.meta.env.PROD": "true" },
        plugins: [{ name: "test-production-module-isolation", generateBundle(_options, bundle) {
          for (const chunk of Object.values(bundle)) if (chunk.type === "chunk") for (const id of Object.keys(chunk.modules)) emittedModules.add(id.replaceAll("\\", "/"));
        } }],
        build: { outDir, emptyOutDir: true },
      });
      expect(emittedModules.size, "没有采集实际生产 chunk 的模块依赖").toBeGreaterThan(0);
      const hostModules = [...emittedModules].filter(id => id.includes("browser-external") || id.startsWith("node:")
        || /\/(better-sqlite3|@napi-rs\/keyring|undici|ws)\//.test(id)
        || /\/packages\/core\/dist\/(?:shared\.js|index\.js|storage\/|runner\/|credentials\/|stress\/runner\.js)/.test(id));
      expect(hostModules, "生产 chunk 包含 Node-only/browser-external 宿主依赖").toEqual([]);
      const html = readFileSync(join(outDir, "index.html"), "utf8");
      const entryMatch = html.match(/<script[^>]+src="\.?\/?(assets\/[^"]+\.js)"/);
      expect(entryMatch, "入口脚本未找到").toBeTruthy();
      const entry = readFileSync(join(outDir, entryMatch![1]!), "utf8");
      // Keep the existing static-contamination negative guard, now against the production entry.
      expect(entry, "memory 模块被静态内联进入口——生产包隔离被破坏").not.toContain(MARKER);
      expect(entry).toContain("The Electron preload API is unavailable");
      const assetsDir = join(outDir, "assets");
      expect(existsSync(assetsDir), "assets 目录缺失").toBe(true);
      const jsFiles = readdirSync(assetsDir).filter((f) => f.endsWith(".js"));
      const productionBundle = jsFiles.map((f) => readFileSync(join(assetsDir, f), "utf8")).join("\n");
      for (const marker of [
        MARKER,
        "createMemoryApi",
        "createSession",
        "getSourceApiRevision",
        "prepareDebugExecution",
        "runDebugExecution",
        "node:fs",
        "node:os",
        "node:crypto",
      ]) {
        expect(productionBundle, `生产产物包含开发 memory/Node 宿主标记: ${marker}`).not.toContain(marker);
      }
    } finally {
      rmSync(join(outDir, ".."), { recursive: true, force: true });
    }
  }, 120_000);
});
