import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { onTestFinished, describe, expect, it } from "vitest";
import { fileStorage } from "@apicc/core";
import type { Workspace } from "@apicc/core";
import { spawnOwnedCliProcess, type OwnedCliLifecycleEvent, type OwnedCliProcess, type OwnedCliResult } from "./helpers/ownedCliProcess.js";

type SpecialUrlVariant = "omitted-slashes" | "whitespace" | "backslash" | "uppercase";
type ObservedRequest = { method: string; url: string };
type ServerCloseResult = { closed: boolean; timedOut: boolean; error?: Error };
type FixtureCleanupResult = {
  ok: boolean;
  initialized: boolean;
  childrenClosed: boolean;
  serverClosed: boolean;
  fixtureRemoved: boolean;
  childStarts: number;
  retainedRoot?: string;
  errors: string[];
};
type FixtureLifecycleEvent = {
  phase: string;
  elapsedMs: number;
  childOrdinal?: number;
  childElapsedMs?: number;
  pid?: number;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  stdoutBytes?: number;
  stderrBytes?: number;
  stageElapsedMs?: number;
  settled?: boolean;
  timedOut?: boolean;
  childrenClosed?: boolean;
  serverClosed?: boolean;
  fixtureRemoved?: boolean;
  ok?: boolean;
  childCount?: number;
  errorCount?: number;
};

const cliEntry = join(dirname(fileURLToPath(import.meta.url)), "../dist/bin.js");
const childFixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures/owned-cli-child.mjs");
const FIXTURE_CLEANUP_TIMEOUT_MS = 2_000;
const MULTI_CLI_CASE_TIMEOUT_MS = 15_000;

function specialUrl(variant: SpecialUrlVariant, baseUrl: string): string {
  const hostPath = baseUrl.slice("http://".length);
  return variant === "omitted-slashes"
    ? `http:${hostPath}`
    : variant === "whitespace"
      ? `\thttp:${hostPath} \n`
      : variant === "backslash"
        ? `http:\\${hostPath}`
        : `HTTP://${hostPath}`;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.off("error", onError);
      server.off("listening", onListening);
      try { server.close(); } catch { /* cleanup reports the eventual close state */ }
      reject(new Error(`loopback server did not listen within ${FIXTURE_CLEANUP_TIMEOUT_MS}ms`));
    }, FIXTURE_CLEANUP_TIMEOUT_MS);
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(0, "127.0.0.1");
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback server did not expose a port");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<ServerCloseResult> {
  let callbackDone = false;
  let forceTimer: NodeJS.Timeout | undefined;
  let deadlineTimer: NodeJS.Timeout | undefined;
  const closePromise = new Promise<ServerCloseResult>((resolve) => {
    const finish = (error?: Error) => {
      if (callbackDone) return;
      callbackDone = true;
      resolve(error ? { closed: false, timedOut: false, error } : { closed: true, timedOut: false });
    };
    try {
      server.close((error?: Error) => finish(error));
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
    forceTimer = setTimeout(() => {
      if (callbackDone) return;
      try {
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    }, 50);
  });
  const deadline = new Promise<ServerCloseResult>((resolve) => {
    deadlineTimer = setTimeout(() => resolve({
      closed: false,
      timedOut: true,
      error: new Error(`loopback server did not close within ${FIXTURE_CLEANUP_TIMEOUT_MS}ms`),
    }), FIXTURE_CLEANUP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([closePromise, deadline]);
  } finally {
    if (forceTimer) clearTimeout(forceTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<{ settled: boolean; value?: T; error?: Error }> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ settled: false });
      }
    }, timeoutMs);
    promise.then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ settled: true, value });
    }, (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ settled: true, error: error instanceof Error ? error : new Error(String(error)) });
    });
  });
}

type SpecialFixtureOwner = {
  root: string;
  server: Server;
  requests: ObservedRequest[];
  initialize: (task: () => Promise<void>) => Promise<void>;
  startCli: (args: string[]) => OwnedCliProcess;
  startFixture: (mode: "ready-wait") => OwnedCliProcess;
  cleanup: () => Promise<FixtureCleanupResult>;
  writeTimeline: () => void;
  snapshot: () => Partial<FixtureCleanupResult> & { root: string };
};

