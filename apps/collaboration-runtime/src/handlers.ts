import { classifyAssetMutation, compileProjectMock, createProjectSnapshot, decodeContractProjectFiles, evaluateMock,
  projectPublication, validateSharedMock } from "@apicc/core/collaboration";
import { digestJson, operations, parsePayload, type Operation } from "./protocol.js";
import type { PlanCache } from "./cache.js";
import type { PublicationInput } from "@apicc/core/collaboration";
import { normalizeSyncSource, readFixedSyncDetail, buildSyncCandidate, resolveSyncCandidate, buildSyncRollback, encodeSyncContent, type SyncPlanInput } from "@apicc/core/sync";
import type { SyncReadPayload, SyncReadOutput } from "./sourceHost.js";
import { createHash } from "node:crypto";

function uniqueFiles(files: readonly { path: string; content: string }[]) {
  if (new Set(files.map(file => file.path)).size !== files.length) throw new Error("RPC_DUPLICATE_PATH");
  return new Map(files.map(file => [file.path, file.content]));
}
export interface OperationContext {
  cache?: PlanCache;
  sourceHost?: { readSource(payload: SyncReadPayload, signal?: AbortSignal): Promise<SyncReadOutput> };
  signal?: AbortSignal; deadlineEpochMs?: number;
}
export async function handleOperation(operation: string, value: unknown, context?: OperationContext): Promise<unknown> {
  if (!operations.includes(operation as Operation)) throw new Error("RPC_INVALID_REQUEST");
  switch (operation) {
    case "sync-read": {
      const payload = parsePayload("sync-read", value);
      if (!context?.sourceHost) throw new Error("SYNC_HOST_UNAVAILABLE");
      return context.sourceHost.readSource({ ...payload, input: { ...payload.input, deadlineAtMs: Math.min(payload.input.deadlineAtMs, context.deadlineEpochMs ?? payload.input.deadlineAtMs) } }, context.signal);
    }
    case "sync-plan": {
      const payload = parsePayload("sync-plan", value);
      if (payload.kind === "fixed-detail") { const { kind: _kind, ...input } = payload; return readFixedSyncDetail(input); }
      let planInput: SyncPlanInput;
      if (payload.kind === "prepared") planInput = payload.input;
      else {
        if (createHash("sha256").update(payload.read.rawText, "utf8").digest("hex") !== payload.read.upstream.rawSha256) throw new Error("SYNC_CONTENT_DIGEST_MISMATCH");
        let stamp;
        if (payload.kind === "source-read-online") {
          if (Buffer.byteLength(JSON.stringify(payload), "utf8") > payload.budget.maxCompareInputBytes) throw new Error("SYNC_COMPARE_INPUT_BYTES_EXCEEDED");
          const loaded = await decodeContractProjectFiles(uniqueFiles(payload.localFiles));
          if (!loaded.project || loaded.readOnly || loaded.problems.length) throw new Error("SYNC_INVALID_FILES");
          stamp = { ...payload.stamp, definitionRevision: createProjectSnapshot(loaded.project).definitionRevision };
        } else stamp = payload.stamp;
        const normalized = normalizeSyncSource({ rawText: payload.read.rawText, source: payload.source, mapping: payload.mapping, allocationSeed: payload.allocationSeed,
          budget: { maxSourceBytes: payload.budget.maxSourceBytes, maxCompareInputBytes: payload.budget.maxCompareInputBytes, maxNormalizeDepth: payload.budget.maxNormalizeDepth, maxNormalizeNodes: payload.budget.maxNormalizeNodes } });
        planInput = { source: payload.source, stamp, upstream: payload.read.upstream, mapping: normalized.mapping, baselineFiles: payload.baselineFiles, localFiles: payload.localFiles, remoteFiles: normalized.files,
          normalizationDiagnostics: [...payload.read.diagnostics, ...normalized.diagnostics], otherSourceMappings: payload.otherSourceMappings,
          budget: { maxCompareInputBytes: payload.budget.maxCompareInputBytes, maxCompareOutputBytes: payload.budget.maxCompareOutputBytes } };
      }
      return { candidate: await buildSyncCandidate(planInput), planInput };
    }
    case "sync-resolve": {
      const payload = parsePayload("sync-resolve", value);
      if (!("kind" in payload)) return resolveSyncCandidate(payload);
      const plan = await resolveSyncCandidate(payload.input);
      return commitResult(plan, payload.input.planInput.localFiles, payload.input.planInput.budget.maxCompareInputBytes);
    }
    case "sync-rollback": {
      const payload = parsePayload("sync-rollback", value);
      if (!("kind" in payload)) return buildSyncRollback(payload);
      return commitResult(await buildSyncRollback(payload.input), payload.input.currentFiles, payload.input.budget.maxCompareInputBytes);
    }
    case "health": parsePayload("health", value); return { ready: true };
    case "project-document": { const { input, policy } = parsePayload("project-document", value); return projectPublication(input, policy); }
    case "project-report": {
      const { input, policy } = parsePayload("project-report", value);
      // The exported wire trace labels are strings; the existing model uses a
      // narrower union. Core still performs its own full source/report parsing.
      return projectPublication(input as PublicationInput, policy);
    }
    case "classify-asset-mutation": { const { beforeFiles, afterFiles } = parsePayload("classify-asset-mutation", value); return classifyAssetMutation(uniqueFiles(beforeFiles), uniqueFiles(afterFiles)); }
    case "compile-mock": {
      const { input, policy } = parsePayload("compile-mock", value);
      if (input.maxResponseBytes !== undefined && input.maxResponseBytes !== policy.maxResponseBytes) throw new Error("RPC_POLICY_MISMATCH");
      const files = uniqueFiles(input.files);
      const loaded = await decodeContractProjectFiles(files);
      if (!loaded.project || loaded.readOnly || loaded.problems.length) throw new Error("PUBLICATION_SOURCE_INVALID");
      const result = compileProjectMock(createProjectSnapshot(loaded.project), { maxResponseBytes: policy.maxResponseBytes });
      if (!result.ok) return result;
      const diagnostics = validateSharedMock(result.plan, policy);
      if (diagnostics.length) return { ok: false, diagnostics };
      context?.cache?.put(digestJson(result.plan), result.plan);
      return result;
    }
    case "respond-mock": {
      const payload = parsePayload("respond-mock", value);
      const plan = "plan" in payload ? payload.plan : context?.cache?.get(payload.planDigest);
      if (!plan) throw new Error("RPC_PLAN_UNAVAILABLE");
      const planDigest = digestJson(plan);
      if (payload.planDigest !== undefined && payload.planDigest !== planDigest) throw new Error("RPC_PLAN_DIGEST_MISMATCH");
      if (validateSharedMock(plan, payload.policy).length) throw new Error("RPC_PLAN_UNSAFE");
      context?.cache?.put(planDigest, plan);
      const response = evaluateMock(plan, { ...payload.input, body: Uint8Array.from(payload.input.body) });
      return { ...response, body: Array.from(response.body) };
    }
  }
}

function commitResult(plan: Awaited<ReturnType<typeof resolveSyncCandidate>>, before: {path:string;content:string}[], maximum: number) {
  const after = new Map(before.map(file => [file.path, file.content]));
  for (const path of plan.deletions) after.delete(path);
  for (const file of plan.writes) after.set(file.path, file.content);
  const limits = { maxStateBytes: maximum, maxContentBytes: maximum, maxTotalContentBytes: maximum };
  return { plan, before: encodeSyncContent(before, limits), after: encodeSyncContent([...after].map(([path, content]) => ({ path, content })), limits), baseline: encodeSyncContent(plan.baselineFiles, limits) };
}
