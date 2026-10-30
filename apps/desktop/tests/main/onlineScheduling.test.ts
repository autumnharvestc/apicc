import {it,expect,vi} from 'vitest';
const preloadBridge = vi.hoisted(() => ({ api: null as any, invoke: async (..._args: any[]): Promise<any> => undefined }));
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld(_name: string, api: unknown) { preloadBridge.api = api; } }, ipcRenderer: { invoke: (...args: any[]) => preloadBridge.invoke(...args), on() {}, send() {}, removeListener() {} } }));
import {prepareOnlineSchedule,type OnlineSchedulePreparationInput} from '../../src/main/online/scheduling.js';
import {createOnlineSession} from '../../src/main/online/session.js';
import {createOnlineClient} from '../../src/main/online/client.js';
import {ContractWorkspaceSchema,encodeContractProjectFiles,type ContractProject} from '@apicc/core';
import {workspaceFixture} from '../../../../packages/core/tests/helpers/contractFixtures.js';
import {projectAssetsManifestHash} from '@apicc/execution/host';
import {readBuildIdentity} from '@apicc/execution/buildIdentity';
import {defaultAgentConfig,defaultPolicyConfig,declaredNetworkPath,runtimeCompatibilityIdForRuntime} from '@apicc/execution/contract';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import { createIpcDeps } from '../../src/main/ipc.js';
import { createSession } from '../../src/main/session.js';
import { readFileSync } from 'node:fs';
import { scheduleView, scheduleOptions } from '../helpers/scheduling.js';
import { OnlineJobSchema } from '../../src/shared/online/execution.js';
const context={serverId:'https://control.test/api/v1',ownerId:'7',scope:{workspaceId:'11',groupId:'22',projectId:'33'}};
const workflowId='10000000-0000-4000-8000-000000000091',suiteId='10000000-0000-4000-8000-000000000092';
async function fixture(origin='http://127.0.0.1:1'){
  const identity=await readBuildIdentity();const project=ContractWorkspaceSchema.parse(workspaceFixture()).groups[0]!.projects[0]!;
  const collection=project.collections[0]!,api=collection.apis[0]!;
  collection.preOperations=[{id:'before',type:'script',content:'throw new Error("SCHEDULE-MUST-NOT-EXECUTE");'}];
  collection.postOperations=[{id:'after',type:'script',content:'throw new Error("SCHEDULE-MUST-NOT-EXECUTE");'}];
  api.cases[0]!.preOperations=[];api.contract.request={protocol:'http',method:'GET',baseUrl:origin,path:'/target',pathParams:[],query:[],headers:[],cookies:[],auth:{kind:'bearer',token:{id:'api-token',policy:'test-auto'}},body:{kind:'none'}};
  api.cases[0]!.dataDriver={sourcePath:'rows.csv',format:'csv'};
  project.workflows=[{id:workflowId,name:'Saved workflow',status:'enabled',nodes:[{id:'request',kind:'request',apiId:api.contract.id,caseId:api.cases[0]!.id}],edges:[]}];
  project.suites=[{formatVersion:1,id:suiteId,name:'Saved suite',tags:[],failFast:false,reporters:['json'],selection:{kind:'explicit',entries:[{id:'10000000-0000-4000-8000-000000000093',kind:'workflow',workflowId}]}}];
  let version='1';let credentialVersion='1';const snapshots=new Map<string,unknown>();const calls:Array<{url:string,method:string,body:unknown}>=[];
  const attachment={refId:'rows',version:'1',hash:createHash('sha256').update('value\na\n').digest('hex')};
  const files=()=>[...encodeContractProjectFiles(project).files].map(([path,content])=>({path,content,version,hash:createHash('sha256').update(content).digest('hex'),size:Buffer.byteLength(content)}));
  const assets=()=>{const f=files();return {...context.scope,format:'contract-files-v1',contractProjectId:project.id,version,manifestHash:projectAssetsManifestHash(f),files:f};};
  const configuration={configVersion:'0',appliedConfigVersion:'0',pendingFields:[],restartRequiredFields:[],status:'applied'};
  const runtime={protocolVersion:1,sessionId:'current',coreBuildId:identity.coreBuildId,scriptApiId:identity.scriptApiId,nodeVersion:'22.19.0',v8Version:'12.4.254.21-node.29',runtimeCompatibilityId:runtimeCompatibilityIdForRuntime('22.19.0','12.4.254.21-node.29',identity.scriptApiId),capabilities:identity.capabilities,configuration};
  const {maxConcurrentStressJobs,maxStressProcesses,maxStressVus,maxStressRequestConcurrency,maxStressRps,maxStressMetricMemoryBytes}=defaultAgentConfig;
  const fetcher:typeof fetch=async(url,init)=>{
    const u=String(url);calls.push({url:u,method:init?.method??'GET',body:init?.body?JSON.parse(String(init.body)):undefined});
    if(u.endsWith('/auth/login'))return Response.json({token:'member',expiresAt:'2030-01-01T00:00:00Z',user:{id:'7',username:'member',displayName:'Member',role:'USER',disabled:false}});
    if(u.endsWith('/execution-snapshots')){const fixed={snapshotId:String(65+Number(version)),createdByUserId:'7',assets:assets()};snapshots.set(fixed.snapshotId,structuredClone(fixed));return Response.json(fixed);}
    if(u.includes('/execution-snapshots/'))return Response.json(snapshots.get(u.split('/').at(-1)!));
    if(u.endsWith('/execution-agents'))return Response.json({defaultAgentId:'5',canManageScripts:false,policy:defaultPolicyConfig,policyVersion:'0',agents:[{id:'5',name:'Agent',acceptingJobs:true,availability:'available',lastSeenAt:null,runtime,configuration,policy:defaultPolicyConfig,policyVersion:'0',scriptsAllowed:true,scriptGrant:{version:'1',scope:'project',scripts:[]},stressConfiguration:{agent:{maxConcurrentStressJobs,maxStressProcesses,maxStressVus,maxStressRequestConcurrency,maxStressRps,maxStressMetricMemoryBytes},sources:{'agent.maxStressRequestConcurrency':'default','agent.maxStressRps':'default','policy.maxStressRequestConcurrency':'default','policy.maxStressRps':'default'}}}]});
    if(u.endsWith('/schedules/material-options'))return Response.json({credentialValidation:'metadata-only',credentials:['api-token','proxy-password'].map(refId=>({refId,version:credentialVersion,status:'registered'})),attachments:[{...attachment,size:8,kind:'file'}]});
    throw new Error('Forbidden request: '+u);
  };
  const session=createOnlineSession({createClient:(baseUrl,hooks)=>createOnlineClient({baseUrl,fetch:fetcher,onUnauthorized:hooks.onUnauthorized}),tokenStore:{save(){},load(){return null;},clear(){}}});
  await session.login({baseUrl:'https://control.test',username:'member',password:'password'});session.openWorkspace({workspaceId:'11',name:'Workspace',myRole:'EDITOR'});
  const input:OnlineSchedulePreparationInput={context,expectedVersion:'1',agentId:'5',target:{kind:'workflow',workflowId},runConfig:{jobTimeoutMs:60000},materials:{projectId:'33',attachments:[attachment],attachmentPaths:{'rows.csv':attachment}},credentialBindings:[],localOnlyRefIds:[],network:{revision:'network-1',configuration:{formatVersion:1,profiles:[{id:'proxy',name:'Proxy',kind:'proxy',proxyUrl:'https://proxy.test',username:'user',passwordRef:{id:'proxy-password',policy:'test-auto'},targetTlsBindings:[]}],projectSelection:{kind:'profile',profileId:'proxy'},environmentSelections:[]}}};
  return {session,fetcher,calls,input,identity,project,attachment,revise(change:(project:ContractProject)=>void){version=String(Number(version)+1);change(project);},advance(){version='2';credentialVersion='2';project.collections[0]!.postOperations[0]!.content='throw new Error("CHANGED-MUST-NOT-EXECUTE");';},advanceData(){version='3';project.collections[0]!.apis[0]!.cases[0]!.parameters={row:'changed'};}};
}
it('uses actual saved scripts, request and network credential closure with zero target requests or secret loads',async()=>{
  let targetRequests=0;const target=createServer((_req,res)=>{targetRequests++;res.end('unexpected');});await new Promise<void>(r=>target.listen(0,'127.0.0.1',r));const a=target.address();if(!a||typeof a==='string')throw new Error('missing owned target');
  try{const f=await fixture(`http://127.0.0.1:${a.port}`);const result=await prepareOnlineSchedule({session:f.session,fetch:f.fetcher},f.input);
    expect(result).toBeDefined();expect(result.execution.preparation).toMatchObject({executionProfile:'trusted-core-script',dispatchKind:'dedicated-task',requiredCoreBuildId:f.identity.coreBuildId,scriptGrantVersion:'1'});
    expect(result.execution.preparation.scriptRequirements.map((s:any)=>s.kind)).toEqual(['pre','post']);
    expect(result.execution.materials.credentials).toEqual([{refId:'api-token',mode:'current-at-trigger'},{refId:'proxy-password',mode:'current-at-trigger'}]);
    expect(result.execution.materials.attachmentPaths).toEqual({'rows.csv':f.attachment});expect(targetRequests).toBe(0);
    expect(f.calls.filter(c=>!c.url.endsWith('/auth/login')).map(c=>c.url.split('/').at(-1))).toEqual(['execution-agents','execution-snapshots','material-options']);
    expect(JSON.stringify(result)).not.toContain('member');
  }finally{await new Promise<void>((r,j)=>target.close(e=>e?j(e):r()));}
});
it('prepares suite dependencies and produces explicit readable refresh differences from saved versions',async()=>{
  const f=await fixture();const input:OnlineSchedulePreparationInput={...f.input,target:{kind:'suite',suiteId,allowDraft:false}};const first=await prepareOnlineSchedule({session:f.session,fetch:f.fetcher},input);expect(first).toBeDefined();
  f.advance();const second=await prepareOnlineSchedule({session:f.session,fetch:f.fetcher},{...input,expectedVersion:'2',credentialBindings:[{refId:'api-token',mode:'fixed-version',version:'2'}],previous:{execution:first.execution,snapshotVersion:first.snapshotVersion,manifestHash:first.manifestHash}});
  expect(second.snapshotVersion).toBe('2');expect(second.execution.snapshotId).toBe('67');expect(second.execution.preparation.scriptPlanDigest).not.toBe(first.execution.preparation.scriptPlanDigest);expect(second.snapshotDiff.areas.find(a=>a.area==='scripts')!.changed).toBe(true);expect(second.snapshotDiff.areas.find(a=>a.area==='data')!.changed).toBe(false);
  expect(f.calls.some(c=>c.url.endsWith('/execution-snapshots/66'))).toBe(true);
});
it('compares actual saved data independently from unchanged scripts',async()=>{
  const f=await fixture();const first=await prepareOnlineSchedule({session:f.session,fetch:f.fetcher},f.input);f.advanceData();
  const third=await prepareOnlineSchedule({session:f.session,fetch:f.fetcher},{...f.input,expectedVersion:'3',previous:{execution:first.execution,snapshotVersion:first.snapshotVersion,manifestHash:first.manifestHash}});
  expect(third.snapshotDiff.areas.find(a=>a.area==='data')!.changed).toBe(true);expect(third.snapshotDiff.areas.find(a=>a.area==='scripts')!.changed).toBe(false);expect(f.calls.some(c=>c.url.endsWith('/execution-snapshots/66'))).toBe(true);
});
it.each(['delay','edge','limits','input-default','subflow-child','loop-mapping','parallel-child','onError-child','finally-child','suite-failFast','suite-child'] as const)('detects execution definition changes with unchanged requests/scripts/data: %s',async change=>{
  const f=await fixture();const original=f.project.workflows[0]!;const request=original.nodes[0]!;
  const childId='10000000-0000-4000-8000-000000000094';
  const child={id:childId,name:'Called workflow',status:'enabled' as const,executionVersion:2 as const,inputs:{value:{required:false,default:1}},outputs:{},limits:{maxConcurrency:4,timeoutMs:300000},nodes:[{id:'child-delay',kind:'delay' as const,delayMs:1}],edges:[]};
  const root:any={id:workflowId,name:'Saved workflow',status:'enabled',executionVersion:2,inputs:{value:{required:false,default:1}},outputs:{},limits:{maxConcurrency:4,timeoutMs:300000},nodes:[request,{id:'delay',kind:'delay',delayMs:1}],edges:[{id:'next',from:'request',to:'delay'}]};
  if(change==='subflow-child'||change==='suite-child')root.nodes[1]={id:'delay',kind:'subflow',workflowId:childId,inputs:{},outputs:{}};
  if(change==='loop-mapping')root.nodes[1]={id:'delay',kind:'loop',workflowId:childId,count:1,maxIterations:2,inputs:{value:{kind:'literal',value:1}},outputs:{}};
  if(change==='parallel-child')root.nodes[1]={id:'delay',kind:'parallel',join:'all',branches:[{id:'left',workflowId:childId,inputs:{},outputs:{}},{id:'right',workflowId:childId,inputs:{},outputs:{}}]};
  if(change==='onError-child'||change==='finally-child')root.nodes[0]={...request,policy:change==='onError-child'?{onError:{workflowId:childId,mode:'propagate',timeoutMs:5000}}:{finally:{workflowId:childId,timeoutMs:5000}}};
  f.project.workflows=[root,child];
  const input:OnlineSchedulePreparationInput={...f.input,...(change.startsWith('suite-')?{target:{kind:'suite',suiteId,allowDraft:false}}:{})};
  const first=await prepareOnlineSchedule({session:f.session,fetch:f.fetcher},input);
  f.revise(project=>{
    if(change==='delay')root.nodes[1].delayMs=2;
    else if(change==='edge')root.edges=[{id:'next',from:'delay',to:'request'}];
    else if(change==='limits')root.limits.timeoutMs=200000;
    else if(change==='input-default')root.inputs.value.default=2;
    else if(change==='loop-mapping')root.nodes[1].inputs.value.value=2;
    else if(change==='suite-failFast')project.suites![0]!.failFast=true;
    else child.nodes[0]!.delayMs=2;
  });
  const second=await prepareOnlineSchedule({session:f.session,fetch:f.fetcher},{...input,expectedVersion:'2',previous:{execution:first.execution,snapshotVersion:first.snapshotVersion,manifestHash:first.manifestHash}});
  expect(second.snapshotDiff.areas.find(a=>a.area==='target')!.changed).toBe(true);
  expect(second.snapshotDiff.areas.filter(a=>a.area!=='target').map(a=>[a.area,a.changed])).toEqual([['environment',false],['scripts',false],['data',false],['materials',false],['network',false],['runtime',false]]);
  expect(f.calls.some(c=>c.url.endsWith('/execution-snapshots/66'))).toBe(true);
});
it('ignores unselected workflow changes when comparing a suite containing only a selected case',async()=>{
  const f=await fixture();const c=f.project.collections[0]!,a=c.apis[0]!;
  f.project.suites![0]!.selection={kind:'explicit',entries:[{id:'10000000-0000-4000-8000-000000000093',kind:'case',collectionId:c.id,folderIds:[],apiId:a.contract.id,caseId:a.cases[0]!.id}]};
  const input:OnlineSchedulePreparationInput={...f.input,target:{kind:'suite',suiteId,allowDraft:false}};
  const first=await prepareOnlineSchedule({session:f.session,fetch:f.fetcher},input);
  f.revise(project=>{project.workflows[0]!.name='Unselected renamed workflow';});
  const second=await prepareOnlineSchedule({session:f.session,fetch:f.fetcher},{...input,expectedVersion:'2',previous:{execution:first.execution,snapshotVersion:first.snapshotVersion,manifestHash:first.manifestHash}});
  expect(second.snapshotDiff.areas.every(a=>!a.changed)).toBe(true);
});
it.each(['local','path','stale-attachment','stale-credential','stale-snapshot'] as const)('rejects %s preparation before any target or material-value request',async invalid=>{
  const f=await fixture();const input=structuredClone(f.input) as any;
  if(invalid==='local')input.localOnlyRefIds=['api-token'];
  if(invalid==='path')input.materials.attachmentPaths={};
  if(invalid==='stale-attachment')input.materials.attachments[0].version='2';
  if(invalid==='stale-credential')input.credentialBindings=[{refId:'api-token',mode:'fixed-version',version:'2'}];
  if(invalid==='stale-snapshot')input.expectedVersion='2';
  await expect(prepareOnlineSchedule({session:f.session,fetch:f.fetcher},input)).rejects.toThrow();
  expect(f.calls.some(c=>c.url.includes('local-materials')||c.url.includes('/jobs'))).toBe(false);
});

