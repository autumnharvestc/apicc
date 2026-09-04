// 渲染层可达源码的 node:/electron: 静态导入守卫（关键 1 修复备案）：
// sandbox:true 的渲染进程拿不到 node 内置模块——vite 会把 `import … from "node:xxx"`
// externalize 成「访问即抛」的空 stub，vitest 在 node 环境全绿探不到，打包产品运行时才炸
// （产物层守门另见 tests/renderer/api/bundle-isolation.test.ts；本测试在**源码层**收口：
// 渲染层静态可达的 renderer/** 与 shared/** 禁止 node:/electron: 静态导入，
// node 能力一律下沉 main 进程或经 IPC 出口）。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** 动态加载的测试回退替身（api/index.ts 惰性 proxy，生产 preload 存在时永不求值）——唯一豁免。 */
const EXCEPTIONS = new Set(["src/renderer/src/api/memory.ts"]);

/** 归一为仓库内相对路径（以 apps/desktop/ 为根，跨平台分隔符）。 */
function relFromDesktopRoot(file: string): string {
  const after = file.split(/[\\/]apps[\\/]desktop[\\/]/).pop() ?? file;
  return after.split("\\").join("/");
}

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      collectSourceFiles(full, acc);
    } else if (/\.(ts|vue|mts)$/.test(name)) {
      acc.push(full);
    }
  }
  return acc;
}

describe("渲染层不 import node:/electron: 内置模块（关键 1 守卫）", () => {
  it("renderer/** 与 shared/** 的静态导入零 node:/electron: 命中（memory.ts 动态替身豁免）", () => {
    const srcRoot = join(__dirname, "..", "..", "src");
    const files = [
      ...collectSourceFiles(join(srcRoot, "renderer", "src")),
      ...collectSourceFiles(join(srcRoot, "shared")),
    ];
    expect(files.length).toBeGreaterThan(30); // 扫描面自检：源码在，扫描没跑空
    const offenders: string[] = [];
    for (const file of files) {
      if (EXCEPTIONS.has(relFromDesktopRoot(file))) continue;
      const content = readFileSync(file, "utf8");
      const hits = content.match(/from\s+["'](node|electron):?[a-z/]*/g) ?? [];
      if (hits.length > 0) offenders.push(`${relFromDesktopRoot(file)}: ${hits.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });
});
