import {
  abortedDebugResult,
  createHttpSession,
  createProjectSnapshot,
  failedDebugResult,
  prepareDebugExecution,
  runDebugExecution,
  createDebugHistoryOwnerKey,
  type DebugInvocation,
  type DebugResult,
  type HttpCookieSummary,
  type PluginRegistry,
} from "@apicc/core";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { ApiLocatorSchema, CaseLocatorSchema, EnvironmentLocatorSchema } from "../shared/locations.js";
import { DebugInvocationSchema } from "@apicc/core/schema";
import { debugHttpSessionKey } from "./executionContext.js";
import type { createSession } from "./session.js";
import type { DebugCredentialHost } from "./credentialHost.js";

type Session = ReturnType<typeof createSession>;
type RegistrySource = PluginRegistry | (() => PluginRegistry | Promise<PluginRegistry>);
type DebugHistoryAppender = {
  append(result: DebugResult, options: { ownerKey: string; parentHistoryId?: string }): Promise<unknown>;
};

interface DebugJob {
  readonly owner: object;
  readonly runId: string;
  readonly startedAt: string;
  readonly abort: AbortController;
  readonly completion: Promise<DebugResult>;
  settled: boolean;
}

export type DebugCancelResult = { status: "cancelled" | "no-active" };

/** Main-process owner-scoped debugger jobs. The owner is the actual IPC sender object. */
export function createDebugController(
  session: Session,
  registrySource: RegistrySource,
  credentials: DebugCredentialHost,
  history?: DebugHistoryAppender,
) {
  const jobsByOwner = new WeakMap<object, Map<string, DebugJob>>();
  const httpSessions = new Map<string, ReturnType<typeof createHttpSession>>();

  function start(ownerValue: unknown, inputValue: unknown): { runId: string } {
    const owner = requireOwner(ownerValue);
    const invocation = parseInvocation(inputValue);
    const identity = ApiLocatorSchema.parse(invocation.locator);
    if (invocation.mode === "case") CaseLocatorSchema.parse(invocation.case);
    if (invocation.environmentId !== undefined) EnvironmentLocatorSchema.parse({
      workspaceId: identity.workspaceId,
      groupId: identity.groupId,
      projectId: identity.projectId,
      environmentId: invocation.environmentId,
    });
    const root = session.root;
    if (!root) throw new Error("尚未打开工作区");
    const located = session.locateApi(identity);
    if (!located
      || located.project.id !== identity.projectId
      || located.group.id !== identity.groupId
      || located.collection.id !== identity.collectionId
      || located.api.contract.id !== identity.apiId) {
      throw new Error(`未找到接口: ${JSON.stringify(identity)}`);
    }
    const snapshot = createProjectSnapshot(located.project);
    const plan = prepareDebugExecution(snapshot, invocation);
    // Capture validated ownership synchronously at start; completion never consults the mutable Session.
    let historyOwnerKey: string | undefined;
    try {
      const ownerRoot = realpathSync(root);
      const ownerIdentity = invocation.mode === "case" ? invocation.case : invocation.locator;
      historyOwnerKey = createDebugHistoryOwnerKey(ownerRoot, ownerIdentity);
    } catch {
      // History ownership capture is best-effort and must not reject an otherwise valid run.
    }
    const runId = randomUUID();
    const abort = new AbortController();
    let resolveCompletion!: (result: DebugResult) => void;
    const rawCompletion = new Promise<DebugResult>((resolve) => {
      resolveCompletion = resolve;
    });
    const completion = rawCompletion.then(async (result) => {
      if (!history) return result;
      if (!historyOwnerKey) return { ...result, warnings: [...result.warnings, "本机历史归属无法校验，本次结果未保存。"] };
      try {
        await history.append(result, {
          ownerKey: historyOwnerKey,
          ...(invocation.parentHistoryId === undefined ? {} : { parentHistoryId: invocation.parentHistoryId }),
        });
        return result;
      } catch {
        return { ...result, warnings: [...result.warnings, "调试结果已完成，但本机历史写入或清理未完整成功。"] };
      }
    });
    const entry: DebugJob = {
      owner,
      runId,
      startedAt: new Date().toISOString(),
      abort,
      completion,
      settled: false,
    };
    let ownerJobs = jobsByOwner.get(owner);
    if (!ownerJobs) {
      ownerJobs = new Map();
      jobsByOwner.set(owner, ownerJobs);
    }
    ownerJobs.set(runId, entry);

    // Start returns before credential access, file capture, registry loading, or network work.
    void Promise.resolve().then(async () => {
      let credentialMarkers: readonly string[] = [];
      let projectionReliable = false;
      try {
        if (abort.signal.aborted) {
          resolveCompletion(abortedDebugResult(plan, runId, entry.startedAt, { markers: credentialMarkers, projectionReliable }));
          return;
        }
        const scope = {
          workspaceId: identity.workspaceId,
          groupId: identity.groupId,
          projectId: identity.projectId,
        };
        const preparation = await withAbort(
          Promise.resolve().then(() => credentials.prepareRunForRequests(scope, plan.snapshot, plan.credentialSelections)),
          abort.signal,
        );
        if (preparation.kind === "aborted") {
          resolveCompletion(abortedDebugResult(plan, runId, entry.startedAt, { markers: credentialMarkers, projectionReliable }));
          return;
        }
        if (preparation.kind === "error") throw preparation.error;
        const prepared = preparation.value;
        credentialMarkers = prepared.markers;
        projectionReliable = true;
        if (abort.signal.aborted) {
          resolveCompletion(abortedDebugResult(plan, runId, entry.startedAt, { markers: credentialMarkers, projectionReliable }));
          return;
        }
        const registryResult = await withAbort(
          Promise.resolve().then(() => typeof registrySource === "function" ? registrySource() : registrySource),
          abort.signal,
        );
        if (registryResult.kind === "aborted") {
          resolveCompletion(abortedDebugResult(plan, runId, entry.startedAt, { markers: credentialMarkers, projectionReliable }));
          return;
        }
        if (registryResult.kind === "error") throw registryResult.error;
        const registry = registryResult.value;
        if (abort.signal.aborted) {
          resolveCompletion(abortedDebugResult(plan, runId, entry.startedAt, { markers: credentialMarkers, projectionReliable }));
          return;
        }
        const key = debugHttpSessionKey(root, identity, invocation.environmentId);
        let httpSession = httpSessions.get(key);
        if (!httpSession) {
          httpSession = createHttpSession();
          httpSessions.set(key, httpSession);
        }
        resolveCompletion(await runDebugExecution(plan, prepared.run, {
          registry,
          workspaceRoot: root,
          httpSession,
          signal: abort.signal,
          credentialMarkers: prepared.markers,
        }, runId));
      } catch (error) {
        if (abort.signal.aborted) resolveCompletion(abortedDebugResult(plan, runId, entry.startedAt, { markers: credentialMarkers, projectionReliable }));
        else resolveCompletion(failedDebugResult(plan, runId, entry.startedAt, error, {
          failureKind: "config",
          markers: credentialMarkers,
          projectionReliable,
        }));
      } finally {
        entry.settled = true;
      }
    });

    return { runId };
  }

  function wait(ownerValue: unknown, runId: string): Promise<DebugResult> {
    const entry = findJob(ownerValue, runId);
    if (!entry) throw new Error("Debug run not found for this renderer owner.");
    return entry.completion;
  }

  function cancel(ownerValue: unknown, runId: string): DebugCancelResult {
    const entry = findJob(ownerValue, runId);
    if (!entry || entry.settled) return { status: "no-active" };
    entry.abort.abort();
    return { status: "cancelled" };
  }

  function cookieSession(inputValue: unknown): ReturnType<typeof createHttpSession> | undefined {
    const input = inputValue as { locator: unknown; environmentId?: unknown };
    const identity = ApiLocatorSchema.parse(input?.locator);
    const root = session.root;
    if (!root) throw new Error("尚未打开工作区");
    const located = session.locateApi(identity);
    if (!located) throw new Error(`未找到接口: ${JSON.stringify(identity)}`);
    const environmentId = input.environmentId === undefined ? undefined : EnvironmentLocatorSchema.parse({
      workspaceId: identity.workspaceId,
      groupId: identity.groupId,
      projectId: identity.projectId,
      environmentId: input.environmentId,
    }).environmentId;
    if (environmentId && !located.project.environments.some((environment) => environment.id === environmentId)) {
      throw new Error(`Environment not found at API project: ${environmentId}`);
    }
    return httpSessions.get(debugHttpSessionKey(root, identity, environmentId));
  }

  async function listCookies(input: unknown): Promise<HttpCookieSummary[]> {
    const httpSession = cookieSession(input);
    return httpSession ? httpSession.listCookies() : [];
  }

  async function clearCookies(input: unknown): Promise<void> {
    const httpSession = cookieSession(input);
    if (httpSession) await httpSession.clearCookies();
  }

  function clearOwner(ownerValue: unknown): void {
    if (typeof ownerValue !== "object" || ownerValue === null) return;
    const jobs = jobsByOwner.get(ownerValue);
    if (!jobs) return;
    for (const entry of jobs.values()) entry.abort.abort();
    jobs.clear();
    jobsByOwner.delete(ownerValue);
  }

  function requireOwner(value: unknown): object {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") {
      throw new TypeError("A renderer IPC sender is required to own a debug run.");
    }
    return value as object;
  }

  function findJob(ownerValue: unknown, runId: string): DebugJob | undefined {
    if ((typeof ownerValue !== "object" || ownerValue === null) && typeof ownerValue !== "function") return undefined;
    return jobsByOwner.get(ownerValue as object)?.get(runId);
  }

  return { start, wait, cancel, listCookies, clearCookies, clearOwner };
}

function parseInvocation(value: unknown): DebugInvocation {
  const parsed = DebugInvocationSchema.safeParse(value);
  if (!parsed.success) throw new TypeError(`Invalid debug invocation: ${parsed.error.message}`);
  return parsed.data;
}

type AbortableResult<Value> = { kind: "value"; value: Value } | { kind: "error"; error: unknown } | { kind: "aborted" };

function withAbort<Value>(operation: Promise<Value>, signal: AbortSignal): Promise<AbortableResult<Value>> {
  if (signal.aborted) return Promise.resolve({ kind: "aborted" });
  return new Promise((resolve) => {
    const onAbort = () => resolve({ kind: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve({ kind: "value", value });
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        resolve({ kind: "error", error });
      },
    );
  });
}
