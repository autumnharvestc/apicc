import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createDebugHistoryOwnerKey } from '@apicc/core';
import { createDesktopDebugHistoryStore } from '../../../src/main/debugHistory.js';
import { createSession } from '../../../src/main/session.js';
import { createOnlineSession } from '../../../src/main/online/session.js';
import { createOnlineClient } from '../../../src/main/online/client.js';
import { createCollaborationHost } from '../../../src/main/online/collaboration.js';
import { IDS, makeWorkspace, persistWorkspace } from '../helpers/contract-assets.js';
import { debugHistory, safeReport, safeDocument, runReport, stressReport } from '../../../../../packages/core/tests/collaboration/fixtures.js';
import { aiReportDigest } from '../../../src/shared/ai/reportDigest.js';
import { writeStressRunScope } from '../../../src/main/runs.js';
import { grantConstraints, previewConstraints } from '../../../../../packages/execution/tests/helpers/collaboration.js';
import { mkdirSync, writeFileSync, appendFileSync, renameSync, symlinkSync } from 'node:fs';
import { createEvidenceBudget } from '@apicc/core';
import { OnlineLocalResultSchema } from '../../../src/shared/online/execution.js';
import { DebugHistoryRecordSchema } from '@apicc/core/schema';
const debugResult = () => DebugHistoryRecordSchema.options[1].parse(debugHistory()).result;
it('final I04 automatic reconciliation cannot borrow replacement-session credentials after an admitted lost POST',async()=>{
  const f=await fixture();try{
    let reject!:(error:Error)=>void;const gate=new Promise<Response>((_,no)=>{reject=no;});
    f.intercept(request=>request.method==='POST'?gate:Response.json({grantId:'42',command:'create',revision:1,generation:1,keyObtained:false}));
    const pending=f.host.handle({operation:'create-grant',context:f.context,input:{publicationId:'41',purpose:'view',audience:'external',expectedRevision:1}},f.owner).catch(error=>error);
    await vi.waitFor(()=>expect(f.requests).toHaveLength(1));await f.online.login({baseUrl:'https://control.test',username:'member',password:'synthetic'});f.online.openWorkspace({workspaceId:'11',name:'Workspace',myRole:'EDITOR'});reject(new TypeError('lost original reply'));
    expect.soft(await pending).toEqual(new Error('collaboration-source-changed'));expect(f.requests.map(row=>row.method)).toEqual(['POST']);
  }finally{f.close();}
});
it.each([504,408])('final I04 HTTP%s response cannot establish that the original grant POST did not commit',async status=>{
  const f=await fixture();try{
    const input={operation:'create-grant',context:f.context,input:{publicationId:'41',purpose:'view',audience:'external',expectedRevision:1}};
    f.intercept(request=>{if(request.method==='POST')return Response.json({code:'synthetic_proxy_timeout',message:'Synthetic uncertain upstream outcome'},{status});throw new TypeError('synthetic reconciliation transport lost');});
    await expect.soft(f.host.handle(input,f.owner)).rejects.toThrow('collaboration-grant-pending');
    await expect.soft(f.host.handle(input,f.owner)).rejects.toThrow('collaboration-grant-pending');
    expect.soft(f.requests.map(row=>row.method)).toEqual(['POST','GET']);const intent=f.requests[0]!.body.operationIntent;
    f.intercept(()=>Response.json({grantId:'42',command:'create',revision:1,generation:1,keyObtained:false}));
    expect((await f.host.handle({operation:'reconcile-grant',context:f.context},f.owner)).stage).toBe('grant-reconciled');expect(f.requests.at(-1)!.url).toContain('/grant-operations/'+intent);
  }finally{f.close();}
});
it.each(['create','rotate'] as const)('final I04 %s retains the original pending intent after POST and automatic GET both lose transport',async command=>{
  const f=await fixture();try{
    const input=command==='create'?{operation:'create-grant',context:f.context,input:{publicationId:'41',purpose:'view',audience:'external',expectedRevision:1}}:{operation:'rotate-grant',context:f.context,input:{grantId:'42',expectedRevision:1}};
    f.intercept(()=>{throw new TypeError('synthetic lost transport');});
    await expect.soft(f.host.handle(input,f.owner)).rejects.toThrow('collaboration-grant-pending');
    expect(f.requests.map(row=>row.method)).toEqual(['POST','GET']);const intent=f.requests[0]!.body.operationIntent;expect(f.requests[1]!.url).toContain(intent);
    await expect.soft(f.host.handle(input,f.owner)).rejects.toThrow('collaboration-grant-pending');expect.soft(f.requests).toHaveLength(2);
    f.intercept(()=>Response.json({grantId:'42',command,revision:2,generation:2,keyObtained:false}));
    expect(await f.host.handle({operation:'reconcile-grant',context:f.context},f.owner)).toMatchObject({stage:'grant-reconciled',receipt:{grantId:'42',keyObtained:false}});
    expect.soft(f.requests.at(-1)!.url).toContain('/grant-operations/'+intent);expect(f.requests.filter(row=>row.method==='POST')).toHaveLength(1);expect(f.copied).toEqual([]);
  }finally{f.close();}
});
it.each(['create','rotate'] as const)('final I04 rejects concurrent %s before a second transport admission',async command=>{
  const f=await fixture();try{
    let release!:(value:Response)=>void;const gate=new Promise<Response>(resolve=>{release=resolve;});
    f.intercept(()=>gate);const input=command==='create'?{operation:'create-grant',context:f.context,input:{publicationId:'41',purpose:'view',audience:'external',expectedRevision:1}}:{operation:'rotate-grant',context:f.context,input:{grantId:'42',expectedRevision:1}};
    const pending=f.host.handle(input,f.owner);await vi.waitFor(()=>expect(f.requests).toHaveLength(1));
    const duplicate=f.host.handle(input,f.owner).catch(error=>error);await Promise.resolve();
    release(Response.json(hostGrant(f.requests[0]!.body.operationIntent)));
    expect.soft(await duplicate).toEqual(new Error('collaboration-grant-pending'));expect.soft((await pending).stage).toBe('grant');expect(f.requests).toHaveLength(1);
  }finally{f.close();}
});
it('final I04 replacement session cannot reconcile an old pending operation but can explicitly create its own',async()=>{
  const f=await fixture();try{
    const input={operation:'create-grant',context:f.context,input:{publicationId:'41',purpose:'view',audience:'external',expectedRevision:1}};
    f.intercept(()=>{throw new TypeError('synthetic lost transport');});await expect(f.host.handle(input,f.owner)).rejects.toThrow('collaboration-grant-pending');const oldIntent=f.requests[0]!.body.operationIntent;
    await f.online.login({baseUrl:'https://control.test',username:'member',password:'synthetic'});f.online.openWorkspace({workspaceId:'11',name:'Workspace',myRole:'EDITOR'});
    const count=f.requests.length;await expect(f.host.handle({operation:'reconcile-grant',context:f.context},f.owner)).rejects.toThrow('collaboration-operation-unavailable');expect(f.requests).toHaveLength(count);
    f.intercept(request=>Response.json(hostGrant(request.body.operationIntent)));expect((await f.host.handle(input,f.owner)).stage).toBe('grant');expect(f.requests.at(-1)!.body.operationIntent).not.toBe(oldIntent);
  }finally{f.close();}
});
it('final I02 selected history retains post-script failure without manufacturing failed request rows',async()=>{
  const f=await fixture();try{
    const raw=debugResult();raw.outcomes=[];raw.run={...raw.run,total:1,passed:1,failed:0};raw.failureKind='script';raw.error='Selected post-script failed';
    const ownerKey=createDebugHistoryOwnerKey(realpathSync(f.root),f.input.source.owner),selected=(await f.history.append(raw,{ownerKey}))!;
    expect(selected.result).toMatchObject({failureKind:'script',run:{passed:1,failed:0}});
    const result=await f.host.handle({...f.input,source:{...f.input.source,historyId:selected.historyId}},f.owner);
    expect.soft(result).toMatchObject({stage:'local',artifact:{kind:'debug-history',report:{verdict:'failed',nodes:[],counts:[{total:1,passed:1,failed:0},{labelCode:'http.exchanges'}],failures:[{category:'script',count:1}]}}});
    expect.soft(result.artifact.summary).toContainEqual({labelCode:'report.failure',value:'Selected post-script failed'});expect(f.requests).toHaveLength(0);expect(f.readIds).toEqual([selected.historyId]);
  }finally{f.close();}
});
it.each(['sub-minute', 'both'] as const)('round1 refuses caller relative duration %s before another grant write after a legal relative create', async mutation => {
  const f = await fixture(); try { f.intercept(request => request.url.endsWith('/publications/41/grants') ? Response.json(hostGrant(request.body.operationIntent)) : undefined);
    const input = { publicationId: '41', purpose: 'view', audience: 'external', expectedRevision: 1, durationMs: 60000 }; expect((await f.host.handle({ operation: 'create-grant', context: f.context, input }, f.owner)).stage).toBe('grant'); expect(f.requests[0]!.body).toMatchObject({ durationMs: 60000 }); const count = f.requests.length;
    await expect(f.host.handle({ operation: 'create-grant', context: f.context, input: { ...input, ...(mutation === 'both' ? { expiresAt: 2000000000000 } : { durationMs: 59999 }) } }, f.owner)).rejects.toThrow('collaboration-invalid-input'); expect(f.requests).toHaveLength(count);
  } finally { f.close(); }
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'apicc-collab-host-')), session = createSession();
  await persistWorkspace(root, makeWorkspace()); await session.open(root);
  const project = { workspaceId: IDS.workspace, groupId: IDS.groupTwo, projectId: IDS.projectTwo };
  const debugOwner = { sourceKind: 'free' as const, project, draftId: '40000000-0000-4000-8000-000000000009' };
  const context = { serverId: 'https://control.test/api/v1', ownerId: '7', scope: { workspaceId: '11', groupId: '22', projectId: '33' } };
  const history = createDesktopDebugHistoryStore({ privateRoot: join(root, 'private-history') });
  const key = createDebugHistoryOwnerKey(realpathSync(root), debugOwner);
  const record = (await history.append(debugResult(), { ownerKey: key }))!;
  const requests: { url: string; method: string; body: any }[] = []; const copied: string[] = []; let serverArtifact: any; let loginUser = '7';
  let interceptor: ((request: { url: string; method: string; body: any }) => Response | undefined | Promise<Response | undefined>) | undefined;
  const transport: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/auth/login')) return Response.json({ token: 'synthetic-token', expiresAt: '2027-01-01T00:00:00Z', user: { id: loginUser, username: 'member', displayName: 'Member' } });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url: String(url), method: init?.method ?? 'GET', body });
    const intercepted = await interceptor?.(requests.at(-1)!); if (intercepted) return intercepted;
    if (String(url).endsWith('/previews')) { serverArtifact = body.source.artifact; return Response.json({ id: '40', state: 'pending', candidateDigest: 'b'.repeat(64), expectedPolicyRevision: 2, expiresAt: '2099-11-02T00:10:00.000Z', artifact: serverArtifact, constraints: previewConstraints() }, { status: 201 }); }
    if (String(url).endsWith('/publications')) return Response.json({ id: '41', version: 1, digest: 'b'.repeat(64), kind: 'debug-history', trust: 'member-claim', createdBy: '7', createdAt: '2026-11-02T00:00:00Z', revision: 1, enabled: true, source: { kind: 'member-upload', revision: serverArtifact.source.revision, digest: serverArtifact.source.digest, uploadId: '12', uploadedBy: '7', jobId: null }, artifact: serverArtifact }, { status: 201 });
    return Response.json({ code: 'unexpected_test_route', message: 'unexpected route' }, { status: 400 });
  };
  const online = createOnlineSession({ createClient: (baseUrl, hooks) => createOnlineClient({ baseUrl, fetch: transport, onUnauthorized: hooks.onUnauthorized }), tokenStore: { save() {}, load() { return null; }, clear() {} } });
  await online.login({ baseUrl: 'https://control.test', username: 'member', password: 'synthetic' }); online.openWorkspace({ workspaceId: '11', name: 'Workspace', myRole: 'EDITOR' });
  let reads = 0; const readIds: string[] = [];
  let readGate: { entered(): void; wait: Promise<void> } | undefined;
  const owner = {};
  const nativeReport = runReport(), reportDigest = await aiReportDigest(nativeReport);
  const currentReport = { context: session.captureDraftWriteContext(), project: structuredClone(project), report: nativeReport, digest: reportDigest };
  const onlineResult = { context: structuredClone(context), result: OnlineLocalResultSchema.parse({ location: { kind: 'local' }, runId: '40000000-0000-4000-8000-000000000019', snapshotId: '66', manifestHash: 'a'.repeat(64), runtimeCompatibilityId: 'compatible', scriptTimeoutMs: 3000, output: { kind: 'suite', result: nativeReport } }) };
  const host = createCollaborationHost({ session: online, localSession: session, fetch: transport, readOnlineResult: (sender: object) => sender === owner ? onlineResult : undefined, readCurrentReport: (sender: object) => sender === owner ? currentReport : undefined, writeClipboard: (text: string) => { copied.push(text); }, readDebugHistory: async (id: string, ownerKey: string) => { reads++; readIds.push(id); const gate = readGate; readGate = undefined; if (gate) { gate.entered(); await gate.wait; } return history.getOwned(id, ownerKey); } });
  const input = { operation: 'preview-local' as const, context, title: 'Selected debug', source: { kind: 'debug' as const, historyId: record.historyId, owner: debugOwner, project } };
  return { root, session, online, host, history, owner, context, input, requests, copied, reportDigest, currentReport, onlineResult, readIds, get reads() { return reads; },
    blockNextRead() { let entered!: () => void, release!: () => void; const reached = new Promise<void>(r => { entered = r; }); const wait = new Promise<void>(r => { release = r; }); readGate = { entered, wait }; return { reached, release }; },
    intercept(handler: NonNullable<typeof interceptor>) { interceptor = handler; }, setUser(id: string) { loginUser = id; }, close() { rmSync(root, { recursive: true, force: true }); } };
}

