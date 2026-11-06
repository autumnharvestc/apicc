import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createProjectSnapshot, type ContractProject } from "@apicc/core";
import {
  buildSyncCandidate, buildSyncRollback, canonical, commitWritePlan, decodeContractWorkspace, defaultSyncPolicyValues,
  defaultSyncStorageLimits, encodeSyncContent, encodeSyncProject, encodeSyncState, hash, loadSyncState, normalizeSyncSource,
  readSyncContent, readFixedSyncDetail, resolveSyncCandidate, syncContentFilePath, syncContentReferences, syncStateFilePath,
  SyncDecisionsSchema, SyncHistoryEntrySchema, SyncPolicyValuesSchema, SyncReceiptSchema, SyncSourceSchema, SyncStampSchema,
  type StoredSyncCandidate, type SyncCandidateView, type SyncContentRef, type SyncHistoryEntry, type SyncPlanInput,
  type SyncReceipt, type SyncResolvedPlan, type SyncSourceState, type SyncStamp, type SyncWorkspaceState,
} from "@apicc/core/sync";
import { createSourceHost, type SourceCacheEntry, type SourceContentCache, type SourceValidatedContent } from "@apicc/execution/source-host";
import type { SessionView } from "../session.js";
import type { LocalSync, LocalSyncAdmission, LocalSyncAuthorization, LocalSyncDependencies, LocalSyncLocation } from "./types.js";

/** Process-wide by default. A retained unsafe owner consumes its slot for the
 * lifetime of this admission owner; it is never freed merely by a finally. */
export function createLocalSyncAdmission(): LocalSyncAdmission {
  const projects = new Map<string, number>(); let host = 0;
  return { acquire(project, projectLimit, hostLimit) {
    if ((projects.get(project) ?? 0) >= projectLimit || host >= hostLimit) throw new Error("SYNC_CONCURRENCY_LIMIT");
    projects.set(project, (projects.get(project) ?? 0) + 1); host++;
    let released = false, retained = false;
    return {
      retain() { retained = true; },
      release() { if (released || retained) return; released = true; host--; const next = projects.get(project)! - 1; if (next) projects.set(project, next); else projects.delete(project); },
    };
  } };
}
const processAdmission = createLocalSyncAdmission();
const increment = (revision: string) => (BigInt(revision) + 1n).toString();
function integrity(record: { integritySha256: string }, tag: string, code: string, requestDigest?: string): void {
  const { integritySha256, ...body } = record;
  if (hash(requestDigest === undefined ? [tag, body] : [tag, requestDigest, body]) !== integritySha256) throw new Error(code);
}
function privateCache(maximum: number): SourceContentCache {
  const entries = new Map<string, SourceCacheEntry>(); let used = 0;
  return {
    async get(binding) { const entry = entries.get(binding); if (entry) { entries.delete(binding); entries.set(binding, entry); } return entry; },
    async put(entry) {
      const prior = entries.get(entry.binding); if (prior) { used -= Buffer.byteLength(prior.rawText, "utf8"); entries.delete(entry.binding); }
      entries.set(entry.binding, entry); used += Buffer.byteLength(entry.rawText, "utf8");
      while (entries.size > 4 || used > maximum) { const [key, oldest] = entries.entries().next().value!; entries.delete(key); used -= Buffer.byteLength(oldest.rawText, "utf8"); }
    },
  };
}
interface LoadedSync {
  project: ContractProject;
  state: SyncWorkspaceState;
  storageRevision: string;
  authorization: LocalSyncAuthorization;
  coreBuildId: string;
  beforeReferences: SyncContentRef[];
}

/** A main-process service bound to the real session context. This is the trusted
 * production seam for T12: the caller supplies route/material/tool/private-owner
 * providers, including configured maxRedirects. No renderer/private-data bridge. */
