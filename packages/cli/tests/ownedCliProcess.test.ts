import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { OWNED_CLI_CLOSE_TIMEOUT_MS, spawnOwnedCliProcess, type OwnedCliLifecycleEvent, type OwnedCliProcess, type OwnedCliResult } from "./helpers/ownedCliProcess.js";

const fixture = fileURLToPath(new URL("./fixtures/owned-cli-child.mjs", import.meta.url));
const cwd = fileURLToPath(new URL("../../", import.meta.url));

function startFixture(mode: "normal" | "exit-after-output" | "wait" | "ready-wait" | "ready-late-action" | "flood", options: Partial<Parameters<typeof spawnOwnedCliProcess>[0]> = {}, registerCleanup = true): OwnedCliProcess {
  const owned = spawnOwnedCliProcess({
    command: process.execPath,
    args: [fixture, mode],
    cwd,
    env: { NODE_ENV: "test" },
    ...options,
  });
  if (registerCleanup) {
    onTestFinished(async () => {
      await owned.cleanup();
    });
  }
  return owned;
}

type OwnedFixtureCleanup = { ok: boolean; childrenClosed: boolean; fixtureRemoved: boolean; retainedRoot?: string; errors: string[] };

function createOwnedFixtureOwner(registerHook = true) {
  const root = mkdtempSync(join(tmpdir(), "apicc-owned-child-"));
  const children = new Set<OwnedCliProcess>();
  let cleanupStarted = false;
  let cleanupPromise: Promise<OwnedFixtureCleanup> | undefined;
  let beforeCleanup: (() => void) | undefined;
  const start = (mode: Parameters<typeof startFixture>[0], options: Partial<Parameters<typeof spawnOwnedCliProcess>[0]> = {}) => {
    if (cleanupStarted) throw new Error("fixture cleanup already started; child start blocked");
    const child = startFixture(mode, { cwd: root, ...options }, false);
    children.add(child);
    return child;
  };
  const setBeforeCleanup = (callback: () => void) => {
    if (cleanupStarted) throw new Error("fixture cleanup already started; callback registration blocked");
    beforeCleanup = callback;
  };
  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupStarted = true;
    let beforeCleanupError: Error | undefined;
    try {
      beforeCleanup?.();
    } catch (error) {
      beforeCleanupError = error instanceof Error ? error : new Error(String(error));
    }
    cleanupPromise = (async () => {
      const childResults = await Promise.all([...children].map((child) => child.cleanup()));
      const childrenClosed = childResults.every((result) => result.closeConfirmed);
      const errors = beforeCleanupError ? [`before cleanup: ${beforeCleanupError.message}`] : [];
      if (!childrenClosed) errors.push("one or more owned children did not confirm close");
      const safeRoot = root.startsWith(join(tmpdir(), "apicc-owned-child-"));
      let fixtureRemoved = false;
      if (childrenClosed && safeRoot) {
        rmSync(root, { recursive: true, force: true });
        fixtureRemoved = true;
      } else if (!safeRoot) {
        errors.push("fixture root failed ownership validation");
      }
      return {
        ok: childrenClosed && fixtureRemoved && errors.length === 0,
        childrenClosed,
        fixtureRemoved,
        ...(fixtureRemoved ? {} : { retainedRoot: root }),
        errors,
      };
    })();
    return cleanupPromise;
  };
  if (registerHook) {
    onTestFinished(async () => {
      const result = await cleanup();
      if (!result.ok) throw new Error(`fixture cleanup failed; retainedRoot=${result.retainedRoot ?? "none"}; ${result.errors.join("; ")}`);
    });
  }
  return { root, start, setBeforeCleanup, cleanup };
}

function ownedFixtureCleanupFailure(result: OwnedFixtureCleanup): Error {
  return new Error(`fixture cleanup failed; retainedRoot=${result.retainedRoot ?? "none"}; ${result.errors.join("; ")}`);
}