// I1: dropping the evidence structure must not lose known header values echoed in diagnostics.
it('round1 masks selected owned header echoes before local preview and actual confirmed upload', async () => {
  const f = await fixture(), cookie = 'syntheticCookieEchoRound1', auth = 'syntheticAuthorizationEchoRound1';
  try {
    const raw = debugResult(), ownerKey = createDebugHistoryOwnerKey(realpathSync(f.root), f.input.source.owner);
    raw.source = { ...f.input.source.owner, draftRevision: 'r1' }; raw.outcomes[0]!.caseName = `Public case ${cookie}`; raw.outcomes[0]!.error = `Public failure ${auth}`;
    raw.outcomes[0]!.evidence!.request!.headers.text = `Cookie: sid=${cookie}\nAuthorization: ${auth}`;
    const selected = (await f.history.append(raw, { ownerKey }))!, other = (await f.history.append(debugResult(), { ownerKey }))!;
    const input = { ...f.input, source: { ...f.input.source, historyId: selected.historyId } };
    const preview = await f.host.handle(input, f.owner);
    expect(preview).toMatchObject({ stage: 'local', artifact: { source: { trust: 'member-claim' }, report: { evidence: [], counts: [{ labelCode: 'case.rows', total: 1, failed: 1 }, { labelCode: 'http.exchanges', total: 1 }], failures: [{ category: 'http', count: 1 }] } } });
    expect(f.requests).toHaveLength(0); expect(f.readIds).toEqual([selected.historyId]);
    const before = JSON.stringify(preview); expect.soft(before).not.toContain(cookie); expect.soft(before).not.toContain(auth);
    await f.host.handle({ operation: 'confirm-upload', context: f.context, candidateId: preview.candidateId }, f.owner);
    expect(f.requests).toHaveLength(1); expect(f.readIds).toEqual([selected.historyId, selected.historyId]); expect(f.readIds).not.toContain(other.historyId);
    const sent = JSON.stringify(f.requests[0]!.body); expect.soft(sent).not.toContain(cookie); expect.soft(sent).not.toContain(auth); expect(f.requests[0]!.body.source.artifact.report.evidence).toEqual([]);
  } finally { f.close(); }
});

it.each(['root', 'input', 'missing'])('rejects unknown independent Mock command authority at %s after a legal state update', async level => {
  const f = await fixture();
  try {
    f.intercept(() => Response.json({ id: '41', version: 1, digest: 'b'.repeat(64), kind: 'mock', trust: 'saved-contract', createdBy: '7', createdAt: '2026-11-02T00:00:00Z', revision: 4, enabled: true, source: { kind: 'mock', revision: '12', digest: 'c'.repeat(64), uploadId: null, jobId: null, uploadedBy: null }, plan: { sourceProjectRevision: 'c'.repeat(64), routes: [] }, planFingerprint: 'd'.repeat(64) }));
    const input = { publicationId: '41', enabled: true, expectedRevision: 3 }; expect((await f.host.handle({ operation: 'set-mock', context: f.context, input }, f.owner)).stage).toBe('published');
    const count = f.requests.length; await expect(f.host.handle({ operation: 'set-mock', context: f.context, ...(level === 'missing' ? {} : { input: level === 'input' ? { ...input, url: 'https://caller.test' } : input }), ...(level === 'root' ? { url: 'https://caller.test' } : {}) }, f.owner)).rejects.toThrow('collaboration-invalid-input'); expect(f.requests).toHaveLength(count);
  } finally { f.close(); }
});