export async function openLocalSync(directory: string, deps: LocalSyncDependencies): Promise<LocalSync> {
  const root = resolve(directory), session = deps.session, context = session.captureDraftWriteContext();
  const policy = SyncPolicyValuesSchema.parse(deps.policy ?? defaultSyncPolicyValues), limits = deps.storageLimits ?? defaultSyncStorageLimits;
  const compareBudget = { maxCompareInputBytes: policy.maxCompareInputBytes, maxCompareOutputBytes: policy.maxCompareOutputBytes };
  const normalizeBudget = { maxSourceBytes: policy.maxSourceBytes, maxCompareInputBytes: policy.maxCompareInputBytes, maxNormalizeDepth: policy.maxNormalizeDepth, maxNormalizeNodes: policy.maxNormalizeNodes };
  const cache = privateCache(2 * policy.maxSourceBytes), admission = deps.admission ?? processAdmission, now = deps.now ?? Date.now;
  function assertContext(): void {
    const current = session.captureDraftWriteContext();
    if (context.root !== root || current.root !== root || current.generation !== context.generation) throw new Error("SYNC_CONTEXT_CHANGED");
  }
  async function load(location: LocalSyncLocation, view: SessionView, write: boolean, signal?: AbortSignal): Promise<LoadedSync> {
    if (write && view.readOnly) throw new Error("SYNC_READ_ONLY");
    const loaded = await decodeContractWorkspace(root);
    if (write && loaded.readOnly) throw new Error("SYNC_READ_ONLY");
    const project = loaded.workspace.groups.find(g => g.id === location.groupId)?.projects.find(p => p.id === location.projectId);
    if (!project) throw new Error("SYNC_PROJECT_NOT_FOUND");
    const authorization = await deps.authorize(project.id, signal), coreBuildId = await deps.readCoreBuildId();
    const state = await loadSyncState(root, location, limits) ?? { formatVersion: 1, projectId: project.id, sources: [], candidates: [], history: [], operations: [] };
    return { project, state, storageRevision: loaded.revision, authorization, coreBuildId, beforeReferences: syncContentReferences(state) };
  }
  async function run<T>(location: LocalSyncLocation, write: boolean, operation: (loaded: LoadedSync) => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    assertContext();
    return session.runSyncContext(context, async view => operation(await load(location, view, write, signal)));
  }
  function source(loaded: LoadedSync, sourceId: string): SyncSourceState {
    const entry = loaded.state.sources.find(s => s.source.id === sourceId);
    if (!entry) throw new Error("SYNC_SOURCE_NOT_FOUND"); return entry;
  }
  function stamp(loaded: LoadedSync, entry: SyncSourceState): SyncStamp {
    return SyncStampSchema.parse({ formatVersion: 1, kind: "local", projectId: loaded.project.id, definitionRevision: createProjectSnapshot(loaded.project).definitionRevision,
      sourceRevision: entry.source.revision, mappingRevision: entry.mapping.revision, baselineRevision: entry.baselineRevision,
      authorizationGeneration: loaded.authorization.generation, coreBuildId: loaded.coreBuildId });
  }
  function reason(record: StoredSyncCandidate, loaded: LoadedSync): SyncCandidateView["reasonCode"] {
    const entry = loaded.state.sources.find(s => s.source.id === record.candidate.sourceId);
    if (!entry) return "source-disabled";
    const current = stamp(loaded, entry), previous = record.candidate.stamp;
    const checks = [["definitionRevision", "project-assets-changed"], ["sourceRevision", "source-revision-changed"], ["mappingRevision", "mapping-revision-changed"], ["baselineRevision", "baseline-revision-changed"], ["authorizationGeneration", "authorization-changed"], ["coreBuildId", "core-identity-changed"]] as const;
    for (const [key, code] of checks) if (current[key] !== previous[key]) return code;
    return now() >= record.expiresAtMs ? "candidate-expired" : null;
  }
  function candidate(loaded: LoadedSync, id: string): StoredSyncCandidate {
    const entry = loaded.state.candidates.find(c => c.candidate.id === id);
    if (!entry) throw new Error("SYNC_CANDIDATE_NOT_FOUND"); return entry;
  }
  function receipt(loaded: LoadedSync, intent: string, requestDigest?: string): SyncReceipt | null {
    const operation = loaded.state.operations.find(o => o.receipt.intentId === intent);
    if (!operation) return null;
    integrity(operation.receipt, "apicc-local-sync-receipt-v1", "SYNC_RECEIPT_INTEGRITY_MISMATCH", operation.requestDigest);
    if (requestDigest && operation.requestDigest !== requestDigest) throw new Error("SYNC_INTENT_MISMATCH");
    return operation.receipt;
  }
  async function commit(location: LocalSyncLocation, loaded: LoadedSync, files: Map<string, string>, deletions: string[] = [], lifetime?: { signal: AbortSignal; deadlineAtMs: number }): Promise<void> {
    files.set(syncStateFilePath(location), encodeSyncState(loaded.state, limits));
    const retained = new Set(syncContentReferences(loaded.state).map(r => r.digest));
    for (const reference of loaded.beforeReferences) if (!retained.has(reference.digest)) deletions.push(syncContentFilePath(location, reference));
    // This is the transaction boundary, after final async authority/Core checks
    // and synchronous metadata encoding. A delayed timer is not deadline proof.
    if (lifetime) {
      if (Date.now() >= lifetime.deadlineAtMs) throw new Error("SYNC_DEADLINE");
      if (lifetime.signal.aborted) throw new Error("SYNC_CANCELLED");
    }
    await commitWritePlan(root, { files }, { expectedRevision: loaded.storageRevision, deletions: [...new Set(deletions)].filter(path => !files.has(path)), faultInjector: deps.writeFault });
  }
  function addContent(location: LocalSyncLocation, files: Map<string, string>, value: SyncPlanInput["localFiles"]): SyncContentRef {
    const content = encodeSyncContent(value, limits); files.set(syncContentFilePath(location, content.reference), content.text); return content.reference;
  }
  async function planInput(location: LocalSyncLocation, loaded: LoadedSync, record: StoredSyncCandidate): Promise<SyncPlanInput> {
    const entry = source(loaded, record.candidate.sourceId);
    const [baselineFiles, localFiles, remoteFiles] = await Promise.all([record.baselineContent, record.localContent, record.remoteContent].map(ref => readSyncContent(root, location, ref, limits)));
    return { source: entry.source, stamp: record.candidate.stamp, upstream: record.candidate.upstream, mapping: record.mapping, baselineFiles: baselineFiles!, localFiles: localFiles!, remoteFiles: remoteFiles!, normalizationDiagnostics: record.normalizationDiagnostics,
      otherSourceMappings: loaded.state.sources.filter(s => s.source.id !== entry.source.id).map(s => s.mapping), budget: compareBudget };
  }
  async function persistOperation(location: LocalSyncLocation, loaded: LoadedSync, entry: SyncSourceState, plan: SyncResolvedPlan, upstream: SyncHistoryEntry["upstream"], intentId: string, requestDigest: string, kind: "apply" | "rollback"): Promise<SyncReceipt> {
    const latestAuthorization = await deps.authorize(loaded.project.id);
    if (latestAuthorization.generation !== loaded.authorization.generation) throw new Error("SYNC_AUTHORIZATION_CHANGED");
    const prefix = `groups/${location.groupId}/projects/${location.projectId}/`, files = new Map(plan.writes.map(f => [prefix + f.path, f.content]));
    const beforeFiles = encodeSyncProject(loaded.project), after = new Map(beforeFiles.map(f => [f.path, f.content]));
    for (const path of plan.deletions) after.delete(path); for (const file of plan.writes) after.set(file.path, file.content);
    const beforeContent = addContent(location, files, beforeFiles), afterContent = addContent(location, files, [...after].map(([path, content]) => ({ path, content })));
    const beforeStamp = stamp(loaded, entry);
    entry.mapping = { ...plan.mapping, revision: increment(entry.mapping.revision) };
    entry.baselineRevision = increment(entry.baselineRevision); entry.baselineContent = addContent(location, files, plan.baselineFiles);
    const afterStamp = { ...beforeStamp, definitionRevision: plan.after.definitionRevision, mappingRevision: entry.mapping.revision, baselineRevision: entry.baselineRevision };
    const historyBase = { formatVersion: 1 as const, id: randomUUID(), sourceId: entry.source.id, projectId: loaded.project.id, intentId, operationKind: kind, actor: loaded.authorization.actor, createdAtMs: now(), beforeStamp, afterStamp, upstream, before: plan.before, after: plan.after, rollback: { beforeContent, afterContent } };
    const history = SyncHistoryEntrySchema.parse({ ...historyBase, integritySha256: hash(["apicc-local-sync-history-v1", historyBase]) });
    const receiptBase = { formatVersion: 1 as const, operationId: randomUUID(), intentId, kind, status: "committed" as const, historyId: history.id, sourceId: entry.source.id, projectId: loaded.project.id, afterStamp, actor: loaded.authorization.actor, completedAtMs: now() };
    const result = SyncReceiptSchema.parse({ ...receiptBase, integritySha256: hash(["apicc-local-sync-receipt-v1", requestDigest, receiptBase]) });
    loaded.state.history.push(history); loaded.state.operations.push({ requestDigest, receipt: result });
    const perSource = new Map<string, number>();
    loaded.state.history = loaded.state.history.filter(h => h.createdAtMs >= now() - policy.historyRetentionDays * 86400000).reverse().filter(h => {
      const count = perSource.get(h.sourceId) ?? 0; perSource.set(h.sourceId, count + 1); return count < policy.historyMaxEntries;
    }).reverse();
    await commit(location, loaded, files, plan.deletions.map(path => prefix + path)); return result;
  }
  const api: LocalSync = {
    sources(location) { return run(location, false, loaded => loaded.state.sources.map(s => s.source)); },
    saveSource(location, input, expectedRevision) { return run(location, true, async loaded => {
      const next = SyncSourceSchema.parse(input), existing = loaded.state.sources.find(s => s.source.id === next.id);
      if ((existing?.source.revision ?? "0") !== expectedRevision || next.revision !== increment(expectedRevision)) throw new Error("SYNC_SOURCE_REVISION_CHANGED");
      if (!loaded.project.collections.some(c => c.id === next.moduleId)) throw new Error("SYNC_SOURCE_MODULE_MISMATCH");
      if (existing && existing.source.moduleId !== next.moduleId) throw new Error("SYNC_SOURCE_MODULE_CHANGE_UNSUPPORTED");
      if (existing) existing.source = next;
      else loaded.state.sources.push({ source: next, mapping: { formatVersion: 1, sourceId: next.id, namespace: next.id, revision: "0", algorithm: "apicc-sync-id-v1", entries: [] }, baselineRevision: "0", baselineContent: null });
      await commit(location, loaded, new Map()); return next;
    }); },
    async check(location, sourceId, callerSignal) {
      const initial = await run(location, true, loaded => { source(loaded, sourceId); return loaded; }, callerSignal), entry = source(initial, sourceId), capturedStamp = stamp(initial, entry);
      // Session fencing keeps its lexical root/generation. Admission instead
      // binds the trusted physical directory identity, including Windows case
      // and junction aliases, without case-folding paths on other platforms.
      const physicalRoot = await stat(await realpath(root), { bigint: true });
      const slot = admission.acquire(canonical([physicalRoot.dev.toString(), physicalRoot.ino.toString(), location.projectId]), policy.projectConcurrency, policy.hostConcurrency);
      const abort = new AbortController(), cancel = () => abort.abort(); callerSignal?.addEventListener("abort", cancel, { once: true }); if (callerSignal?.aborted) cancel();
      const deadlineAtMs = Date.now() + (entry.source.kind === "url" ? policy.urlDeadlineMs : policy.gitDeadlineMs), timer = setTimeout(cancel, deadlineAtMs - Date.now());
      let staged: SourceValidatedContent | undefined;
      try {
        const host = createSourceHost({ ...deps.sourceHost, cache, onContent: async content => { staged = content; } });
        const lease = await deps.acquireMaterial(entry.source, abort.signal);
        // The private callback precedes owned collection/release. Only settlement
        // of this awaited three-argument read authorizes a usable candidate.
        const read = await host.readSource({ formatVersion: 1, source: entry.source, deadlineAtMs, budget: { connectTimeoutMs: policy.connectTimeoutMs, maxAttempts: policy.maxAttempts, maxSourceBytes: policy.maxSourceBytes, gitDiskThresholdBytes: policy.gitDiskThresholdBytes } }, lease, abort.signal);
        if (!staged) throw new Error("SYNC_CONTENT_UNAVAILABLE");
        const normalized = normalizeSyncSource({ rawText: staged.rawText, source: entry.source, mapping: entry.mapping, allocationSeed: "apicc-sync-id-v1", budget: normalizeBudget });
        const input: SyncPlanInput = { source: entry.source, stamp: capturedStamp, upstream: read.upstream, mapping: normalized.mapping, baselineFiles: entry.baselineContent ? await readSyncContent(root, location, entry.baselineContent, limits) : [], localFiles: encodeSyncProject(initial.project), remoteFiles: normalized.files, normalizationDiagnostics: normalized.diagnostics, otherSourceMappings: initial.state.sources.filter(s => s.source.id !== sourceId).map(s => s.mapping), budget: compareBudget };
        const fixed = await buildSyncCandidate(input);
        return await run(location, true, async loaded => {
          if (canonical(stamp(loaded, source(loaded, sourceId))) !== canonical(capturedStamp)) throw new Error("SYNC_CHECK_STALE");
          const files = new Map<string, string>();
          const checkedAtMs = now(), existing = loaded.state.candidates.find(c => c.candidate.id === fixed.id);
          if (existing) {
            // A new successful controlled read refreshes lifecycle metadata;
            // the deterministic candidate DTO and its protected refs stay fixed.
            existing.createdAtMs = checkedAtMs; existing.expiresAtMs = checkedAtMs + policy.candidateTtlMs;
          } else loaded.state.candidates.push({ candidate: fixed, createdAtMs: checkedAtMs, expiresAtMs: checkedAtMs + policy.candidateTtlMs, mapping: normalized.mapping, normalizationDiagnostics: normalized.diagnostics,
            baselineContent: addContent(location, files, input.baselineFiles), localContent: addContent(location, files, input.localFiles), remoteContent: addContent(location, files, input.remoteFiles) });
          // Persist the fixed record once; index-only writes use storage CAS,
          // independently of the candidate's business definition fingerprint.
          await commit(location, loaded, files, [], { signal: abort.signal, deadlineAtMs }); const record = candidate(loaded, fixed.id), code = reason(record, loaded);
          return { candidate: record.candidate, applicable: code === null, reasonCode: code };
        }, abort.signal);
      } catch (error) {
        const code = (error as { code?: string })?.code;
        if (code === "SYNC_PROCESS_UNCOLLECTED" || code === "SYNC_MATERIAL_RELEASE_FAILED") slot.retain();
        throw error;
      } finally { staged = undefined; clearTimeout(timer); callerSignal?.removeEventListener("abort", cancel); slot.release(); }
    },
    detail(location, request) { return run(location, false, async loaded => {
      const record = candidate(loaded, request.candidateId);
      const reference = request.side === 'baseline' ? record.baselineContent : request.side === 'current' ? record.localContent : record.remoteContent;
      const files = await readSyncContent(root, location, reference, limits);
      return readFixedSyncDetail({ candidate: record.candidate, request, files, budget: compareBudget });
    }); },
    candidate(location, id) { return run(location, false, loaded => { const record = candidate(loaded, id), code = reason(record, loaded); return { candidate: record.candidate, applicable: code === null, reasonCode: code }; }); },
    apply(location, identity, input, intentId) { return run(location, true, async loaded => {
      const decisions = SyncDecisionsSchema.parse(input);
      const requestDigest = hash(["apicc-local-sync-apply-v1", location.projectId, identity.id, identity.candidateDigest, { ...decisions, entries: [...decisions.entries].sort((a,b) => a.changeId.localeCompare(b.changeId)) }]);
      const prior = receipt(loaded, intentId, requestDigest); if (prior) return prior;
      const record = candidate(loaded, identity.id);
      if (record.candidate.candidateDigest !== identity.candidateDigest) throw new Error("SYNC_CANDIDATE_DIGEST_MISMATCH");
      if (reason(record, loaded)) throw new Error("SYNC_CANDIDATE_STALE");
      const plan = await resolveSyncCandidate({ candidate: record.candidate, decisions, planInput: await planInput(location, loaded, record) });
      return persistOperation(location, loaded, source(loaded, record.candidate.sourceId), plan, record.candidate.upstream, intentId, requestDigest, "apply");
    }); },
    rollback(location, historyId, intentId) { return run(location, true, async loaded => {
      const requestDigest = hash(["apicc-local-sync-rollback-v1", location.projectId, historyId]), prior = receipt(loaded, intentId, requestDigest); if (prior) return prior;
      const history = loaded.state.history.find(h => h.id === historyId); if (!history) throw new Error("SYNC_HISTORY_NOT_FOUND");
      integrity(history, "apicc-local-sync-history-v1", "SYNC_HISTORY_INTEGRITY_MISMATCH");
      if (history.createdAtMs < now() - policy.historyRetentionDays * 86400000) throw new Error("SYNC_HISTORY_EXPIRED");
      const entry = source(loaded, history.sourceId), currentStamp = stamp(loaded, entry);
      if (currentStamp.sourceRevision !== history.afterStamp.sourceRevision || currentStamp.mappingRevision !== history.afterStamp.mappingRevision || currentStamp.baselineRevision !== history.afterStamp.baselineRevision) throw new Error("SYNC_ROLLBACK_CURRENT_CHANGED");
      const [beforeFiles, afterFiles, baselineFiles] = await Promise.all([history.rollback.beforeContent, history.rollback.afterContent, entry.baselineContent!].map(ref => readSyncContent(root, location, ref, limits)));
      const plan = await buildSyncRollback({ history, currentFiles: encodeSyncProject(loaded.project), currentStamp, beforeFiles: beforeFiles!, afterFiles: afterFiles!, mapping: entry.mapping, baselineFiles: baselineFiles!, otherSourceMappings: loaded.state.sources.filter(s => s.source.id !== entry.source.id).map(s => s.mapping), budget: compareBudget });
      return persistOperation(location, loaded, entry, plan, history.upstream, intentId, requestDigest, "rollback");
    }); },
    operation(location, intentId) { return run(location, false, loaded => receipt(loaded, intentId)); },
    history(location) { return run(location, false, loaded => { for (const entry of loaded.state.history) integrity(entry, "apicc-local-sync-history-v1", "SYNC_HISTORY_INTEGRITY_MISMATCH"); return loaded.state.history.filter(h => h.createdAtMs >= now() - policy.historyRetentionDays * 86400000); }); },
  };
  return api;
}
