import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
const run = promisify(execFile);
export function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; } }
export async function descendants(parentPid: number): Promise<number[]> {
  if (process.platform === "win32") {
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `@(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${parentPid}' | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress`], { windowsHide: true });
    return stdout.trim() ? ([] as number[]).concat(JSON.parse(stdout)) : [];
  }
  const value = await readFile(`/proc/${parentPid}/task/${parentPid}/children`, "utf8"); return value.trim().split(/\s+/).filter(Boolean).map(Number);
}
