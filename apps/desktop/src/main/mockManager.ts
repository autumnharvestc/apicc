import { resolve } from "node:path";
import {
  compileProjectMock,
  createProjectSnapshot,
  startMockServer,
  type CompiledMockPlan,
  type MockDiagnostic,
  type MockProjectConfig,
  type MockServerHandle,
  type MockServerState,
} from "@apicc/core";
import type { ProjectLocator } from "../shared/locations.js";
import type { MockAddress, MockRequestLog, MockStatus } from "../shared/mock.js";
import type { createSession } from "./session.js";

type Session = ReturnType<typeof createSession>;
type StartOptions = { port?: number; signal?: AbortSignal };
type ServerStarter = (plan: CompiledMockPlan, options?: StartOptions) => Promise<MockServerHandle>;

interface MockContext {
  root: string;
  generation: number;
  locator: ProjectLocator;
  snapshot: ReturnType<typeof createProjectSnapshot>;
}

interface MockEntry {
  readonly key: string;
  readonly context: MockContext;
  readonly abort: AbortController;
  status: MockServerState;
  sourceProjectRevision: string;
  diagnostics: MockDiagnostic[];
  handle?: MockServerHandle;
  startPromise?: Promise<void>;
  stopPromise?: Promise<void>;
}

export interface MockManagerOptions {
  session: Session;
  compile?: typeof compileProjectMock;
  startServer?: ServerStarter;
}

