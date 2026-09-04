/**
 * 迁移的 main 进程文件面（M3-B 任务 3，简报裁定 D）：本地目录扫描与写盘。
 * - 扫描（scanDirFiles）：递归读取文本文件，跳过生成物目录（`.apicc/` 运行历史、`.git/`），
 *   产出 `/` 分隔的相对路径 + sha-256 hash + utf8 内容——与服务端 tree 的 path 口径一致
 *   （§2 D6：服务端目录树与本地工作区完全同构）。选型说明：推送差异直接以目录遍历的
 *   原文为源（服务端只当字节管家），不经 M1 fileStorage 的模型序列化——模型往返会重排
 *   YAML 字段导致同内容 hash 漂移，破坏「同 hash 跳过」语义。
 * - 写盘（writeFiles）：相对路径先过契约 OnlinePathSchema（禁 `..`/绝对路径/反斜杠/空段）
 *   再做包含性校验（resolve 后必须仍位于目标目录内），逐文件 mkdir -p 写入。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { OnlinePathSchema } from "../../shared/online/contract.js";

/** 生成物隔离目录（规格 §8）：迁移扫描/推送永不触碰。 */
const SKIP_DIRS = new Set([".apicc", ".git"]);

export interface ScannedFile { path: string; hash: string; content: string }

/**
 * 与服务端同口径的内容指纹（§3.4：sha-256 hex utf8）。
 * **main 进程专用**（关键 1 修复备案）：渲染层 sandbox 无 node:crypto，hash 比对在渲染层
 * 一律用上游产出的 hash（服务端 tree 自带 / 本函数扫描产出），绝不在客户端重算。
 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** 递归扫描目录下的文本文件（utf8）；目录不存在抛可读错误。 */
export function scanDirFiles(root: string): ScannedFile[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`目录不存在或不是目录: ${root}`);
  }
  const files: ScannedFile[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(full);
        continue;
      }
      const content = readFileSync(full, "utf8");
      files.push({ path: relative(root, full).split(sep).join("/"), hash: hashContent(content), content });
    }
  };
  walk(root);
  return files;
}

/** 逐文件写入目标目录（校验全部通过才开始写，避免半途越界写入）。返回写入的相对路径清单。 */
export function writeFiles(root: string, files: ReadonlyArray<{ path: string; content: string }>): string[] {
  const resolvedRoot = resolve(root) + sep;
  const targets = files.map((file) => {
    const parsed = OnlinePathSchema.safeParse(file.path);
    if (!parsed.success) throw new Error(`迁移写入路径非法: ${file.path}`);
    const full = resolve(root, file.path);
    if (!full.startsWith(resolvedRoot)) throw new Error(`迁移写入路径越出目标目录: ${file.path}`);
    return { full, path: file.path, content: file.content };
  });
  const written: string[] = [];
  for (const target of targets) {
    mkdirSync(dirname(target.full), { recursive: true });
    writeFileSync(target.full, target.content, "utf8");
    written.push(target.path);
  }
  return written;
}