function createFixtureOwner(traceLifecycle: boolean): SpecialFixtureOwner {
  const requests: ObservedRequest[] = [];
  const root = mkdtempSync(join(tmpdir(), "apicc-special-url-"));
  const traceStartedAt = performance.now();
  const lifecycle: FixtureLifecycleEvent[] = [];
  let timelineWritten = false;
  const record = (event: Omit<FixtureLifecycleEvent, "elapsedMs">): void => {
    const entry: FixtureLifecycleEvent = {
      ...event,
      elapsedMs: Number((performance.now() - traceStartedAt).toFixed(3)),
    };
    if (lifecycle.length === 64) lifecycle.shift();
    lifecycle.push(entry);
    if (traceLifecycle) {
      try { process.stderr.write(`[special-url-lifecycle] ${JSON.stringify(entry)}\n`); } catch { /* diagnostics must not affect fixture cleanup */ }
    }
  };
  const writeTimeline = (): void => {
    if (timelineWritten) return;
    timelineWritten = true;
    try { process.stderr.write(`[special-url-lifecycle-summary] ${JSON.stringify(lifecycle.slice(-64))}\n`); } catch { /* diagnostics must not affect fixture cleanup */ }
  };
  let server: Server;
  try {
    server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        requests.push({ method: req.method ?? "", url: req.url ?? "" });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      });
    });
  } catch (error) {
    if (root.startsWith(join(tmpdir(), "apicc-special-url-"))) rmSync(root, { recursive: true, force: true });
    throw error;
  }
  let cancelled = false;
  let initialization: Promise<void> | undefined;
  let initialized = false;
  let childStarts = 0;
  const children = new Set<OwnedCliProcess>();
  let cleanupPromise: Promise<FixtureCleanupResult> | undefined;
  let cleanupResult: FixtureCleanupResult | undefined;

  const initialize = (task: () => Promise<void>) => {
    if (initialization) throw new Error("fixture initialization can only start once");
    const stageStartedAt = performance.now();
    record({ phase: "fixture-initialize-start" });
    initialization = Promise.resolve().then(task).then(() => {
      initialized = true;
      record({ phase: "fixture-initialize-complete", stageElapsedMs: Number((performance.now() - stageStartedAt).toFixed(3)) });
    }, (error: unknown) => {
      record({ phase: "fixture-initialize-failed", stageElapsedMs: Number((performance.now() - stageStartedAt).toFixed(3)) });
      throw error;
    });
    return initialization;
  };
  const ownChild = (command: string, args: string[], cwd = root, readyToken?: string) => {
    if (cancelled) throw new Error("fixture cleanup already started; child start blocked");
    const childOrdinal = childStarts + 1;
    const child = spawnOwnedCliProcess({
      command,
      args,
      cwd,
      env: { NODE_ENV: "test" },
      timeoutMs: 5_000,
      ...(readyToken ? { readyToken } : {}),
      onLifecycleEvent: (event: OwnedCliLifecycleEvent) => record({
        phase: `cli-${event.phase}`,
        childOrdinal,
        childElapsedMs: event.elapsedMs,
        ...(event.pid === undefined ? {} : { pid: event.pid }),
        ...(event.code === undefined ? {} : { code: event.code }),
        ...(event.signal === undefined ? {} : { signal: event.signal }),
        ...(event.stdoutBytes === undefined ? {} : { stdoutBytes: event.stdoutBytes }),
        ...(event.stderrBytes === undefined ? {} : { stderrBytes: event.stderrBytes }),
      }),
    });
    children.add(child);
    childStarts++;
    return child;
  };
  const startCli = (args: string[]) => ownChild(process.execPath, [cliEntry, "--no-plugins", ...args]);
  const startFixture = (mode: "ready-wait") => ownChild(process.execPath, [childFixture, mode], root, "READY");
  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    cancelled = true;
    const cleanupStartedAt = performance.now();
    record({ phase: "fixture-cleanup-start", childCount: children.size });
    cleanupPromise = (async () => {
      const errors: string[] = [];
      let initializationSettled = !initialization;
      if (initialization) {
        const stageStartedAt = performance.now();
        const init = await settleWithin(initialization, FIXTURE_CLEANUP_TIMEOUT_MS);
        initializationSettled = init.settled;
        if (init.error) errors.push(`initialization: ${init.error.message}`);
        if (!init.settled) errors.push("initialization did not settle before cleanup deadline");
        record({
          phase: "fixture-cleanup-initialization",
          stageElapsedMs: Number((performance.now() - stageStartedAt).toFixed(3)),
          settled: initializationSettled,
        });
      }
      const childCleanupStartedAt = performance.now();
      const childResults = await Promise.all([...children].map((child) => child.cleanup()));
      const childrenClosed = childResults.every((result) => result.closeConfirmed);
      record({
        phase: "fixture-cleanup-children",
        stageElapsedMs: Number((performance.now() - childCleanupStartedAt).toFixed(3)),
        childCount: childResults.length,
        childrenClosed,
      });
      if (!childrenClosed) errors.push("one or more owned children did not confirm close");
      let serverResult: ServerCloseResult = { closed: false, timedOut: false, error: new Error("server close was skipped") };
      if (childrenClosed) {
        const serverCloseStartedAt = performance.now();
        serverResult = await closeServer(server);
        record({
          phase: "fixture-cleanup-server",
          stageElapsedMs: Number((performance.now() - serverCloseStartedAt).toFixed(3)),
          serverClosed: serverResult.closed,
          timedOut: serverResult.timedOut,
        });
      }
      if (!serverResult.closed) {
        errors.push(serverResult.error?.message ?? "server close was not confirmed");
      }
      const safeRoot = root.startsWith(join(tmpdir(), "apicc-special-url-"));
      let fixtureRemoved = false;
      if (initializationSettled && childrenClosed && serverResult.closed && safeRoot) {
        const removalStartedAt = performance.now();
        rmSync(root, { recursive: true, force: true });
        fixtureRemoved = true;
        record({ phase: "fixture-cleanup-root", stageElapsedMs: Number((performance.now() - removalStartedAt).toFixed(3)), fixtureRemoved });
      } else if (!safeRoot) {
        errors.push("fixture root failed ownership validation");
      }
      cleanupResult = {
        ok: initializationSettled && childrenClosed && serverResult.closed && fixtureRemoved && errors.length === 0,
        initialized,
        childrenClosed,
        serverClosed: serverResult.closed,
        fixtureRemoved,
        childStarts,
        ...(fixtureRemoved ? {} : { retainedRoot: root }),
        errors,
      };
      record({
        phase: "fixture-cleanup-complete",
        stageElapsedMs: Number((performance.now() - cleanupStartedAt).toFixed(3)),
        ok: cleanupResult.ok,
        childrenClosed,
        serverClosed: serverResult.closed,
        fixtureRemoved,
        childCount: childStarts,
        errorCount: errors.length,
      });
      if (traceLifecycle || !cleanupResult.ok) writeTimeline();
      return cleanupResult;
    })();
    return cleanupPromise;
  };

  const owner: SpecialFixtureOwner = { root, server, requests, initialize, startCli, startFixture, cleanup, writeTimeline, snapshot: () => ({ root, ...cleanupResult, childStarts }) };
  onTestFinished(async () => {
    const result = await owner.cleanup();
    if (!result.ok) throw cleanupFailure(result);
  });
  return owner;
}

