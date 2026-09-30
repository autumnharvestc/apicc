import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { runCommand } from "./run-command.js";

export type CommandResult = { status: number | null; output: string };
export type CommandRunner = (exe: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, opts?: { cwd?: string }) => CommandResult;

export function parseJavaMajor(output: string): number | null {
  const match = /version\s+"(\d+)/.exec(output);
  return match ? Number(match[1]) : null;
}

export function requireJava21(major: number | null): void {
  if (major !== 21) throw new Error(`E2E 服务端要求 Java 21（检测到 ${major === null ? "未知版本" : `Java ${major}`}）`);
}

export function probeJavaMajor(
  exe: string,
  probe: (exe: string) => Pick<SpawnSyncReturns<string>, "status" | "stdout" | "stderr" | "error"> = (file) =>
    spawnSync(file, ["-version"], { encoding: "utf8", windowsHide: true, timeout: 15_000 }),
): number | null {
  try {
    const result = probe(exe);
    if (result.error || result.status !== 0) return null;
    return parseJavaMajor(`${result.stderr ?? ""}${result.stdout ?? ""}`);
  } catch {
    return null;
  }
}

const ownedRoots = new Set<string>();

function canonical(path: string): string {
  return resolve(path).replace(/[\\/]+$/, "").toLowerCase();
}

function assertStrictTempDescendant(path: string): string {
  const temp = canonical(tmpdir());
  const candidate = canonical(path);
  if (candidate === temp || !candidate.startsWith(`${temp}${sep}`)) {
    throw new Error(`拒绝清理临时目录边界外路径：${path}`);
  }
  return candidate;
}

export function createOwnedTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  ownedRoots.add(assertStrictTempDescendant(root));
  return root;
}

export function cleanupOwnedRoot(root: string | undefined): void {
  if (!root) return;
  const candidate = assertStrictTempDescendant(root);
  if (!ownedRoots.has(candidate)) throw new Error(`拒绝清理未由 fixture 创建的临时根：${root}`);
  rmSync(root, { recursive: true, force: true });
  ownedRoots.delete(candidate);
}

export function cleanupAfterConfirmedStop(
  stopped: boolean,
  roots: string[],
  cleanup: (root: string) => void = (root) => cleanupOwnedRoot(root),
): void {
  if (!stopped) throw new Error("服务端进程未确认退出，拒绝清理临时根");
  const errors: unknown[] = [];
  for (const root of roots) {
    try {
      cleanup(root);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw errors[0];
}

function findJar(root: string): string | undefined {
  if (!existsSync(root)) return undefined;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && /^apicc-server-.+\.jar$/.test(entry.name)) return path;
    if (entry.isDirectory()) {
      const found = findJar(path);
      if (found) return found;
    }
  }
  return undefined;
}

export type ServerArtifact = { jar: string; root: string; buildDirectory: string };

/** Build into a private Maven root; shared server/target is never read or written. */
export function prepareServerArtifact(opts: {
  serverDir: string;
  repoRoot: string;
  javaHome?: string;
  mvn: string;
  run?: CommandRunner;
  env?: NodeJS.ProcessEnv;
  onPrepared?: (artifact: ServerArtifact) => void;
  cleanup?: (root: string) => void;
}): ServerArtifact {
  const root = createOwnedTempRoot("apicc-e2e-build-");
  const buildDirectory = join(root, "maven-output");
  const run = opts.run ?? runCommand;
  const cleanup = opts.cleanup ?? cleanupOwnedRoot;
  const env = { ...process.env, ...opts.env, ...(opts.javaHome ? { JAVA_HOME: opts.javaHome } : {}) };
  const args = ["-s", join(opts.serverDir, ".mvn", "settings.xml"), "-f", join(opts.serverDir, "pom.xml"), "-q", "-DskipTests", `-Dapicc.build.directory=${buildDirectory}`, "package"];
  try {
    const result = run(opts.mvn, args, env, 600_000, { cwd: opts.repoRoot });
    if (result.status !== 0) {
      throw new Error(`服务端 jar 构建失败（exit ${result.status ?? "unknown"}）。\n${result.output.slice(-2000)}`);
    }
    const jar = findJar(buildDirectory);
    if (!jar) {
      throw new Error(`构建成功但专属 Maven 输出目录中未找到 apicc-server-*.jar：${buildDirectory}`);
    }
    const artifact = { jar, root, buildDirectory };
    opts.onPrepared?.(artifact);
    return artifact;
  } catch (error) {
    if (ownedRoots.has(canonical(root))) {
      try {
        cleanup(root);
      } catch {
        // Preserve the original build/discovery error; cleanup is best effort here.
      }
    }
    throw error;
  }
}

