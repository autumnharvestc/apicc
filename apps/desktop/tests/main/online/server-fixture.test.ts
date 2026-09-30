import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupOwnedRoot, parseJavaMajor, prepareServerArtifact, requireJava21, type CommandRunner } from "./server-fixture.js";

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
    const run: CommandRunner = (_exe, args) => {
      rootSeen = args.find((arg) => arg.startsWith("-Dapicc.build.directory="))!.slice("-Dapicc.build.directory=".length);
      return { status: 17, output: "COMPILATION FAILED: fixture" };
    };
    expect(() => prepareServerArtifact({ ...options(), run })).toThrow(/exit 17.*COMPILATION FAILED/s);
    expect(rootSeen).not.toBe("");
    expect(existsSync(rootSeen)).toBe(false);
  });

  it("只接受 Java 21，且能正确解析正常 stderr 版本输出", () => {
    expect(parseJavaMajor('openjdk version "21.0.12" 2025-07-15\n')).toBe(21);
    expect(() => requireJava21(20)).toThrow(/Java 20/);
    expect(() => requireJava21(22)).toThrow(/Java 22/);
    expect(() => requireJava21(21)).not.toThrow();
  });
});