function resultOutput(result: OwnedCliResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

function cleanupFailure(result: FixtureCleanupResult): Error {
  return new Error(`fixture cleanup failed; retainedRoot=${result.retainedRoot ?? "none"}; ${result.errors.join("; ")}`);
}

const API_PATH = "groups/00000000-0000-4000-8000-000000000102/projects/00000000-0000-4000-8000-000000000103/collections/00000000-0000-4000-8000-000000000105/apis/00000000-0000-4000-8000-000000000106";

async function saveWorkspace(root: string, workspace: Workspace): Promise<void> {
  const initial = await fileStorage.load(root);
  await fileStorage.save(root, workspace, { expectedRevision: initial.revision, deletions: [] });
}

function withBaseUrlEnvironmentChain(workspace: Workspace, parentBaseUrl: string, childBaseUrl?: string): Workspace {
  const project = workspace.groups[0]!.projects[0]!;
  project.environments = [
    {
      id: "00000000-0000-4000-8000-000000000108",
      name: "parent",
      variables: {},
      baseUrls: { "00000000-0000-4000-8000-000000000105": parentBaseUrl },
    },
    {
      id: "00000000-0000-4000-8000-000000000109",
      name: "dev",
      extends: "parent",
      variables: {},
      baseUrls: childBaseUrl === undefined ? {} : { "00000000-0000-4000-8000-000000000105": childBaseUrl },
    },
  ];
  return workspace;
}

function workspaceFor(baseUrl: string, requestBaseUrl: string): Workspace {
  return {
    formatVersion: 1,
    id: "00000000-0000-4000-8000-000000000101",
    name: "special-url-test",
    variables: {},
    groups: [{
      id: "00000000-0000-4000-8000-000000000102",
      name: "demo",
      projects: [{
        id: "00000000-0000-4000-8000-000000000103",
        name: "svc",
        variables: {},
        globals: { query: [], headers: [], cookies: [], body: [] },
        components: [],
        models: [],
        stressPolicy: { trustedOrigins: [], deniedOrigins: [] },
        workflows: [],
        environments: [{ id: "00000000-0000-4000-8000-000000000104", name: "dev", variables: { baseUrl }, baseUrls: {} }],
        collections: [{
          id: "00000000-0000-4000-8000-000000000105",
          name: "api",
          variables: {},
          preOperations: [],
          postOperations: [],
          folders: [],
          apis: [{
            contract: {
              formatVersion: 1,
              id: "00000000-0000-4000-8000-000000000106",
              metadata: { name: "ok", description: "", tags: [], version: "1", status: "published" },
              request: {
                protocol: "http", method: "GET", baseUrl: requestBaseUrl, path: "/x",
                pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" }, body: { kind: "none" },
              },
              responses: [],
            },
            documentation: "",
            cases: [{
              id: "00000000-0000-4000-8000-000000000107",
              name: "passes",
              scope: "base",
              parameters: {},
              preOperations: [],
              postOperations: [],
              assertions: [{ id: "status", target: "status", op: "eq", expected: "200" }],
            }],
          }],
        }],
      }],
    }],
  };
}

describe("CLI run-stress WHATWG special URL isolation", () => {
  it("prefers a nonempty contract base URL over a different selected-environment origin", async () => {
    const fixture = createFixtureOwner(false);
    let primaryError: unknown;
    try {
      const contractOrigin = await listen(fixture.server);
      const environmentOrigin = "http://127.0.0.1:9";
      await fixture.initialize(async () => {
        const workspace = withBaseUrlEnvironmentChain(
          workspaceFor(environmentOrigin, contractOrigin), environmentOrigin, environmentOrigin,
        );
        await saveWorkspace(fixture.root, workspace);
      });

      const rejected = fixture.startCli([
        "run-stress", API_PATH,
        "--case", "00000000-0000-4000-8000-000000000107", "--env", "dev", "--concurrency", "1", "--iterations", "1",
        "--runs-dir", join(fixture.root, ".apicc", "contract-origin-rejected"),
      ]);
      const rejectedResult = await rejected.result;
      expect(rejectedResult).toMatchObject({ termination: "exit", exitCode: 1, closeConfirmed: true });
      expect(fixture.requests).toHaveLength(0);
      expect(resultOutput(rejectedResult)).toContain("target_confirmation_required");
      expect(resultOutput(rejectedResult)).toContain(contractOrigin);
      expect(resultOutput(rejectedResult)).not.toContain(environmentOrigin);

      const allowed = fixture.startCli([
        "run-stress", API_PATH,
        "--case", "00000000-0000-4000-8000-000000000107", "--env", "dev", "--concurrency", "1", "--iterations", "1",
        "--allow-target", contractOrigin, "--runs-dir", join(fixture.root, ".apicc", "contract-origin-allowed"),
      ]);
      const allowedResult = await allowed.result;
      expect(allowedResult).toMatchObject({ termination: "exit", exitCode: 0, closeConfirmed: true });
      expect(fixture.requests).toEqual([{ method: "GET", url: "/x" }]);
      expect(resultOutput(allowedResult)).toContain(`target origins: ${contractOrigin}`);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      const cleanup = await fixture.cleanup();
      if (primaryError || !cleanup.ok) fixture.writeTimeline();
      if (!cleanup.ok) {
        const cleanupError = cleanupFailure(cleanup);
        if (primaryError instanceof Error) primaryError.cause = cleanupError;
        else throw cleanupError;
      }
    }
  }, MULTI_CLI_CASE_TIMEOUT_MS);

  it("uses an inherited parent collection base URL when the contract URL is empty", async () => {
    const fixture = createFixtureOwner(false);
    let primaryError: unknown;
    try {
      let baseUrl = "";
      await fixture.initialize(async () => {
        baseUrl = await listen(fixture.server);
        const workspace = withBaseUrlEnvironmentChain(workspaceFor(baseUrl, ""), baseUrl);
        await saveWorkspace(fixture.root, workspace);
      });

      const rejected = fixture.startCli([
        "run-stress", API_PATH,
        "--case", "00000000-0000-4000-8000-000000000107", "--env", "dev", "--concurrency", "1", "--iterations", "1",
        "--runs-dir", join(fixture.root, ".apicc", "inherited-origin-rejected"),
      ]);
      const rejectedResult = await rejected.result;
      expect(rejectedResult).toMatchObject({ termination: "exit", exitCode: 1, closeConfirmed: true });
      expect(fixture.requests).toHaveLength(0);
      expect(resultOutput(rejectedResult)).toContain("target_confirmation_required");
      expect(resultOutput(rejectedResult)).toContain(baseUrl);

      const allowed = fixture.startCli([
        "run-stress", API_PATH,
        "--case", "00000000-0000-4000-8000-000000000107", "--env", "dev", "--concurrency", "1", "--iterations", "1",
        "--allow-target", baseUrl, "--runs-dir", join(fixture.root, ".apicc", "inherited-origin-allowed"),
      ]);
      const allowedResult = await allowed.result;
      expect(allowedResult).toMatchObject({ termination: "exit", exitCode: 0, closeConfirmed: true });
      expect(fixture.requests).toEqual([{ method: "GET", url: "/x" }]);
      expect(resultOutput(allowedResult)).toContain(`target origins: ${baseUrl}`);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      const cleanup = await fixture.cleanup();
      if (primaryError || !cleanup.ok) fixture.writeTimeline();
      if (!cleanup.ok) {
        const cleanupError = cleanupFailure(cleanup);
        if (primaryError instanceof Error) primaryError.cause = cleanupError;
        else throw cleanupError;
      }
    }
  }, MULTI_CLI_CASE_TIMEOUT_MS);

  it("reports a server close callback error instead of silently treating close as confirmed", async () => {
    const server = createServer();
    const result = await closeServer(server);
    expect(result.closed).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.error?.message).toMatch(/not running|ERR_SERVER_NOT_RUNNING/i);
  });

  it.each<SpecialUrlVariant>(["omitted-slashes", "whitespace", "backslash", "uppercase"])(
    "run-stress WHATWG special HTTP URL %s 先做结构化目标确认，再以 canonical URL 发包",
    async (variant) => {
      const traceLifecycle = variant === "uppercase" && process.env.APICC_TRACE_SPECIAL_URL_LIFECYCLE === "1";
      const fixture = createFixtureOwner(traceLifecycle);
      let primaryError: unknown;
      try {
        let baseUrl = "";
        await fixture.initialize(async () => {
          baseUrl = await listen(fixture.server);
          await saveWorkspace(fixture.root, workspaceFor(baseUrl, specialUrl(variant, baseUrl)));
        });
        const expectedCanonicalOrigin = baseUrl;
        const expectedRequestPath = "/x";
        const rejected = fixture.startCli([
          "run-stress", API_PATH,
          "--case", "00000000-0000-4000-8000-000000000107", "--env", "dev", "--concurrency", "1", "--iterations", "1",
          "--runs-dir", join(fixture.root, ".apicc", "rejected-runs"),
        ]);
        const rejectedResult = await rejected.result;
        expect(rejectedResult).toMatchObject({ termination: "exit", exitCode: 1, closeConfirmed: true });
        expect(fixture.requests).toHaveLength(0);
        expect(resultOutput(rejectedResult)).toContain("target_confirmation_required");
        expect(resultOutput(rejectedResult)).toContain(expectedCanonicalOrigin);
        expect(resultOutput(rejectedResult)).not.toContain("无协议客户端");

        const allowed = fixture.startCli([
          "run-stress", API_PATH,
          "--case", "00000000-0000-4000-8000-000000000107", "--env", "dev", "--concurrency", "1", "--iterations", "1",
          "--allow-target", expectedCanonicalOrigin, "--runs-dir", join(fixture.root, ".apicc", "allowed-runs"),
        ]);
        const allowedResult = await allowed.result;
        expect(allowedResult).toMatchObject({ termination: "exit", exitCode: 0, closeConfirmed: true });
        expect(fixture.requests).toEqual([{ method: "GET", url: expectedRequestPath }]);
        expect(resultOutput(allowedResult)).toContain(`target origins: ${expectedCanonicalOrigin}`);
      } catch (error) {
        primaryError = error;
        throw error;
      } finally {
        const cleanup = await fixture.cleanup();
        if (primaryError || !cleanup.ok) fixture.writeTimeline();
        if (!cleanup.ok) {
          const cleanupError = cleanupFailure(cleanup);
          if (primaryError instanceof Error) primaryError.cause = cleanupError;
          else throw cleanupError;
        }
      }
    },
    MULTI_CLI_CASE_TIMEOUT_MS,
  );

  if (process.env.APICC_ENABLE_TIMEOUT_NEGATIVE_CONTROL === "1") {
    it("negative control: Vitest timeout cleans child, server, and temp fixture without late child start", async () => {
      const fixture = createFixtureOwner(false);
      const marker = process.env.APICC_TIMEOUT_MARKER;
      if (!marker) throw new Error("APICC_TIMEOUT_MARKER is required for the timeout control");
      onTestFinished(async () => {
        const cleanup = await fixture.cleanup();
        let lateStartBlocked = false;
        let lateChild: OwnedCliProcess | undefined;
        try {
          lateChild = fixture.startFixture("ready-wait");
        } catch {
          lateStartBlocked = true;
        }
        if (lateChild) await lateChild.cleanup();
        writeFileSync(marker, JSON.stringify({
          ...cleanup,
          root: fixture.root,
          childStarts: fixture.snapshot().childStarts,
          lateStartBlocked,
          rootExistsAfterCleanup: existsSync(fixture.root),
          hookFailure: cleanup.ok ? null : cleanupFailure(cleanup).message,
        }));
        if (!cleanup.ok) throw cleanupFailure(cleanup);
      });
      let baseUrl = "";
      await fixture.initialize(async () => {
        baseUrl = await listen(fixture.server);
        await saveWorkspace(fixture.root, workspaceFor(baseUrl, "{{baseUrl}}/x"));
      });
      const child = fixture.startFixture("ready-wait");
      await child.waitForReady(1_000);
      if (process.env.APICC_FORCE_TIMEOUT_CLEANUP_FAILURE === "1") {
        const preClosed = await closeServer(fixture.server);
        if (!preClosed.closed) throw preClosed.error ?? new Error("forced server close did not complete");
      }
      await new Promise<void>(() => {});
    }, 2_000);
  }
});
