import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { ContractWorkspaceSchema, createProjectSnapshot, fileStorage, prepareNetworkRun, type StorageAdapter } from "@apicc/core";
import { buildSyncCandidate, canonical, commitWritePlan, decodeContractWorkspace, encodeSyncContent, encodeSyncProject, encodeSyncState, hash, loadSyncState, normalizeSyncSource, readSyncContent, readSyncProject, resolveSyncCandidate, syncContentFilePath, syncStateFilePath, defaultSyncPolicyValues, type SyncDecisions, type SyncHistoryEntry, type SyncReceipt, type SyncWorkspaceState, type WriteFaultInjector } from "@apicc/core/sync";
import { createSession } from "../../../src/main/session.js";
import { createLocalSyncAdmission, openLocalSync } from "../../../src/main/sync/local.js";
import type { LocalSyncDependencies } from "../../../src/main/sync/types.js";
import { createMemorySecretStore } from "../helpers/secret-store.js";

export const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
export function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
export async function withLocalSync(callback: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>, descriptions?: { baseline?: string; local?: string; source?: string }): Promise<void> {
  const disposers: (() => Promise<void>)[] = [];
  try { await callback(await fixture(dispose => disposers.push(dispose), descriptions)); }
  finally { for (const dispose of disposers.reverse()) await dispose(); }
}
async function fixture(register: (dispose: () => Promise<void>) => void, descriptions?: { baseline?: string; local?: string; source?: string }) {
  async function ownRoot(prefix: string) { const path = await mkdtemp(join(tmpdir(), prefix)); register(async () => { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe fixture cleanup"); await rm(path, { recursive: true, force: true }); }); return path; }
  const workspaceContainer = await ownRoot("apicc-local-sync-"), privateRoot = await ownRoot("apicc-local-sync-private-"), otherRoot = await ownRoot("apicc-local-sync-other-");
  const root = join(workspaceContainer, "workspace"); await mkdir(root);
  const location = { groupId: id(820), projectId: id(821) }, sourceId = id(822), moduleId = id(823);
  let clock = Date.now(), authorizationGeneration = "1", coreBuildId = "a".repeat(64), failRefresh = false, releaseFailure = false, readOnlyMode = false;
  let releaseGate: ReturnType<typeof deferred> | undefined, releaseStarted = deferred(), released = 0;
  const secrets = createMemorySecretStore();
  const requests: { conditional: boolean; status: number; authorization?: string }[] = [];
  const doc = (description: string) => ({ openapi: "3.1.0", info: { title: "Owned fixture", version: "1" }, paths: { "/pets": { get: { operationId: "pets", description, responses: { "200": { description: "OK" } } } } } });
  let rawText = JSON.stringify(doc(descriptions?.source ?? "upstream"));
  const server = createServer((request, response) => {
    const conditional = request.headers["if-none-match"] === '"owned-v1"'; requests.push({ conditional, status: conditional ? 304 : 200, ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}) });
    response.writeHead(conditional ? 304 : 200, { etag: '"owned-v1"' }); response.end(conditional ? undefined : rawText);
  });
  register(async () => { releaseGate?.resolve(); server.closeAllConnections(); if (server.listening) await new Promise<void>(r => server.close(() => r())); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const source = { formatVersion: 1 as const, id: sourceId, revision: "1", moduleId, kind: "url" as const, url: `${origin}/openapi.json`, schedule: { enabled: false, rule: { kind: "cron" as const, expression: "0 0 * * * *", timeZone: "UTC", dstOverlap: "first" as const } } };
  const budget = { maxSourceBytes: defaultSyncPolicyValues.maxSourceBytes, maxCompareInputBytes: defaultSyncPolicyValues.maxCompareInputBytes, maxNormalizeDepth: 128, maxNormalizeNodes: 100000 };
  const emptyMapping = { formatVersion: 1 as const, sourceId, namespace: sourceId, revision: "0", algorithm: "apicc-sync-id-v1" as const, entries: [] };
  const baseline = normalizeSyncSource({ rawText: JSON.stringify(doc(descriptions?.baseline ?? "baseline")), source, mapping: emptyMapping, allocationSeed: "apicc-sync-id-v1", budget });
  const project = await readSyncProject(baseline.files); project.id = location.projectId; project.name = "Local target"; if (descriptions?.local !== undefined) project.collections[0]!.apis[0]!.contract.metadata.description = descriptions.local;
  project.collections.push({ id: id(824), name: "Unrelated local assets", variables: {}, preOperations: [], postOperations: [], folders: [], apis: [] });
  const workspace = ContractWorkspaceSchema.parse({ formatVersion: 1, id: id(825), name: "Owned local sync", variables: {}, groups: [{ id: location.groupId, name: "Owned", projects: [project] }] });
  const saved = await fileStorage.save(root, workspace, { expectedRevision: "empty", deletions: [] });
  await fileStorage.save(otherRoot, { ...workspace, id: id(826), name: "Other root" }, { expectedRevision: "empty", deletions: [] });
  const localFiles = encodeSyncProject(project), remote = normalizeSyncSource({ rawText, source, mapping: baseline.mapping, allocationSeed: "apicc-sync-id-v1", budget });
  const upstream = { kind: "url" as const, finalUrl: source.url, rawSha256: createHash("sha256").update(rawText).digest("hex") };
  const stamp = { formatVersion: 1 as const, kind: "local" as const, projectId: location.projectId, definitionRevision: createProjectSnapshot(project).definitionRevision, sourceRevision: "1", mappingRevision: "0", baselineRevision: "0", authorizationGeneration, coreBuildId };
  const planInput = { source, stamp, upstream, mapping: remote.mapping, baselineFiles: baseline.files, localFiles, remoteFiles: remote.files, normalizationDiagnostics: remote.diagnostics, otherSourceMappings: [], budget: { maxCompareInputBytes: defaultSyncPolicyValues.maxCompareInputBytes, maxCompareOutputBytes: defaultSyncPolicyValues.maxCompareOutputBytes } };
  const preparedCandidate = await buildSyncCandidate(planInput);
  const before = encodeSyncContent(localFiles), base = encodeSyncContent(baseline.files), afterSource = encodeSyncContent(remote.files);
  const initialState: SyncWorkspaceState = { formatVersion: 1, projectId: location.projectId, sources: [{ source, mapping: baseline.mapping, baselineRevision: "0", baselineContent: base.reference }], candidates: [{ candidate: preparedCandidate, createdAtMs: clock, expiresAtMs: clock + defaultSyncPolicyValues.candidateTtlMs, baselineContent: base.reference, localContent: before.reference, remoteContent: afterSource.reference, mapping: remote.mapping, normalizationDiagnostics: remote.diagnostics }], history: [], operations: [] };
  const initialFiles = new Map([[syncStateFilePath(location), encodeSyncState(initialState)], ...[base, before, afterSource].map(c => [syncContentFilePath(location, c.reference), c.text] as [string, string])]);
  await commitWritePlan(root, { files: initialFiles }, { expectedRevision: saved.revision, deletions: [] });
  const storage: StorageAdapter = { save: fileStorage.save, async load(path) { if (failRefresh) { failRefresh = false; throw new Error("synthetic refresh unavailable"); } const state = await fileStorage.load(path); return { ...state, readOnly: readOnlyMode || state.readOnly }; } };
  let session = createSession({ storage }); await session.open(root);
  const prepared = await prepareNetworkRun({ scope: { canonicalRoot: root, project: { workspaceId: workspace.id, ...location } }, store: { load: async () => ({ revision: "1", configuration: { formatVersion: 1, profiles: [], environmentSelections: [] } }), save: async () => "1" }, secretStore: {} as never, selection: { kind: "direct" } });
  const deps: LocalSyncDependencies = {
    session, now: () => clock, admission: createLocalSyncAdmission(),
    sourceHost: { maxRedirects: 2, captureNetwork: async () => ({ prepared, policyIdentity: "fixture-policy-v1", materialIdentity: "fixture-material-v1", approveDestination: u => u.origin === origin }) },
    acquireMaterial: async () => ({ leaseId: randomUUID(), release: async () => { releaseStarted.resolve(); await releaseGate?.promise; released++; if (releaseFailure) throw new Error("synthetic private release secret"); } }),
    authorize: async () => ({ generation: authorizationGeneration, actor: { id: "owned-editor", name: "Owned editor" } }), readCoreBuildId: async () => coreBuildId,
  };
  let client = await openLocalSync(root, deps);
  const decisions = (candidate = preparedCandidate, decision: "take-source" | "keep-current" = "take-source"): SyncDecisions => ({ formatVersion: 1, candidateDigest: candidate.candidateDigest, entries: candidate.changes.map(c => ({ changeId: c.changeId, decision })) });
  const state = async () => (await loadSyncState(root, location))!;
  const mutateState = async (mutate: (s: SyncWorkspaceState) => void) => { const loaded = await decodeContractWorkspace(root), s = await state(); mutate(s); await commitWritePlan(root, { files: new Map([[syncStateFilePath(location), encodeSyncState(s)]]) }, { expectedRevision: loaded.revision, deletions: [] }); };
  const readProject = () => session.locateProject({ workspaceId: workspace.id, ...location })!.project;
  const unrelatedPath = join(root, `groups/${location.groupId}/projects/${location.projectId}/collections/${id(824)}/collection.yaml`);
  const originalUnrelatedAssetBytes = readFileSync(unrelatedPath);
  const f = {
    root, workspaceContainer, privateRoot, otherRoot, location, source, preparedCandidate, originalUnrelatedAssetBytes, deps, requests, secrets,
    get session() { return session; }, get client() { return client; }, decisions, state, mutateState, readProject,
    newIntent: randomUUID, storageRevision: () => session.revision!, unrelatedAssetBytes: () => readFileSync(unrelatedPath),
    check: (signal?: AbortSignal) => client.check(location, sourceId, signal),
    apply: (candidate = preparedCandidate, choice = decisions(candidate), intentId: string = randomUUID()) => client.apply(location, candidate, choice, intentId),
    rollback: (historyId: string, intentId: string = randomUUID()) => client.rollback(location, historyId, intentId),
    async reopen() { session = createSession({ storage }); await session.open(root); deps.session = session; client = await openLocalSync(root, deps); },
    async applyPreparedChange() { const beforeStorageRevision = session.revision; const view = await f.check(); const receipt = await f.apply(view.candidate); return { ...receipt, beforeStorageRevision }; },
    async editAssets() { const p = readProject(); await session.setProjectGlobals({ workspaceId: workspace.id, ...location }, { ...p.globals, variables: { edited: "yes" } }); },
    expire() { clock += defaultSyncPolicyValues.candidateTtlMs + 1; }, changeAuthorization() { authorizationGeneration = "2"; }, changeCore() { coreBuildId = "b".repeat(64); },
    advanceTime(milliseconds: number) { clock += milliseconds; },
    failNextRefresh() { failRefresh = true; }, failRelease() { releaseFailure = true; }, released: () => released,
    async makeReadOnly() { readOnlyMode = true; await f.reopen(); },
    blockRelease() { releaseGate = deferred(); releaseStarted = deferred(); return { started: releaseStarted.promise, unblock: () => releaseGate?.resolve() }; },
    setWriteFault(fault?: WriteFaultInjector) { deps.writeFault = fault; },
    async remoteFiles(candidateId: string) { const s = await state(); return readSyncContent(root, location, s.candidates.find(c => c.candidate.id === candidateId)!.remoteContent); },
    async seedApplied() {
      const plan = await resolveSyncCandidate({ candidate: preparedCandidate, decisions: decisions(), planInput });
      const files = new Map(localFiles.map(f => [f.path, f.content])); for (const path of plan.deletions) files.delete(path); for (const file of plan.writes) files.set(file.path, file.content);
      const nextFiles = [...files].map(([path, content]) => ({ path, content })), after = encodeSyncContent(nextFiles), baseContent = encodeSyncContent(plan.baselineFiles);
      const afterStamp = { ...stamp, definitionRevision: plan.after.definitionRevision, mappingRevision: "1", baselineRevision: "1" };
      const historyBase = { formatVersion: 1 as const, id: randomUUID(), sourceId, projectId: location.projectId, intentId: randomUUID(), operationKind: "apply" as const, actor: { id: "owned-editor", name: "Owned editor" }, createdAtMs: clock, beforeStamp: stamp, afterStamp, upstream, before: plan.before, after: plan.after, rollback: { beforeContent: before.reference, afterContent: after.reference } };
      const history: SyncHistoryEntry = { ...historyBase, integritySha256: hash(["apicc-local-sync-history-v1", historyBase]) };
      const choice = decisions(), requestDigest = hash(["apicc-local-sync-apply-v1", location.projectId, preparedCandidate.id, preparedCandidate.candidateDigest, { ...choice, entries: [...choice.entries].sort((a,b) => a.changeId.localeCompare(b.changeId)) }]);
      const receiptBase = { formatVersion: 1 as const, operationId: randomUUID(), intentId: history.intentId, kind: "apply" as const, status: "committed" as const, historyId: history.id, sourceId, projectId: location.projectId, afterStamp, actor: history.actor, completedAtMs: clock };
      const receipt: SyncReceipt = { ...receiptBase, integritySha256: hash(["apicc-local-sync-receipt-v1", requestDigest, receiptBase]) };
      const s = await state(); s.sources[0]!.mapping = { ...plan.mapping, revision: "1" }; s.sources[0]!.baselineRevision = "1"; s.sources[0]!.baselineContent = baseContent.reference; s.history.push(history);
      s.operations.push({ requestDigest, receipt });
      const prefix = `groups/${location.groupId}/projects/${location.projectId}/`, writes = new Map(plan.writes.map(f => [prefix + f.path, f.content]));
      for (const content of [after, baseContent]) writes.set(syncContentFilePath(location, content.reference), content.text); writes.set(syncStateFilePath(location), encodeSyncState(s));
      await commitWritePlan(root, { files: writes }, { expectedRevision: (await decodeContractWorkspace(root)).revision, deletions: plan.deletions.map(p => prefix + p) });
      await f.reopen(); return { ...history, receipt };
    },
  };
  return f;
}
