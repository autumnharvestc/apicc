import { expect, it } from 'vitest';
import { createMemberCollaborationClient, CollaborationPreviewInputSchema } from '../src/client/collaboration.js';
import { safeDocument, safeReport } from '../../core/tests/collaboration/fixtures.js';
import { grantConstraints, previewConstraints } from './helpers/collaboration.js';

const context = { serverId: 'https://control.test/api/v1', ownerId: '7', scope: { workspaceId: '11', groupId: '22', projectId: '33' } };
it.each(['bounded','disabled','observations-missing'] as const)('final I01 strict existing audit feed carries finite %s access observation metadata',async state=>{
  expect((await setup(audit()).client.readAudit(context,{})).collaboration).toHaveLength(1);
  const page={...audit(),accessDetails:{state,retentionMs:state==='disabled'?0:604800000}};
  expect(await setup(page).client.readAudit(context,{})).toMatchObject({accessDetails:page.accessDetails});
});
it.each(['sub-minute', 'both', 'fractional', 'unsafe'] as const)('round1 rejects invalid relative grant %s only after a valid relative command reaches transport', async mutation => {
  const { client, requests } = setup(grant()), command = { publicationId: '41', operationIntent: 'relative-bound', purpose: 'view', audience: 'members', durationMs: 60000, expectedRevision: 3 }; await client.createGrant(context, command as any); expect(requests).toHaveLength(1);
  const bad = { ...command, ...(mutation === 'both' ? { expiresAt: 2000000000000 } : { durationMs: mutation === 'sub-minute' ? 59999 : mutation === 'fractional' ? 60000.5 : Number.MAX_SAFE_INTEGER + 1 }) };
  await expect(client.createGrant(context, bad as any)).rejects.toThrow(); expect(requests).toHaveLength(1);
});
it('round1 transports an explicit server-relative grant duration without converting it to client expiry', async () => {
  const { client, requests } = setup(grant()); await client.createGrant(context, { publicationId: '41', operationIntent: 'relative-1', purpose: 'view', audience: 'members', durationMs: 60000, expectedRevision: 3 } as any);
  expect(requests[0]!.body).toEqual({ operationIntent: 'relative-1', purpose: 'view', audience: 'members', durationMs: 60000, expectedRevision: 3 });
});
const prefix = 'https://control.test/api/v1/workspaces/11/projects/33/collaboration';
const artifact = () => safeDocument();
const memberArtifact = () => { const a = safeReport(); a.source.trust = 'member-claim'; return CollaborationPreviewInputSchema.shape.source.options[4].shape.artifact.parse(a); };
const source = { kind: 'document', revision: '1', digest: 'a'.repeat(64), uploadId: null, jobId: null, uploadedBy: null };
const publication = () => ({ id: '41', version: 2, digest: 'b'.repeat(64), kind: 'document', trust: 'saved-contract', createdBy: '7', createdAt: '2026-11-02T00:00:00.000Z', revision: 3, enabled: true, source, artifact: artifact() });
const preview = (value = artifact()) => ({ id: '40', state: 'pending', candidateDigest: 'b'.repeat(64), expectedPolicyRevision: 2, expiresAt: '2026-11-02T00:10:00.000Z', artifact: value, constraints: previewConstraints() });
const grant = () => ({ id: '42', publicationId: '41', version: 2, purpose: 'view', audience: 'external', responsibleId: '7', responsibilityEpoch: 2, generation: 1, expiresAt: 1793577600000, downloadAllowed: false, revision: 1, state: 'active', operationIntent: 'grant-1', publicId: 'a'.repeat(22), publicUrl: 'https://public.test/s/' + 'a'.repeat(22), key: 's'.repeat(43) });
const policy = () => ({ revision: 0, projectionRevision: 1, settings: [{ valueType: 'boolean', code: 'historyPublishingAllowed', builtin: true, local: null, effective: true, source: 'builtin', unit: 'boolean', effect: 'new-uploads-and-retention' }], identity: { deploymentDigest: 'a'.repeat(64), effectiveDigest: 'b'.repeat(64), lineage: [{ scope: 'project', workspaceId: '11', projectId: '33', revision: 0, projectionRevision: 1 }] }, resources: { recommendations: { cpuVcpu: { value: 1, minimum: 1, maximum: 32, unit: 'vCPU' }, totalMemoryBytes: { value: 1024, minimum: 1, maximum: 2048, unit: 'bytes' }, nodeHeapBytes: { value: 1024, minimum: 1, maximum: 2048, unit: 'bytes' } }, externalLimits: { cpuVcpu: { value: null, status: 'unconfigured', unit: 'vCPU' }, totalMemoryBytes: { value: null, status: 'unconfigured', unit: 'bytes' } }, applicationSettings: { nodeHeapBytes: { value: null, status: 'unconfigured', unit: 'bytes' }, inFlightBytes: { value: null, status: 'unconfigured', unit: 'bytes' }, headroomBytes: { value: null, status: 'unconfigured', unit: 'bytes' } } } });
const history = () => ({ id: '40', source: 'server-report', kind: 'report', trust: 'server-archive', createdBy: '7', createdAt: '2026-11-02T00:00:00.000Z', conclusion: 'unknown', state: 'ended', integrity: 'unavailable', jobId: '40', executionId: '100', agentId: null, creatorId: '7', snapshotId: '5', runtime: { origin: 'unavailable', runtimeCompatibilityId: null, executionProfile: null, policyRevision: null, coreBuildId: null, scriptApiId: null, nodeVersion: null, v8Version: null }, conclusionInfo: { origin: 'legacy-unindexed', reasonCode: 'legacy-unindexed', reason: '旧任务未建立终态索引' } });
const audit = () => ({ access: [{ id: '1', actorId: '7', action: 'member.updated', time: '2026-11-02T00:00:00Z', revision: 2, reason: 'changed', objectKind: 'MEMBER', objectId: '8' }], execution: [{ id: '2', actorId: '7', action: 'asset.change', time: '2026-11-02T00:00:00Z', revision: null, objectKind: 'PROJECT', objectId: '33', agentId: null, locations: null, locationLabel: '未采集', summary: null, summaryLabel: '未采集', beforeRevision: null, afterRevision: null }], collaboration: [{ id: '3', actorId: null, action: 'CREATED', time: '2026-11-02T00:00:00Z', revision: null, reason: null, objectKind: 'ARTIFACT', objectId: '41' }], nextCursor: 'next', scannedCount: 3, pageLimit: 50 });
const logs = () => ({ items: [{ id: '1', publicationId: '41', version: 2, time: '2026-11-02T00:00:00Z', method: 'GET', routeTemplate: '/hello', ruleId: null, status: 503, durationMs: 1, reason: 'RUNTIME_UNAVAILABLE', requestId: null, grantPublicId: 'a'.repeat(22) }], nextCursor: null, scannedCount: 1, pageLimit: 50, discarded: 0, state: 'bounded', integrityLabel: '仅保留有限明细', maxEntries: 100, retentionMs: 1000 });
const access = () => ({ accountEnabled: true, member: true, workspaceRole: 'EDITOR', projectOverride: null, overrideState: 'inherited', effectiveRole: 'EDITOR', capabilities: ['history.read', 'history.publish', 'publication.manage'], accessRevision: 2, membershipEpoch: 1, responsibilityEpoch: 1, reasonCode: null });
function setup(response: unknown, options?: { actor?: string }) {
  const requests: { url: string; method: string; body: unknown; auth: string | null }[] = [];
  const client = createMemberCollaborationClient({ session: { captureExecution: () => ({ serverId: context.serverId, userId: options?.actor ?? '7', token: () => 'synthetic-token', assertCurrent() {} }) }, fetch: async (url, init) => { requests.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: new Headers(init?.headers).get('authorization') }); return response === undefined ? new Response(null, { status: 204 }) : Response.json(response); } });
  return { client, requests };
}
const cases: { name: string; input: unknown; method: string; path: string; response: () => unknown; body?: unknown }[] = [
  { name: 'readPolicy', input: {}, method: 'GET', path: '/policy', response: policy },
  { name: 'listHistory', input: { source: 'server-report', limit: 50, cursor: 'bound', conclusion: 'unknown' }, method: 'GET', path: '/history?source=server-report&limit=50&cursor=bound&conclusion=unknown', response: () => ({ items: [history()], nextCursor: 'next' }) },
  { name: 'readHistory', input: { id: '40', source: 'member-history' }, method: 'GET', path: '/history/40?source=member-history', response: () => ({ id: '40', source: 'member-history', artifact: memberArtifact() }) },
  { name: 'preview', input: { title: 'One selected item', includeEvidence: false, source: { kind: 'member-upload', artifact: memberArtifact() } }, method: 'POST', path: '/previews', response: () => preview(memberArtifact()) },
  { name: 'commitPublication', input: { publicationIntentId: 'publish-1', previewId: '40', candidateDigest: 'b'.repeat(64), expectedPolicyRevision: 2 }, method: 'POST', path: '/publications', response: publication },
  { name: 'queryOperation', input: { kind: 'publication', intentId: 'publish-1' }, method: 'GET', path: '/operations/publish-1', response: () => ({ publicationIntentId: 'publish-1', state: 'committed', publicationId: '41', candidateDigest: 'b'.repeat(64) }) },
  { name: 'queryOperation', input: { kind: 'grant', intentId: 'grant-1' }, method: 'GET', path: '/grant-operations/grant-1', response: () => ({ grantId: '42', command: 'create', revision: 1, generation: 1, keyObtained: false }) },
  { name: 'listPublications', input: { limit: 50 }, method: 'GET', path: '/publications?limit=50', response: () => { const { artifact: _artifact, ...metadata } = publication(); return { items: [{ ...metadata, policyRevision: 2 }], nextCursor: null }; } },
  { name: 'createGrant', input: { publicationId: '41', operationIntent: 'grant-1', purpose: 'view', audience: 'external', downloadAllowed: false, expectedRevision: 3 }, method: 'POST', path: '/publications/41/grants', response: grant },
  { name: 'rotateGrant', input: { grantId: '42', operationIntent: 'rotate-1', expectedRevision: 1 }, method: 'POST', path: '/grants/42/rotate', response: grant },
  { name: 'revokeGrant', input: { grantId: '42', expectedRevision: 1 }, method: 'DELETE', path: '/grants/42', response: () => undefined },
  { name: 'setMockEnabled', input: { publicationId: '41', enabled: false, expectedRevision: 3 }, method: 'POST', path: '/publications/41/disable', response: publication },
  { name: 'readAudit', input: { limit: 50, cursor: 'bound', object: 'PROJECT:33', actor: '7', time: '2026-11-01T00:00:00Z/2026-11-03T00:00:00Z' }, method: 'GET', path: '/audit?limit=50&cursor=bound&object=PROJECT%3A33&actor=7&time=2026-11-01T00%3A00%3A00Z%2F2026-11-03T00%3A00%3A00Z', response: audit },
  { name: 'readMockLogs', input: { publicationId: '41', limit: 50 }, method: 'GET', path: '/publications/41/mock-logs?limit=50', response: logs },
  { name: 'listGrants', input: { publicationId: '41', limit: 50, cursor: 'bound' }, method: 'GET', path: '/publications/41/grants?limit=50&cursor=bound', response: () => { const { key: _key, ...metadata } = grant(); return { items: [metadata], nextCursor: 'next', constraints: grantConstraints() }; } },
];
const sourceCases = [
  { kind: 'document', revision: '1', manifestHash: 'a'.repeat(64), scope: { kind: 'apis', contractIds: ['00000000-0000-4000-8000-000000000001'] } },
  { kind: 'server-report', jobId: '40' }, { kind: 'member-history', uploadId: '40' },
  { kind: 'mock', revision: '1', manifestHash: 'a'.repeat(64), scope: { kind: 'project' } },
] as const;
function sourcePreview(source: typeof sourceCases[number]) {
  if (source.kind === 'mock') return { id: '40', state: 'pending', candidateDigest: 'b'.repeat(64), expectedPolicyRevision: 2, expiresAt: '2026-11-02T00:10:00.000Z', source: { kind: 'mock', revision: '1', digest: 'a'.repeat(64), uploadId: null, jobId: null, uploadedBy: null }, planFingerprint: 'a'.repeat(64), plan: { sourceProjectRevision: 'a'.repeat(64), routes: [] }, constraints: previewConstraints() };
  if (source.kind === 'document') return preview();
  const value = safeReport(); value.source.trust = source.kind === 'server-report' ? 'server-archive' : 'member-claim'; return preview(value);
}
it.each(sourceCases)('previews the exact saved $kind source descriptor', async source => {
  const { client, requests } = setup(sourcePreview(source));
  await client.preview(context, { title: 'Saved source', includeEvidence: false, source: structuredClone(source) as any });
  expect(requests[0]).toMatchObject({ url: prefix + '/previews', method: 'POST', body: { title: 'Saved source', includeEvidence: false, source } });
});
it.each(sourceCases)('refuses raw authority inside saved $kind descriptor', async source => {
  const good = setup(sourcePreview(source)); await good.client.preview(context, { title: 'Saved source', includeEvidence: false, source: structuredClone(source) as any });
  const { client, requests } = setup(sourcePreview(source));
  await expect(client.preview(context, { title: 'Saved source', includeEvidence: false, source: { ...source, path: 'C:/private/project' } as any })).rejects.toThrow(); expect(requests).toHaveLength(0);
});
it('enables Mock through its one existing CAS command', async () => {
  const { client, requests } = setup(publication()); await client.setMockEnabled(context, { publicationId: '41', enabled: true, expectedRevision: 3 });
  expect(requests[0]).toMatchObject({ url: prefix + '/publications/41/enable', method: 'POST', body: { expectedRevision: 3 } });
});

