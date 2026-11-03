import { createDebugHistoryOwnerKey, workflowToRunResult, type DebugHistoryReadResult, type RunResult } from '@apicc/core';
import { realpathSync, lstatSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { createSession } from '../session.js';
import type { OnlineSession } from './session.js';
import { projectPublication, type PublicArtifactDto } from '@apicc/core/collaboration';
import { createHash, randomUUID } from 'node:crypto';
import { createMemberCollaborationClient, ExecutionHttpError, CollaborationPreviewInputSchema, CollaborationGrantMetadataSchema, type CollaborationPreview } from '@apicc/execution/client';
import type { DraftWriteContext } from '../session.js';
import type { OnlineExecutionContext, OnlineLocalResult } from '../../shared/online/execution.js';
import { CollaborationInputSchema, COLLABORATION_LOCAL_LIMITS } from '../../shared/online/collaboration.js';
import type { ProjectLocator } from '../../shared/locations.js';
import { readScopedStressRun } from '../runs.js';

export function createCollaborationHost(deps: { session: OnlineSession; localSession: ReturnType<typeof createSession>; fetch?: typeof fetch; readOnlineResult?(owner: object): { context: OnlineExecutionContext; result: OnlineLocalResult } | undefined; readCurrentReport?(owner: object): { context: DraftWriteContext; project: ProjectLocator; report: RunResult; digest: string } | undefined; writeClipboard?(text: string): void | Promise<void>; readDebugHistory(id: string, ownerKey: string): Promise<DebugHistoryReadResult> }) {
  const client = createMemberCollaborationClient(deps);
  type Candidate = { candidateId: string; title: string; artifact: PublicArtifactDto; preview?: CollaborationPreview; publicationIntentId: string;
    context: OnlineExecutionContext; binding: ReturnType<OnlineSession['captureExecution']>; localContext?: DraftWriteContext; generation: number; expiresAt: number; digest: string; readCurrent?: () => Promise<unknown>; attempted?: boolean };
  const candidates = new WeakMap<object, Candidate>();
  const generations = new WeakMap<object, number>();
  type Operation = { intentId: string; context: OnlineExecutionContext; binding: ReturnType<OnlineSession['captureExecution']>; pending?: boolean };
  const grantOperations = new WeakMap<object, Operation>(), publicationOperations = new WeakMap<object, Operation>();
  const grantSecrets = new WeakMap<object, { grants: Map<string, { key?: string; grant: ReturnType<typeof CollaborationGrantMetadataSchema.parse> }>; binding: ReturnType<OnlineSession['captureExecution']>; context: OnlineExecutionContext }>();
  const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const changed = () => new Error('collaboration-source-changed');
  function operationFor(map: WeakMap<object, Operation>, owner: object, context: OnlineExecutionContext) {
    const value = map.get(owner);
    if (!value || JSON.stringify(value.context) !== JSON.stringify(context)) throw new Error('collaboration-operation-unavailable');
    try { value.binding.assertCurrent(); } catch { throw new Error('collaboration-operation-unavailable'); }
    return value;
  }
  async function candidateFor(input: any, owner: object) {
    const candidate = candidates.get(owner);
    if (!candidate || candidate.candidateId !== input.candidateId) throw new Error('collaboration-candidate-unavailable');
    if (Date.now() >= candidate.expiresAt) throw new Error('collaboration-candidate-expired');
    const check = () => {
      if (JSON.stringify(candidate.context) !== JSON.stringify(input.context) || candidate.generation !== generations.get(owner)) throw changed();
      try { candidate.binding.assertCurrent(); if (candidate.localContext) deps.localSession.assertDraftWriteContext(candidate.localContext); } catch { throw changed(); }
    };
    check(); const current = candidate.readCurrent ? await candidate.readCurrent() : undefined; check();
    if (candidate.readCurrent && (!current || fingerprint(current) !== candidate.digest)) throw changed();
    return candidate;
  }
  function clearOwner(owner: object) { generations.set(owner, (generations.get(owner) ?? 0) + 1); candidates.delete(owner); grantSecrets.delete(owner); }
  async function handle(raw: unknown, owner?: object): Promise<any> {
    if (!owner || typeof owner !== 'object') throw new Error('collaboration-candidate-unavailable');
    const parsed = CollaborationInputSchema.safeParse(raw);
    if (!parsed.success) throw new Error('collaboration-invalid-input');
    const input = parsed.data;
    if (input.operation === 'access') return { stage: 'access', access: await client.readAccess(input.context, input.input) };
    if (input.operation === 'history') return { stage: 'history', page: await client.listHistory(input.context, input.input) };
    if (input.operation === 'read-history') return { stage: 'history-body', history: await client.readHistory(input.context, input.input) };
    if (input.operation === 'publications') return { stage: 'publications', page: await client.listPublications(input.context, input.input) };
    if (input.operation === 'grants') {
      const binding = deps.session.captureExecution(input.context), page = await client.listGrants(input.context, input.input);
      grantSecrets.set(owner, { grants: new Map(page.items.map(grant => [grant.id, { grant }])), binding, context: structuredClone(input.context) });
      return { stage: 'grants', page };
    }
    if (input.operation === 'audit') return { stage: 'audit', page: await client.readAudit(input.context, input.input) };
    if (input.operation === 'mock-logs') return { stage: 'mock-logs', page: await client.readMockLogs(input.context, input.input) };
    if (input.operation === 'set-mock') return { stage: 'published', publication: await client.setMockEnabled(input.context, input.input) };
    if (input.operation === 'preview-online') {
      grantSecrets.delete(owner);
      const generation = (generations.get(owner) ?? 0) + 1; generations.set(owner, generation);
      const binding = deps.session.captureExecution(input.context), preview = await client.preview(input.context, input.input);
      if (generations.get(owner) !== generation) throw changed(); binding.assertCurrent();
      const candidateId = randomUUID();
      candidates.set(owner, { candidateId, title: input.input.title, artifact: 'artifact' in preview ? preview.artifact : undefined!, preview, publicationIntentId: randomUUID(), context: structuredClone(input.context), binding, generation, expiresAt: Date.parse(preview.expiresAt), digest: preview.candidateDigest });
      return { stage: 'server', candidateId, preview };
    }
    if (input.operation === 'reconcile-publication') {
      return { stage: 'publication-reconciled', receipt: await client.queryOperation(input.context, { kind: 'publication', intentId: operationFor(publicationOperations, owner, input.context).intentId }) };
    }
    if (input.operation === 'reconcile-grant') {
      const operation = operationFor(grantOperations, owner, input.context);
      const receipt = await client.queryOperation(input.context, { kind: 'grant', intentId: operation.intentId });
      operation.pending = false;
      return { stage: 'grant-reconciled', receipt };
    }
    if (input.operation === 'copy-grant') {
      const secret = grantSecrets.get(owner);
      const selected = secret?.grants.get(input.input.grantId);
      if (!secret || !selected || JSON.stringify(secret.context) !== JSON.stringify(input.context)) throw new Error('collaboration-key-unavailable');
      try { secret.binding.assertCurrent(); } catch { throw new Error('collaboration-key-unavailable'); }
      const { grant, key } = selected;
      if (!key && !grant.memberPath) throw new Error('collaboration-key-unavailable');
      await deps.writeClipboard?.(grant.memberPath ? new URL(grant.memberPath, input.context.serverId).href : grant.purpose === 'call' ? `${grant.baseUrl}\nX-Apicc-Mock-Key: ${key}` : `${grant.publicUrl}#key=${encodeURIComponent(key!)}`);
      return { stage: 'copied' };
    }
    if (input.operation === 'revoke-grant') { await client.revokeGrant(input.context, input.input); grantSecrets.delete(owner); return { stage: 'revoked' }; }
    if (input.operation === 'create-grant' || input.operation === 'rotate-grant') {
      const operationIntent = randomUUID(), binding = deps.session.captureExecution(input.context), generation = generations.get(owner);
      const previous = grantOperations.get(owner);
      if (previous?.pending) {
        let current = true;
        try { previous.binding.assertCurrent(); } catch { current = false; }
        if (current) throw new Error('collaboration-grant-pending');
        grantOperations.delete(owner);
      }
      const operation = { intentId: operationIntent, context: structuredClone(input.context), binding, pending: true };
      grantOperations.set(owner, operation);
      try {
        const result = input.operation === 'create-grant' ? await client.createGrant(input.context, { ...input.input, operationIntent }) : await client.rotateGrant(input.context, { ...input.input, operationIntent });
        const { key, ...metadata } = result, grant = CollaborationGrantMetadataSchema.parse(metadata);
        if (generation !== generations.get(owner)) throw changed();
        operation.pending = false;
        grantSecrets.set(owner, { grants: new Map([[grant.id, { key, grant }]]), binding, context: structuredClone(input.context) });
        return { stage: 'grant', grant, keyAvailable: !!key };
      } catch (error) {
        if (error instanceof ExecutionHttpError && error.status !== 408 && error.status < 500) { operation.pending = false; throw error; }
        if (error instanceof Error && error.message === 'collaboration-source-changed') throw error;
        try { binding.assertCurrent(); } catch { throw changed(); }
        try {
          const receipt = await client.queryOperation(input.context, { kind: 'grant', intentId: operationIntent });
          operation.pending = false;
          return { stage: 'grant-reconciled', receipt };
        } catch { throw new Error('collaboration-grant-pending'); }
      }
    }
    if (input.operation === 'activate') { generations.set(owner, (generations.get(owner) ?? 0) + 1); grantSecrets.delete(owner); return { stage: 'idle' }; }
    if (input.operation === 'cancel-preview') { clearOwner(owner); return { stage: 'idle' }; }
    if (input.operation === 'confirm-upload') {
      const local = await candidateFor(input, owner);
      if (local.preview) throw new Error('collaboration-already-uploaded');
      const body = CollaborationPreviewInputSchema.parse({ title: local.title, includeEvidence: false, source: { kind: 'member-upload', artifact: local.artifact } });
      const preview = await client.preview(input.context, body);
      if (candidates.get(owner) !== local || generations.get(owner) !== local.generation) throw changed();
      try { local.binding.assertCurrent(); if (local.localContext) deps.localSession.assertDraftWriteContext(local.localContext); } catch { throw changed(); }
      const candidateId = randomUUID(); candidates.set(owner, { ...local, candidateId, preview, expiresAt: Date.parse(preview.expiresAt) });
      return { stage: 'server', candidateId, preview };
    }
    if (input.operation === 'confirm-publication') {
      const candidate = await candidateFor(input, owner), preview = candidate.preview!;
      if (!preview) throw new Error('collaboration-server-confirmation-required');
      if (candidate.attempted) throw new Error('collaboration-operation-already-attempted');
      candidate.attempted = true;
      publicationOperations.set(owner, { intentId: candidate.publicationIntentId, context: structuredClone(input.context), binding: candidate.binding });
      try {
        const publication = await client.commitPublication(input.context, { publicationIntentId: candidate.publicationIntentId, previewId: preview.id, candidateDigest: preview.candidateDigest, expectedPolicyRevision: preview.expectedPolicyRevision });
        return { stage: 'published', publication };
      } catch (error) {
        if (error instanceof ExecutionHttpError) throw error;
        const receipt = await client.queryOperation(input.context, { kind: 'publication', intentId: candidate.publicationIntentId });
        return { stage: 'publication-reconciled', receipt };
      }
    }
    if (input.operation !== 'preview-local') return { stage: 'pending' };
    grantSecrets.delete(owner);
    const generation = (generations.get(owner) ?? 0) + 1; generations.set(owner, generation);
    const binding = deps.session.captureExecution(input.context), localContext = input.source.kind === 'online-local' ? undefined : deps.localSession.captureDraftWriteContext();
    const source = input.source;
    const readSource = async () => {
      if (source.kind === 'online-local') {
        const current = deps.readOnlineResult?.(owner);
        if (!current || current.result.runId !== source.runId || JSON.stringify(current.context) !== JSON.stringify(input.context) || current.result.output.kind === 'stress-failure') throw new Error('collaboration-source-unavailable');
        return current.result.output;
      }
      if (source.kind === 'debug') {
        const identity = source.owner.sourceKind === 'free' ? source.owner.project : source.owner.mode === 'request' ? source.owner.locator : source.owner.case;
        if (identity.workspaceId !== source.project.workspaceId || identity.groupId !== source.project.groupId || identity.projectId !== source.project.projectId) throw new Error('collaboration-source-unavailable');
        return (await deps.readDebugHistory(source.historyId, createDebugHistoryOwnerKey(realpathSync(localContext!.root), source.owner))).record;
      }
      if (source.kind === 'current') {
        const current = deps.readCurrentReport?.(owner);
        if (!current || current.digest !== source.expectedReportDigest || current.project.workspaceId !== source.project.workspaceId || current.project.groupId !== source.project.groupId || current.project.projectId !== source.project.projectId) throw new Error('collaboration-source-unavailable');
        try { deps.localSession.assertDraftWriteContext(current.context); } catch { throw new Error('collaboration-source-unavailable'); }
        return current.report;
      }
      const runs = join(realpathSync(localContext!.root), '.apicc', 'runs'), file = join(runs, source.file), maxBytes = COLLABORATION_LOCAL_LIMITS.maxSourceBytes;
      for (const path of [file, `${file}.scope`]) {
        if (dirname(realpathSync(path)) !== runs || lstatSync(path).isSymbolicLink()) throw new Error('collaboration-source-unavailable');
        if (statSync(path).size > maxBytes) throw new Error('collaboration-source-budget-exceeded');
      }
      return readScopedStressRun(localContext!.root, source.project, source.file, { maxBytes });
    };
    const readCurrent = async () => {
      const value = await readSource();
      if (Buffer.byteLength(JSON.stringify(value)) > COLLABORATION_LOCAL_LIMITS.maxSourceBytes) throw new Error('collaboration-source-budget-exceeded');
      return value;
    };
    const value = await readCurrent(), digest = fingerprint(value);
    let report: import('@apicc/core/collaboration').ArchiveReport;
    if (source.kind === 'online-local') {
      const output = value as OnlineLocalResult['output'];
      if (output.kind === 'debug') report = { format: 'debug', body: { formatVersion: 2, historyId: randomUUID(), createdAt: output.result.startedAt, result: output.result } };
      else if (output.kind === 'stress') report = { format: 'stress', body: output.result };
      else if (output.kind === 'workflow') report = { format: 'run', body: workflowToRunResult(output.result) };
      else report = { format: 'run', body: (output as Extract<typeof output, { kind: 'suite' }>).result };
    } else report = source.kind === 'debug' ? { format: 'debug', body: value as import('@apicc/core').DebugHistoryRecord } : source.kind === 'current' ? { format: 'run', body: value as RunResult } : { format: 'stress', body: value as import('@apicc/core').ReadableStressReport };
    const projected = await projectPublication({ sourceKind: 'server-archive', title: input.title, source: { revision: digest, digest }, report, redaction: 'unavailable', privateMarkers: [] },
      { revision: 1, includeEvidence: false, maxFieldBytes: COLLABORATION_LOCAL_LIMITS.maxFieldBytes, maxEvidenceBytes: 8388608, maxArtifactBytes: COLLABORATION_LOCAL_LIMITS.maxArtifactBytes, extraSensitiveHeaders: [], extraSensitiveQuery: [], extraSensitiveFields: [], extraSensitivePointers: [] });
    const artifact: PublicArtifactDto = { ...projected, source: { ...projected.source, trust: 'member-claim' } };
    if (generations.get(owner) !== generation) throw changed();
    try { binding.assertCurrent(); if (localContext) deps.localSession.assertDraftWriteContext(localContext); } catch { throw changed(); }
    const candidateId = randomUUID(), expiresAt = Date.now() + 600000;
    candidates.set(owner, { candidateId, title: artifact.title, artifact, publicationIntentId: randomUUID(), context: structuredClone(input.context), binding, localContext, generation, expiresAt, digest, readCurrent });
    const upload = CollaborationPreviewInputSchema.parse({ title: artifact.title, includeEvidence: false, source: { kind: 'member-upload', artifact } });
    return { stage: 'local', candidateId, artifact, expiresAt: new Date(expiresAt).toISOString(), artifactBytes: Buffer.byteLength(JSON.stringify(artifact)), uploadBytes: Buffer.byteLength(JSON.stringify(upload)), localLimits: COLLABORATION_LOCAL_LIMITS, source: { kind: source.kind === 'online-local' ? 'online-local' : `local-${source.kind}`, location: 'local', selectionCount: 1, project: source.kind === 'online-local' ? input.context.scope : source.project } };
  }
  return { clearOwner, async handle(raw: unknown, owner?: object): Promise<any> {
    try { return await handle(raw, owner); }
    catch (error) {
      if (error instanceof ExecutionHttpError) throw Object.assign(new Error(error.code ?? 'collaboration-request-failed'), { code: error.code, status: error.status });
      if (error instanceof Error && (/^collaboration-[a-z-]+$/.test(error.message) || /^PUBLICATION_[A-Z_]+$/.test(error.message) || ['online-session-changed','execution-requires-https'].includes(error.message))) throw error;
      throw new Error('collaboration-request-failed');
    }
  } };
}
