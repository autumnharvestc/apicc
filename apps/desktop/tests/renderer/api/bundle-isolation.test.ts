// node 环境即可（无需 DOM）：跑一次真实 renderer 构建，在产物层把守「生产包隔离」——
// api/index.ts 若退化为静态 import memory.ts，vite 会把 memory 模块（含 node:fs 的
// externalize stub）内联进入口 chunk，模块求值即炸掉 Electron 生产包（任务 8 冒烟实测）。
// 判据：memory.ts 的唯一字符串标记 "apicc-memory-"（临时目录前缀，字符串字面量不受
// 压缩改名影响）不得出现在入口 chunk；正确形态下它只存在于经动态 import 引用的
// 独立懒加载 chunk，且入口 chunk 持有对该 chunk 文件名的引用。
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
    try {
      await build({
        configFile: join(desktopRoot, "vite.config.ts"),
        root: join(desktopRoot, "src/renderer"),
        logLevel: "error", // 静态引用场景仅产生 warn，不改变构建成败——判据靠下方产物断言
        // Vitest sets NODE_ENV=test; spell out Vite's browser flags so this is a real
        // production-branch build without mutating NODE_ENV for the surrounding suite.
        define: { "import.meta.env.DEV": "false", "import.meta.env.PROD": "true" },
        build: { outDir, emptyOutDir: true },
      });
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
