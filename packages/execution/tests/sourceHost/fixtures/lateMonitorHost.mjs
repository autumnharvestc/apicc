import { createRequire, syncBuiltinESMExports } from "node:module";
import { join, basename } from "node:path";
import { pathToFileURL } from "node:url";

const [applicationDirectory, directory] = process.argv.slice(2);
const childProcess = createRequire(import.meta.url)("node:child_process");
const spawn = childProcess.spawn;
let release;
let nativeClosed = false;
let nativeExitCode;
const closed = new Promise(resolve => { release = resolve; });
// Observe a real native close to place the external disk sampler's failure at
// the terminal boundary. Keep the actual spawn, process, pipes and helper.
childProcess.spawn = function (...args) {
  const child = spawn(...args);
  if (basename(args[0]) === "owned-process.exe") child.once("close", code => {
    nativeClosed = true; nativeExitCode = code; release();
  });
  return child;
};
syncBuiltinESMExports();

const { runOwnedProcess } = await import(pathToFileURL(join(applicationDirectory, "process.js")).href);
let errorCode;
try {
  await runOwnedProcess({
    toolPath: process.execPath, args: ["-e", ""], cwd: directory,
    env: { SystemRoot: process.env.SystemRoot }, maxOutputBytes: 1024,
    signal: new AbortController().signal,
    monitor: async () => { await closed; throw new Error("controlled late disk sampler failure"); },
  });
} catch (error) { errorCode = error.code; }
const settled = process.hrtime.bigint();
process.on("exit", () => console.log(JSON.stringify({ nativeClosed, nativeExitCode, errorCode, exitAfterSettlementMs: Number((process.hrtime.bigint() - settled) / 1000000n) })));
