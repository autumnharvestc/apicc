/**
 * 迁移差异比对纯函数（M3-B 任务 3，简报裁定 D / 规格 §2 D8）：
 * - 拉取（planPull）：服务端 tree 的 files 清单与本地目录 hash 比对——同 path 同 hash 跳过，
 *   新路径 pulled、hash 不同 updated；永不删除本地多出的文件。
 * - 推送（planPush）：本地文件与服务端 tree 比对——新文件 baseVersion=0、已存在且 hash 不同
 *   带服务端 version 作 baseVersion 走 batch、同 hash 跳过——**从不盲目覆盖**（D8）。
 * **渲染层边界（关键 1 修复备案）**：本模块被 stores/online.ts 静态引入生产渲染入口，
 * sandbox 渲染进程拿不到 node 内置模块——因此本模块**禁止 import node:***；
 * hash 一律来自上游产出（服务端 tree 自带 hash；本地侧由 main 进程 scanDirFiles 产出），
 * planPush 直接比对 `remote.hash !== file.hash`，绝不在客户端重算。
 * 分批（chunk）对齐契约 ≤200/批上限。
 */
import type { OnlineTreeFile } from "./contract.js";

/** 本地文件行（scan 产物：/ 相对路径 + sha-256 hex + utf8 内容，结构对齐 main scanDirFiles）。 */
export interface LocalFileRow { path: string; hash: string; content: string }

export type PullFileAction = "pulled" | "updated" | "skipped";

export interface PullPlan {
  /** 需要取回内容的路径（pulled + updated），按服务端清单顺序。 */
  toFetch: string[];
  /** 逐文件动作明细（含 skipped）。 */
  details: Array<{ path: string; action: PullFileAction }>;
}

export function planPull(serverFiles: readonly OnlineTreeFile[], localFiles: readonly LocalFileRow[]): PullPlan {
  const localByPath = new Map(localFiles.map((f) => [f.path, f.hash]));
  const toFetch: string[] = [];
  const details: PullPlan["details"] = [];
  for (const file of serverFiles) {
    const localHash = localByPath.get(file.path);
    if (localHash === undefined) {
      toFetch.push(file.path);
      details.push({ path: file.path, action: "pulled" });
    } else if (localHash !== file.hash) {
      toFetch.push(file.path);
      details.push({ path: file.path, action: "updated" });
    } else {
      details.push({ path: file.path, action: "skipped" });
    }
  }
  return { toFetch, details };
}

export interface PushPlan {
  /** batch push 条目：新文件 baseVersion=0，已存在且 hash 不同带服务端当前 version。 */
  entries: Array<{ path: string; content: string; baseVersion: number }>;
  /** 同 hash 跳过的本地路径。 */
  skipped: string[];
}

export function planPush(localFiles: readonly LocalFileRow[], serverFiles: readonly OnlineTreeFile[]): PushPlan {
  const serverByPath = new Map(serverFiles.map((f) => [f.path, f]));
  const entries: PushPlan["entries"] = [];
  const skipped: string[] = [];
  for (const file of localFiles) {
    const remote = serverByPath.get(file.path);
    if (!remote) {
      entries.push({ path: file.path, content: file.content, baseVersion: 0 });
    } else if (remote.hash !== file.hash) {
      entries.push({ path: file.path, content: file.content, baseVersion: remote.version });
    } else {
      skipped.push(file.path);
    }
  }
  return { entries, skipped };
}

/** 按 size 分批（size < 1 时按 1 处理），保持元素顺序。 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const step = Math.max(1, Math.floor(size));
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += step) batches.push(items.slice(i, i + step));
  return batches;
}

