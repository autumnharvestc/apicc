import type { ProjectSnapshot, DebugInvocation, NetworkSelection } from "@apicc/core";
import type { ExecutionLocation, MemberRunInput, MemberPreparationSummary, PreparedMemberRun } from "@apicc/execution/client";
import { ExecutionHttpError, isFullOnlineJob } from "@apicc/execution/client";
import type { PreparedExecution, InvocationOutput } from "@apicc/execution/host";
import type { ExecutionProfile } from "@apicc/execution/contract";
import { resolveEffectiveConfig } from "@apicc/execution/contract";
import type { McpSource } from "./source.js";
import { randomUUID } from "node:crypto";
import { executionCapabilityFor } from "./executionCapabilities.js";
import { createMcpIntentJournal, assertMcpIntentId, type McpIntentReceipt } from "./intents.js";
import { createMcpTickets } from "./tickets.js";
import { createMcpLocalExecutionHost } from "./localExecution.js";
import type { CredentialHostOptions } from "../credentials.js";
import { createOwnedLocalRuns, McpLocalExecutionFailure, safeRunFailure } from "./ownedRuns.js";

export type McpSavedTarget = { kind: "debug"; invocation: Extract<DebugInvocation, { mode: "case" }> }
  | Extract<MemberRunInput["target"], { kind: "suite" | "workflow" }>;
