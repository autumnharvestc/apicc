/** Root-owned leaf admission. Containers must never hold a permit. */
export function createWorkflowScheduler(options: { maxConcurrency: number; signal?: AbortSignal }) {
  if (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1 || options.maxConcurrency > 32) throw new Error("Invalid workflow concurrency");
  type Waiting = { start(): void; cancel(reason: unknown): void };
  const waiting: Waiting[] = [];
  const drains = new Set<() => void>();
  let active = 0;
  const aborted = (signal?: AbortSignal) => signal?.reason ?? new Error("Workflow leaf cancelled");
  const rootAbort = () => { for (const item of [...waiting]) item.cancel(aborted(options.signal)); };
  const pump = () => {
    while (!options.signal?.aborted && active < options.maxConcurrency && waiting.length) waiting.shift()!.start();
    if (!waiting.length) options.signal?.removeEventListener("abort", rootAbort);
    if (!active && !waiting.length) { for (const resolve of drains) resolve(); drains.clear(); }
  };
  return {
    runLeaf<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (options.signal?.aborted || signal?.aborted) return Promise.reject(aborted(options.signal?.aborted ? options.signal : signal));
      return new Promise<T>((resolve, reject) => {
        const cleanup = () => signal?.removeEventListener("abort", cancel);
        const cancel = () => item.cancel(aborted(signal));
        const item: Waiting = {
          cancel(reason) {
            const index = waiting.indexOf(item);
            if (index < 0) return; // Started work keeps its permit until actual settlement.
            waiting.splice(index, 1); cleanup(); reject(reason); pump();
          },
          start() {
            cleanup(); active++;
            // No race against cancellation: the task owns its actual cleanup lifetime.
            Promise.resolve().then(task).then(resolve, reject).finally(() => { active--; pump(); });
          },
        };
        waiting.push(item);
        signal?.addEventListener("abort", cancel, { once: true });
        options.signal?.addEventListener("abort", rootAbort, { once: true });
        pump();
      });
    },
    drain(): Promise<void> {
      return !active && !waiting.length ? Promise.resolve() : new Promise((resolve) => { drains.add(resolve); });
    },
  };
}
export type WorkflowScheduler = ReturnType<typeof createWorkflowScheduler>;
