import { serveLocalStressWorker, type StressWorkerChannel } from "@apicc/core";
import type { RunCliDeps } from "../../src/main.js";

/** Real v3 protocol/host with an in-process private IPC-equivalent boundary. */
export const localStressWorker: NonNullable<RunCliDeps["spawnLocalStressWorker"]> = async (identity, _timeout, prepare) => {
  const listeners = [new Set<(value: unknown) => void>(), new Set<(value: unknown) => void>()], closes = [new Set<() => void>(), new Set<() => void>()];
  const exits: ((value: { code: number | null; signal: string | null }) => void)[] = [];
  const exited = [0, 1].map((i) => new Promise<{ code: number | null; signal: string | null }>((resolve) => { exits[i] = resolve; }));
  const make = (i: number): StressWorkerChannel => ({
    send(value) { const copy = JSON.parse(JSON.stringify(value)); queueMicrotask(() => listeners[1 - i]!.forEach((f) => f(copy))); },
    subscribe(f) { listeners[i]!.add(f); return () => { listeners[i]!.delete(f); }; },
    onClose(f) { closes[i]!.add(f); return () => { closes[i]!.delete(f); }; },
    waitForExit() { return exited[i]!; },
    async finish() { exits[1 - i]!({ code: 0, signal: null }); closes[1 - i]!.forEach((f) => f()); },
    async close() { exits[1 - i]!({ code: 1, signal: null }); closes[1 - i]!.forEach((f) => f()); },
  });
  const coordinator = make(0), worker = make(1); serveLocalStressWorker(worker, identity, prepare); return coordinator;
};
