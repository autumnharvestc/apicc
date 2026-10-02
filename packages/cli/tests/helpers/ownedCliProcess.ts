import { spawn, type ChildProcess } from "node:child_process";

export const OWNED_CLI_CLOSE_TIMEOUT_MS = 2_000;
export const OWNED_CLI_OUTPUT_LIMIT_BYTES = 1_048_576;

export type OwnedCliTermination =
  | "exit"
  | "spawn-error"
  | "deadline"
  | "aborted"
  | "cancelled"
  | "output-limit"
  | "close-timeout";

export type OwnedCliProcessOptions = {
  command?: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  readyToken?: string;
};

export type OwnedCliExit = { exitCode: number | null; signal: NodeJS.Signals | null };

export type OwnedCliResult = {
  termination: OwnedCliTermination;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  outputTruncated: boolean;
  closeConfirmed: boolean;
  terminationDiagnostics: string[];
  error?: Error;
};

export type OwnedCliProcess = {
  child: ChildProcess;
  result: Promise<OwnedCliResult>;
  exited: Promise<OwnedCliExit>;
  closeEventObserved: () => boolean;
  resultSettled: () => boolean;
  waitForReady: (timeoutMs?: number) => Promise<void>;
  cancel: (reason?: "deadline" | "aborted" | "cancelled") => Promise<OwnedCliResult>;
  cleanup: () => Promise<OwnedCliResult>;
};

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function validatePositiveFinite(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new Error(`${name} must be a positive finite number`);
  }
}

/**
 * Spawn one direct Node child and own its complete lifecycle in tests.
 * The result settles only after `close`, or after the bounded close-confirmation
 * window expires. No shell is used and captured output is always bounded.
 */