async function finishRetainedFixture(owner: ReturnType<typeof createOwnedFixtureOwner>, owned: OwnedCliProcess, realCleanup: OwnedCliProcess["cleanup"]): Promise<void> {
  owned.child.stdout?.resume();
  owned.child.stderr?.resume();
  try {
    await owner.cleanup();
  } finally {
    await realCleanup();
    if (!owned.closeEventObserved()) {
      throw new Error(`fixture cleanup failed; retainedRoot=${owner.root}; real owned child did not confirm close`);
    }
    const root = resolve(owner.root);
    const prefix = "apicc-owned-child-";
    if (!isAbsolute(owner.root) || root !== owner.root || dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith(prefix) || basename(root) === prefix) {
      throw new Error(`fixture cleanup failed; retainedRoot=${owner.root}; fixture root failed ownership validation`);
    }
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
}

async function appearsBeforeDeadline(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return existsSync(path);
}

describe("owned CLI child lifecycle", () => {
  it("returns the real exit code and both streams only after close", async () => {
    const owned = startFixture("normal");
    const result = await owned.result;

    expect(result).toMatchObject({
      termination: "exit",
      exitCode: 0,
      signal: null,
      stdout: "owned-child-stdout\n",
      stderr: "owned-child-stderr\n",
      closeConfirmed: true,
    });
  });

  it("emits a bounded monotonic lifecycle trace without changing the captured result", async () => {
    const events: OwnedCliLifecycleEvent[] = [];
    const owned = startFixture("normal", {
      onLifecycleEvent: (event) => events.push(event),
    });
    const result = await owned.result;

    expect(result).toMatchObject({
      termination: "exit",
      exitCode: 0,
      stdout: "owned-child-stdout\n",
      stderr: "owned-child-stderr\n",
      closeConfirmed: true,
    });
    expect(events.map((event) => event.phase)).toEqual(["start", "spawn", "exit", "close"]);
    const elapsed = events.map((event) => event.elapsedMs);
    expect(elapsed.every(Number.isFinite)).toBe(true);
    expect(elapsed).toEqual([...elapsed].sort((left, right) => left - right));
    expect(events[1]).toMatchObject({ pid: owned.child.pid });
    expect(events[2]).toMatchObject({ code: 0, signal: null });
    expect(events[3]).toMatchObject({
      code: 0,
      signal: null,
      stdoutBytes: Buffer.byteLength("owned-child-stdout\n"),
      stderrBytes: Buffer.byteLength("owned-child-stderr\n"),
    });
  });

  it("isolates observer exceptions from deadline kill, result settlement, and real close", async () => {
    const events: OwnedCliLifecycleEvent[] = [];
    const owned = startFixture("ready-wait", {
      readyToken: "READY",
      onLifecycleEvent: (event) => {
        events.push(event);
        throw new Error("observer exception must not affect child lifecycle");
      },
    });
    await owned.waitForReady(1_000);
    const result = await owned.cancel("deadline");

    expect(result).toMatchObject({ termination: "deadline", closeConfirmed: true });
    expect(owned.resultSettled()).toBe(true);
    expect(owned.closeEventObserved()).toBe(true);
    expect(events.map((event) => event.phase)).toContain("close");
  });

  it("waits for close after exit while draining remaining stdio", async () => {
    const owner = createOwnedFixtureOwner();
    const root = owner.root;
    const releaseFile = join(root, "release-exit-output");
    const owned = owner.start("exit-after-output", {
      env: { NODE_ENV: "test", OWNED_CLI_RELEASE_FILE: releaseFile },
      readyToken: "EXIT-BARRIER-READY",
    });
    let streamsPaused = false;
    const restoreStreams = () => {
      if (!streamsPaused) return;
      owned.child.stdout?.resume();
      owned.child.stderr?.resume();
      streamsPaused = false;
    };
    owner.setBeforeCleanup(restoreStreams);
    let primaryError: unknown;
    let result: OwnedCliResult | undefined;
    try {
      await owned.waitForReady(1_000);
      owned.child.stdout?.pause();
      owned.child.stderr?.pause();
      streamsPaused = true;
      writeFileSync(releaseFile, "release\n");

      let barrierTimer: NodeJS.Timeout | undefined;
      const outcome = await Promise.race([
        owned.exited.then((value) => ({ kind: "exit" as const, value })),
        owned.result.then((value) => ({ kind: "result" as const, value })),
        new Promise<{ kind: "deadline" }>((resolve) => {
          barrierTimer = setTimeout(() => resolve({ kind: "deadline" }), OWNED_CLI_CLOSE_TIMEOUT_MS);
        }),
      ]).finally(() => {
        if (barrierTimer) clearTimeout(barrierTimer);
      });
      if (outcome.kind === "result") {
        throw new Error(`owned result settled before exit/close barrier: ${outcome.value.termination}${outcome.value.error ? ` (${outcome.value.error.message})` : ""}`);
      }
      if (outcome.kind === "deadline") throw new Error("owned exit/close barrier deadline expired");
      expect(outcome.value.exitCode).toBe(0);
      expect(owned.closeEventObserved()).toBe(false);
      expect(owned.resultSettled()).toBe(false);
      restoreStreams();
      let resultTimer: NodeJS.Timeout | undefined;
      result = await Promise.race([
        owned.result,
        new Promise<OwnedCliResult>((_, reject) => {
          resultTimer = setTimeout(() => reject(new Error("owned result did not settle after stdio resume")), OWNED_CLI_CLOSE_TIMEOUT_MS);
        }),
      ]).finally(() => {
        if (resultTimer) clearTimeout(resultTimer);
      });
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      const cleanup = await owner.cleanup();
      if (!cleanup.ok) {
        const cleanupError = ownedFixtureCleanupFailure(cleanup);
        if (primaryError instanceof Error) primaryError.cause = cleanupError;
        else throw cleanupError;
      }
    }
    expect(result).toMatchObject({
      closeConfirmed: true,
      exitCode: 0,
    });
    expect(result?.stdout).toBe("EXIT-BARRIER-READY\n" + "exit-before-close-stdout\n" + "tail-after-exit-stdout\n".repeat(1024));
    expect(result?.stderr).toBe("exit-before-close-stderr\n" + "tail-after-exit-stderr\n".repeat(1024));
  });

  it("retains the barrier root when close confirmation fails after restoring stdio", async () => {
    const owner = createOwnedFixtureOwner(false);
    const owned = owner.start("ready-wait", { readyToken: "READY" });
    const realCleanup = owned.cleanup;
    let streamsPaused = false;
    let realResult: OwnedCliResult | undefined;
    let cleanup: OwnedFixtureCleanup | undefined;
    owner.setBeforeCleanup(() => {
      if (!streamsPaused) return;
      owned.child.stdout?.resume();
      owned.child.stderr?.resume();
      streamsPaused = false;
    });
    try {
      await owned.waitForReady(1_000);
      owned.child.stdout?.pause();
      owned.child.stderr?.pause();
      streamsPaused = true;
      owned.cleanup = async () => {
        realResult = await realCleanup();
        return {
          ...realResult,
          termination: "close-timeout",
          closeConfirmed: false,
          error: new Error("test-controlled close confirmation loss"),
        };
      };
      cleanup = await owner.cleanup();
      expect(cleanup).toMatchObject({
        ok: false,
        childrenClosed: false,
        fixtureRemoved: false,
        retainedRoot: owner.root,
      });
      expect(cleanup.errors).toContain("one or more owned children did not confirm close");
      expect(realResult).toMatchObject({ closeConfirmed: true });
      expect(owned.closeEventObserved()).toBe(true);
      expect(owned.child.stdout?.isPaused()).toBe(false);
      expect(owned.child.stderr?.isPaused()).toBe(false);
      expect(existsSync(owner.root)).toBe(true);
    } finally {
      await finishRetainedFixture(owner, owned, realCleanup);
    }
  });

  it("retains its exact root and reports failure when final cleanup cannot confirm real close", async () => {
    const owner = createOwnedFixtureOwner(false);
    const owned = owner.start("ready-wait", { readyToken: "READY" });
    const realCleanup = owned.cleanup;
    const realCloseObserved = owned.closeEventObserved;
    owner.setBeforeCleanup(() => {
      owned.child.stdout?.resume();
      owned.child.stderr?.resume();
    });
    try {
      await owned.waitForReady(1_000);
      owned.child.stdout?.pause();
      owned.child.stderr?.pause();
      owned.cleanup = async () => {
        const result = await realCleanup();
        return { ...result, termination: "close-timeout", closeConfirmed: false };
      };
      await owner.cleanup();
      expect(realCloseObserved()).toBe(true);
      // The real child is already closed; only the final deletion decision is controlled.
      owned.closeEventObserved = () => false;
      const error = await finishRetainedFixture(owner, owned, realCleanup).catch((failure: unknown) => failure);
      expect({ rootExists: existsSync(owner.root), error }).toMatchObject({
        rootExists: true,
        error: { message: `fixture cleanup failed; retainedRoot=${owner.root}; real owned child did not confirm close` },
      });
    } finally {
      owned.closeEventObserved = realCloseObserved;
      await finishRetainedFixture(owner, owned, realCleanup);
    }
  });

  it("confirms real close in final cleanup when READY has not completed", async () => {
    const owner = createOwnedFixtureOwner(false);
    const owned = owner.start("ready-wait", { readyToken: "NEVER-EMITTED" });
    const realCleanup = owned.cleanup;
    try {
      await expect(owned.waitForReady(50)).rejects.toThrow(/within 50ms|before ready/i);
    } finally {
      await finishRetainedFixture(owner, owned, realCleanup);
    }
    expect(owned.closeEventObserved()).toBe(true);
    expect(existsSync(owner.root)).toBe(false);
  });

  it("reports a startup error instead of manufacturing an exit code", async () => {
    const missing = join(cwd, "tests", "fixtures", "does-not-exist-node-executable");
    expect(existsSync(missing)).toBe(false);
    const owned = spawnOwnedCliProcess({
      command: missing,
      args: [],
      cwd,
      env: { NODE_ENV: "test" },
    });
    onTestFinished(async () => {
      await owned.cleanup();
    });
    const result = await owned.result;

    expect(result.termination).toBe("spawn-error");
    expect(result.closeConfirmed).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.error?.message).toMatch(/Cannot find module|cannot find|ENOENT/i);
  });

  it("manually cancels a READY child with deadline reason, confirms close, then leaves the next child clean", async () => {
    const stuck = startFixture("ready-wait", { readyToken: "READY" });
    await stuck.waitForReady(1_000);
    const timed = await stuck.cancel("deadline");

    expect(timed.termination).toBe("deadline");
    expect(timed.closeConfirmed).toBe(true);
    expect(timed.exitCode === null || timed.signal !== null).toBe(true);

    const next = startFixture("normal");
    const nextResult = await next.result;
    expect(nextResult).toMatchObject({ termination: "exit", exitCode: 0, closeConfirmed: true });
  });

  it("aborts a real waiting child and reports the bounded termination", async () => {
    const controller = new AbortController();
    const owned = startFixture("ready-wait", { readyToken: "READY", signal: controller.signal });
    await owned.waitForReady(1_000);
    controller.abort();
    const result = await owned.result;

    expect(result.termination).toBe("aborted");
    expect(result.closeConfirmed).toBe(true);
  });

  it("races readiness against an early child exit instead of waiting forever", async () => {
    const owned = startFixture("normal", { readyToken: "READY" });
    await expect(owned.waitForReady(1_000)).rejects.toThrow(/before ready|exit/i);
    const result = await owned.result;
    expect(result.termination).toBe("exit");
    expect(result.closeConfirmed).toBe(true);
  });

  it("cleans an abnormal readiness failure before removing its fixture root", async () => {
    const owner = createOwnedFixtureOwner();
    try {
      const child = owner.start("ready-late-action", { readyToken: "NEVER-EMITTED" });
      await expect(child.waitForReady(50)).rejects.toThrow(/within 50ms|before ready/i);
    } finally {
      const cleanup = await owner.cleanup();
      expect(cleanup).toMatchObject({ ok: true, childrenClosed: true, fixtureRemoved: true });
      expect(existsSync(owner.root)).toBe(false);
    }
  });

  it("aborts only after ready and leaves no scheduled late action for the next child", async () => {
    const owner = createOwnedFixtureOwner();
    const root = owner.root;
    const lateAction = join(root, "late-action.txt");
    try {
      const owned = owner.start("ready-late-action", { readyToken: "READY" });
      await owned.waitForReady(1_000);
      const result = await owned.cancel("aborted");
      expect(result.closeConfirmed).toBe(true);
      expect(await appearsBeforeDeadline(lateAction, 300)).toBe(false);

      const next = owner.start("normal");
      expect(await next.result).toMatchObject({ termination: "exit", exitCode: 0, closeConfirmed: true });
      expect(existsSync(lateAction)).toBe(false);
    } finally {
      const cleanup = await owner.cleanup();
      expect(cleanup).toMatchObject({ ok: true, childrenClosed: true, fixtureRemoved: true });
    }
  });

  it("turns output overflow into an explicit bounded failure", async () => {
    const owned = startFixture("flood", { maxOutputBytes: 1024 });
    const result = await owned.result;

    expect(result.termination).toBe("output-limit");
    expect(result.outputTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1024);
    expect(result.closeConfirmed).toBe(true);
  });

});
