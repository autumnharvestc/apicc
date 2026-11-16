import { realpath } from "node:fs";
import { stat } from "node:fs/promises";
import { parse } from "node:path";
import { promisify } from "node:util";

const resolveNativePath = promisify(realpath.native);

export interface WorkspaceDirectory {
  root: string;
  device: bigint;
  inode: bigint;
}

export async function resolveWorkspaceDirectory(path: string): Promise<WorkspaceDirectory> {
  if (!path) throw new Error("未指定工作区目录");
  const root = await resolveNativePath(path);
  if (parse(root).root === root) throw new Error("工作区必须位于文件系统根目录之下");
  const stats = await stat(root, { bigint: true });
  if (!stats.isDirectory()) throw new Error(`工作区路径不是目录: ${path}`);
  return { root, device: stats.dev, inode: stats.ino };
}

export function sameWorkspaceDirectory(left: WorkspaceDirectory, right: WorkspaceDirectory): boolean {
  if (left.device !== right.device) return false;
  return left.inode !== 0n && right.inode !== 0n ? left.inode === right.inode : left.root === right.root;
}
