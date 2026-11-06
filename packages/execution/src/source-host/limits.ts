export class SourceHostError extends Error {
  constructor(readonly code: string, readonly retryable = false) { super(code); this.name = "SourceHostError"; }
}

/** One owned signal across preparation, DNS, requests, decoding and retries. */
export function readLifetime(deadlineAtMs: number, caller?: AbortSignal) {
  const controller = new AbortController();
  let code = "SYNC_DEADLINE";
  const cancel = () => { code = "SYNC_CANCELLED"; controller.abort(); };
  caller?.addEventListener("abort", cancel, { once: true });
  if (caller?.aborted) cancel();
  const remaining = deadlineAtMs - Date.now();
  if (remaining <= 0) controller.abort();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(remaining, 2147483647)));
  const check = () => {
    if (!controller.signal.aborted && Date.now() >= deadlineAtMs) controller.abort();
    if (controller.signal.aborted) throw new SourceHostError(code);
  };
  return { signal: controller.signal, check, dispose: () => { clearTimeout(timer); caller?.removeEventListener("abort", cancel); } };
}
