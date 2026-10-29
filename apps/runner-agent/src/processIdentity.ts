import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readlink, readdir } from "node:fs/promises";
import { basename } from "node:path";
const run = promisify(execFile);
export interface NativeProcessIdentity { pid: number; parentPid: number; birth: string; executable: string; commandLine: string }
export interface StressProcessIntent { runId: string; workerId: string; scriptPath: string }
/** Candidate selection is shared by the actual OS scans; unknown rows must not silently count as absent. */
export function matchesStressWorkerProcess(commandLine: unknown, intent: StressProcessIntent): boolean {
  if (typeof commandLine !== "string") throw new Error("OS process candidate identity is unreadable");
  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const token = (value: string) => new RegExp(`(?:^|[\\s"])${escaped(value)}(?=[\\s"]|$)`);
  return token(intent.runId).test(commandLine) && token(intent.workerId).test(commandLine) && (process.platform === "win32" ? commandLine.toLowerCase().includes(intent.scriptPath.toLowerCase()) : commandLine.includes(intent.scriptPath));
}
/** Actual exit supervision must rediscover intents that have never acquired a verified OS identity. */
export function stressIntentsNeedingDiscovery<T extends StressProcessIntent>(intents: Iterable<T>, processes: ReadonlyMap<string, { identity?: NativeProcessIdentity }>): T[] {
  return [...intents].filter(intent => !processes.get(`${intent.runId}/${intent.workerId}`)?.identity);
}
/** Discover only an already-authorized fixed worker identity, including an OS-reparented worker. */
export async function findStressWorkerProcesses(intent: StressProcessIntent): Promise<NativeProcessIdentity[]> {
  const matches = (command: unknown) => matchesStressWorkerProcess(command, intent);
  const found: NativeProcessIdentity[] = [];
  if (process.platform === "win32") {
    const name = basename(process.execPath).replace(/'/g, "''");
    const command = `@(Get-CimInstance Win32_Process -Filter \"Name='${name}'\" | Select-Object ProcessId,ParentProcessId,@{n='birth';e={$_.CreationDate.ToUniversalTime().Ticks.ToString()}},ExecutablePath,CommandLine) | ConvertTo-Json -Compress`;
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, timeout: 5000, maxBuffer: 1048576 });
    const rows = stdout.trim() ? ([] as unknown[]).concat(JSON.parse(stdout)) : [];
    for (const raw of rows) {
      const row = raw as { ProcessId: number; CommandLine?: string };
      if (!matches(row.CommandLine)) continue;
      const actual = await readProcessIdentity(row.ProcessId);
      if (actual && matches(actual.commandLine) && actual.executable.toLowerCase() === process.execPath.toLowerCase()) found.push(actual);
      else if (actual) throw new Error("Fixed worker OS ownership is uncertain");
    }
  } else {
    for (const entry of await readdir("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      let command: string;
      try { command = (await readFile(`/proc/${entry}/cmdline`, "utf8")).replace(/\0/g, " "); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") continue; throw error; }
      if (!matches(command)) continue;
      const actual = await readProcessIdentity(Number(entry));
      if (actual && actual.executable === process.execPath && matches(actual.commandLine)) found.push(actual);
      else if (actual) throw new Error("Fixed worker OS ownership is uncertain");
    }
  }
  return found;
}
/** Missing process is distinct from inspection failure. Callers must retain ownership on unknown failure. */
export async function readProcessIdentity(pid: number): Promise<NativeProcessIdentity | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid process identity");
  if (process.platform === "win32") {
    const command = `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object ProcessId,ParentProcessId,@{n='birth';e={$_.CreationDate.ToUniversalTime().Ticks.ToString()}},ExecutablePath,CommandLine | ConvertTo-Json -Compress`;
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, timeout: 5000, maxBuffer: 131072 });
    if (!stdout.trim()) return undefined;
    const value = JSON.parse(stdout);
    if (value.ProcessId !== pid || !Number.isSafeInteger(value.ParentProcessId) || typeof value.birth !== "string" || !value.birth || typeof value.ExecutablePath !== "string" || !value.ExecutablePath || typeof value.CommandLine !== "string") throw new Error("Process creation identity unavailable");
    return { pid, parentPid: value.ParentProcessId, birth: value.birth, executable: value.ExecutablePath, commandLine: value.CommandLine };
  }
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8"), fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    if (fields[0] === "Z") return undefined;
    const [executable, commandLine] = await Promise.all([readlink(`/proc/${pid}/exe`), readFile(`/proc/${pid}/cmdline`, "utf8")]);
    if (!fields[19] || !Number.isSafeInteger(Number(fields[1]))) throw new Error("Process creation identity unavailable");
    return { pid, parentPid: Number(fields[1]), birth: fields[19], executable, commandLine: commandLine.replace(/\0/g, " ") };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") return undefined; throw error; }
}
/** Reparenting does not replace a process; creation identity does. */
export function sameProcessIdentity(expected: NativeProcessIdentity, current: NativeProcessIdentity): boolean {
  const executable = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  return expected.pid === current.pid && expected.birth === current.birth && executable(expected.executable) === executable(current.executable);
}