async function routingFixture() {
  const f = await fixture(); const requests: Array<{ url: string; method: string; body: any; authorization: string | null }> = [];
  const task = JSON.parse(readFileSync(new URL('../../../../server/src/test/resources/scheduling/job-control-batch.json', import.meta.url), 'utf8')).deliveries[0].task;
  let originalJob: unknown = OnlineJobSchema.parse({ jobId: '78', executionId: '79', agentId: '5', state: 'ended', cancelState: 'none', executionReleased: true, reportState: 'archived', task: { ...task, jobId: '78', executionId: '79', scope: context.scope } });
  let jobGate: Promise<Response> | undefined;
  const row = { ...scheduleView(), execution: { ...scheduleView().execution, target: f.input.target } };
  let delayOptions: Promise<Response> | undefined;
  let updateFailure = false;
  const fetcher: typeof fetch = async (url, init) => {
    const u = String(url); const method = init?.method ?? 'GET'; const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url: u, method, body, authorization: new Headers(init?.headers).get('authorization') });
    if (u.endsWith('/tree')) return Response.json({ workspaceId: '11', rootVersion: 1, projects: [], files: [] });
    if (u.endsWith('/groups')) return Response.json([]);
    if (u.endsWith('/auth/logout')) return new Response(null, { status: 204 });
    if (u.endsWith('/jobs/78')) return jobGate ?? Response.json(originalJob);
    if (u.endsWith('/jobs/78/report')) return Response.json({ executionId: '79', verdict: 'failed', executionFact: 'started' });
    if (u.endsWith('/schedules/options')) return delayOptions ?? Response.json(scheduleOptions());
    if (u.endsWith('/schedules/preview')) return Response.json({ candidates: [{ plannedAtUtc: '2035-01-01T00:00:00.123456789Z', localTime: '2035-01-01T08:00:00.123456789', offset: '+08:00' }], notices: [], limits: {} });
    if (u.includes('/notification-history')) {
      const capture = JSON.parse(readFileSync(new URL('../../../../server/src/test/resources/notifications/history.json', import.meta.url), 'utf8'));
      return Response.json({ ...capture, workspaceId: '11', projectId: '33', scheduleId: row.id });
    }
    if (u.includes('/notifications/') && u.endsWith('/read')) return Response.json({ id: '6', read: true });
    if (u.includes('/notifications')) return Response.json({ items: [], nextBeforeId: null });
    if (u.includes('/history')) return Response.json({ workspaceId: '11', projectId: '33', scheduleId: row.id, evaluationStatus: 'paused', pausedReasonCode: null, evaluatedThroughUtc: null, lastAdmittedPlannedAtUtc: null, items: [], nextBeforeId: null, missedWindows: [], nextMissedBeforeId: null });
    if (/\/schedules(?:\?|$)/.test(u)) return Response.json(method === 'POST' ? { ...row, ...body } : { items: [row], nextBeforeId: null });
    if (new URL(u).pathname.endsWith('/schedules/' + row.id)) return method === 'DELETE' ? new Response(null, { status: 204 }) : updateFailure && method === 'PUT' ? Response.json({ code: 'version_conflict', message: 'PRIVATE-SERVER-DIAGNOSTIC' }, { status: 409 }) : Response.json(method === 'PUT' ? { ...row, name: body.name ?? row.name } : row);
    return f.fetcher(url, init);
  };
  const deps = createIpcDeps({ session: createSession(), pickDirectory: async () => '', saveFile: async () => '', online: { fetch: fetcher, createClient: (baseUrl, hooks) => createOnlineClient({ baseUrl, fetch: fetcher, onUnauthorized: hooks.onUnauthorized }), tokenStore: { save() {}, load() { return null; }, clear() {} } } });
  await deps.handle('online:login', {}, { baseUrl: 'https://control.test', username: 'member', password: 'password' });
  await deps.handle('online:workspace:open', {}, { workspaceId: '11', name: 'Workspace', myRole: 'EDITOR' });
  const invoke = (input: unknown) => Reflect.apply(deps.handle, undefined, ['online:scheduling', {}, input]) as Promise<any>;
  return { ...f, row, deps, requests, invoke, originalJob() { return OnlineJobSchema.parse(originalJob); }, setOriginalJob(value: unknown) { originalJob = value; }, delayJob(value: Promise<Response>) { jobGate = value; }, setDelay(promise: Promise<Response>) { delayOptions = promise; }, failUpdate() { updateFailure = true; } };
}