const responseMutations: { name: string; operation: string; response: () => any; input: any; path: (string | number)[]; value?: unknown }[] = [
  ...[['identity'], ['identity', 'lineage', 0], ['resources'], ['resources', 'recommendations'], ['resources', 'recommendations', 'cpuVcpu'], ['resources', 'externalLimits'], ['resources', 'externalLimits', 'cpuVcpu'], ['resources', 'applicationSettings'], ['settings', 0]].map(path => ({ name: `policy nested ${path.join('.')}`, operation: 'readPolicy', response: policy, input: {}, path })),
  { name: 'history row', operation: 'listHistory', response: () => ({ items: [history()], nextCursor: '' }), input: {}, path: ['items', 0] },
  { name: 'history runtime', operation: 'listHistory', response: () => ({ items: [history()], nextCursor: '' }), input: {}, path: ['items', 0, 'runtime'] },
  { name: 'history conclusion proof', operation: 'listHistory', response: () => ({ items: [history()], nextCursor: '' }), input: {}, path: ['items', 0, 'conclusionInfo'] },
  { name: 'preview artifact', operation: 'preview', response: cases[3]!.response, input: cases[3]!.input, path: ['artifact'] },
  { name: 'publication source', operation: 'commitPublication', response: publication, input: cases[4]!.input, path: ['source'] },
  { name: 'publication metadata', operation: 'listPublications', response: cases[7]!.response, input: {}, path: ['items', 0] },
  ...['access', 'execution', 'collaboration'].map(kind => ({ name: `audit ${kind}`, operation: 'readAudit', response: audit, input: {}, path: [kind, 0] })),
  { name: 'mock log', operation: 'readMockLogs', response: logs, input: { publicationId: '41' }, path: ['items', 0] },
  { name: 'numeric entity ID', operation: 'listHistory', response: () => ({ items: [history()], nextCursor: '' }), input: {}, path: ['items', 0, 'id'], value: 40 },
  { name: 'numeric nullable audit ID', operation: 'readAudit', response: audit, input: {}, path: ['execution', 0, 'agentId'], value: 5 },
  { name: 'string revision', operation: 'createGrant', response: grant, input: cases[8]!.input, path: ['revision'], value: '1' },
  { name: 'unknown audience', operation: 'createGrant', response: grant, input: cases[8]!.input, path: ['audience'], value: 'anyone' },
];
it.each(responseMutations)('rejects malformed $name with valid positive response control', async mutation => {
  const good = setup(mutation.response()); await (good.client as any)[mutation.operation](context, mutation.input);
  const bad = structuredClone(mutation.response()); let target = bad;
  for (const key of mutation.path.slice(0, -1)) target = target[key]; const last = mutation.path.at(-1)!;
  if ('value' in mutation) target[last] = mutation.value; else target[last].privateSnapshot = 'synthetic-private';
  const { client } = setup(bad); await expect((client as any)[mutation.operation](context, mutation.input)).rejects.toThrow();
});
it.each([
  { operation: 'commitPublication', input: { ...(cases[4]!.input as object), expectedPolicyRevision: 0 } },
  { operation: 'createGrant', input: { ...(cases[8]!.input as object), expectedRevision: '3' } },
  { operation: 'preview', input: { ...(cases[3]!.input as any), source: { kind: 'member-upload', artifact: { ...memberArtifact(), privateSnapshot: true } } } },
  { operation: 'preview', input: { ...(cases[3]!.input as any), source: { kind: 'member-upload', artifact: { ...memberArtifact(), source: { ...memberArtifact().source, trust: 'server-archive' } } } } },
  { operation: 'queryOperation', input: { kind: 'infer', intentId: 'grant-1' } },
])('rejects malformed $operation command before network', async test => {
  const { client, requests } = setup(test.operation === 'createGrant' ? grant() : test.operation === 'preview' ? preview() : publication());
  await expect((client as any)[test.operation](context, test.input)).rejects.toThrow(); expect(requests).toHaveLength(0);
});
it('accepts a server-supported member report and refuses a document upload before network', async () => {
  const { client, requests } = setup(preview(memberArtifact()));
  await client.preview(context, { title: 'Selected report', includeEvidence: false, source: { kind: 'member-upload', artifact: memberArtifact() } });
  expect(requests).toHaveLength(1);
  const document = artifact(); document.source.trust = 'member-claim';
  await expect(client.preview(context, { title: 'Unsupported document upload', includeEvidence: false, source: { kind: 'member-upload', artifact: document } as any })).rejects.toThrow();
  expect(requests).toHaveLength(1);
});

