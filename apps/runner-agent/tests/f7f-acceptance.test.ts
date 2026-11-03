// Concentrated synthetic composition. No visible window, user project, or public target.
import { it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { encodeContractProjectFiles, type ContractProject } from '@apicc/core';
import { defaultAgentConfig } from '@apicc/execution/contract';
import { acceptanceStress } from './helpers/acceptanceStress.js';
import { serverFixture, freePort, until, repo } from './server-fixture.js';
import { createMockConfiguredProject } from '../../../packages/core/tests/helpers/mockFixtures.js';
import { startMockServer } from '../../../packages/core/src/mock/server.js';
import { compileProjectMock } from '../../../packages/core/src/mock/compile.js';
import { createProjectSnapshot } from '../../../packages/core/src/assets/snapshot.js';
import { DebugResultSchema } from '../../../packages/core/src/debug/model.js';
import { semanticTarget } from './runtime-semantics.mjs';

it('F7f same candidate: real agent archive, fixed publications, independent Mock and restart authority', async () => {
  const parent = resolve(process.env.APICC_F7F_EVIDENCE_ROOT ?? join(repo, 'local/f7f-acceptance'));
  if (!parent.startsWith(resolve(repo, 'local') + requireSeparator())) throw Error('SYNTHETIC_EVIDENCE_ROOT');
  mkdirSync(parent, { recursive: true }); const root = mkdtempSync(join(parent, 'composition-'));
  const facts: unknown[] = [], cleanup: unknown[] = [];
  const record = (name: string, data: unknown) => writeFileSync(join(root, name + '.json'), JSON.stringify(data, null, 2) + '\n');
  const fact = (kind: string, data: unknown) => { facts.push({ kind, data, at: new Date().toISOString() }); record('facts', facts); };
  const processes: ChildProcess[] = [];
  const start = (label: string, args: string[], env: NodeJS.ProcessEnv = process.env) => {
    const child = spawn(process.execPath, args, { cwd: repo, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); processes.push(child);
    for (const stream of [child.stdout, child.stderr]) stream!.on('data', bytes => appendFileSync(join(root, label + '.log'), bytes));
    fact('process-start', { label, pid: child.pid }); return child;
  };
  const stop = async (label: string, child: ChildProcess) => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(done => child.once('close', () => done())); child.kill('SIGTERM');
      await Promise.race([exited, new Promise<never>((_, reject) => setTimeout(() => reject(Error(`OWNED_PROCESS_STOP_TIMEOUT: ${label}`)), 10000))]);
    }
    cleanup.push({ label, pid: child.pid, exitCode: child.exitCode, signal: child.signalCode, collected: true }); record('cleanup', cleanup);
  };
  let server: Awaited<ReturnType<typeof serverFixture>> | undefined, local: Awaited<ReturnType<typeof startMockServer>> | undefined;
  const target = createServer((request, response) => { request.resume(); request.on('end', () => { response.setHeader('content-type', 'application/json'); response.end('{"token":"fixed-token"}'); }); });
  try {
    const rpcPort = await freePort(), publicPort = await freePort();
    const secretFile = join(root, 'rpc-secret'); writeFileSync(secretFile, 'synthetic-f7f-rpc-secret-0123456789abcdef');
    const rpc = start('runtime', ['apps/collaboration-runtime/dist/main.js'], { ...process.env,
      APICC_COLLABORATION_RUNTIME_ENABLED: 'true', APICC_COLLABORATION_RUNTIME_SECRET_FILE: secretFile,
      APICC_COLLABORATION_RUNTIME_HOST: '127.0.0.1', APICC_COLLABORATION_RUNTIME_PORT: String(rpcPort) });
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${rpcPort}/rpc`)).status === 401; } catch { return false; } }, Boolean);
    const variables: NodeJS.ProcessEnv = {
      APICC_COLLABORATION_RUNTIME_ENABLED: 'true', APICC_COLLABORATION_RUNTIME_BASE_URL: `http://127.0.0.1:${rpcPort}`,
      APICC_COLLABORATION_RUNTIME_SECRET_FILE: secretFile, APICC_COLLABORATION_PUBLIC_ENABLED: 'true',
      APICC_COLLABORATION_PUBLIC_PORT: String(publicPort), APICC_COLLABORATION_PUBLIC_BASE_URL: `http://127.0.0.1:${publicPort}`,
      APICC_SHARE_VIEWER_DIR: join(repo, 'apps/share-viewer/dist'),
      APICC_COLLABORATION_POLICY_DEFAULTS_EXTERNALSHARINGALLOWED: 'true',
      APICC_COLLABORATION_POLICY_DEFAULTS_EXTERNALDOWNLOADALLOWED: 'true',
      APICC_COLLABORATION_POLICY_DEFAULTS_SHAREDMOCKALLOWED: 'true',
    };
    server = await serverFixture({ artifactJar: process.env.APICC_F7F_JAR, evidenceParent: root, variables });
    fact('origins', { management: server.baseUrl, public: variables.APICC_COLLABORATION_PUBLIC_BASE_URL, rpc: `http://127.0.0.1:${rpcPort}`, javaPid: server.serverPid() });
    let token = '';
    const api = async (method: string, path: string, input?: unknown, expected = 200) => {
      const response = await server!.trustedFetch(`${server!.baseUrl}/api/v1/${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(15000) });
      const text = await response.text(); expect(response.status, `${method} ${path}: ${text}`).toBe(expected); return text ? JSON.parse(text) : null;
    };
    token = (await api('POST', 'auth/login', { username: 't11-owner', password: 't11-password8' })).token;
    const ws = (await api('GET', 'connect')).workspaceId, group = (await api('GET', `workspaces/${ws}/groups`))[0].id;
    const project = (await api('POST', `workspaces/${ws}/projects`, { groupId: group, name: 'F7f synthetic composition' }, 201)).id;
    const path = `workspaces/${ws}/projects/${project}`, collab = `${path}/collaboration`;
    const agentId = (await api('POST', 'agents', { name: 'F7f independent synthetic agent' }, 201)).id;
    // Existing outbox default is60s; this bounded fixture explicitly uses the existing fast-test value.
    await api('PATCH',`agents/${agentId}`,{expectedVersion:'0',config:{transferRetryCycleMs:200}});
    await api('PUT', `agents/${agentId}/workspace-grants`, { workspaceIds: [ws] });
    await api('PUT', `workspaces/${ws}/agent-project-allocations`, { agentId, projectIds: [project] });
    await api('PUT', `${path}/execution-settings`, { expectedVersion: '0', agentIds: [agentId], defaultAgentId: agentId, policy: {} });
    const enrollment = await api('POST', `agents/${agentId}/enrollments`, {}, 201);
    const identity = await api('POST', 'runner/enroll', { enrollmentToken: enrollment.enrollmentToken }, 201);
    const agentToken = join(root, 'agent-token'); writeFileSync(agentToken, identity.agentToken);
    const agentConfig = join(root, 'deployment.json'); writeFileSync(agentConfig, JSON.stringify({ baseUrl: `${server.baseUrl}/api/v1`, agentId,
      tokenFile: agentToken, dataDirectory: join(root, 'agent-data'), trustedCaFile: join(server.root, 'control-ca.pem'), bootstrapConfig: { ...defaultAgentConfig, minFreeDiskBytes: 1 } }));
    const agent = start('agent', ['apps/runner-agent/dist/main.js', agentConfig]);
    const registered=await until(() => api('GET', `agents/${agentId}`), value => value.runtime && value.status === 'applied');
    await api('PUT', `${path}/credentials/synthetic-credential`, { expectedVersion: '0', value: 't11-synthetic-secret' });
    for (const policyPath of [`workspaces/${ws}/collaboration/policy`, `${collab}/policy`]) {
      const policy = await api('GET', policyPath);
      await api('PUT', policyPath, { expectedRevision: policy.revision, settings: { externalSharingAllowed: true, externalDownloadAllowed: true, sharedMockAllowed: true } });
    }
    let assets: any;
    const save = async (value: ContractProject) => {
      const files = [...encodeContractProjectFiles(value).files];
      assets = await api('PUT', `${path}/assets`, { format: 'contract-files-v1', contractProjectId: value.id, expectedVersion: assets?.version ?? '0', changes: files.map(([path, content]) => ({ path, content })), deletes: (assets?.files ?? []).map((file: any) => file.path).filter((path: string) => !files.some(([name]) => name === path)) });
    };
    await new Promise<void>(done => target.listen(0, '127.0.0.1', done));
    const stress = acceptanceStress(`http://127.0.0.1:${(target.address() as { port: number }).port}`, 'f7f-stress', false, 2);
    await save(stress.project);
    const input = join(root, 'desktop-input.json'), output = join(root, 'desktop-output.json');
    writeFileSync(input, JSON.stringify({ baseUrl: server.baseUrl, username: 't11-owner', password: 't11-password8', privateRoot: root, scope: { workspaceId: ws, groupId: group, projectId: project }, operations: [{ operation: 'run', runId: randomUUID(), location: { kind: 'agent', agentId }, target: stress.target, expectedVersion: assets.version, environmentId: stress.target.plan.environmentId, runConfig: { jobTimeoutMs: 30000 }, materials: { projectId: project, credentials: [{ refId: 'synthetic-credential', version: '1' }], attachments: [] }, localOnlyRefIds: [] }] }));
    const desktop = start('desktop-host', ['apps/desktop/tests/main/online/electron-execution-probe.mjs', input, output], { ...process.env, NODE_EXTRA_CA_CERTS: join(server.root, 'control-ca.pem') });
    await new Promise<void>((done, reject) => { desktop.once('error', reject); desktop.once('close', code => code === 0 ? done() : reject(Error(`DESKTOP_HOST_EXIT_${code}`))); });
    const submitted = JSON.parse(readFileSync(output, 'utf8')).results[0];
    await until(() => api('GET', `jobs/${submitted.jobId}`), value => value.state === 'ended' && value.executionReleased && value.reportState === 'archived');
    const report = await api('GET', `jobs/${submitted.jobId}/report`); expect(report.verdict).toBe('passed');
    const history = await api('GET', `${collab}/history?source=server-report`);
    const archived = history.items.find((item: any) => item.id === submitted.jobId);
    expect(archived, JSON.stringify(history)).toBeTruthy();
    expect(archived.runtime.origin).toBe('stress-admission');expect(archived.runtime.coreBuildId).toBe(registered.runtime.coreBuildId);
    expect(archived.runtime.nodeVersion).toBe(process.versions.node);expect(archived.runtime.v8Version).toBe(process.versions.v8);
    expect(archived.runtime.runtimeCompatibilityId).toBe(registered.runtime.runtimeCompatibilityId);
    fact('real-agent-archive-and-history', { jobId: submitted.jobId, history: archived, desktopHostClosed: desktop.exitCode === 0 });
    const safeHistory=await api('GET',`${collab}/history/${submitted.jobId}?source=server-report`);
    expect(safeHistory.artifact.source.trust).toBe('server-archive');
    expect(safeHistory.artifact.report.sourceCategory).toBe('stress');
    expect(safeHistory.artifact.report.stress.requests.completed).toBe(2);
    expect(safeHistory.artifact.summary).toContainEqual({labelCode:'execution.verdict',value:'passed'});
    expect(safeHistory.artifact.summary).toContainEqual({labelCode:'report.verdict',value:'passed'});
    fact('real-agent-safe-history-body',{jobId:submitted.jobId,source:safeHistory.artifact.source,requests:safeHistory.artifact.report.stress.requests,summary:safeHistory.artifact.summary});
    const publish = async (source: unknown, title: string) => {
      const preview = await api('POST', `${collab}/previews`, { title, includeEvidence: false, source }, 201);
      const command = { publicationIntentId: randomUUID(), previewId: preview.id, candidateDigest: preview.candidateDigest, expectedPolicyRevision: preview.expectedPolicyRevision };
      const publication = await api('POST', `${collab}/publications`, command, 201);
      expect((await api('POST', `${collab}/publications`, command, 200)).id).toBe(publication.id);
      return publication;
    };
    const fromAgent = await publish({ kind: 'server-report', jobId: submitted.jobId }, '真实代理归档 / agent archive');
    expect(fromAgent.trust).toBe('server-archive');
    // I1: an actual agent debug archive must satisfy the same source-bound Java
    // preview contract as safe history, not only a pure Core DTO assertion.
    const debugInput=join(root,'desktop-debug-input.json'),debugOutput=join(root,'desktop-debug-output.json');
    const debugCommand=JSON.parse(readFileSync(input,'utf8'));debugCommand.operations[0].runId=randomUUID();debugCommand.operations[0].target=semanticTarget('debug');
    writeFileSync(debugInput,JSON.stringify(debugCommand));
    const debugDesktop=start('desktop-debug-host',['apps/desktop/tests/main/online/electron-execution-probe.mjs',debugInput,debugOutput],{...process.env,NODE_EXTRA_CA_CERTS:join(server.root,'control-ca.pem')});
    await new Promise<void>((done,reject)=>{debugDesktop.once('error',reject);debugDesktop.once('close',code=>code===0?done():reject(Error(`DESKTOP_DEBUG_HOST_EXIT_${code}`)));});
    const debugSubmitted=JSON.parse(readFileSync(debugOutput,'utf8')).results[0];
    await until(()=>api('GET',`jobs/${debugSubmitted.jobId}`),value=>value.state==='ended'&&value.executionReleased&&value.reportState==='archived');
    const debugArchive=await api('GET',`jobs/${debugSubmitted.jobId}/report`);
    expect(debugArchive.output.kind).toBe('debug');expect(DebugResultSchema.safeParse(debugArchive.output.result).success).toBe(true);
    const originalDebugSource={trust:'server-archive',revision:String(debugArchive.executionId),digest:createHash('sha256').update(JSON.stringify(debugArchive)).digest('hex')};
    const debugHistory=await api('GET',`${collab}/history/${debugSubmitted.jobId}?source=server-report`);
    expect(debugHistory.artifact.source).toEqual(originalDebugSource);expect(debugHistory.artifact.report.sourceCategory).toBe('debug');
    fact('real-debug-archive-safe-history',{jobId:debugSubmitted.jobId,source:debugHistory.artifact.source,outputKind:debugArchive.output.kind,sourceCategory:debugHistory.artifact.report.sourceCategory});
    const debugPreview=await api('POST',`${collab}/previews`,{title:'真实调试归档 / debug archive',includeEvidence:false,source:{kind:'server-report',jobId:debugSubmitted.jobId}},201);
    expect(debugPreview.artifact.source).toEqual(originalDebugSource);expect(debugPreview.artifact.kind).toBe('report');expect(debugPreview.artifact.report.sourceCategory).toBe('debug');
    const debugPublication=await api('POST',`${collab}/publications`,{publicationIntentId:randomUUID(),previewId:debugPreview.id,candidateDigest:debugPreview.candidateDigest,expectedPolicyRevision:debugPreview.expectedPolicyRevision},201);
    expect(debugPublication.source.jobId).toBe(debugSubmitted.jobId);expect(debugPublication.source.revision).toBe(String(debugArchive.executionId));expect(debugPublication.source.digest).toBe(originalDebugSource.digest);
    fact('real-debug-archive-preview',{jobId:debugSubmitted.jobId,source:debugPreview.artifact.source,kind:debugPreview.artifact.kind,sourceCategory:debugPreview.artifact.report.sourceCategory});
    const claimed = { formatVersion: 1, kind: 'report', title: '单项成员声明', source: { trust: 'member-claim', revision: 'synthetic-selected-1', digest: 'selected-claim' }, summary: [], limitations: [], report: { sourceCategory: 'run', startedAt: '2026-11-01T00:00:00.000Z', finishedAt: '2026-11-01T00:00:01.000Z', verdict: 'unknown', counts: [], failures: [], nodes: [], trace: [], evidence: [] } };
    const member = await publish({ kind: 'member-upload', artifact: claimed }, '单项成员声明 / member claim'); expect(member.trust).toBe('member-claim');
    const document = await publish({ kind: 'document', revision: assets.version, manifestHash: assets.manifestHash, scope: { kind: 'project' } }, '固定文档 <script>window.injected=1</script>');
    const grant = await api('POST', `${collab}/publications/${document.id}/grants`, { operationIntent: randomUUID(), purpose: 'view', audience: 'external', downloadAllowed: true, durationMs: 600000, expectedRevision: document.revision }, 201);
    const publicRead = (suffix = '', key = grant.key) => fetch(`http://127.0.0.1:${publicPort}/share-api/${grant.publicId}${suffix}`, { headers: { 'X-Apicc-Share-Key': key }, signal: AbortSignal.timeout(10000) });
    const before = await (await publicRead()).json(); expect(before.kind).toBe('document');
    const download = await publicRead('/download'); expect(download.status).toBe(200); expect(download.headers.get('content-type')).toContain('application/json'); expect(await download.text()).not.toContain(grant.key);
    const mock = createMockConfiguredProject();
    const responseBinding = mock.collections[0]!.folders[0]!.folders[0]!.apis[0]!.contract.responses[0]!;
    if (responseBinding.kind !== 'inline') throw Error('SYNTHETIC_RESPONSE_BINDING'); delete responseBinding.headers['Content-Length'];
    await save(mock); expect(await (await publicRead()).json()).toEqual(before);
    const compiled = compileProjectMock(createProjectSnapshot(mock)); if (!compiled.ok) throw Error('SYNTHETIC_MOCK_INVALID'); local = await startMockServer(compiled.plan);
    let publication = await publish({ kind: 'mock', revision: assets.version, manifestHash: assets.manifestHash, scope: { kind: 'project' } }, 'Independent shared Mock');
    publication = await api('PATCH', `${collab}/publications/${publication.id}`, { expectedRevision: publication.revision, enabled: true });
    const mockGrant = await api('POST', `${collab}/publications/${publication.id}/grants`, { operationIntent: randomUUID(), purpose: 'call', audience: 'external', expectedRevision: publication.revision }, 201);
    const call = () => fetch(`${mockGrant.baseUrl}/items/item-7`, { headers: { 'X-Apicc-Mock-Key': mockGrant.key }, signal: AbortSignal.timeout(10000) });
    const localResponse = await fetch(`http://127.0.0.1:${local.address.port}/items/item-7`), shared = await call(); expect(shared.status).toBe(localResponse.status); expect(await shared.text()).toBe(await localResponse.text());
    await stop('agent-offline', agent); expect((await call()).status).toBe(200);
    fact('independent-mock', { publisherHostClosed: true, agentOffline: true, publicStatus: 200, ruleId: local.logs()[0]?.ruleId });
    await stop('node-outage', rpc); expect((await call()).status).toBe(503);
    expect((await publicRead()).status).toBe(200);
    await api('DELETE', `${collab}/grants/${grant.id}`, { expectedRevision: grant.revision }, 204);
    expect((await publicRead()).status).toBe(410);
    const expiry = mockGrant.expiresAt;
    await server.stop(); await server.start(variables);
    const restartRead=await until(async()=>{
      const startedAt=new Date().toISOString();
      let observed:{status:number;code:string|null};
      try {const response=await publicRead(),body=await response.json();observed={status:response.status,code:typeof body.code==='string'?body.code:null};}
      catch {observed={status:0,code:'transport-error'};}
      fact('restart-public-read',{startedAt,endedAt:new Date().toISOString(),...observed});
      return observed;
    },observed=>observed.status!==503||observed.code!=='public_origin_unavailable');
    expect(restartRead.status).toBe(410);
    const savedGrant = await api('GET', `${collab}/grants/${mockGrant.id}`); expect(savedGrant.expiresAt).toBe(expiry);
    fact('restart', { revokedStatus: 410, originalExpiresAt: expiry, restoredExpiresAt: savedGrant.expiresAt });
    record('result', { passed: true, limitations: ['No visible native/browser/CSP proof; shared fixture carries synthetic sources only.'] });
  } finally {
    const failures: unknown[] = [];
    for (const child of processes.reverse()) { try { await stop('final-owned-process', child); } catch (error) { failures.push(String(error)); } }
    try { await local?.stop(); } catch (error) { failures.push(String(error)); }
    target.closeAllConnections(); await new Promise<void>(done => target.close(() => done()));
    try { await server?.close(); } catch (error) { failures.push(String(error)); }
    cleanup.push({ javaAndProxyClosed: true, localMockClosed: true, targetClosed: true, failures }); record('cleanup', cleanup);
    if (failures.length) throw Error(`F7F_CLEANUP_FAILED: ${failures.join('; ')}`);
  }
}, 300000);

function requireSeparator() { return process.platform === 'win32' ? '\\' : '/'; }
