import { spawn } from "node:child_process";
import type { SourceMaterialLease } from "./types.js";
import { resolveOwnedProcessHelper } from "./tools.js";
import { SourceHostError } from "./limits.js";

export interface OwnedProcessInput {
  readonly toolPath: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly maxOutputBytes: number;
  readonly signal: AbortSignal;
  readonly monitor?: () => Promise<void>;
}
export interface PrivateSourceReadOwner {
  readonly directory: string;
  collect(): Promise<void>;
  retainUncollected(): Promise<void>;
}
/** The Git reader owns this lifecycle; do not wrap it in the URL reader's release finally. */
export async function runPrivateSourceRead<T>(owner: PrivateSourceReadOwner, lease: SourceMaterialLease, operation: () => Promise<T>): Promise<T> {
  let value: T | undefined; let failure: unknown; let failed = false;
  try { value = await operation(); } catch (error) { failure = error; failed = true; }
  const retain = async () => { try { await owner.retainUncollected(); } catch { /* No lease release: the host still owns unresolved occupancy. */ } throw new SourceHostError("SYNC_PROCESS_UNCOLLECTED"); };
  if (failed && (failure as { code?: string })?.code === "SYNC_PROCESS_UNCOLLECTED") return retain();
  try { await owner.collect(); } catch { return retain(); }
  try { await lease.release(); } catch { throw new SourceHostError("SYNC_MATERIAL_RELEASE_FAILED"); }
  if (failed) throw failure;
  return value as T;
}
export interface OwnedProcessResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly collected: boolean;
}
/** Trusted absolute executables only; callers supply an isolated environment and application arguments. */
export async function runOwnedProcess(input: OwnedProcessInput): Promise<OwnedProcessResult> {
  const descriptor = JSON.stringify({ toolPath: input.toolPath, args: input.args, cwd: input.cwd, env: Object.fromEntries(Object.entries(input.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), maxOutputBytes: input.maxOutputBytes });
  if (Buffer.byteLength(descriptor) > 65536) throw new SourceHostError("SYNC_PROCESS_INPUT_LIMIT");
  return process.platform === "win32" ? runWindows(input, descriptor) : runPosix(input);
}

function monitor(input: OwnedProcessInput, interrupt: (code: string) => void) {
  let stopped = false; let pending: Promise<void> | undefined;
  const sample = () => { if (pending || stopped || !input.monitor) return; pending = Promise.resolve().then(() => input.monitor!()).catch(error => interrupt(error instanceof SourceHostError ? error.code : "SYNC_DISK_MONITOR_FAILED")).finally(() => { pending = undefined; }); };
  const timer = setInterval(sample, 25); sample();
  const abort = () => interrupt("SYNC_INTERRUPTED"); input.signal.addEventListener("abort", abort, { once: true }); if (input.signal.aborted) abort();
  return async () => { stopped = true; clearInterval(timer); input.signal.removeEventListener("abort", abort); await pending; };
}

async function runWindows(input: OwnedProcessInput, descriptor: string): Promise<OwnedProcessResult> {
  const helper = await resolveOwnedProcessHelper(import.meta.url);
  return new Promise((resolve, reject) => {
    const child = spawn(helper, [], { cwd: input.cwd, env: { SystemRoot: process.env.SystemRoot, PROGRAMDATA: process.env.PROGRAMDATA }, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; let proof: { kind: string; activeProcesses?: number; exitCode: number; errorCode?: string; stdout: string; stderr: string } | undefined;
    let invalid = false; let failure: string | undefined; let timer: ReturnType<typeof setTimeout> | undefined; let started = false; let closed = false;
    const interrupt = (code: string) => { failure ??= code; if (closed) return; if (!child.stdin.destroyed) child.stdin.write("cancel\n"); timer ??= setTimeout(() => { invalid = true; child.kill(); }, 9000); };
    child.stdin.on("error", () => undefined);
    child.stdin.write(descriptor + "\n");
    const stopMonitoring = monitor(input, interrupt);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (Buffer.byteLength(output) > Math.ceil(input.maxOutputBytes * 4 / 3) + 65536) { invalid = true; interrupt("SYNC_PROCESS_UNCOLLECTED"); return; }
      let newline: number;
      while ((newline = output.indexOf("\n")) >= 0) {
        const line = output.slice(0, newline); output = output.slice(newline + 1);
        try {
          const frame = JSON.parse(line);
          if (frame.kind === "started" && !started) started = true;
          else if (frame.kind === "collected" && !proof) proof = frame;
          else invalid = true;
        } catch { invalid = true; }
      }
    });
    // Helper stderr is neither specification data nor public diagnostics.
    child.stderr.resume();
    child.on("error", () => { invalid = true; });
    child.on("close", async code => {
      closed = true;
      if (timer) clearTimeout(timer); await stopMonitoring();
      if (invalid || code !== 0 || !proof || proof.activeProcesses !== 0 || output.trim()) { reject(new SourceHostError("SYNC_PROCESS_UNCOLLECTED")); return; }
      let stdout: Buffer, stderr: Buffer;
      try { stdout = Buffer.from(proof.stdout, "base64"); stderr = Buffer.from(proof.stderr, "base64"); } catch { reject(new SourceHostError("SYNC_PROCESS_UNCOLLECTED")); return; }
      if (stdout.length + stderr.length > input.maxOutputBytes) { reject(new SourceHostError("SYNC_PROCESS_UNCOLLECTED")); return; }
      const errorCode = failure ?? proof.errorCode;
      if (errorCode) reject(new SourceHostError(errorCode));
      else resolve({ exitCode: proof.exitCode, stdout, stderr, collected: true });
    });
  });
}

function runPosix(input: OwnedProcessInput): Promise<OwnedProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.toolPath, [...input.args], { cwd: input.cwd, env: input.env, shell: false, windowsHide: true, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: Buffer[] = []; let bytes = 0; let failure: string | undefined;
    const collect = () => { if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure = "SYNC_PROCESS_UNCOLLECTED"; } };
    const interrupt = (code: string) => { failure ??= code; collect(); };
    const stopMonitoring = monitor(input, interrupt);
    const output = (chunks: Buffer[], chunk: Buffer) => { bytes += chunk.length; if (bytes > input.maxOutputBytes) interrupt("SYNC_PROCESS_OUTPUT_LIMIT"); else chunks.push(chunk); };
    child.stdout.on("data", chunk => output(stdout, chunk)); child.stderr.on("data", chunk => output(stderr, chunk));
    child.on("error", () => { failure ??= "SYNC_PROCESS_START_FAILED"; });
    child.on("exit", collect);
    child.on("close", async code => {
      collect(); const until = Date.now() + 5000;
      while (child.pid) {
        try { process.kill(-child.pid, 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure = "SYNC_PROCESS_UNCOLLECTED"; break; }
        if (Date.now() >= until) { failure = "SYNC_PROCESS_UNCOLLECTED"; break; }
        await new Promise(r => setTimeout(r, 10));
      }
      await stopMonitoring();
      if (failure) reject(new SourceHostError(failure));
      else resolve({ exitCode: code ?? -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), collected: true });
    });
  });
}
