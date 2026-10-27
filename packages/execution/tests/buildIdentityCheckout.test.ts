import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildIdentity } from "../src/buildIdentity.js";
import { runtimeCompatibilityIdForRuntime } from "../src/contract/runtime.js";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const identityScript = "packages/execution/scripts/build-identity.mjs";
const scriptSource = "packages/core/src/sandbox/jsEngine.ts";
let temporary: string;
let windowsCheckout: string;
let lfCheckout: string;

function identity(root: string): BuildIdentity {
  return JSON.parse(execFileSync(process.execPath, [join(root, identityScript), "--print"], { cwd: root, encoding: "utf8" }));
}

// Exercise real Git conversion and the real source collector, not configuration text or a mocked hash.
beforeAll(() => {
  temporary = mkdtempSync(join(tmpdir(), "apicc-identity-checkout-"));
  const seed = join(temporary, "seed");
  mkdirSync(seed);
  const sourceFiles = identity(repository).sourceFiles;
  for (const path of [...sourceFiles, ...(existsSync(join(repository, ".gitattributes")) ? [".gitattributes"] : [])]) {
    const destination = join(seed, path);
    mkdirSync(dirname(destination), { recursive: true });
    // Seed one canonical committed tree; only Git's checkout settings differ below.
    writeFileSync(destination, readFileSync(join(repository, path), "utf8").replaceAll("\r\n", "\n"));
  }
  const git = (...args: string[]) => execFileSync("git", [
    "-c", "core.autocrlf=false", "-c", "core.hooksPath=disabled-hooks",
    "-c", "commit.gpgsign=false", "-c", "user.name=apicc synthetic test",
    "-c", "user.email=synthetic@example.invalid", ...args,
  ], { cwd: seed, encoding: "utf8" });
  git("init", "--quiet");
  git("add", "--all");
  git("commit", "--quiet", "-m", "synthetic source tree");
  windowsCheckout = join(temporary, "windows");
  lfCheckout = join(temporary, "lf");
  for (const [autocrlf, eol, destination] of [["true", "crlf", windowsCheckout], ["false", "lf", lfCheckout]]) {
    execFileSync("git", ["-c", `core.autocrlf=${autocrlf}`, "-c", `core.eol=${eol}`,
      "clone", "--quiet", "--no-local", "-c", `core.autocrlf=${autocrlf}`, "-c", `core.eol=${eol}`, seed, destination],
    { cwd: temporary, encoding: "utf8" });
  }
});

afterAll(() => {
  // Only the exact directory allocated by this fixture; never the repository or the temporary root.
  if (temporary) rmSync(temporary, { recursive: true, force: true });
});

describe("source identity across real Git checkouts", () => {
  it("keeps every fingerprint input and generated identity identical with Windows and LF checkout settings", () => {
    const windows = identity(windowsCheckout);
    const lf = identity(lfCheckout);
    const mismatches = lf.sourceFiles.filter(path => !readFileSync(join(windowsCheckout, path)).equals(readFileSync(join(lfCheckout, path))));
    expect(mismatches).toEqual([]);
    expect(windows).toEqual(lf);

    // Content changes must still change both IDs and fail controlled-runtime admission.
    const path = join(windowsCheckout, scriptSource);
    writeFileSync(path, readFileSync(path, "utf8") + "\n// synthetic fingerprint mutation\n");
    const changed = identity(windowsCheckout);
    expect(changed.coreBuildId).not.toBe(windows.coreBuildId);
    expect(changed.scriptApiId).not.toBe(windows.scriptApiId);
    expect(() => runtimeCompatibilityIdForRuntime("22.19.0", "12.4.254.21-node.29", changed.scriptApiId)).toThrow(/Unknown/);
  });

  it("admits the generated LF script API only for the two verified runtime tuples", () => {
    const { scriptApiId } = identity(lfCheckout);
    for (const [node, v8] of [["22.19.0", "12.4.254.21-node.29"], ["24.19.0", "15.2.124.18-electron.0"]]) {
      expect(runtimeCompatibilityIdForRuntime(node, v8, scriptApiId)).toBe(`node-${node}-v8-${v8}-script-${scriptApiId}`);
    }
    expect(() => runtimeCompatibilityIdForRuntime("22.19.1", "12.4.254.21-node.29", scriptApiId)).toThrow(/Unknown/);
    expect(() => runtimeCompatibilityIdForRuntime("24.19.0", "15.2.124.18-electron.1", scriptApiId)).toThrow(/Unknown/);
  });
});