export interface McpExecutionLimits {
  ticketTtlMs?: number;
  maxTickets?: number;
  activeLocalRuns?: number;
  terminalLocalRuns?: number;
  terminalLocalBytes?: number;
  /** Nonsecret intent metadata ceilings: local memory receipts and online private journal receipts. */
  journalReceiptBytes?: number;
  journalMaxRecords?: number;
  journalTotalBytes?: number;
}
export interface McpPrepareInput {
  projectId: string;
  location: ExecutionLocation;
  target: McpSavedTarget;
  environmentId?: string;
  runConfig?: MemberRunInput["runConfig"];
}
export interface McpPreparedSummary {
  ticketId: string;
  runId: string;
  location: ExecutionLocation;
  targetKind: McpSavedTarget["kind"];
  environmentId: string | null;
  definitionRevision: string;
  expiresAt: string;
  deadlineAt?: string;
  snapshotId?: string;
  assetVersion?: string;
  manifestHash?: string;
  executionProfile?: MemberPreparationSummary["executionProfile"];
  policyVersion?: string;
  materialVersions?: Readonly<Record<string, string>>;
  dataDigest?: string;
  networkRevision?: string;
  networkSelection?: NetworkSelection;
  scriptPlanDigest?: string;
  budgets?: Partial<MemberPreparationSummary["budgets"]>;
  sources?: MemberPreparationSummary["sources"];
  limitations?: readonly string[];
}
export interface McpRunHandle {
  runId: string;
  location: ExecutionLocation;
  state: "preparing" | "running" | "queued" | "ended";
  bindingStatus?: "fixed-input-binding-unverified";
}
export interface McpLocalExecutionHost {
  prepare(snapshot: ProjectSnapshot, target: McpSavedTarget, environmentId: string | undefined, limits: McpExecutionLimits, context: {
    signal: AbortSignal; workspaceRoot: string; scope: { workspaceId: string; groupId: string; projectId: string };
    runConfig: NonNullable<McpPrepareInput["runConfig"]>; profile: ExecutionProfile;
  }): PreparedExecution | Promise<PreparedExecution>;
  start(prepared: PreparedExecution, runId: string, signal: AbortSignal): Promise<InvocationOutput>;
  discard?(prepared: PreparedExecution): void | Promise<void>;
}
export interface McpExecutionHost {
  prepare(input: McpPrepareInput, signal: AbortSignal): Promise<McpPreparedSummary>;
  start(input: { ticketId: string; intentId: string }, signal: AbortSignal): Promise<McpRunHandle>;
  cancel(runId: string, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
export interface McpExecutionHostOptions extends Pick<CredentialHostOptions, "secretStore" | "credentialPrivateRoot" | "networkPrivateRoot"> {
  source: McpSource;
  privateRoot: string;
  limits?: McpExecutionLimits;
  localHost?: McpLocalExecutionHost;
  localProfile?: ExecutionProfile;
}
/** Only the canonical member HTTP boundary supplies this reason; it never changes uncertainty. */
export class McpExecutionOutcomeUncertainError extends Error {
  constructor(readonly reasonCode: string) {
    super(`execution-outcome-uncertain (${reasonCode})；请仅查询原 intent，勿重新提交`);
  }
}
type McpTicketBase = { summary: McpPreparedSummary; projectId: string; contractProjectId: string; createdAt: string; intentId?: string; pendingIntent?: string; pending?: Promise<McpRunHandle>; attempted?: boolean; rejected?: boolean; discard(): Promise<void> };
type McpOwnedLocalOperation = { handle: McpRunHandle; controller: AbortController; completion: Promise<InvocationOutput> };
type LocalDeadline = { controller: AbortController; jobTimeoutMs: number; deadlineAt: string; clear(): void };
type McpExecutionTicket = McpTicketBase & ({ kind: "online"; prepared: PreparedMemberRun; localHandle?: McpRunHandle } | { kind: "local"; prepared: PreparedExecution; deadline: LocalDeadline; run?: McpOwnedLocalOperation });
type McpOwnedRun = { projectId: string; location: ExecutionLocation } & ({ kind: "local"; operation: McpOwnedLocalOperation } | { kind: "online" });

export function createMcpExecutionHost(options: McpExecutionHostOptions): McpExecutionHost {
  const defaultLocalHost = createMcpLocalExecutionHost({ secretStore: options.secretStore, credentialPrivateRoot: options.credentialPrivateRoot, networkPrivateRoot: options.networkPrivateRoot });
  const localHost = options.localHost ?? defaultLocalHost;
  const tickets = createMcpTickets<McpExecutionTicket>(options.limits);
  const journal = createMcpIntentJournal(options.privateRoot, options.limits);
  const owned = createOwnedLocalRuns(options.source, options.limits);
  const runs = new Map<string, McpOwnedRun>();
  const ownedOnlineLocal = new Map<PreparedMemberRun, () => Promise<void>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const preparationLifetime = new AbortController();
  const assertOpen = () => { if (closed) throw new Error("mcp-execution-host-closed"); };
  const authenticate = async (signal: AbortSignal) => {
    const capability = executionCapabilityFor(options.source);
    try { await capability.authenticate(signal); }
    catch (error) { if (capability.isInvalid()) await tickets.discardUnused(); throw error; }
    return capability;
  };
  const unimplemented = async (): Promise<never> => {
    const error = new Error("MCP execution feature is not implemented");
    error.name = "McpExecutionUnimplementedError";
    throw error;
  };
  const rememberOnlineRun = (handle: McpRunHandle, projectId: string) => {
    runs.set(handle.runId, { kind: "online", projectId, location: handle.location });
    return handle;
  };
  const observeOnlineLocal = (capability: Extract<ReturnType<typeof executionCapabilityFor>, { kind: "online" }>, ticket: McpExecutionTicket & { kind: "online" }) => {
    const run = owned.get(ticket.summary.runId);
    if (!run || closed) return;
    const prepared = ticket.prepared;
    const reading = capability.member.report(capability.contextFor(ticket.projectId), { kind: "local" }, run.handle.runId, new AbortController().signal);
    void reading.then(result => owned.settle(run, result, () => capability.member.releaseLocalResult(prepared), () => {
      tickets.forget(run.ticketId); ownedOnlineLocal.delete(prepared); runs.delete(run.handle.runId);
    }), () => owned.settle(run, safeRunFailure(undefined, "uncertain"))).catch(() => {});
  };
  return {
    async prepare(input, signal) {
      assertOpen();
      const release = tickets.reserve();
      signal = AbortSignal.any([signal, preparationLifetime.signal]);
      let deadline: LocalDeadline | undefined, deadlineTicket: string | undefined, published = false;
      try {
      // Local admission uses the existing policy resolver, before the first asynchronous authority read.
      // Online preparations already own a member deadline; never add another one here.
      const localConfig = executionCapabilityFor(options.source).kind === "local" ? (() => {
        try { return resolveEffectiveConfig({ run: input.runConfig }); }
        catch { throw new Error("mcp-local-jobTimeout-policy-invalid"); }
      })() : undefined;
      if (localConfig) {
        const admittedAt = performance.now(), controller = new AbortController();
        const end = admittedAt + localConfig.jobTimeoutMs;
        const timer = setTimeout(() => {
          controller.abort(new Error("mcp-local-job-timeout"));
          if (deadlineTicket) void tickets.expire(deadlineTicket, "mcp-local-job-timeout-not-started").catch(() => {});
        }, Math.max(0, end - performance.now()));
        timer.unref();
        deadline = { controller, jobTimeoutMs: localConfig.jobTimeoutMs,
          deadlineAt: new Date(Date.now() + localConfig.jobTimeoutMs).toISOString(), clear: () => clearTimeout(timer) };
        signal = AbortSignal.any([signal, controller.signal]);
      }
      const capability = await authenticate(signal);
      signal.throwIfAborted();
      if (capability.kind === "local") {
        if (input.location.kind === "agent") throw new Error("local-source-agent-not-supported");
        const project = await options.source.readProject(input.projectId, signal);
        assertOpen(); signal.throwIfAborted();
        const prepared = await localHost.prepare(project.snapshot, input.target, input.environmentId, options.limits ?? {}, {
          signal, workspaceRoot: capability.root, scope: { workspaceId: project.workspaceId, groupId: project.groupId, projectId: project.snapshot.project.id },
          runConfig: { ...input.runConfig, scriptTimeoutMs: localConfig!.policy.scriptTimeoutMs,
            requestSettings: localConfig!.requestSettings }, profile: options.localProfile ?? "no-script",
        });
        try {
        assertOpen(); signal.throwIfAborted();
        const ticketId = randomUUID();
        const summary: McpPreparedSummary = Object.freeze({ ticketId, runId: randomUUID(), location: Object.freeze({ kind: "local" }),
          targetKind: input.target.kind, environmentId: prepared.environmentId ?? null, executionProfile: prepared.profile,
          ...(!options.localHost ? defaultLocalHost.metadata(prepared) : {}),
          budgets: { jobTimeoutMs: deadline!.jobTimeoutMs }, deadlineAt: deadline!.deadlineAt,
          limitations: ["local-default-policy", "job-deadline-includes-prepare-and-ticket-wait", "cancel-grace-is-not-hard-termination"],
          definitionRevision: prepared.snapshot.definitionRevision, expiresAt: new Date(Date.now() + tickets.ttlMs).toISOString() });
        tickets.add(ticketId, { kind: "local", prepared, deadline: deadline!, summary, projectId: input.projectId, contractProjectId: project.snapshot.project.id,
          createdAt: new Date().toISOString(), discard: async () => { deadline!.clear(); await localHost.discard?.(prepared); } });
        deadlineTicket = ticketId; published = true;
        return summary;
        } catch (error) { await localHost.discard?.(prepared); throw error; }
      }
      const project = await options.source.readProject(input.projectId, signal);
      const prepared = await capability.member.prepare({
        context: capability.contextFor(input.projectId), runId: randomUUID(), location: input.location,
        target: input.target, expectedVersion: project.binding.kind === "online" ? project.binding.projectVersion : "",
        ...(input.environmentId ? { environmentId: input.environmentId } : {}), runConfig: input.runConfig ?? {},
        materials: { projectId: input.projectId, credentials: [], attachments: [] }, localOnlyRefIds: [],
      }, signal);
      const ticketId = randomUUID();
      const summary: McpPreparedSummary = Object.freeze({ ...prepared.summary, ticketId, definitionRevision: project.snapshot.definitionRevision,
        expiresAt: new Date(Date.now() + tickets.ttlMs).toISOString() });
      tickets.add(ticketId, { kind: "online", prepared, summary, projectId: input.projectId, contractProjectId: project.snapshot.project.id, createdAt: new Date().toISOString(), discard: () => capability.member.discardPrepared(prepared) });
      return summary;
      } finally { if (!published) deadline?.clear(); release(); }
    },
    async start(input, signal) {
      assertOpen();
      assertMcpIntentId(input.intentId);
      signal = AbortSignal.any([signal, preparationLifetime.signal]);
      const consumed = owned.ticket(input.ticketId);
      if (consumed) {
        if (consumed.intentId !== input.intentId) throw new Error("intent_conflict");
        await authenticate(signal); assertOpen(); signal.throwIfAborted();
        return consumed.handle;
      }
      await tickets.assertUnusedFresh(input.ticketId);
      const ticket = tickets.get(input.ticketId);
      if (ticket?.kind === "local") signal = AbortSignal.any([signal, ticket.deadline.controller.signal]);
      if (ticket?.intentId !== undefined && ticket.intentId !== input.intentId) throw new Error("intent_conflict");
      if (ticket?.pendingIntent !== undefined && ticket.pendingIntent !== input.intentId) throw new Error("intent_conflict");
      if (ticket?.pending) return ticket.pending;
      const operation = (async (): Promise<McpRunHandle> => {
      const capability = await authenticate(signal);
      assertOpen(); signal.throwIfAborted();
      if (capability.kind === "online" && ticket?.kind === "online" && ticket.localHandle) return ticket.localHandle;
      if (capability.kind === "online" && ticket?.kind === "online" && ticket.summary.location.kind === "local") owned.assertUnconsumed(ticket.projectId, input.intentId);
      if (capability.kind === "local" && ticket?.kind === "local") {
        if (ticket.run) return ticket.run.handle;
        const project = await options.source.readProject(ticket.projectId, signal);
        assertOpen(); signal.throwIfAborted();
        if (project.snapshot.definitionRevision !== ticket.summary.definitionRevision) throw new Error("mcp-ticket-definition-changed");
        const controller = ticket.deadline.controller;
        const handle: McpRunHandle = { runId: ticket.summary.runId, location: ticket.summary.location, state: "running" };
        const record = owned.begin(input.ticketId, input.intentId, ticket.projectId, ticket.contractProjectId, handle, ticket.summary.definitionRevision);
        ticket.intentId = input.intentId;
        const completion = Promise.resolve().then(() => localHost.start(ticket.prepared, handle.runId, controller.signal)).finally(ticket.deadline.clear);
        const run: McpOwnedLocalOperation = { handle, controller, completion };
        ticket.run = run;
        runs.set(handle.runId, { kind: "local", projectId: ticket.projectId, location: handle.location, operation: run });
        tickets.consume(input.ticketId);
        record.stop = async () => { controller.abort(new Error("mcp-local-run-cancelled")); await completion.catch(() => {}); };
        const forget = () => { tickets.forget(input.ticketId); runs.delete(handle.runId); };
        void completion.then(output => owned.settle(record, output, undefined, forget), error => {
          const failure = error instanceof McpLocalExecutionFailure ? error.failure : safeRunFailure(undefined, "uncertain");
          runs.delete(handle.runId); tickets.forget(input.ticketId); record.stop = undefined;
          return owned.settle(record, failure);
        }).catch(() => {});
        return handle;
      }
      if (capability.kind !== "online" || ticket?.kind === "local") return unimplemented();
      if (!ticket || ticket.attempted) {
        const receipt = await journal.read(input.ticketId);
        if (!receipt) throw new Error("mcp-ticket-unavailable");
        if (receipt.intentId !== input.intentId) throw new Error("intent_conflict");
        if (receipt.state === "rejected" || ticket?.rejected) throw new Error("intent_conflict");
        const context = capability.contextFor(receipt.projectId);
        if (receipt.serverIdentity !== options.source.identity.serverIdentity || receipt.memberId !== context.ownerId
          || receipt.profileGeneration !== capability.generation || receipt.workspaceId !== context.scope.workspaceId || receipt.groupId !== context.scope.groupId) throw new Error("mcp-receipt-source-changed");
        const prior = await capability.member.findIntent(context, input.intentId, signal);
        if (!prior) throw new Error("execution-outcome-uncertain");
        if (!isFullOnlineJob(prior)) throw new Error("mcp-receipt-binding-unavailable；固定输入绑定不可核对；查询原intent，勿重新提交");
        if (prior.agentId !== (receipt.location.kind === "agent" ? receipt.location.agentId : undefined)
          || prior.task.snapshotId !== receipt.snapshotId || prior.task.manifestHash !== receipt.manifestHash
          || prior.task.contractProjectId !== receipt.contractProjectId || prior.task.target.kind !== receipt.targetKind
          || receipt.knownRunId && prior.jobId !== receipt.knownRunId || receipt.knownExecutionId && prior.executionId !== receipt.knownExecutionId) throw new Error("mcp-receipt-binding-mismatch");
        // Recovery has no complete submission body. It must not forge a prepared object or claim verify.
        capability.rememberAgentJob(receipt.projectId, prior);
        if (!ticket) return rememberOnlineRun({ runId: prior.jobId, location: receipt.location, state: prior.state, bindingStatus: "fixed-input-binding-unverified" }, receipt.projectId);
        if (ticket.prepared.summary.location.kind === "local") ownedOnlineLocal.set(ticket.prepared, () => capability.member.stopOwnedLocalRun(ticket.prepared));
        const started = await capability.member.start(ticket.prepared, input.intentId, signal);
        assertOpen(); signal.throwIfAborted();
        const handle: McpRunHandle = { runId: started.runId, location: started.location, state: started.state };
        if (started.location.kind === "local") ticket.localHandle = handle;
        return rememberOnlineRun(handle, ticket.projectId);
      }
      const context = capability.contextFor(ticket.projectId);
      const summary = ticket.prepared.summary;
      const receipt: McpIntentReceipt = {
        formatVersion: 1, ticketId: input.ticketId, intentId: input.intentId, sourceKind: "online",
        serverIdentity: options.source.identity.serverIdentity!, memberId: context.ownerId, profileGeneration: capability.generation,
        workspaceId: context.scope.workspaceId, groupId: context.scope.groupId, projectId: context.scope.projectId,
        contractProjectId: ticket.contractProjectId, location: summary.location, snapshotId: summary.snapshotId,
        manifestHash: summary.manifestHash, definitionRevision: ticket.summary.definitionRevision, assetVersion: summary.assetVersion,
        targetKind: summary.targetKind, environmentId: summary.environmentId, scriptPlanDigest: summary.scriptPlanDigest,
        materialVersions: summary.materialVersions, policyVersion: summary.policyVersion, executionProfile: summary.executionProfile,
        budgets: summary.budgets, state: "submitting", createdAt: ticket.createdAt, updatedAt: new Date().toISOString(),
      };
      const priorReceipt = await journal.admit(receipt);
      if (priorReceipt) {
        // B owns an independently bounded receipt before consuming its continuation or verifying I.
        // Finding A never exempts B's stable replay reference from journal admission limits.
        await journal.write(receipt);
        const prior = await capability.member.findIntent(context, input.intentId, signal);
        if (!prior) throw new Error("execution-outcome-uncertain");
      }
      await tickets.assertUnusedFresh(input.ticketId);
      if (summary.location.kind === "local") {
        const record = owned.begin(input.ticketId, input.intentId, ticket.projectId, ticket.contractProjectId,
          { runId: summary.runId, location: summary.location, state: "preparing" }, ticket.summary.definitionRevision);
        record.stop = () => capability.member.stopOwnedLocalRun(ticket.prepared);
      }
      ticket.intentId = input.intentId;
      tickets.consume(input.ticketId);
      try {
        if (ticket.prepared.summary.location.kind === "local") ownedOnlineLocal.set(ticket.prepared, () => capability.member.stopOwnedLocalRun(ticket.prepared));
        const started = await capability.member.start(ticket.prepared, input.intentId, signal).finally(() => {
          if (summary.location.kind === "local") observeOnlineLocal(capability, ticket);
        });
        assertOpen(); signal.throwIfAborted();
        await journal.write({ ...receipt, state: "accepted", knownRunId: started.runId, ...(started.job ? { knownExecutionId: started.job.executionId } : {}), updatedAt: new Date().toISOString() });
        assertOpen(); signal.throwIfAborted();
        const handle: McpRunHandle = { runId: started.runId, location: started.location, state: started.state };
        if (started.job) capability.rememberAgentJob(ticket.projectId, started.job);
        if (started.location.kind === "local") {
          ticket.localHandle = handle;
          const record = owned.get(started.runId)!; owned.running(record, handle);
          return rememberOnlineRun(record.handle, ticket.projectId);
        }
        return rememberOnlineRun(handle, ticket.projectId);
      } catch (error) {
        const rejected = error && typeof error === "object" && "code" in error && error.code === "intent_conflict";
        ticket.rejected = Boolean(rejected);
        await journal.write({ ...receipt, state: rejected ? "rejected" : "uncertain", updatedAt: new Date().toISOString() });
        assertOpen();
        if (rejected) throw new Error("intent_conflict");
        if (error instanceof ExecutionHttpError && error.code) {
          throw new McpExecutionOutcomeUncertainError(error.code);
        }
        throw new Error("execution-outcome-uncertain");
      }
      })();
      if (ticket) { ticket.pendingIntent = input.intentId; ticket.pending = operation; }
      try { return await operation; }
      finally { if (ticket) { ticket.pending = undefined; ticket.pendingIntent = undefined; } }
    },
    async cancel(runId, signal) {
      assertOpen();
      signal.throwIfAborted();
      const local = owned.get(runId);
      if (local) {
        const capability = executionCapabilityFor(options.source);
        if (capability.kind === "online") {
          await authenticate(signal); assertOpen(); signal.throwIfAborted();
          if (local.view.state !== "ended") await capability.member.cancel(capability.contextFor(local.projectId), local.handle.location, runId, signal);
        } else await local.stop?.();
        return;
      }
      const run = runs.get(runId);
      if (!run) throw new Error("mcp-run-unavailable");
      if (run.kind === "local") {
        run.operation.controller.abort(new Error("mcp-local-run-cancelled"));
        await run.operation.completion.catch(() => {});
        return;
      }
      const capability = await authenticate(signal);
      if (capability.kind !== "online") return unimplemented();
      await capability.member.cancel(capability.contextFor(run.projectId), run.location, runId, signal);
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = Promise.resolve().then(async () => {
        preparationLifetime.abort(new Error("mcp-execution-host-closed"));
        const local = [...runs.values()].filter((run): run is McpOwnedRun & { kind: "local" } => run.kind === "local");
        for (const run of local) run.operation.controller.abort(new Error("mcp-execution-host-closed"));
        const onlineLocal = [...ownedOnlineLocal.values()].map(stop => stop());
        await Promise.all([...local.map(run => run.operation.completion.catch(() => {})), ...onlineLocal]);
        await tickets.discardUnused();
        tickets.clearReferences();
        runs.clear();
        ownedOnlineLocal.clear();
        owned.close();
      });
      return closing;
    },
  };
}
