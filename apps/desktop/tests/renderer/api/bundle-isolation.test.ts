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
  it("入口 chunk 不内联 memory 模块，且经动态 import 引用独立 memory chunk", async () => {
    const outDir = join(mkdtempSync(join(tmpdir(), "apicc-bundle-")), "dist-renderer");
    mkdirSync(outDir, { recursive: true });
    try {
      await build({
        configFile: join(desktopRoot, "vite.config.ts"),
        root: join(desktopRoot, "src/renderer"),
        logLevel: "error", // 静态引用场景仅产生 warn，不改变构建成败——判据靠下方产物断言
        build: { outDir, emptyOutDir: true },
      });
      const html = readFileSync(join(outDir, "index.html"), "utf8");
      const entryMatch = html.match(/<script[^>]+src="\.?\/?(assets\/[^"]+\.js)"/);
      expect(entryMatch, "入口脚本未找到").toBeTruthy();
      const entry = readFileSync(join(outDir, entryMatch![1]!), "utf8");
      // 关键断言：静态 import 回归时 memory 代码（含 MARKER）会被内联进入口 chunk
      expect(entry, "memory 模块被静态内联进入口——动态 import 隔离被破坏").not.toContain(MARKER);
      // memory 代码仍应存在于某个独立懒加载 chunk，且入口持有对它的引用
      const assetsDir = join(outDir, "assets");
      expect(existsSync(assetsDir), "assets 目录缺失").toBe(true);
      const memoryChunk = readdirSync(assetsDir).find(
        (f) => f.endsWith(".js") && readFileSync(join(assetsDir, f), "utf8").includes(MARKER),
      );
      expect(memoryChunk, "memory 懒加载 chunk 消失——回退路径被移除").toBeTruthy();
      expect(entry, "入口未引用 memory chunk——动态 import 被移除").toContain(memoryChunk!);
    } finally {
      rmSync(join(outDir, ".."), { recursive: true, force: true });
    }
  }, 120_000);
});
