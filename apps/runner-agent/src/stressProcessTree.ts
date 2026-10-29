import { findStressWorkerProcesses, readProcessIdentity, sameProcessIdentity, stressIntentsNeedingDiscovery, type NativeProcessIdentity } from "./processIdentity.js";
import type { ExecutionProcess, ExecutionProcessIntent } from "./ledger.js";

export interface OwnedStressProcess { record: ExecutionProcess; identity?: NativeProcessIdentity }
const pause = (signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
  const timer = setTimeout(finish, 100);
  const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason); };
  signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
});
/** The sole agent subtree exit algorithm, shared by live supervision and restart recovery. */
export async function confirmStressProcessTreeExited(intents: Iterable<ExecutionProcessIntent>, processes: Map<string, OwnedStressProcess>, record: (value: ExecutionProcess) => void, signal?: AbortSignal): Promise<void> {
  for (const intent of stressIntentsNeedingDiscovery(intents, processes)) {
    for (;;) {
      signal?.throwIfAborted();
      try {
        const found = await findStressWorkerProcesses(intent);
        if (found.length > 1) throw new Error("Ambiguous fixed worker process ownership");
        for (const actual of found) {
          const value: ExecutionProcess = { id: intent.id, name: intent.role === "coordinator" ? "stress coordinator" : `stress worker ${intent.workerId}`, role: intent.role, pid: actual.pid, scope: intent.scope, epoch: intent.epoch, birth: actual.birth, exited: false };
          record(value); processes.set(intent.id, { record: value, identity: actual });
        }
        break;
      } catch { signal?.throwIfAborted(); await pause(signal); }
    }
  }
  const outcomes = await Promise.allSettled([...processes.values()].map(async entry => {
    while (!entry.record.exited) {
      signal?.throwIfAborted();
      try {
        const current = await readProcessIdentity(entry.record.pid);
        const recordedBirthChanged = typeof entry.record.birth === "string" && /^[1-9]\d*$/.test(entry.record.birth) && current && entry.record.birth !== current.birth;
        if (!current || recordedBirthChanged || entry.identity && !sameProcessIdentity(entry.identity, current)) {
          const exited = { ...entry.record, exited: true, code: entry.record.code ?? null, signal: entry.record.signal ?? null };
          record(exited); entry.record = exited; return;
        }
        if (entry.identity && sameProcessIdentity(entry.identity, current)) process.kill(entry.record.pid, "SIGKILL");
      } catch { /* Unknown identity never grants kill authority or releases this reservation. */ }
      await pause(signal);
    }
  }));
  const failed = outcomes.find(outcome => outcome.status === "rejected"); if (failed?.status === "rejected") throw failed.reason;
}