function rootKey(root: string): string {
  const normalized = resolve(root);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function projectKey(locator: ProjectLocator): string {
  return [locator.workspaceId, locator.groupId, locator.projectId].join("\u0000");
}

function entryKey(context: MockContext): string {
  return `${rootKey(context.root)}\u0000${projectKey(context.locator)}\u0000${context.generation}`;
}

function diagnostic(code: string, message: string, ownerId: string): MockDiagnostic {
  return { severity: "error", code, path: "mock.server", message, lossy: false, ownerId };
}

function addressOf(handle: MockServerHandle | undefined, status: MockServerState): MockAddress | null {
  if (!handle || status === "stopped" || status === "stopping") return null;
  const { address, family, port } = handle.address;
  return { address, family: family === "IPv6" ? "IPv6" : "IPv4", port };
}

export function createMockManager(options: MockManagerOptions) {
  const { session } = options;
  const compile = options.compile ?? compileProjectMock;
  const startServer = options.startServer ?? startMockServer;
  const entries = new Map<string, MockEntry>();
  let transitionCount = 0;
  let transitionTail: Promise<void> = Promise.resolve();

  function capture(locator: ProjectLocator): MockContext {
    const sessionContext = session.captureDraftWriteContext();
    const located = session.locateProject(locator);
    if (!located) throw new Error(`Project not found at complete locator: ${JSON.stringify(locator)}`);
    return {
      root: sessionContext.root,
      generation: sessionContext.generation,
      locator: { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId },
      snapshot: createProjectSnapshot(located.project),
    };
  }

  function sameCurrentContext(context: MockContext): boolean {
    try {
      const current = session.captureDraftWriteContext();
      return rootKey(current.root) === rootKey(context.root)
        && current.generation === context.generation
        && session.locateProject(context.locator) !== undefined;
    } catch {
      return false;
    }
  }

  function refreshStartContext(context: MockContext, locator: ProjectLocator, expectedSourceProjectRevision?: string): MockContext {
    if (!sameCurrentContext(context)) throw new Error("工作区已切换，请刷新后重试。");
    const current = capture(locator);
    if (entryKey(current) !== entryKey(context)) throw new Error("工作区已切换，请刷新后重试。");
    if (expectedSourceProjectRevision && expectedSourceProjectRevision !== current.snapshot.definitionRevision) {
      throw new Error("Mock 配置已变化，请刷新后重试。");
    }
    if (session.readOnly) throw new Error("工作区处于只读模式，不能启动 Mock。");
    return current;
  }

  function toStatus(context: MockContext, entry?: MockEntry): MockStatus {
    const status = entry?.handle?.status ?? entry?.status ?? "stopped";
    const logs: readonly MockRequestLog[] = entry?.handle ? entry.handle.logs() : [];
    return structuredClone({
      locator: context.locator,
      config: context.snapshot.project.mock ? structuredClone(context.snapshot.project.mock) as MockProjectConfig : null,
      sourceProjectRevision: context.snapshot.definitionRevision,
      status,
      address: addressOf(entry?.handle, status),
      diagnostics: entry?.diagnostics ?? [],
      logs: [...logs],
      simulated: false,
    });
  }

  function get(locator: ProjectLocator): MockStatus {
    const context = capture(locator);
    return toStatus(context, entries.get(entryKey(context)));
  }

  async function stopEntry(entry: MockEntry, remove: boolean): Promise<void> {
    if (!entry.stopPromise) {
      entry.status = "stopping";
      entry.abort.abort();
      entry.stopPromise = (async () => {
        try {
          await entry.startPromise?.catch(() => undefined);
          await entry.handle?.stop();
        } finally {
          entry.status = "stopped";
        }
      })();
    }
    await entry.stopPromise;
    if (remove && entries.get(entry.key) === entry) entries.delete(entry.key);
  }

  function scheduleTransition<T>(operation: () => Promise<T>): Promise<T> {
    transitionCount += 1;
    const previous = transitionTail;
    const result = previous.then(operation, operation);
    const settled = result.then(
      () => { transitionCount -= 1; },
      () => { transitionCount -= 1; },
    );
    transitionTail = settled.then(() => undefined, () => undefined);
    return result;
  }

  function waitForTransitionAdmission(): Promise<void> | undefined {
    if (transitionCount === 0) return undefined;
    return (async () => {
      while (transitionCount > 0) await transitionTail;
    })();
  }

  async function stopEntries(): Promise<void> {
    await Promise.all([...entries.values()].map((entry) => stopEntry(entry, true)));
  }

  async function stop(locator: ProjectLocator): Promise<MockStatus> {
    const context = capture(locator);
    const entry = entries.get(entryKey(context));
    if (entry) await stopEntry(entry, false);
    return toStatus(context, entry);
  }

  async function start(locator: ProjectLocator, port = 0, expectedSourceProjectRevision?: string): Promise<MockStatus> {
    let context = capture(locator);
    const admission = waitForTransitionAdmission();
    if (admission) await admission;
    context = refreshStartContext(context, locator, expectedSourceProjectRevision);

    for (const [otherKey, other] of entries) {
      if (otherKey !== entryKey(context) && (rootKey(other.context.root) !== rootKey(context.root)
        || other.context.generation !== context.generation)) {
        await stopEntry(other, true);
        const nextAdmission = waitForTransitionAdmission();
        if (nextAdmission) await nextAdmission;
        context = refreshStartContext(context, locator, expectedSourceProjectRevision);
      }
    }
    const key = entryKey(context);
    let entry: MockEntry | undefined;
    while (true) {
      entry = entries.get(key);
      if (entry?.startPromise) {
        await entry.startPromise;
        return toStatus(context, entries.get(key) ?? entry);
      }
      if (entry?.handle && entry.handle.status !== "stopped") return toStatus(context, entry);
      if (!entry) break;

      await stopEntry(entry, true);
      const nextAdmission = waitForTransitionAdmission();
      if (nextAdmission) await nextAdmission;
      context = refreshStartContext(context, locator, expectedSourceProjectRevision);
    }

    entry = {
      key,
      context,
      abort: new AbortController(),
      status: "starting",
      sourceProjectRevision: context.snapshot.definitionRevision,
      diagnostics: [],
    };
    entries.set(key, entry);
    entry.startPromise = (async () => {
      const result = compile(context.snapshot);
      if (!result.ok) {
        entry!.status = "invalid";
        entry!.diagnostics = [...result.diagnostics];
        return;
      }
      try {
        const handle = await startServer(result.plan, { port, signal: entry!.abort.signal });
        if (entries.get(key) !== entry || !sameCurrentContext(context) || entry!.status === "stopping") {
          await handle.stop();
          entry!.status = "stopped";
          if (entries.get(key) === entry) entries.delete(key);
          return;
        }
        entry!.handle = handle;
        entry!.status = handle.status;
      } catch (error) {
        entry!.status = "stopped";
        if (!entry!.abort.signal.aborted) {
          const code = typeof error === "object" && error !== null && "code" in error
            ? String((error as { code: unknown }).code)
            : "MOCK_START_FAILED";
          entry!.diagnostics = [diagnostic(code, error instanceof Error ? error.message : "Mock server failed to start.", context.locator.projectId)];
        }
      }
    })();
    try {
      await entry.startPromise;
    } finally {
      if (entries.get(key) === entry) entry.startPromise = undefined;
    }
    return toStatus(context, entries.get(key) ?? entry);
  }

  async function reload(locator: ProjectLocator, expectedSourceProjectRevision?: string): Promise<MockStatus> {
    const context = capture(locator);
    if (expectedSourceProjectRevision && expectedSourceProjectRevision !== context.snapshot.definitionRevision) {
      throw new Error("Mock 配置已变化，请刷新后重试。");
    }
    let entry = entries.get(entryKey(context));
    if (entry?.startPromise) {
      await entry.startPromise;
      entry = entries.get(entryKey(context));
    }
    if (!entry?.handle) return toStatus(context, entry);

    entry.handle.beginReload();
    entry.status = "reloading";
    entry.sourceProjectRevision = context.snapshot.definitionRevision;
    const result = compile(context.snapshot);
    if (!result.ok) {
      entry.handle.invalidate(result.diagnostics);
      entry.status = "invalid";
      entry.diagnostics = [...result.diagnostics];
      return toStatus(context, entry);
    }
    if (!sameCurrentContext(context)) {
      await stopEntry(entry, true);
      return toStatus(context, undefined);
    }
    try {
      await entry.handle.reload(result.plan);
      entry.status = entry.handle.status;
      entry.sourceProjectRevision = result.plan.sourceProjectRevision;
      entry.diagnostics = [];
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "MOCK_RELOAD_FAILED";
      entry.handle.invalidate([diagnostic(code, error instanceof Error ? error.message : "Mock server reload failed.", locator.projectId)]);
      entry.status = "invalid";
      entry.diagnostics = [diagnostic(code, error instanceof Error ? error.message : "Mock server reload failed.", locator.projectId)];
    }
    if (!sameCurrentContext(context)) {
      await stopEntry(entry, true);
      return toStatus(context, undefined);
    }
    return toStatus(context, entry);
  }

  async function saved(locator: ProjectLocator, expectedContext?: Pick<MockContext, "root" | "generation">): Promise<MockStatus> {
    await waitForTransitionAdmission();
    const context = capture(locator);
    if (expectedContext && (rootKey(context.root) !== rootKey(expectedContext.root)
      || context.generation !== expectedContext.generation)) return toStatus(context);
    const entry = entries.get(entryKey(context));
    if (!entry) return toStatus(context);
    if (entry.startPromise) await entry.startPromise;
    const currentEntry = entries.get(entryKey(context));
    return currentEntry?.handle ? reload(locator) : toStatus(context, currentEntry);
  }

  async function stopProject(root: string, locator: ProjectLocator): Promise<void> {
    const wantedRoot = rootKey(root);
    const wantedProject = projectKey(locator);
    const matches = [...entries.values()].filter((entry) => rootKey(entry.context.root) === wantedRoot
      && projectKey(entry.context.locator) === wantedProject);
    await Promise.all(matches.map((entry) => stopEntry(entry, true)));
  }

  async function stopWorkspace(): Promise<void> {
    await scheduleTransition(stopEntries);
  }

  async function transitionWorkspace<T>(operation: () => Promise<T>): Promise<T> {
    return scheduleTransition(async () => {
      await stopEntries();
      return operation();
    });
  }

  async function stopAll(): Promise<void> {
    await stopWorkspace();
  }

  return { get, start, stop, reload, saved, stopProject, stopWorkspace, stopAll, transitionWorkspace };
}