// Break caught: the real main IPC dispatch has no bounded scheduling route.
it('round1 originalJob lookup reaches the actual preload main boundary and reopens the original agent report', async () => {
  const f = await routingFixture();
  try {
    preloadBridge.invoke = (channel: string, ...args: any[]) => Reflect.apply(f.deps.handle, undefined, [channel, {}, ...args]);
    await import('../../src/preload/preload.js');
    const outcome = await preloadBridge.api.onlineScheduling({ operation: 'originalJob', context, jobId: '78', executionId: '79' }).then((value: unknown) => ({ status: 'fulfilled', value }), (error: unknown) => ({ status: 'rejected', error }));
    expect(outcome).toEqual({ status: 'fulfilled', value: { jobId: '78', executionId: '79', agentId: '5' } });
    // Existing authority must still reject a caller guessing the current plan's agent B.
    await expect(f.deps.handle('online:execution', {}, { operation: 'status', context, location: { kind: 'agent', agentId: '6' }, runId: '78' })).rejects.toThrow('online-project-scope-mismatch');
    const job = await f.deps.handle('online:execution', {}, { operation: 'status', context, location: { kind: 'agent', agentId: '5' }, runId: '78' });
    expect(OnlineJobSchema.parse(job).agentId).toBe('5');
    const report = await f.deps.handle('online:execution', {}, { operation: 'report', context, location: { kind: 'agent', agentId: '5' }, runId: '78' });
    expect(report).toMatchObject({ executionId: '79', verdict: 'failed' });
    expect(f.requests.filter(request => request.url.includes('/jobs')).every(request => request.method === 'GET' && request.authorization === 'Bearer member')).toBe(true);
  } finally { await f.deps.stopOnlineExecutions(); }
});

