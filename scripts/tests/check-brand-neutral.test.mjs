import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

// Catches a clean tracked scan silently omitting new untracked production files.
test("include-untracked fails on an untracked source under the same word policy", () => {
  const root = mkdtempSync(join(tmpdir(), "apicc-brand-test-"));
  try {
    mkdirSync(join(root, "scripts")); mkdirSync(join(root, "src"));
    copyFileSync(new URL("../check-brand-neutral.mjs", import.meta.url), join(root, "scripts/check-brand-neutral.mjs"));
    execFileSync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
    writeFileSync(join(root, "src/new-source.ts"), `// ${"post" + "man"}\n`);
    const result = spawnSync(process.execPath, ["scripts/check-brand-neutral.mjs", "--include-untracked"], { cwd: root, windowsHide: true, encoding: "utf8" });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /src\/new-source\.ts:1:/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