it.each(['local', 'online'])('clears a previously created transient key when a new %s preview is selected', async kind => {
  const f = await fixture();
  try {
    f.intercept(r => r.url.endsWith('/publications/41/grants') ? Response.json(hostGrant(r.body.operationIntent)) : r.url.endsWith('/previews') && r.body.source.kind !== 'member-upload' ? Response.json({ id: '40', state: 'pending', candidateDigest: 'b'.repeat(64), expectedPolicyRevision: 2, expiresAt: '2099-11-02T00:10:00Z', artifact: safeDocument(), constraints: previewConstraints() }) : undefined);
    expect((await f.host.handle({ operation: 'create-grant', context: f.context, input: { publicationId: '41', purpose: 'view', audience: 'external', expectedRevision: 1 } }, f.owner)).stage).toBe('grant');
    expect((await f.host.handle({ operation: 'copy-grant', context: f.context, input: { grantId: '42' } }, f.owner)).stage).toBe('copied');
    const result = await f.host.handle(kind === 'local' ? f.input : { operation: 'preview-online', context: f.context, input: { title: 'Saved', includeEvidence: false, source: { kind: 'document', revision: '12', manifestHash: 'c'.repeat(64), scope: { kind: 'project' } } } }, f.owner);
    expect(result.stage).toBe(kind === 'local' ? 'local' : 'server');
    await expect(f.host.handle({ operation: 'copy-grant', context: f.context, input: { grantId: '42' } }, f.owner)).rejects.toThrow('collaboration-key-unavailable'); expect(f.copied).toHaveLength(1);
  } finally { f.close(); }
});
it.each([['reconcile-grant', 'input'], ['reconcile-publication', 'input'], ['reconcile-grant', 'root'], ['reconcile-publication', 'root']])('rejects unknown %s fields at %s after its real saved operation is readable', async (operation, level) => {
  const f = await fixture();
  try {
    if (operation === 'reconcile-grant') {
      f.intercept(r => r.method === 'POST' ? Response.json(hostGrant(r.body.operationIntent)) : Response.json({ grantId: '42', command: 'create', revision: 1, generation: 1, keyObtained: false }));
      await f.host.handle({ operation: 'create-grant', context: f.context, input: { publicationId: '41', purpose: 'view', audience: 'external', expectedRevision: 1 } }, f.owner);
    } else {
      const local = await f.host.handle(f.input, f.owner), server = await f.host.handle({ operation: 'confirm-upload', context: f.context, candidateId: local.candidateId }, f.owner); await f.host.handle({ operation: 'confirm-publication', context: f.context, candidateId: server.candidateId }, f.owner);
      f.intercept(() => Response.json({ publicationIntentId: 'saved', state: 'committed', publicationId: '41', candidateDigest: 'b'.repeat(64) }));
    }
    expect((await f.host.handle({ operation, context: f.context }, f.owner)).stage).toBe(operation === 'reconcile-grant' ? 'grant-reconciled' : 'publication-reconciled'); const count = f.requests.length;
    await expect(f.host.handle({ operation, context: f.context, ...(level === 'input' ? { input: { intentId: 'caller-authority' } } : { intentId: 'caller-authority' }) }, f.owner)).rejects.toThrow('collaboration-invalid-input'); expect(f.requests).toHaveLength(count);
  } finally { f.close(); }
});

