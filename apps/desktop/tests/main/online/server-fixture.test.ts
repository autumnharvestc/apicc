import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanupOwnedRoot,
  cleanupAfterConfirmedStop,
  createOwnedTempRoot,
  parseJavaMajor,
  prepareServerArtifact,
  probeJavaMajor,
  requireJava21,
  type CommandRunner,
} from "./server-fixture.js";

const options = () => ({ serverDir: "C:/repo/server", repoRoot: "C:/repo", mvn: "C:/repo/server/mvnw.cmd" });

describe("server fixture Maven 产物隔离", () => {
  it("每次构建使用不同专属 build.directory，且 jar 不在共享 target", () => {
    const calls: string[][] = [];
    const run: CommandRunner = (_exe, args) => {
      calls.push(args);
      const dir = args.find((arg) => arg.startsWith("-Dapicc.build.directory="))!.slice("-Dapicc.build.directory=".length);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "apicc-server-fixture.jar"), "jar");
      return { status: 0, output: "BUILD SUCCESS" };
    };
    const a = prepareServerArtifact({ ...options(), run });
    const b = prepareServerArtifact({ ...options(), run });
    expect(a.buildDirectory).not.toBe(b.buildDirectory);
    expect(a.jar).not.toContain(`${join("C:/repo/server", "target")}`);
    expect(calls[0]).toContain(`-Dapicc.build.directory=${a.buildDirectory}`);
    expect(calls[0]).toContain("package");
    expect(calls[1]).toContain(`-Dapicc.build.directory=${b.buildDirectory}`);
    cleanupOwnedRoot(a.root);
    cleanupOwnedRoot(b.root);
    expect(existsSync(a.root)).toBe(false);
    expect(existsSync(b.root)).toBe(false);
  });

  it("失败构建返回可读错误且不产出/启动服务，失败临时根会回收", () => {
    let rootSeen = "";
    let started = false;
    const run: CommandRunner = (_exe, args) => {
      rootSeen = args.find((arg) => arg.startsWith("-Dapicc.build.directory="))!.slice("-Dapicc.build.directory=".length);
      return { status: 17, output: "COMPILATION FAILED: fixture" };
    };
    expect(() => prepareServerArtifact({ ...options(), run, onPrepared: () => (started = true) })).toThrow(/exit 17.*COMPILATION FAILED/s);
    expect(rootSeen).not.toBe("");
    expect(existsSync(join(rootSeen, ".."))).toBe(false);
    expect(started).toBe(false);
  });

  it("清理失败不会遮蔽非零构建和缺 jar 的原始错误", () => {
    let root = "";
    const cleanup = (value: string) => {
      root = value;
      throw new Error("remove denied");
    };
    const failed = () => prepareServerArtifact({ ...options(), cleanup, run: () => ({ status: 17, output: "COMPILATION FAILED: fixture" }) });
    expect(failed).toThrow(/exit 17.*COMPILATION FAILED/s);
    cleanupOwnedRoot(root);

    root = "";
    const noJar = () => prepareServerArtifact({ ...options(), cleanup, run: () => ({ status: 0, output: "BUILD SUCCESS" }) });
    expect(noJar).toThrow(/未找到.*maven-output/s);
    cleanupOwnedRoot(root);
  });

  it("runner 抛错和成功但缺 jar 都回收实际创建的专属根", () => {
    let rootSeen = "";
    const throwing: CommandRunner = (_exe, args) => {
      rootSeen = args.find((arg) => arg.startsWith("-Dapicc.build.directory="))!.slice("-Dapicc.build.directory=".length);
      throw new Error("runner exploded");
    };
    expect(() => prepareServerArtifact({ ...options(), run: throwing })).toThrow("runner exploded");
    expect(existsSync(join(rootSeen, ".."))).toBe(false);

    rootSeen = "";
    const noJar: CommandRunner = (_exe, args) => {
      rootSeen = args.find((arg) => arg.startsWith("-Dapicc.build.directory="))!.slice("-Dapicc.build.directory=".length);
      mkdirSync(rootSeen, { recursive: true });
      return { status: 0, output: "BUILD SUCCESS" };
    };
    expect(() => prepareServerArtifact({ ...options(), run: noJar })).toThrow(/未找到/);
    expect(existsSync(join(rootSeen, ".."))).toBe(false);
  });

  it("只允许清理本 fixture 创建的严格 temp 子根，拒绝 temp 根和未拥有子目录", () => {
    const owned = createOwnedTempRoot("apicc-fixture-test-");
    const unrelated = join(process.env.TEMP ?? "", "unrelated-apicc-fixture");
    expect(() => cleanupOwnedRoot(process.env.TEMP)).toThrow();
    expect(() => cleanupOwnedRoot(unrelated)).toThrow();
    cleanupOwnedRoot(owned);
    expect(existsSync(owned)).toBe(false);
  });

  it("只接受 Java 21，且能正确解析正常 stderr 版本输出", () => {
    expect(parseJavaMajor('openjdk version "21.0.12" 2025-07-15\n')).toBe(21);
    expect(() => requireJava21(20)).toThrow(/Java 20/);
    expect(() => requireJava21(22)).toThrow(/Java 22/);
    expect(() => requireJava21(21)).not.toThrow();
  });

  it("真实 Java 探针要求成功退出且拒绝非零、spawn 和超时失败", () => {
    const success = probeJavaMajor("java", () => ({ status: 0, stdout: "", stderr: 'openjdk version "21.0.12"' } as any));
    expect(success).toBe(21);
    expect(probeJavaMajor("java", () => ({ status: 0, stdout: "", stderr: 'openjdk version "20.0.2"' } as any))).toBe(20);
    expect(probeJavaMajor("java", () => ({ status: 0, stdout: "", stderr: 'openjdk version "22.0.1"' } as any))).toBe(22);
    expect(probeJavaMajor("java", () => ({ status: 17, stdout: "", stderr: 'openjdk version "21.0.12"' } as any))).toBeNull();
    expect(probeJavaMajor("java", () => ({ status: null, error: new Error("spawn") } as any))).toBeNull();
    expect(probeJavaMajor("java", () => ({ status: null, stdout: "", stderr: 'openjdk version "21.0.12"' } as any))).toBeNull();
  });

  it("生命周期仅在确认退出后删除，并在首个删除失败时继续第二个根", () => {
    const calls: string[] = [];
    expect(() => cleanupAfterConfirmedStop(false, ["data", "artifact"], (root) => calls.push(root))).toThrow(/退出/);
    expect(calls).toEqual([]);

    const errors: string[] = [];
    expect(() => cleanupAfterConfirmedStop(true, ["data", "artifact"], (root) => {
      calls.push(root);
      if (root === "data") throw new Error("data remove denied");
    })).toThrow("data remove denied");
    errors.push(...calls);
    expect(errors).toEqual(["data", "artifact"]);
  });
});

