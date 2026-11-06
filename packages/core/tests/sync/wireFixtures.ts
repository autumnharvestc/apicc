import { hashA, projectId, sourceId, syncFixture } from "./fixtures.js";

export const candidateId = "00000000-0000-4000-8000-000000000711";
export const intentId = "00000000-0000-4000-8000-000000000712";
export const historyId = "00000000-0000-4000-8000-000000000713";
export const actor = { id: "synthetic-user", name: "Fixture editor" };

export function syncWireFixture() {
  const fixture = syncFixture();
  const api = fixture.localProject.collections[0]!.apis[0]!;
  const entityId = api.contract.id;
  const responseId = api.contract.responses[0]!.id;
  const modelId = fixture.localProject.models[0]!.id;
  const encodedFiles = fixture.planInput().localFiles;
  const upstream = fixture.upstream;
  const mapping = { formatVersion: 1, sourceId, namespace: sourceId, revision: "0", algorithm: "apicc-sync-id-v1", entries: [
    { entityKind: "api", externalKey: "api/GET /pets/{id}", entityId, ownerExternalKey: "module/pets", aliases: ["api/GET /animals/{id}"], ownership: "source", correspondence: "confirmed" },
    { entityKind: "response", externalKey: "api/GET /pets/{id}/response/200", entityId: responseId, ownerExternalKey: "api/GET /pets/{id}", aliases: [], ownership: "local", correspondence: "manual" },
    { entityKind: "model", externalKey: "model/Pet", entityId: modelId, ownerExternalKey: "module/pets", aliases: [], ownership: "source", correspondence: "confirmed" },
  ] };
  const change = { changeId: hashA, entityKind: "api", externalKey: "api/GET /pets/{id}", entityId, layer: "contract", operation: "update", path: encodedFiles.find(file => file.path.endsWith("/api.yaml"))!.path, fieldPath: "/metadata/description", label: "GET /pets/{id}", beforeDigest: hashA, afterDigest: "b".repeat(64),
    summaries:{baseline:{kind:"scalar",value:"Baseline Pet response",truncated:false},current:{kind:"scalar",value:"Local Pet response",truncated:false},source:{kind:"scalar",value:"Source Pet response",truncated:false}} };
  const diagnostic = { code: "SYNC_LOCAL_MODIFIED", severity: "warning", ownerId: entityId, path: "responses/200", message: "Local response differs from source" };
  const candidate = { formatVersion: 1, id: candidateId, sourceId, stamp: fixture.stamp, upstream, candidateDigest: hashA,
    summary: { added: 0, updated: 1, removed: 0, conflicts: 1 }, diagnostics: [diagnostic], changes: [change],
    conflicts: [{ changeId: hashA, reasonCode: "both-modified", message: "Both local and upstream changed", currentSummary: "Local Pet response", sourceSummary: "Source Pet response" }],
    referenceImpacts: [{ changeId: hashA, ownerId: entityId, targetId: modelId, path: "responses/200", reasonCode: "protected-reference", protected: true }],
  };
  const decisions = { formatVersion: 1, candidateDigest: hashA, entries: [{ changeId: hashA, decision: "take-source" }] };
  const digest = { definitionRevision: hashA, manifestDigest: hashA };
  const contentRef = { digest: hashA, bytes: 100, contentType: "application/vnd.apicc.sync-files+json" };
  const history = { formatVersion: 1, id: historyId, sourceId, projectId, intentId, operationKind: "apply", actor, createdAtMs: 1000,
    beforeStamp: fixture.stamp, afterStamp: { ...fixture.stamp, baselineRevision: "1" }, upstream,
    before: digest, after: digest, rollback: { beforeContent: contentRef, afterContent: contentRef }, integritySha256: hashA };
  const receipt = { formatVersion: 1, operationId: intentId, intentId, kind: "apply", status: "committed", historyId, sourceId, projectId,
    afterStamp: fixture.stamp, actor, completedAtMs: 1000, integritySha256: hashA };
  const planInput = { ...fixture.planInput(), upstream, mapping, budget: { maxCompareInputBytes: 16 * 1024 * 1024, maxCompareOutputBytes: 8 * 1024 * 1024 } };
  const resolved = { formatVersion: 1, candidateDigest: hashA, decisionsDigest: hashA, stamp: fixture.stamp,
    writes: encodedFiles.filter(file => file.path.startsWith("models/")), deletions: [], baselineFiles: planInput.remoteFiles, mapping,
    before: digest, after: digest };
  const sourceReadInput = { formatVersion: 1, source: fixture.source, deadlineAtMs: 100000, budget: { connectTimeoutMs: 10000, maxAttempts: 1, maxSourceBytes: 5 * 1024 * 1024, gitDiskThresholdBytes: 256 * 1024 * 1024 } };
  const sourceReadResult = { formatVersion: 1, status: "read", upstream, rawText: fixture.rawText, diagnostics: [] };
  const normalizeInput = { ...fixture.normalizeInput, mapping };
  const normalized = { files: planInput.remoteFiles, mapping, entityIds: [{ entityKind: "api", externalKey: "api/GET /pets/{id}", entityId }], manifestDigest: hashA, diagnostics: [] };
  return { ...fixture, upstream, mapping, change, candidate, decisions, history, receipt, planInput, resolved, contentRef, sourceReadInput, sourceReadResult, normalizeInput, normalized };
}