// Each case catches a wrong route/method or lost finite producer data, not a mocked client method.
it.each(cases)('$name consumes its actual finite member contract at $path', async test => {
  const response = test.response(), { client, requests } = setup(response);
  expect(await (client as any)[test.name](context, test.input)).toEqual(response);
  expect(requests).toEqual([{ url: prefix + test.path, method: test.method, body: test.method === 'GET' ? undefined : test.body ?? Object.fromEntries(Object.entries(test.input as object).filter(([key]) => !['publicationId', 'grantId', 'enabled'].includes(key))), auth: 'Bearer synthetic-token' }]);
});

// Legal positive payload first, then one added unknown property must not cross the strict boundary.
it.each(cases.filter(c => c.response() !== undefined))('$name rejects an unknown response field', async test => {
  const response = test.response(); const good = setup(response); await (good.client as any)[test.name](context, test.input);
  const bad = setup({ ...(response as object), privateSnapshot: 'synthetic-private' });
  await expect((bad.client as any)[test.name](context, test.input)).rejects.toThrow();
});
it.each(cases)('$name rejects unknown request authority before network', async test => {
  const { client, requests } = setup(test.response());
  await expect((client as any)[test.name](context, { ...(test.input as object), url: 'https://other.invalid' })).rejects.toThrow();
  expect(requests).toHaveLength(0);
});
it.each([0, 201, 1.5])('rejects page size %s after a valid single page control', async limit => {
  const { client, requests } = setup({ items: [], nextCursor: 'sparse-next' });
  expect(await client.listHistory(context, { limit: 50 })).toEqual({ items: [], nextCursor: 'sparse-next' });
  await expect(client.listHistory(context, { limit })).rejects.toThrow(); expect(requests).toHaveLength(1);
});
it('rejects capture actor mismatch before sending', async () => {
  const { client, requests } = setup(policy(), { actor: '8' });
  await expect(client.readPolicy(context, {})).rejects.toThrow('online-session-changed'); expect(requests).toHaveLength(0);
});
it.each([{ id: '40' }, { id: 40, source: 'server-report' }])('requires history source and textual ID: %j', async invalid => {
  const { client, requests } = setup({ id: '40', source: 'server-report', artifact: artifact() });
  await client.readHistory(context, { id: '40', source: 'server-report' });
  await expect(client.readHistory(context, invalid as any)).rejects.toThrow(); expect(requests).toHaveLength(1);
});
it('preserves typed historical null IDs and sparse overall audit continuation', async () => {
  const { client } = setup(audit()); expect((await client.readAudit(context, {})).execution[0].agentId).toBeNull();
  const sparse = setup({ access: [], execution: [], collaboration: [], nextCursor: 'sparse', scannedCount: 50, pageLimit: 50 });
  expect((await sparse.client.readAudit(context, {})).nextCursor).toBe('sparse');
});
it('reads current capability authority independently from assets and policy', async () => {
  const { client, requests } = setup(access()); expect(await client.readAccess(context, {})).toEqual(access());
  expect(requests[0]!.url).toBe('https://control.test/api/v1/workspaces/11/projects/33/access');
});
it('accepts the finite sync capabilities in an actual current-access response', async () => {
  const response = { ...access(), effectiveRole: 'ADMIN', capabilities: ['history.read', 'sync.manage', 'sync.check', 'sync.apply'] };
  const { client } = setup(response);
  expect(await client.readAccess(context, {})).toEqual(response);
});
it('refuses unknown capability authority fields', async () => {
  const { client } = setup({ ...access(), privatePolicy: true }); await expect(client.readAccess(context, {})).rejects.toThrow();
});
it('refuses a secret-bearing grant directory row instead of persisting it', async () => {
  const { key: _key, ...metadata } = grant(); const good = setup({ items: [metadata], nextCursor: '', constraints: grantConstraints() });
  expect((await good.client.listGrants(context, { publicationId: '41' })).items[0]!.id).toBe('42');
  const bad = setup({ items: [grant()], nextCursor: '', constraints: grantConstraints() }); await expect(bad.client.listGrants(context, { publicationId: '41' })).rejects.toThrow();
});
it('bounds grant directory page size before network', async () => {
  const { client, requests } = setup({ items: [], nextCursor: '', constraints: grantConstraints() });
  await client.listGrants(context, { publicationId: '41', limit: 50 });
  await expect(client.listGrants(context, { publicationId: '41', limit: 201 })).rejects.toThrow(); expect(requests).toHaveLength(1);
});
it.each(['document','report','mock','grant-directory'])('preserves exact finite constraints for %s without admin-policy data', async kind => {
  const response = kind === 'grant-directory' ? { items: [], nextCursor: '', constraints: grantConstraints() } : kind === 'mock' ? sourcePreview(sourceCases[3]!) : preview(kind === 'report' ? memberArtifact() : artifact());
  const { client } = setup(response); const value = kind === 'grant-directory' ? await client.listGrants(context, { publicationId: '41' }) : await client.preview(context, kind === 'report' ? cases[3]!.input as any : { title: 'Saved', includeEvidence: false, source: sourceCases[kind === 'mock' ? 3 : 0] } as any);
  expect(value.constraints.defaultShareDurationMs).toEqual({ value: 604800000, source: 'builtin' });
  if (kind !== 'grant-directory') expect(value.constraints).toHaveProperty('maxArtifactBytes', { value: 8388608, source: 'builtin' });
});
it.each(['missing','private-root','private-fact','missing-fact','source','value-type','negative','unsafe'])('refuses malformed candidate constraints %s after a valid report control', async mutation => {
  const good = setup(preview(memberArtifact())); await good.client.preview(context, cases[3]!.input as any);
  const bad: any = preview(memberArtifact());
  if (mutation === 'missing') delete bad.constraints;
  if (mutation === 'private-root') bad.constraints.resources = { private: true };
  if (mutation === 'private-fact') bad.constraints.maxArtifactBytes.local = 1;
  if (mutation === 'missing-fact') delete bad.constraints.maxArtifactBytes;
  if (mutation === 'source') bad.constraints.maxArtifactBytes.source = 'server-archive';
  if (mutation === 'value-type') bad.constraints.maxArtifactBytes.value = '8388608';
  if (mutation === 'negative') bad.constraints.maxArtifactBytes.value = -1;
  if (mutation === 'unsafe') bad.constraints.maxArtifactBytes.value = 9007199254740992;
  await expect(setup(bad).client.preview(context, cases[3]!.input as any)).rejects.toThrow();
});
it.each(['missing','private','value-type'])('refuses malformed grant directory constraints %s', async mutation => {
  const response: any = { items: [], nextCursor: '', constraints: grantConstraints() };
  await setup(response).client.listGrants(context, { publicationId: '41' });
  if (mutation === 'missing') delete response.constraints;
  if (mutation === 'private') response.constraints.sensitiveRules = ['private'];
  if (mutation === 'value-type') response.constraints.externalSharingAllowed.value = 'true';
  await expect(setup(response).client.listGrants(context, { publicationId: '41' })).rejects.toThrow();
});