export function spawnOwnedCliProcess(options: OwnedCliProcessOptions): OwnedCliProcess {
  const timeoutMs = options.timeoutMs;
  const maxOutputBytes = options.maxOutputBytes ?? OWNED_CLI_OUTPUT_LIMIT_BYTES;
  validatePositiveFinite("timeoutMs", timeoutMs);
  validatePositiveFinite("maxOutputBytes", maxOutputBytes);

  const child = spawn(options.command ?? process.execPath, [...options.args], {
    cwd: options.cwd,
    env: options.env ?? { NODE_ENV: "test" },
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let state: "running" | "terminating" | "settled" = "running";
  let requestedTermination: OwnedCliTermination | undefined;
  let terminationError: Error | undefined;
  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  let closeEventObserved = false;
  let resultSettled = false;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputTruncated = false;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let deadlineTimer: NodeJS.Timeout | undefined;
  let closeTimer: NodeJS.Timeout | undefined;
  let removeAbortListener: (() => void) | undefined;
  let readyBuffer = "";
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void readyPromise.catch(() => {});
  let resolveExited!: (exit: OwnedCliExit) => void;
  const exited = new Promise<OwnedCliExit>((resolve) => {
    resolveExited = resolve;
  });
  const terminationDiagnostics: string[] = [];
  let resolveResult!: (result: OwnedCliResult) => void;
  const result = new Promise<OwnedCliResult>((resolve) => {
    resolveResult = resolve;
  });

  const clearTimers = () => {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (closeTimer) clearTimeout(closeTimer);
    deadlineTimer = undefined;
    closeTimer = undefined;
    removeAbortListener?.();
    removeAbortListener = undefined;
  };

  const complete = (closeConfirmed: boolean, closeCode: number | null, closeSignal: NodeJS.Signals | null, closeError?: Error) => {
    if (state === "settled") return;
    state = "settled";
    resultSettled = true;
    clearTimers();
    if (requestedTermination === "spawn-error") {
      // A platform-specific close code (for example Windows ERROR_FILE_NOT_FOUND)
      // is not a child exit code when the executable never started.
      exitCode = null;
      signal = null;
    } else {
      if (closeCode !== null || exitCode === null) exitCode = closeCode;
      if (closeSignal !== null || signal === null) signal = closeSignal;
    }
    const error = closeError ?? terminationError;
    resolveResult({
      termination: closeConfirmed ? (requestedTermination ?? "exit") : "close-timeout",
      exitCode,
      signal,
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
      stdoutBytes,
      stderrBytes,
      outputTruncated,
      closeConfirmed,
      terminationDiagnostics: [...terminationDiagnostics],
      ...(error ? { error } : {}),
    });
  };

  const beginCloseConfirmation = () => {
    if (state !== "terminating" || closeTimer) return;
    closeTimer = setTimeout(() => {
      if (state !== "settled") {
        const reason = requestedTermination ?? "cancelled";
        const detail = terminationError ? `: ${terminationError.message}` : "";
        complete(false, exitCode, signal, new Error(`owned child did not close within ${OWNED_CLI_CLOSE_TIMEOUT_MS}ms after ${reason}${detail}`));
      }
    }, OWNED_CLI_CLOSE_TIMEOUT_MS);
  };

  const requestTermination = (kind: Exclude<OwnedCliTermination, "exit" | "close-timeout">, error: Error) => {
    if (state === "settled") return;
    if (state === "running") {
      state = "terminating";
      requestedTermination = kind;
      terminationError = error;
      try {
        const killed = child.kill();
        if (!killed) terminationDiagnostics.push(`${kind}: child.kill() returned false`);
      } catch (killError) {
        const diagnostic = `${kind}: child.kill() threw: ${asError(killError).message}`;
        terminationDiagnostics.push(diagnostic);
        terminationError = new Error(`${error.message}; ${diagnostic}`);
      }
      beginCloseConfirmation();
    }
  };

  const capture = (target: "stdout" | "stderr", chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const bytes = buffer.byteLength;
    const currentBytes = target === "stdout" ? stdoutBytes : stderrBytes;
    if (target === "stdout") stdoutBytes += bytes;
    else stderrBytes += bytes;
    const remaining = Math.max(0, maxOutputBytes - currentBytes);
    if (remaining > 0) {
      const clipped = buffer.byteLength > remaining ? buffer.subarray(0, remaining) : buffer;
      (target === "stdout" ? stdoutChunks : stderrChunks).push(clipped);
    }
    if (currentBytes + bytes > maxOutputBytes) {
      outputTruncated = true;
      requestTermination("output-limit", new Error(`${target} exceeded ${maxOutputBytes} byte limit`));
    }
  };

  child.stdout?.on("data", (chunk: Buffer) => capture("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => capture("stderr", chunk));
  child.on("exit", (code, childSignal) => {
    exitCode = code;
    signal = childSignal;
    resolveExited({ exitCode: code, signal: childSignal });
    if (options.readyToken && !readySettled) {
      readySettled = true;
      rejectReady(new Error(`owned child exited before ready (${code ?? "signal"})`));
    }
  });
  child.on("error", (error) => {
    const normalized = asError(error);
    if (state === "terminating") {
      terminationDiagnostics.push(`child error during termination: ${normalized.message}`);
      return;
    }
    if (options.readyToken && !readySettled) {
      readySettled = true;
      rejectReady(new Error(`owned child errored before ready: ${normalized.message}`));
    }
    requestTermination("spawn-error", normalized);
  });
  child.on("close", (code, childSignal) => {
    closeEventObserved = true;
    if (options.readyToken && !readySettled) {
      readySettled = true;
      rejectReady(new Error("owned child closed before ready"));
    }
    complete(true, code, childSignal);
  });

  const inspectReady = (chunk: Buffer | string) => {
    const token = options.readyToken;
    if (!token || readySettled) return;
    readyBuffer = `${readyBuffer}${Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk}`;
    const keep = Math.max(token.length * 2, 256);
    if (readyBuffer.length > keep) readyBuffer = readyBuffer.slice(-keep);
    if (readyBuffer.includes(token)) {
      readySettled = true;
      resolveReady();
    }
  };
  child.stdout?.on("data", inspectReady);

  if (timeoutMs !== undefined) {
    deadlineTimer = setTimeout(() => {
      requestTermination("deadline", new Error(`owned child exceeded ${timeoutMs}ms deadline`));
    }, timeoutMs);
  }
  if (options.signal) {
    const abort = () => requestTermination("aborted", new Error("owned child aborted"));
    options.signal.addEventListener("abort", abort, { once: true });
    removeAbortListener = () => options.signal?.removeEventListener("abort", abort);
    if (options.signal.aborted) abort();
  }

  const cancel = async (reason: "deadline" | "aborted" | "cancelled" = "cancelled") => {
    requestTermination(reason, new Error(`owned child ${reason}`));
    return await result;
  };
  const cleanup = async () => {
    if (state === "settled") return await result;
    return await cancel("aborted");
  };

  const waitForReady = async (readyTimeoutMs = OWNED_CLI_CLOSE_TIMEOUT_MS) => {
    if (!options.readyToken) throw new Error("readyToken is required for waitForReady");
    validatePositiveFinite("readyTimeoutMs", readyTimeoutMs);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`owned child did not emit ${options.readyToken} within ${readyTimeoutMs}ms`)), readyTimeoutMs);
    });
    try {
      await Promise.race([
        readyPromise,
        exited.then(() => { throw new Error("owned child exited before ready"); }),
        result.then((closed) => {
          if (!readySettled) throw new Error(`owned child settled before ready (${closed.termination})`);
        }),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  return {
    child,
    result,
    exited,
    closeEventObserved: () => closeEventObserved,
    resultSettled: () => resultSettled,
    waitForReady,
    cancel,
    cleanup,
  };
}