it('routes preparation through actual saved Core preparation and returns no main token', async () => {
  const f = await routingFixture(); const { context: _, ...input } = f.input;
  const outcome = await f.invoke({ operation: 'prepare', context, input }).then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', error: error instanceof Error ? error.message : String(error) }));
  expect(outcome).toMatchObject({ status: 'fulfilled', value: { execution: { snapshotId: '66', preparation: { dispatchKind: 'dedicated-task' } } } });
  const result = (outcome as { value: any }).value;
  expect(result.execution.snapshotId).toBe('66'); expect(result.execution.preparation.dispatchKind).toBe('dedicated-task');
  expect(JSON.stringify(result)).not.toContain('member');
  expect(f.requests.some(r => r.url.includes('/jobs'))).toBe(false);
  await f.deps.stopOnlineExecutions();
});

// Route is reachable now: each authority dimension must independently reject a valid wrong identity.
it.each(['workspace', 'group', 'project', 'job', 'execution', 'task-job', 'task-execution'] as const)('round1 originalJob rejects a producer with wrong %s identity', async dimension => {
  const f = await routingFixture(); const job = f.originalJob();
  if (dimension === 'workspace') job.task.scope.workspaceId = '44';
  if (dimension === 'group') job.task.scope.groupId = '44';
  if (dimension === 'project') job.task.scope.projectId = '44';
  if (dimension === 'job') job.jobId = '999';
  if (dimension === 'execution') job.executionId = '999';
  if (dimension === 'task-job') job.task.jobId = '999';
  if (dimension === 'task-execution') job.task.executionId = '999';
  f.setOriginalJob(OnlineJobSchema.parse(job));
  try {
    await expect(f.invoke({ operation: 'originalJob', context, jobId: '78', executionId: '79' })).rejects.toThrow(['workspace', 'group', 'project'].includes(dimension) ? 'online-project-scope-mismatch' : 'fixed-input-mismatch');
  } finally { await f.deps.stopOnlineExecutions(); }
});

