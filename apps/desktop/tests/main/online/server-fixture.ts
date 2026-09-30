import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
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

function assertChild(root: string, child: string): void {
  const rootAbs = `${root.replace(/[\\/]+$/, "")}${sep}`;
  const childAbs = child.replace(/[\\/]+$/, "") + sep;
  if (!childAbs.startsWith(rootAbs)) throw new Error(`拒绝清理临时目录边界外路径：${child}`);
}

export function cleanupOwnedRoot(root: string | undefined): void {
  if (!root) return;
  assertChild(resolveTempRoot(), root);
  rmSync(root, { recursive: true, force: true });
}

function resolveTempRoot(): string {
  return tmpdir().replace(/[\\/]+$/, "");
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
}): ServerArtifact {
  const root = mkdtempSync(join(tmpdir(), "apicc-e2e-build-"));
  const buildDirectory = join(root, "maven-output");
  const run = opts.run ?? runCommand;
  const env = { ...process.env, ...opts.env, ...(opts.javaHome ? { JAVA_HOME: opts.javaHome } : {}) };
  const args = ["-s", join(opts.serverDir, ".mvn", "settings.xml"), "-f", join(opts.serverDir, "pom.xml"), "-q", "-DskipTests", `-Dapicc.build.directory=${buildDirectory}`, "package"];
  const result = run(opts.mvn, args, env, 600_000, { cwd: opts.repoRoot });
  if (result.status !== 0) {
    cleanupOwnedRoot(root);
    throw new Error(`服务端 jar 构建失败（exit ${result.status ?? "unknown"}）。\n${result.output.slice(-2000)}`);
  }
  const jar = findJar(buildDirectory);
  if (!jar) {
    cleanupOwnedRoot(root);
    throw new Error(`构建成功但专属 Maven 输出目录中未找到 apicc-server-*.jar：${buildDirectory}`);
  }
  return { jar, root, buildDirectory };
}