// Catches previewing one local record uploading it implicitly or reading another record.
it('opens only the selected owned local record without any upload, private cookie, or unselected read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'apicc-collaboration-')), session = createSession();
  const uploads: unknown[] = []; let unselectedReads = 0;
  const project = { workspaceId: IDS.workspace, groupId: IDS.groupTwo, projectId: IDS.projectTwo };
  const owner = { sourceKind: 'free' as const, project, draftId: '40000000-0000-4000-8000-000000000009' };
  const context = { serverId: 'https://control.test/api/v1', ownerId: '7', scope: { workspaceId: '11', groupId: '22', projectId: '33' } };
  const transport: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/auth/login')) return Response.json({ token: 'synthetic-member-token', expiresAt: '2027-01-01T00:00:00Z', user: { id: '7', username: 'member', displayName: 'Member' } });
    uploads.push(JSON.parse(String(init?.body ?? '{}')));
    return Response.json({});
  };
  const online = createOnlineSession({ createClient: (baseUrl, hooks) => createOnlineClient({ baseUrl, fetch: transport, onUnauthorized: hooks.onUnauthorized }), tokenStore: { save() {}, load() { return null; }, clear() {} } });
  try {
    await persistWorkspace(root, makeWorkspace()); await session.open(root);
    const history = createDesktopDebugHistoryStore({ privateRoot: join(root, 'private-history') });
    const key = createDebugHistoryOwnerKey(realpathSync(root), owner);
    const selected = debugResult(); selected.outcomes[0]!.evidence!.request!.headers!.text = 'Cookie: synthetic-private-cookie';
    const selectedId = (await history.append(selected, { ownerKey: key }))!.historyId;
    const nonSelectedId = (await history.append(debugResult(), { ownerKey: key }))!.historyId;
    await online.login({ baseUrl: 'https://control.test', username: 'member', password: 'synthetic' });
    online.openWorkspace({ workspaceId: '11', name: 'Workspace', myRole: 'EDITOR' });
    const host = createCollaborationHost({ session: online, localSession: session, fetch: transport,
      readDebugHistory: (id: string, ownerKey: string) => { if (id === nonSelectedId) unselectedReads++; return history.getOwned(id, ownerKey); } });
    const preview = await host.handle({ operation: 'preview-local', context, title: 'Selected debug result', source: { kind: 'debug', historyId: selectedId, owner, project } }, {});
    const previewText = JSON.stringify(preview);
    expect(uploads).toHaveLength(0);
    expect(unselectedReads).toBe(0);
    expect(previewText).not.toContain('synthetic-private-cookie');
    expect(preview).toMatchObject({ stage: 'local', artifact: { source: { trust: 'member-claim' }, report: { verdict: 'failed' } } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.each(['url', 'path', 'artifact', 'actor'])('refuses renderer-owned %s authority before reading a local source', async field => {
  const f = await fixture();
  try {
    const local = await f.host.handle(f.input, f.owner); expect(local.artifact.kind).toBe('debug-history'); const reads = f.reads;
    await expect(f.host.handle({ ...f.input, [field]: field === 'artifact' ? { private: true } : 'renderer-authority' }, f.owner)).rejects.toThrow('collaboration-invalid-input');
    expect(f.reads).toBe(reads); expect(f.requests).toHaveLength(0);
  } finally { f.close(); }
});
it('refuses hidden source payload authority before reading selected history', async () => {
  const f = await fixture();
  try {
    await f.host.handle(f.input, f.owner); const reads = f.reads;
    await expect(f.host.handle({ ...f.input, source: { ...f.input.source, artifact: { private: true } } }, f.owner)).rejects.toThrow('collaboration-invalid-input'); expect(f.reads).toBe(reads);
  } finally { f.close(); }
});
it('requires a real IPC owner before any selected-source read', async () => {
  const f = await fixture();
  try {
    await expect(f.host.handle(f.input, undefined as any)).rejects.toThrow('collaboration-candidate-unavailable'); expect(f.reads).toBe(0); expect(f.requests).toHaveLength(0);
  } finally { f.close(); }
});
it.each(['new-selection', 'cancel', 'window-close'])('does not restore an in-flight preview after %s invalidation', async change => {
  const f = await fixture();
  try {
    const gate = f.blockNextRead(), old = f.host.handle(f.input, f.owner).then(value => ({ value }), error => ({ error })); await gate.reached;
    let next: any;
    if (change === 'new-selection') next = await f.host.handle(f.input, f.owner);
    if (change === 'cancel') await f.host.handle({ operation: 'cancel-preview', context: f.context }, f.owner);
    if (change === 'window-close') f.host.clearOwner(f.owner);
    gate.release(); expect(await old).toMatchObject({ error: new Error('collaboration-source-changed') }); expect(f.requests).toHaveLength(0);
    if (next) expect(await f.host.handle({ operation: 'confirm-upload', context: f.context, candidateId: next.candidateId }, f.owner)).toMatchObject({ stage: 'server' });
  } finally { f.close(); }
});

// Every refusal below first reaches a valid owned preview, then changes exactly the target binding.
it.each(['relogin', 'actor', 'server', 'workspace', 'project', 'local-source'])('refuses the old candidate after current %s binding changes', async change => {
  const f = await fixture();
  try {
    const local = await f.host.handle(f.input, f.owner); expect(local.artifact.kind).toBe('debug-history');
    let context = structuredClone(f.context);
    if (change === 'local-source') await f.session.open(f.root);
    else if (change === 'project') { context.scope.projectId = '34'; await f.host.handle({ operation: 'activate', context }, f.owner); }
    else if (change === 'workspace') { context.scope.workspaceId = '12'; f.online.openWorkspace({ workspaceId: '12', name: 'Other workspace', myRole: 'EDITOR' }); }
    else {
      if (change === 'actor') { f.setUser('8'); context.ownerId = '8'; }
      if (change === 'server') {
        context.serverId = 'https://other.test/api/v1';
        f.online.closeWorkspace(context.scope.workspaceId);
      }
      await f.online.login({ baseUrl: change === 'server' ? 'https://other.test' : 'https://control.test', username: 'member', password: 'synthetic' });
      f.online.openWorkspace({ workspaceId: '11', name: 'Workspace', myRole: 'EDITOR' });
    }
    await expect(f.host.handle({ operation: 'confirm-upload', context, candidateId: local.candidateId }, f.owner)).rejects.toThrow('collaboration-source-changed');
    expect(f.requests).toHaveLength(0);
  } finally { f.close(); }
});
it.each(['reselected', 'unknown', 'other-window', 'cancelled', 'expired'])('refuses a %s candidate with no network', async change => {
  const f = await fixture();
  try {
    const local = await f.host.handle(f.input, f.owner); expect(local.artifact.kind).toBe('debug-history');
    let candidateId = local.candidateId, owner = f.owner;
    if (change === 'reselected') { const next = await f.host.handle(f.input, f.owner); expect(next.candidateId).not.toBe(local.candidateId); }
    if (change === 'unknown') candidateId = '40000000-0000-4000-8000-000000000099';
    if (change === 'other-window') owner = {};
    if (change === 'cancelled') await f.host.handle({ operation: 'cancel-preview', context: f.context }, f.owner);
    if (change === 'expired') { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 600001); }
    await expect(f.host.handle({ operation: 'confirm-upload', context: f.context, candidateId }, owner)).rejects.toThrow(change === 'expired' ? 'collaboration-candidate-expired' : 'collaboration-candidate-unavailable');
    expect(f.requests).toHaveLength(0);
  } finally { vi.useRealTimers(); f.close(); }
});
it('refuses a removed selected record after preview without uploading its cached content', async () => {
  const f = await fixture();
  try {
    const local = await f.host.handle(f.input, f.owner); expect(local.artifact.kind).toBe('debug-history');
    await f.history.delete(f.input.source.historyId);
    await expect(f.host.handle({ operation: 'confirm-upload', context: f.context, candidateId: local.candidateId }, f.owner)).rejects.toThrow('collaboration-source-changed'); expect(f.requests).toHaveLength(0);
  } finally { f.close(); }
});
it('refuses the valid owned record under a different local project selection', async () => {
  const f = await fixture();
  try {
    const local = await f.host.handle(f.input, f.owner); expect(local.artifact.kind).toBe('debug-history');
    const source = { ...f.input.source, project: { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne } };
    await expect(f.host.handle({ ...f.input, source }, f.owner)).rejects.toThrow('collaboration-source-unavailable'); expect(f.requests).toHaveLength(0);
  } finally { f.close(); }
});

// Catches accepting an upload before the explicit action or replacing server candidate bytes on commit.
it('uploads only the locally confirmed selected safe item then separately confirms the server candidate', async () => {
  const f = await fixture();
  try {
    const local = await f.host.handle(f.input, f.owner); expect(f.requests).toHaveLength(0);
    const server = await f.host.handle({ operation: 'confirm-upload', context: f.context, candidateId: local.candidateId }, f.owner);
    expect(server).toMatchObject({ stage: 'server', preview: { id: '40', artifact: { kind: 'debug-history', source: { trust: 'member-claim' } } } });
    expect(f.requests).toHaveLength(1); expect(f.requests[0]).toMatchObject({ method: 'POST', url: 'https://control.test/api/v1/workspaces/11/projects/33/collaboration/previews', body: { title: 'Selected debug', includeEvidence: false, source: { kind: 'member-upload' } } });
    expect(JSON.stringify(f.requests[0]!.body)).not.toContain('private-debug-run');
    const published = await f.host.handle({ operation: 'confirm-publication', context: f.context, candidateId: server.candidateId }, f.owner);
    expect(published).toMatchObject({ stage: 'published', publication: { id: '41', version: 1 } });
    expect(f.requests[1]!.body).toEqual({ publicationIntentId: expect.any(String), previewId: '40', candidateDigest: 'b'.repeat(64), expectedPolicyRevision: 2 });
    expect(f.requests[1]!.body).not.toHaveProperty('artifact');
  } finally { f.close(); }
});

const accessView = { accountEnabled: true, member: true, workspaceRole: 'EDITOR', projectOverride: null, overrideState: 'inherited', effectiveRole: 'EDITOR', capabilities: ['history.read','history.publish','publication.manage'], accessRevision: 1, membershipEpoch: 1, responsibilityEpoch: 1, reasonCode: null };
const readCases = [
  { operation: 'access', input: {}, route: '/access', stage: 'access', key: 'access', value: accessView },
  { operation: 'history', input: { source: 'member-history', limit: 50 }, route: '/collaboration/history?source=member-history&limit=50', stage: 'history', key: 'page', value: { items: [], nextCursor: 'sparse-next' } },
  { operation: 'publications', input: { limit: 50 }, route: '/collaboration/publications?limit=50', stage: 'publications', key: 'page', value: { items: [], nextCursor: '' } },
  { operation: 'grants', input: { publicationId: '41', limit: 50 }, route: '/collaboration/publications/41/grants?limit=50', stage: 'grants', key: 'page', value: { items: [], nextCursor: '', constraints: grantConstraints() } },
  { operation: 'audit', input: { limit: 50 }, route: '/collaboration/audit?limit=50', stage: 'audit', key: 'page', value: { access: [], execution: [], collaboration: [], nextCursor: 'sparse-next', scannedCount: 50, pageLimit: 50 } },
  { operation: 'mock-logs', input: { publicationId: '41', limit: 50 }, route: '/collaboration/publications/41/mock-logs?limit=50', stage: 'mock-logs', key: 'page', value: { items: [], nextCursor: '', scannedCount: 0, pageLimit: 50, discarded: 0, state: 'observations-missing', integrityLabel: '本服务启动以来发生观测缺失，可能涉及本版本', maxEntries: 200, retentionMs: 86400000 } },
  { operation: 'read-history', input: { id: '40', source: 'member-history' }, route: '/collaboration/history/40?source=member-history', stage: 'history-body', key: 'history', value: { id: '40', source: 'member-history', artifact: { ...safeReport(), source: { ...safeReport().source, trust: 'member-claim' } } } },
];
it.each(readCases)('uses the current controlled member binding for $operation without policy-admin initialization', async test => {
  const f = await fixture();
  try {
    f.intercept(request => request.method === 'GET' ? Response.json(test.value) : undefined);
    expect(await f.host.handle({ operation: test.operation, context: f.context, input: test.input }, f.owner)).toEqual({ stage: test.stage, [test.key]: test.value });
    expect(f.requests).toEqual([{ url: 'https://control.test/api/v1/workspaces/11/projects/33' + test.route, method: 'GET', body: undefined }]);
  } finally { f.close(); }
});
it.each(readCases)('refuses renderer URL authority on the $operation IPC envelope', async test => {
  const f = await fixture();
  try {
    f.intercept(() => Response.json(test.value));
    await expect(f.host.handle({ operation: test.operation, context: f.context, input: test.input, url: 'https://renderer.invalid' }, f.owner)).rejects.toThrow('collaboration-invalid-input'); expect(f.requests).toHaveLength(0);
  } finally { f.close(); }
});

it('reconciles an uncertain publication response through its own operation without resubmitting bytes', async () => {
  const f = await fixture();
  try {
    const local = await f.host.handle(f.input, f.owner), server = await f.host.handle({ operation: 'confirm-upload', context: f.context, candidateId: local.candidateId }, f.owner);
    let intent = '';
    f.intercept(request => {
      if (request.method === 'POST' && request.url.endsWith('/publications')) { intent = request.body.publicationIntentId; throw new TypeError('synthetic-response-lost'); }
      if (request.url.endsWith('/operations/' + intent)) return Response.json({ publicationIntentId: intent, state: 'committed', publicationId: '41', candidateDigest: 'b'.repeat(64) });
    });
    const result = await f.host.handle({ operation: 'confirm-publication', context: f.context, candidateId: server.candidateId }, f.owner);
    expect(result).toMatchObject({ stage: 'publication-reconciled', receipt: { publicationId: '41', state: 'committed' } });
    expect(f.requests.filter(request => request.method === 'POST' && request.url.endsWith('/publications'))).toHaveLength(1);
    expect(f.requests.at(-1)!.url).toBe('https://control.test/api/v1/workspaces/11/projects/33/collaboration/operations/' + intent);
  } finally { f.close(); }
});
it('preserves a definite publication conflict with no operation query or automatic replay', async () => {
  const f = await fixture();
  try {
    const local = await f.host.handle(f.input, f.owner), server = await f.host.handle({ operation: 'confirm-upload', context: f.context, candidateId: local.candidateId }, f.owner);
    f.intercept(request => request.url.endsWith('/publications') ? Response.json({ code: 'publication_revision_conflict', message: 'synthetic-private-upstream-message' }, { status: 409 }) : undefined);
    const error = await f.host.handle({ operation: 'confirm-publication', context: f.context, candidateId: server.candidateId }, f.owner).catch(error => error);
    expect(error).toMatchObject({ status: 409, code: 'publication_revision_conflict' });
    expect(String(error)).toContain('publication_revision_conflict'); expect(String(error)).not.toContain('synthetic-private-upstream-message');
    expect(f.requests.filter(request => request.url.includes('/operations/'))).toHaveLength(0);
  } finally { f.close(); }
});
it('does not expose native private-source paths when an already selected workspace disappears', async () => {
  const f = await fixture();
  try {
    expect((await f.host.handle(f.input, f.owner)).artifact.kind).toBe('debug-history'); f.close();
    const error = await f.host.handle(f.input, f.owner).catch(error => error);
    expect(error.message).toBe('collaboration-request-failed'); expect(String(error)).not.toContain(f.root);
  } finally { f.close(); }
});
it('uses the Core-projected title and exact single-item byte counts in the upload preview', async () => {
  const f = await fixture();
  try {
    const local = await f.host.handle({ ...f.input, title: 'Result C:\\Users\\owner\\private.key' }, f.owner);
    expect(local.artifact.title).not.toContain('private.key');
    await f.host.handle({ operation: 'confirm-upload', context: f.context, candidateId: local.candidateId }, f.owner);
    expect(JSON.stringify(f.requests[0]!.body)).not.toContain('private.key');
    expect(local.uploadBytes).toBe(Buffer.byteLength(JSON.stringify(f.requests[0]!.body)));
    expect(local.artifactBytes).toBe(Buffer.byteLength(JSON.stringify(local.artifact)));
    expect(local.source).toEqual({ kind: 'local-debug', location: 'local', selectionCount: 1, project: f.input.source.project });
    expect(local.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  } finally { f.close(); }
});
it('reports actual selected upload bytes and bounded local expiry without exposing its native root', async () => {
  const f = await fixture();
  try {
    const local = await f.host.handle(f.input, f.owner);
    await f.host.handle({ operation: 'confirm-upload', context: f.context, candidateId: local.candidateId }, f.owner);
    expect.soft(local.uploadBytes).toBe(Buffer.byteLength(JSON.stringify(f.requests[0]!.body)));
    expect.soft(local.artifactBytes).toBe(Buffer.byteLength(JSON.stringify(local.artifact)));
    expect.soft(local.source).toEqual({ kind: 'local-debug', location: 'local', selectionCount: 1, project: f.input.source.project });
    expect.soft(typeof local.expiresAt).toBe('string'); expect.soft(Date.parse(local.expiresAt) - Date.now()).toBeGreaterThan(590000);
    expect(JSON.stringify(local)).not.toContain(f.root);
  } finally { f.close(); }
});

it.each(['cancel', 'selection', 'close'])('does not resurrect a server candidate after upload-time %s', async change => {
  const f = await fixture(); let release!: () => void, reached!: () => void;
  const wait = new Promise<void>(r => { release = r; }), entered = new Promise<void>(r => { reached = r; });
  try {
    const local = await f.host.handle(f.input, f.owner);
    f.intercept(async request => { if (!request.url.endsWith('/previews')) return undefined; reached(); await wait; return undefined; });
    const pending = f.host.handle({ operation: 'confirm-upload', context: f.context, candidateId: local.candidateId }, f.owner).then(value => ({ value }), error => ({ error })); await entered;
    if (change === 'cancel') await f.host.handle({ operation: 'cancel-preview', context: f.context }, f.owner);
    if (change === 'selection') await f.host.handle(f.input, f.owner);
    if (change === 'close') f.host.clearOwner(f.owner);
    release(); expect(await pending).toMatchObject({ error: new Error('collaboration-source-changed') });
    expect(f.requests).toHaveLength(1);
  } finally { release(); f.close(); }
});
it('never repeats a confirmed publication write and reconciles its saved intent after source removal', async () => {
  const f = await fixture();
  try {
    const local = await f.host.handle(f.input, f.owner), server = await f.host.handle({ operation: 'confirm-upload', context: f.context, candidateId: local.candidateId }, f.owner);
    const first = await f.host.handle({ operation: 'confirm-publication', context: f.context, candidateId: server.candidateId }, f.owner); expect(first.stage).toBe('published');
    await expect(f.host.handle({ operation: 'confirm-publication', context: f.context, candidateId: server.candidateId }, f.owner)).rejects.toThrow('collaboration-operation-already-attempted');
    expect(f.requests.filter(r => r.method === 'POST' && r.url.endsWith('/publications'))).toHaveLength(1);
    const intent = f.requests.at(-1)!.body.publicationIntentId; await f.history.delete(f.input.source.historyId);
    f.intercept(request => request.url.endsWith('/operations/' + intent) ? Response.json({ publicationIntentId: intent, state: 'committed', publicationId: '41', candidateDigest: 'b'.repeat(64) }) : undefined);
    expect(await f.host.handle({ operation: 'reconcile-publication', context: f.context }, f.owner)).toMatchObject({ stage: 'publication-reconciled', receipt: { publicationId: '41' } });
  } finally { f.close(); }
});
const hostGrant = (operationIntent: string, generation = 1) => ({ id: '42', publicationId: '41', version: 1, purpose: 'view', audience: 'external', responsibleId: '7', responsibilityEpoch: 2, generation, expiresAt: 2000000000000, downloadAllowed: false, revision: generation, state: 'active', operationIntent, publicId: 'a'.repeat(22), publicUrl: 'https://public.test/s/' + 'a'.repeat(22), key: 's'.repeat(43) });
it('creates finite grant metadata and copies its one-time secret only on explicit action', async () => {
  const f = await fixture();
  try {
    f.intercept(r => r.method === 'POST' && r.url.endsWith('/publications/41/grants') ? Response.json(hostGrant(r.body.operationIntent), { status: 201 }) : undefined);
    const result = await f.host.handle({ operation: 'create-grant', context: f.context, input: { publicationId: '41', purpose: 'view', audience: 'external', expectedRevision: 1 } }, f.owner);
    expect(result).toMatchObject({ stage: 'grant', grant: { id: '42', revision: 1 }, keyAvailable: true });
    expect(JSON.stringify(result)).not.toContain('s'.repeat(43)); expect(f.copied).toEqual([]);
    expect(f.requests[0]!.body.operationIntent).toMatch(/^[0-9a-f-]{36}$/);
    expect(await f.host.handle({ operation: 'copy-grant', context: f.context, input: { grantId: '42' } }, f.owner)).toEqual({ stage: 'copied' });
    expect(f.copied).toEqual(['https://public.test/s/' + 'a'.repeat(22) + '#key=' + 's'.repeat(43)]);
  } finally { f.close(); }
});
it.each(['create', 'rotate'])('reconciles a lost grant %s through grant-operation without replay or recovering a secret', async command => {
  const f = await fixture(); let intent = '';
  try {
    f.intercept(r => { if (r.method === 'POST') { intent = r.body.operationIntent; throw new TypeError('response lost'); } if (r.url.endsWith('/grant-operations/' + intent)) return Response.json({ grantId: '42', command, revision: 2, generation: 2, keyObtained: false }); });
    const input = command === 'create' ? { publicationId: '41', purpose: 'view', audience: 'external', expectedRevision: 1 } : { grantId: '42', expectedRevision: 1 };
    expect(await f.host.handle({ operation: command + '-grant', context: f.context, input }, f.owner)).toMatchObject({ stage: 'grant-reconciled', receipt: { grantId: '42', keyObtained: false } });
    expect(f.requests.map(r => r.method)).toEqual(['POST', 'GET']); expect(f.requests[1]!.url).toContain('/grant-operations/'); expect(f.copied).toEqual([]);
  } finally { f.close(); }
});
it.each(['window', 'session', 'cancel', 'selection', 'unknown'])('refuses transient grant copy after %s changes', async change => {
  const f = await fixture();
  try {
    f.intercept(r => r.method === 'POST' ? Response.json(hostGrant(r.body.operationIntent), { status: 201 }) : undefined);
    expect((await f.host.handle({ operation: 'create-grant', context: f.context, input: { publicationId: '41', purpose: 'view', audience: 'external', expectedRevision: 1 } }, f.owner)).stage).toBe('grant');
    if (change === 'session') { await f.online.login({ baseUrl: 'https://control.test', username: 'member', password: 'synthetic' }); f.online.openWorkspace({ workspaceId: '11', name: 'Workspace', myRole: 'EDITOR' }); }
    if (change === 'cancel') await f.host.handle({ operation: 'cancel-preview', context: f.context }, f.owner);
    if (change === 'selection') await f.host.handle({ operation: 'activate', context: f.context }, f.owner);
    await expect(f.host.handle({ operation: 'copy-grant', context: f.context, input: { grantId: change === 'unknown' ? '99' : '42' } }, change === 'window' ? {} : f.owner)).rejects.toThrow('collaboration-key-unavailable');
    expect(f.copied).toEqual([]); expect(f.requests).toHaveLength(1);
  } finally { f.close(); }
});
it.each(['operationIntent', 'key', 'url', 'unexpected'])('refuses renderer grant %s authority with a valid grant prerequisite', async field => {
  const f = await fixture(); const input = { publicationId: '41', purpose: 'view', audience: 'external', expectedRevision: 1 };
  try {
    f.intercept(r => r.method === 'POST' ? Response.json(hostGrant(r.body.operationIntent), { status: 201 }) : undefined);
    expect((await f.host.handle({ operation: 'create-grant', context: f.context, input }, f.owner)).stage).toBe('grant');
    await expect(f.host.handle({ operation: 'create-grant', context: f.context, input: { ...input, [field]: 'renderer' } }, f.owner)).rejects.toThrow('collaboration-invalid-input'); expect(f.requests).toHaveLength(1);
  } finally { f.close(); }
});
it('revokes a recovered grant by its actual revision while preview disposal never revokes it', async () => {
  const f = await fixture();
  try {
    f.intercept(r => r.method === 'DELETE' && r.url.endsWith('/grants/42') ? new Response(null, { status: 204 }) : undefined);
    expect(await f.host.handle({ operation: 'revoke-grant', context: f.context, input: { grantId: '42', expectedRevision: 3 } }, f.owner)).toEqual({ stage: 'revoked' });
    expect(f.requests[0]).toMatchObject({ method: 'DELETE', body: { expectedRevision: 3 } });
    await f.host.handle({ operation: 'cancel-preview', context: f.context }, f.owner); f.host.clearOwner(f.owner); expect(f.requests).toHaveLength(1);
  } finally { f.close(); }
});
it.each(['current', 'stress'])('projects the single attributable local %s report without networking', async kind => {
  const f = await fixture();
  try {
    const file = 'selected-stress.json'; mkdirSync(join(f.root, '.apicc', 'runs'), { recursive: true });
    const report = stressReport(); report.projectId = f.input.source.project.projectId;
    writeFileSync(join(f.root, '.apicc', 'runs', file), JSON.stringify(report)); writeStressRunScope(f.root, file, f.input.source.project);
    const source = kind === 'current' ? { kind, project: f.input.source.project, expectedReportDigest: f.reportDigest } : { kind, project: f.input.source.project, file };
    const local = await f.host.handle({ ...f.input, source }, f.owner);
    expect(local).toMatchObject({ stage: 'local', artifact: { kind: 'report', source: { trust: 'member-claim' } }, source: { kind: 'local-' + kind, selectionCount: 1 } });
    expect(f.requests).toEqual([]); expect(f.reads).toBe(0); expect(JSON.stringify(local)).not.toContain('KNOWN-RUN-MARKER');
  } finally { f.close(); }
});
it.each(['document', 'server-report', 'member-history'])('previews an explicitly selected online %s without a renderer candidate body', async kind => {
  const f = await fixture();
  try {
    const source = kind === 'document' ? { kind, revision: '12', manifestHash: 'c'.repeat(64), scope: { kind: 'project' } } : kind === 'server-report' ? { kind, jobId: '50' } : { kind, uploadId: '12' };
    const artifact = kind === 'document' ? safeDocument() : safeReport(); artifact.source.trust = kind === 'document' ? 'saved-contract' : kind === 'server-report' ? 'server-archive' : 'member-claim';
    f.intercept(r => r.url.endsWith('/previews') ? Response.json({ id: '40', state: 'pending', candidateDigest: 'b'.repeat(64), expectedPolicyRevision: 2, expiresAt: '2099-11-02T00:10:00Z', artifact, constraints: previewConstraints() }, { status: 201 }) : undefined);
    const result = await f.host.handle({ operation: 'preview-online', context: f.context, input: { title: 'Saved selection', includeEvidence: false, source } }, f.owner);
    expect(result).toMatchObject({ stage: 'server', candidateId: expect.any(String), preview: { id: '40' } });
    expect(f.requests).toHaveLength(1); expect(f.requests[0]!.body.source).toEqual(source); expect(f.reads).toBe(0);
  } finally { f.close(); }
});
it('keeps the saved online candidate for explicit confirmation with no local record read', async () => {
  const f = await fixture(); const artifact = safeDocument(); artifact.source.trust = 'saved-contract';
  try {
    f.intercept(r => r.url.endsWith('/previews') ? Response.json({ id: '40', state: 'pending', candidateDigest: 'b'.repeat(64), expectedPolicyRevision: 2, expiresAt: '2099-11-02T00:10:00Z', artifact, constraints: previewConstraints() }, { status: 201 }) : r.url.endsWith('/publications') ? Response.json({ id: '41', version: 1, digest: 'b'.repeat(64), kind: 'document', trust: 'saved-contract', createdBy: '7', createdAt: '2026-11-02T00:00:00Z', revision: 1, enabled: true, source: { kind: 'document', revision: '12', digest: 'c'.repeat(64), uploadId: null, jobId: null, uploadedBy: null }, artifact }, { status: 201 }) : undefined);
    const server = await f.host.handle({ operation: 'preview-online', context: f.context, input: { title: 'Saved', includeEvidence: false, source: { kind: 'document', revision: '12', manifestHash: 'c'.repeat(64), scope: { kind: 'project' } } } }, f.owner);
    expect((await f.host.handle({ operation: 'confirm-publication', context: f.context, candidateId: server.candidateId }, f.owner)).stage).toBe('published'); expect(f.reads).toBe(0);
  } finally { f.close(); }
});
it.each(['artifact', 'url', 'unsaved'])('refuses online preview %s authority after a valid saved-source preview', async field => {
  const f = await fixture(); const input = { title: 'Saved', includeEvidence: false, source: { kind: 'server-report', jobId: '50' } };
  try {
    f.intercept(r => r.url.endsWith('/previews') ? Response.json({ id: '40', state: 'pending', candidateDigest: 'b'.repeat(64), expectedPolicyRevision: 2, expiresAt: '2099-11-02T00:10:00Z', artifact: safeReport(), constraints: previewConstraints() }, { status: 201 }) : undefined);
    expect((await f.host.handle({ operation: 'preview-online', context: f.context, input }, f.owner)).stage).toBe('server');
    await expect(f.host.handle({ operation: 'preview-online', context: f.context, input: { ...input, [field]: field === 'artifact' ? safeReport() : 'caller-owned' } }, f.owner)).rejects.toThrow('collaboration-invalid-input'); expect(f.requests).toHaveLength(1);
  } finally { f.close(); }
});
it('does not restore an online source while its preview response is in flight', async () => {
  const f = await fixture(); let reached!: () => void, release!: () => void;
  const entered = new Promise<void>(r => { reached = r; }), wait = new Promise<void>(r => { release = r; });
  try {
    f.intercept(async r => { if (r.url.endsWith('/previews')) { reached(); await wait; return Response.json({ id: '40', state: 'pending', candidateDigest: 'b'.repeat(64), expectedPolicyRevision: 2, expiresAt: '2099-11-02T00:10:00Z', artifact: safeReport(), constraints: previewConstraints() }); } });
    const pending = f.host.handle({ operation: 'preview-online', context: f.context, input: { title: 'Saved', includeEvidence: false, source: { kind: 'server-report', jobId: '50' } } }, f.owner).then(value => ({ value }), error => ({ error })); await entered;
    await f.host.handle({ operation: 'activate', context: f.context }, f.owner); release(); expect(await pending).toMatchObject({ error: new Error('collaboration-source-changed') });
  } finally { release(); f.close(); }
});
it('never accepts a renderer-supplied member artifact through the online-source bridge', async () => {
  const f = await fixture();
  try {
    expect((await f.host.handle(f.input, f.owner)).stage).toBe('local');
    await expect(f.host.handle({ operation: 'preview-online', context: f.context, input: { title: 'Caller artifact', includeEvidence: false, source: { kind: 'member-upload', artifact: { ...safeReport(), source: { ...safeReport().source, trust: 'member-claim' } } } } }, f.owner)).rejects.toThrow('collaboration-invalid-input'); expect(f.requests).toEqual([]);
  } finally { f.close(); }
});
it('does not restore transient grant keys from a late create response after source activation', async () => {
  const f = await fixture(); let reached!: () => void, release!: () => void;
  const entered = new Promise<void>(r => { reached = r; }), wait = new Promise<void>(r => { release = r; });
  try {
    f.intercept(async r => { if (r.method === 'POST') { reached(); await wait; return Response.json(hostGrant(r.body.operationIntent), { status: 201 }); } });
    const pending = f.host.handle({ operation: 'create-grant', context: f.context, input: { publicationId: '41', purpose: 'view', audience: 'external', expectedRevision: 1 } }, f.owner).then(value => ({ value }), error => ({ error })); await entered;
    await f.host.handle({ operation: 'activate', context: f.context }, f.owner); release(); expect(await pending).toMatchObject({ error: new Error('collaboration-source-changed') });
    await expect(f.host.handle({ operation: 'copy-grant', context: f.context, input: { grantId: '42' } }, f.owner)).rejects.toThrow('collaboration-key-unavailable');
  } finally { release(); f.close(); }
});
it('copies a recovered members-view locator without a transferable key', async () => {
  const f = await fixture();
  try {
    const { publicId, publicUrl, key, ...base } = hostGrant('existing'); const grant = { ...base, audience: 'members', memberPath: '/api/v1/workspaces/11/projects/33/collaboration/publications/41' };
    f.intercept(r => r.method === 'GET' ? Response.json({ items: [grant], nextCursor: null, constraints: grantConstraints() }) : undefined);
    expect((await f.host.handle({ operation: 'grants', context: f.context, input: { publicationId: '41' } }, f.owner)).page.items[0].audience).toBe('members');
    expect(await f.host.handle({ operation: 'copy-grant', context: f.context, input: { grantId: '42' } }, f.owner)).toEqual({ stage: 'copied' });
    expect(f.copied).toEqual(['https://control.test/api/v1/workspaces/11/projects/33/collaboration/publications/41']);
  } finally { f.close(); }
});
it('copies Mock access as base URL and dedicated header, never as a proxy or query key', async () => {
  const f = await fixture();
  try {
    f.intercept(r => { const { publicUrl, ...grant } = hostGrant(r.body.operationIntent); return Response.json({ ...grant, purpose: 'call', audience: 'members', baseUrl: 'https://public.test/mock/' + 'a'.repeat(22) }, { status: 201 }); });
    expect((await f.host.handle({ operation: 'create-grant', context: f.context, input: { publicationId: '41', purpose: 'call', audience: 'members', expectedRevision: 1 } }, f.owner)).stage).toBe('grant');
    expect(await f.host.handle({ operation: 'copy-grant', context: f.context, input: { grantId: '42' } }, f.owner)).toEqual({ stage: 'copied' });
    expect(f.copied).toEqual(['https://public.test/mock/' + 'a'.repeat(22) + '\nX-Apicc-Mock-Key: ' + 's'.repeat(43)]);
  } finally { f.close(); }
});
it('uses a saved grant operation for explicit reconciliation without retrying its write', async () => {
  const f = await fixture(); let intent = '';
  try {
    f.intercept(r => { if (r.method === 'POST') { intent = r.body.operationIntent; return Response.json(hostGrant(intent), { status: 201 }); } return Response.json({ grantId: '42', command: 'create', revision: 1, generation: 1, keyObtained: false }); });
    expect((await f.host.handle({ operation: 'create-grant', context: f.context, input: { publicationId: '41', purpose: 'view', audience: 'external', expectedRevision: 1 } }, f.owner)).stage).toBe('grant');
    expect(await f.host.handle({ operation: 'reconcile-grant', context: f.context }, f.owner)).toMatchObject({ stage: 'grant-reconciled', receipt: { grantId: '42', keyObtained: false } });
    expect(f.requests.map(r => r.method)).toEqual(['POST', 'GET']); expect(f.requests[1]!.url).toContain('/grant-operations/' + intent);
  } finally { f.close(); }
});
it('does not send any request when publication confirmation skips the local upload stage', async () => {
  const f = await fixture();
  try {
    const local = await f.host.handle(f.input, f.owner);
    await expect(f.host.handle({ operation: 'confirm-publication', context: f.context, candidateId: local.candidateId }, f.owner)).rejects.toThrow('collaboration-server-confirmation-required');
    expect(f.requests).toEqual([]);
  } finally { f.close(); }
});
it('uses server preview expiry rather than the longer local preview budget', async () => {
  const f = await fixture();
  try {
    const local = await f.host.handle(f.input, f.owner);
    f.intercept(r => r.url.endsWith('/previews') ? Response.json({ id: '40', state: 'pending', candidateDigest: 'b'.repeat(64), expectedPolicyRevision: 2, expiresAt: new Date(Date.now() + 1000).toISOString(), artifact: r.body.source.artifact, constraints: previewConstraints() }) : r.url.endsWith('/publications') ? Response.json({ id: '41', version: 1, digest: 'b'.repeat(64), kind: 'debug-history', trust: 'member-claim', createdBy: '7', createdAt: '2026-11-02T00:00:00Z', revision: 1, enabled: true, source: { kind: 'member-upload', revision: local.artifact.source.revision, digest: local.artifact.source.digest, uploadId: '12', uploadedBy: '7', jobId: null }, artifact: local.artifact }) : undefined);
    const server = await f.host.handle({ operation: 'confirm-upload', context: f.context, candidateId: local.candidateId }, f.owner);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 1001);
    await expect(f.host.handle({ operation: 'confirm-publication', context: f.context, candidateId: server.candidateId }, f.owner)).rejects.toThrow('collaboration-candidate-expired'); expect(f.requests).toHaveLength(1);
  } finally { vi.useRealTimers(); f.close(); }
});
it('reconciles an attempted publication after local cancellation without keeping its local content', async () => {
  const f = await fixture(); let intent = '';
  try {
    const local = await f.host.handle(f.input, f.owner), server = await f.host.handle({ operation: 'confirm-upload', context: f.context, candidateId: local.candidateId }, f.owner);
    f.intercept(r => { if (r.method === 'POST') { intent = r.body.publicationIntentId; throw new TypeError('lost'); } return Response.json({ publicationIntentId: intent, state: 'committed', publicationId: '41', candidateDigest: 'b'.repeat(64) }); });
    expect((await f.host.handle({ operation: 'confirm-publication', context: f.context, candidateId: server.candidateId }, f.owner)).stage).toBe('publication-reconciled');
    await f.host.handle({ operation: 'cancel-preview', context: f.context }, f.owner); await f.history.delete(f.input.source.historyId); const reads = f.reads;
    expect(await f.host.handle({ operation: 'reconcile-publication', context: f.context }, f.owner)).toMatchObject({ stage: 'publication-reconciled', receipt: { publicationId: '41' } }); expect(f.reads).toBe(reads);
  } finally { f.close(); }
});
it.each(['grant', 'publication'])('refuses saved %s reconciliation in a different project before a request', async kind => {
  const f = await fixture();
  try {
    if (kind === 'grant') { f.intercept(r => Response.json(hostGrant(r.body.operationIntent), { status: 201 })); expect((await f.host.handle({ operation: 'create-grant', context: f.context, input: { publicationId: '41', purpose: 'view', audience: 'external', expectedRevision: 1 } }, f.owner)).stage).toBe('grant'); }
    else { const local = await f.host.handle(f.input, f.owner), server = await f.host.handle({ operation: 'confirm-upload', context: f.context, candidateId: local.candidateId }, f.owner); expect((await f.host.handle({ operation: 'confirm-publication', context: f.context, candidateId: server.candidateId }, f.owner)).stage).toBe('published'); }
    const count = f.requests.length; const context = { ...f.context, scope: { ...f.context.scope, projectId: '34' } };
    f.intercept(() => kind === 'grant' ? Response.json({ grantId: '42', command: 'create', revision: 1, generation: 1, keyObtained: false }) : Response.json({ publicationIntentId: 'old', state: 'committed', publicationId: '41', candidateDigest: 'b'.repeat(64) }));
    await expect(f.host.handle({ operation: 'reconcile-' + kind, context }, f.owner)).rejects.toThrow('collaboration-operation-unavailable'); expect(f.requests).toHaveLength(count);
  } finally { f.close(); }
});
it('refuses saved grant reconciliation after relogin despite the same textual account', async () => {
  const f = await fixture();
  try {
    f.intercept(r => r.method === 'POST' ? Response.json(hostGrant(r.body.operationIntent)) : Response.json({ grantId: '42', command: 'create', revision: 1, generation: 1, keyObtained: false }));
    expect((await f.host.handle({ operation: 'create-grant', context: f.context, input: { publicationId: '41', purpose: 'view', audience: 'external', expectedRevision: 1 } }, f.owner)).stage).toBe('grant');
    await f.online.login({ baseUrl: 'https://control.test', username: 'member', password: 'synthetic' }); f.online.openWorkspace({ workspaceId: '11', name: 'Workspace', myRole: 'EDITOR' });
    await expect(f.host.handle({ operation: 'reconcile-grant', context: f.context }, f.owner)).rejects.toThrow('collaboration-operation-unavailable'); expect(f.requests).toHaveLength(1);
  } finally { f.close(); }
});
it.each(['project', 'digest', 'generation', 'window'])('refuses a current-result %s mismatch after a real attributable positive', async change => {
  const f = await fixture(); const source = { kind: 'current', project: f.input.source.project, expectedReportDigest: f.reportDigest };
  try {
    expect((await f.host.handle({ ...f.input, source }, f.owner)).stage).toBe('local');
    if (change === 'project') f.currentReport.project.projectId = IDS.projectOne;
    if (change === 'digest') source.expectedReportDigest = 'e'.repeat(64);
    if (change === 'generation') await f.session.open(f.root);
    await expect(f.host.handle({ ...f.input, source }, change === 'window' ? {} : f.owner)).rejects.toThrow('collaboration-source-unavailable'); expect(f.requests).toEqual([]);
  } finally { f.close(); }
});
it.each(['junction', 'report-bytes', 'scope-bytes'])('refuses unsafe stress %s after a valid actual owned single report', async change => {
  const f = await fixture();
  try {
    const runs = join(f.root, '.apicc', 'runs'), file = 'selected-stress.json', path = join(runs, file); mkdirSync(runs, { recursive: true });
    const report = stressReport(); report.projectId = f.input.source.project.projectId; writeFileSync(path, JSON.stringify(report)); writeStressRunScope(f.root, file, f.input.source.project);
    const input = { ...f.input, source: { kind: 'stress', project: f.input.source.project, file } }; expect((await f.host.handle(input, f.owner)).stage).toBe('local');
    if (change === 'junction') { const moved = join(f.root, 'moved-runs'); renameSync(runs, moved); symlinkSync(moved, runs, 'junction'); }
    if (change === 'report-bytes') { appendFileSync(path, ' '.repeat(64 * 1024 * 1024)); writeStressRunScope(f.root, file, f.input.source.project); }
    if (change === 'scope-bytes') appendFileSync(path + '.scope', ' '.repeat(64 * 1024 * 1024));
    await expect(f.host.handle(input, f.owner)).rejects.toThrow(change === 'junction' ? 'collaboration-source-unavailable' : 'collaboration-source-budget-exceeded'); expect(f.requests).toEqual([]);
  } finally { f.close(); }
});
it('projects an online-project local execution by opaque runId without any network or local history read', async () => {
  const f = await fixture();
  try {
    const result = await f.host.handle({ operation: 'preview-local', context: f.context, title: 'Selected local execution', source: { kind: 'online-local', runId: f.onlineResult.result.runId } }, f.owner);
    expect(result).toMatchObject({ stage: 'local', artifact: { kind: 'report', source: { trust: 'member-claim' } }, source: { kind: 'online-local', location: 'local', selectionCount: 1, project: f.context.scope } }); expect(f.requests).toEqual([]); expect(f.reads).toBe(0);
  } finally { f.close(); }
});
it.each(['run', 'context', 'window', 'failure'])('refuses an online-local %s mismatch after a real typed positive', async change => {
  const f = await fixture(), input = { operation: 'preview-local', context: f.context, title: 'One local result', source: { kind: 'online-local', runId: f.onlineResult.result.runId } };
  try {
    expect((await f.host.handle(input, f.owner)).stage).toBe('local');
    if (change === 'run') input.source.runId = '40000000-0000-4000-8000-000000000099';
    if (change === 'context') f.onlineResult.context.scope.projectId = '34';
    if (change === 'failure') f.onlineResult.result.output = { kind: 'stress-failure', error: 'not-started', started: false, requests: { started: 0, completed: 0 } };
    await expect(f.host.handle(input, change === 'window' ? {} : f.owner)).rejects.toThrow('collaboration-source-unavailable'); expect(f.requests).toEqual([]);
  } finally { f.close(); }
});
it('bounds current-result source bytes before projection with a legal unchanged source identity', async () => {
  const f = await fixture(), input = { ...f.input, source: { kind: 'current', project: f.input.source.project, expectedReportDigest: f.reportDigest } };
  try {
    expect((await f.host.handle(input, f.owner)).stage).toBe('local');
    f.currentReport.report.collectionName = 'public'.repeat(Math.ceil(32 * 1024 * 1024 / 6));
    expect((await f.host.handle(input, f.owner)).stage).toBe('local');
    f.currentReport.report.collectionName = 'public'.repeat(Math.ceil(64 * 1024 * 1024 / 6));
    await expect(f.host.handle(input, f.owner)).rejects.toThrow('collaboration-source-budget-exceeded'); expect(f.requests).toEqual([]);
  } finally { f.close(); }
});
it('requires publication confirmation instead of uploading the same server candidate again', async () => {
  const f = await fixture();
  try {
    const local = await f.host.handle(f.input, f.owner), server = await f.host.handle({ operation: 'confirm-upload', context: f.context, candidateId: local.candidateId }, f.owner);
    await expect(f.host.handle({ operation: 'confirm-upload', context: f.context, candidateId: server.candidateId }, f.owner)).rejects.toThrow('collaboration-already-uploaded'); expect(f.requests).toHaveLength(1);
  } finally { f.close(); }
});
it('sets an independent saved Mock state by actual revision and disposal sends no implicit disable', async () => {
  const f = await fixture();
  try {
    f.intercept(r => Response.json({ id: '41', version: 1, digest: 'b'.repeat(64), kind: 'mock', trust: 'saved-contract', createdBy: '7', createdAt: '2026-11-02T00:00:00Z', revision: 4, enabled: true, source: { kind: 'mock', revision: '12', digest: 'c'.repeat(64), uploadId: null, jobId: null, uploadedBy: null }, plan: { sourceProjectRevision: 'c'.repeat(64), routes: [] }, planFingerprint: 'd'.repeat(64), activity: { activeRequests: 1, state: 'active', stateLabel: '已有活动请求' } }));
    expect(await f.host.handle({ operation: 'set-mock', context: f.context, input: { publicationId: '41', enabled: true, expectedRevision: 3 } }, f.owner)).toMatchObject({ stage: 'published', publication: { revision: 4, activity: { activeRequests: 1 } } });
    expect(f.requests[0]).toMatchObject({ method: 'POST', url: expect.stringContaining('/publications/41/enable'), body: { expectedRevision: 3 } });
    await f.host.handle({ operation: 'cancel-preview', context: f.context }, f.owner); f.host.clearOwner(f.owner); expect(f.requests).toHaveLength(1);
  } finally { f.close(); }
});
it('refuses caller URL on explicit copy after a valid finite grant and explicit copy', async () => {
  const f = await fixture();
  try {
    f.intercept(r => Response.json(hostGrant(r.body.operationIntent)));
    expect((await f.host.handle({ operation: 'create-grant', context: f.context, input: { publicationId: '41', purpose: 'view', audience: 'external', expectedRevision: 1 } }, f.owner)).stage).toBe('grant');
    expect((await f.host.handle({ operation: 'copy-grant', context: f.context, input: { grantId: '42' } }, f.owner)).stage).toBe('copied');
    await expect(f.host.handle({ operation: 'copy-grant', context: f.context, input: { grantId: '42', url: 'https://caller.test' } }, f.owner)).rejects.toThrow('collaboration-invalid-input'); expect(f.copied).toHaveLength(1);
  } finally { f.close(); }
});
it('accepts a proven source above the default16MiB and below the approved64MiB local ceiling', async () => {
  const f = await fixture();
  try {
    const runs = join(f.root, '.apicc', 'runs'), file = 'large-valid.json'; mkdirSync(runs, { recursive: true }); const report = stressReport(); report.projectId = f.input.source.project.projectId;
    writeFileSync(join(runs, file), JSON.stringify(report) + ' '.repeat(20 * 1024 * 1024)); writeStressRunScope(f.root, file, f.input.source.project);
    expect((await f.host.handle({ ...f.input, source: { kind: 'stress', project: f.input.source.project, file } }, f.owner)).stage).toBe('local'); expect(f.requests).toEqual([]);
  } finally { f.close(); }
});
it('preserves a safe field above the8KiB default under the64KiB approved local ceiling', async () => {
  const f = await fixture();
  try {
    f.currentReport.report.cases[0]!.error = 'F'.repeat(12000);
    const local = await f.host.handle({ ...f.input, source: { kind: 'current', project: f.input.source.project, expectedReportDigest: f.reportDigest } }, f.owner);
    expect(local.artifact.report.nodes[0].message).toBe('F'.repeat(12000)); expect(f.requests).toEqual([]);
  } finally { f.close(); }
});
it('accepts a safe artifact above default8MiB but below the approved32MiB local ceiling', async () => {
  const f = await fixture();
  try {
    const row = { ...f.currentReport.report.cases[0]!, caseName: 'N'.repeat(2048), error: 'original failure', evidence: undefined };
    f.currentReport.report.cases = Array.from({ length: 5000 }, (_, index) => ({ ...row, caseId: 'case-' + index })); f.currentReport.report.total = 5000; f.currentReport.report.failed = 5000; f.currentReport.report.passed = 0;
    const local = await f.host.handle({ ...f.input, source: { kind: 'current', project: f.input.source.project, expectedReportDigest: f.reportDigest } }, f.owner);
    expect(local.artifactBytes).toBeGreaterThan(8 * 1024 * 1024); expect(local.artifactBytes).toBeLessThanOrEqual(32 * 1024 * 1024); expect(f.requests).toEqual([]);
  } finally { f.close(); }
});
it('labels the local product ceiling separately from unknown current server constraints', async () => {
  const f = await fixture();
  try {
    const local = await f.host.handle(f.input, f.owner); expect(local.stage).toBe('local');
    expect(local.localLimits).toEqual({ source: 'product-hard-ceiling', maxSourceBytes: 67108864, maxArtifactBytes: 33554432, maxFieldBytes: 65536, evidenceIncluded: false, serverPolicyKnown: false });
  } finally { f.close(); }
});