// Existing captured request/current checks are baseline, including failures, not a new missing-route RED.
it.each(['success', 'error'] as const)('round1 originalJob retains captured session rejection for a late %s', async result => {
  const f = await routingFixture(); let release!: (response: Response) => void;
  f.delayJob(new Promise<Response>(done => { release = done; }));
  try {
    const outcome = f.invoke({ operation: 'originalJob', context, jobId: '78', executionId: '79' }).then(value => ({ value, error: null }), error => ({ value: null, error }));
    await new Promise(done => setTimeout(done, 0)); await f.deps.handle('online:logout', {});
    release(result === 'success' ? Response.json(f.originalJob()) : Response.json({ code: 'private-late-failure' }, { status: 503 }));
    expect((await outcome).error).toMatchObject({ message: 'online-session-changed' });
  } finally { await f.deps.stopOnlineExecutions(); }
});

it('round1 originalJob retains strict preload input and operation-specific minimal output', async () => {
  const f = await routingFixture();
  try {
    preloadBridge.invoke = (channel: string, ...args: any[]) => Reflect.apply(f.deps.handle, undefined, [channel, {}, ...args]);
    await import('../../src/preload/preload.js');
    const before = f.requests.length;
    await expect(preloadBridge.api.onlineScheduling({ operation: 'originalJob', context, jobId: '78', executionId: '79', token: 'private' })).rejects.toThrow();
    await expect(preloadBridge.api.onlineScheduling({ operation: 'originalJob', context, jobId: '../78', executionId: '79' })).rejects.toThrow();
    expect(f.requests).toHaveLength(before);
    preloadBridge.invoke = async () => f.originalJob();
    await expect(preloadBridge.api.onlineScheduling({ operation: 'originalJob', context, jobId: '78', executionId: '79' })).rejects.toThrow();
  } finally { await f.deps.stopOnlineExecutions(); }
});
it.each(['options', 'list', 'detail', 'save', 'update', 'remove', 'preview', 'materialOptions', 'history', 'notificationHistory', 'notifications', 'markNotificationRead'])('routes the strict project/member scheduling operation %s using the captured identity', async operation => {
  const f = await routingFixture(); const input: any = { operation, context };
  if (['detail', 'update', 'remove', 'history', 'notificationHistory'].includes(operation)) input.id = f.row.id;
  if (['list', 'history', 'notificationHistory', 'notifications'].includes(operation)) input.limit = 25;
  if (operation === 'notificationHistory') { input.beforeId = '44'; input.sourceBeforeId = '55'; }
  if (operation === 'save') { const { name, rule, policies, execution, notifications } = f.row; input.input = { name, rule, policies, execution, notifications }; }
  if (operation === 'update') input.input = { expectedVersion: f.row.version, name: 'Renamed' };
  if (operation === 'remove') input.expectedVersion = f.row.version;
  if (operation === 'preview') input.input = { rule: f.row.rule, afterUtc: '2034-12-31T00:00:00Z' };
  if (operation === 'markNotificationRead') input.id = '6';
  const outcome = await f.invoke(input).then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', error: error instanceof Error ? error.message : String(error) }));
  expect(outcome, `Authorized ${operation} must return its public result`).toMatchObject({ status: 'fulfilled' });
  const result = (outcome as { value: any }).value;
  if (operation === 'remove') expect(result).toBeNull(); else expect(result).toBeDefined();
  const request = f.requests.at(-1)!;
  expect(request.authorization).toBe('Bearer member');
  if (operation === 'notificationHistory') expect(request.url).toContain('beforeId=44&sourceBeforeId=55');
  if (operation === 'update') expect(request.body).toEqual({ expectedVersion: '9007199254740995', name: 'Renamed' });
  expect(f.requests.some(r => r.url.includes('/jobs'))).toBe(false);
  await f.deps.stopOnlineExecutions();
});
it('rejects an old captured scheduling result after logout rather than returning old scope data', async () => {
  const f = await routingFixture(); let release!: (value: Response) => void;
  f.setDelay(new Promise<Response>(resolve => { release = resolve; }));
  const pending = f.invoke({ operation: 'options', context });
  const outcome = pending.then(value => ({ value, error: null }), error => ({ value: null, error }));
  // The scheduling request is asynchronous; allow its captured identity to reach fetch.
  await new Promise(resolve => setTimeout(resolve, 0));
  await f.deps.handle('online:logout', {}); release(Response.json(scheduleOptions()));
  expect((await outcome).error).toMatchObject({ message: 'online-session-changed' });
  await f.deps.stopOnlineExecutions();
});

