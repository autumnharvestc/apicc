// Runs inside this candidate's real Linux container; no mocked /proc or inferred zombie facts.
import assert from "node:assert/strict";
import { spawn, fork } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { findStressWorkerProcesses, matchesStressWorkerProcess, readProcessIdentity, sameProcessIdentity } from "../../dist/processIdentity.js";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, accept) { for (let i = 0; i < 100; i++) { const value = await read(); if (accept(value)) return value; await sleep(20); } throw Error("Owned Linux evidence deadline"); }
const result = { platform: process.platform, runtime: process.versions };
assert.equal(process.platform, "linux");
const parent = spawn("/bin/sh", ["-c", "sleep 0.2 & echo $!; kill -STOP $$; wait"], { stdio: ["ignore", "pipe", "inherit"] });
const parentExit = new Promise(resolve => parent.once("exit", (code, signal) => resolve({ code, signal })));
let zombiePid;
try {
  zombiePid = Number(await new Promise(resolve => parent.stdout.once("data", data => resolve(String(data).trim()))));
  assert.ok(Number.isSafeInteger(zombiePid) && zombiePid > 0);
  const stat = await until(() => readFile(`/proc/${zombiePid}/stat`, "utf8"), value => value.slice(value.lastIndexOf(")") + 2).startsWith("Z "));
  const cmdline = await readFile(`/proc/${zombiePid}/cmdline`, "utf8");
  assert.equal(cmdline, "");
  assert.equal(matchesStressWorkerProcess(cmdline, { runId: "fixed-run", workerId: "worker-1", scriptPath: "fixed-worker.js" }), false);
  assert.equal(await readProcessIdentity(zombiePid), undefined);
  result.zombie = { pid: zombiePid, parentPid: parent.pid, stat, cmdlineBytes: Buffer.byteLength(cmdline), classifiedAbsent: true };
} finally {
  process.kill(parent.pid, "SIGCONT"); result.zombieParentExit = await parentExit;
}
const runId = randomUUID(), workerId = "worker-1";
const orphanParent = fork(new URL("./stress-orphan-parent.mjs", import.meta.url), [runId, workerId], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
const orphanParentExit = new Promise(resolve => orphanParent.once("exit", (code, signal) => resolve({ code, signal })));
let pid, birth;
try {
  pid = await new Promise((resolve, reject) => { orphanParent.once("message", value => resolve(value.pid)); orphanParent.once("error", reject); });
  birth = await readProcessIdentity(pid); assert.ok(birth);
  orphanParent.kill("SIGKILL"); await orphanParentExit;
  const found = await findStressWorkerProcesses({ runId, workerId, scriptPath: fileURLToPath(new URL("./stress-orphan-worker.mjs", import.meta.url)) });
  assert.deepEqual(found.map(value => value.pid), [pid]); assert.equal(sameProcessIdentity(birth, found[0]), true);
  result.orphan = { runId, workerId, before: birth, discovered: found[0] };
} finally {
  orphanParent.kill("SIGKILL"); result.orphanParentExit = await orphanParentExit;
  if (pid && birth) { const current = await readProcessIdentity(pid); if (current && sameProcessIdentity(birth, current)) process.kill(pid, "SIGKILL"); }
  if (pid) await until(() => readProcessIdentity(pid), value => value === undefined);
  result.orphanExitConfirmed = !!pid;
}
console.log(JSON.stringify(result));