it('preserves the server safe conflict reason across the real main IPC error boundary', async () => {
  const f = await routingFixture(); f.failUpdate();
  await expect(f.invoke({ operation: 'update', context, id: f.row.id, input: { expectedVersion: f.row.version, name: 'Changed' } })).rejects.toThrow('version_conflict');
  await f.deps.stopOnlineExecutions();
});

it('uses the actual exposed preload method and strict registered main route together', async () => {
  const f = await routingFixture();
  try {
    preloadBridge.invoke = (channel: string, ...args: any[]) => Reflect.apply(f.deps.handle, undefined, [channel, {}, ...args]);
    await import('../../src/preload/preload.js');
    const result = await preloadBridge.api.onlineScheduling({ operation: 'options', context });
    expect(result.canManageSchedules).toBe(true); expect(result).not.toHaveProperty('token');
    const before = f.requests.length;
    await expect(preloadBridge.api.onlineScheduling({ operation: 'options', context, token: 'must-not-cross' })).rejects.toThrow();
    expect(f.requests).toHaveLength(before);
    preloadBridge.invoke = async () => scheduleView();
    await expect(preloadBridge.api.onlineScheduling({ operation: 'options', context })).rejects.toThrow();
  } finally { await f.deps.stopOnlineExecutions(); }
});
