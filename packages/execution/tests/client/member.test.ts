import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContractWorkspaceSchema, encodeContractProjectFiles, type ContractProject, type SecretStore } from '@apicc/core';
import { workspaceFixture } from '../../../core/tests/helpers/contractFixtures.js';
import { projectAssetsManifestHash } from '../../src/host/prepare.js';
import { defaultPolicyConfig, defaultAgentConfig, runtimeCompatibilityIdForRuntime } from '../../src/contract/index.js';
import { readBuildIdentity } from '@apicc/execution/buildIdentity';
import { createMemberExecutionClient } from '../../src/client/member.js';
import type { PreparedMemberRun, MemberRunInput } from '../../src/client/memberTypes.js';

const context = { serverId: 'https://control.test/api/v1', ownerId: '7', scope: { workspaceId: '11', groupId: '22', projectId: '33' } };
const signal = () => new AbortController().signal;
function projectFixture(configure?: (project: ContractProject) => void) {
  const project = ContractWorkspaceSchema.parse(workspaceFixture()).groups[0]!.projects[0]!;
  project.collections[0]!.preOperations = []; project.collections[0]!.apis[0]!.cases[0]!.preOperations = [];
  project.workflows = [{ id: '00000000-0000-4000-8000-000000000091', name: 'No requests', status: 'enabled', nodes: [{ id: 'only', kind: 'noop' }], edges: [] }];
  configure?.(project);
  const files = [...encodeContractProjectFiles(project).files].map(([path, content]) => ({ path, content, version: '1', hash: createHash('sha256').update(content).digest('hex'), size: Buffer.byteLength(content) }));
  return { project, assets: { ...context.scope, format: 'contract-files-v1' as const, contractProjectId: project.id, version: '1', manifestHash: projectAssetsManifestHash(files), files } };
}
function fixture(configure?: (project: ContractProject) => void, options?: { localStore?: () => SecretStore; token?:()=>string|Promise<string>; assertCurrent?:()=>void; response?: (url: string, init?: RequestInit) => Response | undefined | Promise<Response | undefined> }) {
  const { project, assets } = projectFixture(configure), requests: Array<{ url: string; method: string; body: any }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url); requests.push({ url: path, method: init?.method ?? 'GET', body: init?.body && JSON.parse(String(init.body)) });
    const custom = await options?.response?.(path,init); if (custom) return custom;
    if (path.endsWith('/execution-agents')) return Response.json({ agents: [], defaultAgentId: null, canManageScripts: false, policyVersion: '0', policy: defaultPolicyConfig });
    if (path.endsWith('/execution-snapshots')) return Response.json({ snapshotId: '66', createdByUserId: '7', assets });
    if (path.endsWith('/local-materials')) return Response.json({ snapshotId: '66', scope: context.scope, credentials: [], attachments: [] });
    return Response.json({ code: 'job_not_found' }, { status: 404 });
  };
  const client = createMemberExecutionClient({ session: { captureExecution: () => ({ serverId: context.serverId, userId: '7', token: options?.token??(async () => 'member-token'), assertCurrent: options?.assertCurrent??(()=>{}) }) }, fetch: fetcher, localStore: options?.localStore });
  const input: MemberRunInput = { context, runId: randomUUID(), location: { kind: 'local' as const }, target: { kind: 'workflow' as const, workflowId: project.workflows[0]!.id }, expectedVersion: '1', runConfig: {}, materials: { projectId: '33', credentials: [], attachments: [] }, localOnlyRefIds: [] };
  return { client, input, project, assets, requests };
}
async function agentFixture(uncertain=false, policy=defaultPolicyConfig, configure?: (project:ContractProject)=>void, minimum=false) {
  const identity=await readBuildIdentity(),configuration={configVersion:'0',appliedConfigVersion:'0',pendingFields:[],restartRequiredFields:[],status:'applied'};
  let accepted:any,fixedSubmission:any;let visible=true;let submissions=0,verifications=0;
  const responseJob=()=>minimum?{jobId:accepted.jobId,executionId:accepted.executionId,agentId:accepted.agentId,state:accepted.state,cancelState:accepted.cancelState,executionReleased:accepted.executionReleased,canCancel:true,view:'active-status',scope:accepted.task.scope}:accepted;
  const f=fixture(configure,{response:(url,init)=>{
    if(url.endsWith('/execution-agents'))return Response.json({defaultAgentId:'5',canManageScripts:false,policy,policyVersion:'0',agents:[{id:'5',name:'Fixed agent',acceptingJobs:true,availability:'available',lastSeenAt:'2026-10-26T12:00:00Z',policy,policyVersion:'0',scriptsAllowed:false,scriptGrant:{scope:'script-version',version:'0',scripts:[]},stressConfiguration:{agent:{maxConcurrentStressJobs:defaultAgentConfig.maxConcurrentStressJobs,maxStressProcesses:defaultAgentConfig.maxStressProcesses,maxStressVus:defaultAgentConfig.maxStressVus,maxStressRequestConcurrency:defaultAgentConfig.maxStressRequestConcurrency,maxStressRps:defaultAgentConfig.maxStressRps,maxStressMetricMemoryBytes:defaultAgentConfig.maxStressMetricMemoryBytes},sources:{'agent.maxStressRequestConcurrency':'default','agent.maxStressRps':'default','policy.maxStressRequestConcurrency':'default','policy.maxStressRps':'default'}},configuration,runtime:{protocolVersion:1,sessionId:'registered-host',coreBuildId:identity.coreBuildId,scriptApiId:identity.scriptApiId,capabilities:identity.capabilities,nodeVersion:process.versions.node,v8Version:process.versions.v8,runtimeCompatibilityId:runtimeCompatibilityIdForRuntime(process.versions.node,process.versions.v8,identity.scriptApiId),configuration}}]});
    if(url.includes('/jobs/by-intent?'))return accepted&&visible?Response.json(responseJob()):Response.json({code:'job_not_found'},{status:404});
    if(url.endsWith('/jobs/by-intent/verify')){verifications++;return JSON.stringify(JSON.parse(String(init?.body)))===JSON.stringify(fixedSubmission)?Response.json(responseJob()):Response.json({code:'intent_conflict'},{status:409});}
    if(url.endsWith('/jobs')&&init?.method==='POST'){
      submissions++;const body=JSON.parse(String(init.body));const {scriptRequirements:_requirements,...preparation}=body.preparation;
      if(accepted)return JSON.stringify(body)===JSON.stringify(fixedSubmission)?Response.json(accepted):Response.json({code:'intent_conflict'},{status:409});
      fixedSubmission=body;
      accepted={jobId:'99',executionId:'100',agentId:'5',state:'queued',cancelState:'none',executionReleased:false,reportState:'none',task:{protocolVersion:1,jobId:'99',executionId:'100',scope:context.scope,submittedByUserId:'7',contractProjectId:'00000000-0000-4000-8000-000000000018',snapshotId:body.snapshotId,manifestHash:body.preparation.manifestHash,target:body.target,policyVersion:'0',...preparation}};
      if(uncertain)throw new Error('owned-response-lost');return Response.json(responseJob());
    }
    return undefined;
  }});
  f.input.location={kind:'agent',agentId:'5'};
  return {...f,hide:()=>{visible=false;},counts:()=>({submissions,verifications})};
}
function savedCaseInput(f:{input:MemberRunInput;project:ContractProject}):MemberRunInput{
  const collection=f.project.collections[0]!,asset=collection.apis[0]!,locator={workspaceId:'11',groupId:'22',projectId:f.project.id,collectionId:collection.id,folderIds:[],apiId:asset.contract.id};
  return {...f.input,target:{kind:'debug',invocation:{mode:'case',locator,case:{...locator,caseId:asset.cases[0]!.id,scope:'base'}}}};
}
async function ownedCleanupTarget() {
  const hits:number[]=[],closed:number[]=[],send:Array<()=>void>=[];
  const target=createServer((_request,response)=>{
    const id=hits.length;hits.push(id);
    response.once('close',()=>{if(!response.writableEnded)closed.push(id);});
    send.push(()=>response.end('owned-local-cleanup-response'));
  });
  await new Promise<void>(resolve=>target.listen(0,'127.0.0.1',resolve));
  const address=target.address();if(!address||typeof address==='string')throw new Error('owned target missing');
  return {hits,closed,baseUrl:`http://127.0.0.1:${address.port}`,release(){for(const finish of send)finish();},async close(){for(const finish of send)finish();target.closeAllConnections();await new Promise<void>(resolve=>target.close(()=>resolve()));}};
}
function setCleanupTarget(project:ContractProject,baseUrl:string){
  const request=project.collections[0]!.apis[0]!.contract.request;
  request.baseUrl=baseUrl;request.path='/saved-owned';request.auth={kind:'none'};
  if(request.protocol==='http')request.body={kind:'none'};
}
async function cleanupResult(action:()=>Promise<void>){
  try{return {value:await action(),error:null};}catch(error){return {value:undefined,error:error instanceof Error?error.message:String(error)};}
}
describe('member execution client', () => {
  it.each([false,true])('F7f minimum agent receipt/reconciliation retains trusted preparation without task (lost=%s)',async lost=>{
    const f=await agentFixture(lost,defaultPolicyConfig,undefined,true);
    try{
      const prepared=await f.client.prepare(f.input,signal());
      if(lost)await expect(f.client.start(prepared,'minimum-intent',signal())).rejects.toThrow('owned-response-lost');
      const started=await f.client.start(prepared,'minimum-intent',signal());
      expect(started).toMatchObject({runId:'99',snapshotId:prepared.summary.snapshotId,manifestHash:prepared.summary.manifestHash,job:{view:'active-status'}});
      expect(started.job).not.toHaveProperty('task');
      expect(f.counts()).toEqual({submissions:1,verifications:lost?1:0});
    }finally{await f.client.close();}
  });
  it('r50_owned_cleanup_stops_only_the_exact_active_local_after_session_generation_changes',async()=>{
    const target=await ownedCleanupTarget();let replaced=false;
    const f=fixture(project=>setCleanupTarget(project,target.baseUrl),{assertCurrent(){if(replaced)throw new Error('fixture-session-generation-changed');}});
    let aReport:Promise<unknown>|undefined,bReport:Promise<unknown>|undefined;
    try{
      const aInput=savedCaseInput(f),bInput={...aInput,runId:randomUUID()};
      const a=await f.client.prepare(aInput,signal()),b=await f.client.prepare(bInput,signal());
      await f.client.start(a,'cleanup-owner-a',signal());await vi.waitFor(()=>expect(target.hits).toHaveLength(1));
      await f.client.start(b,'cleanup-owner-b',signal());await vi.waitFor(()=>expect(target.hits).toHaveLength(2));
      let aSettled=false,bSettled=false;
      aReport=f.client.report(context,aInput.location,aInput.runId,signal()).then(value=>{aSettled=true;return value;});
      bReport=f.client.report(context,bInput.location,bInput.runId,signal()).then(value=>{bSettled=true;return value;});
      replaced=true;
      await expect(f.client.status(context,aInput.location,aInput.runId,signal())).rejects.toThrow('fixture-session-generation-changed');
      const requests=f.requests.length,stopped=await cleanupResult(()=>f.client.stopOwnedLocalRun(a));
      expect.soft(stopped.error).toBeNull();expect(stopped.value).toBeUndefined();
      await vi.waitFor(()=>expect(aSettled).toBe(true));
      expect(await aReport).toMatchObject({verdict:'cancelled'});
      if(stopped.error===null)await vi.waitFor(()=>expect(target.closed).toContain(0));
      expect(target.closed).not.toContain(1);expect(bSettled).toBe(false);
      expect(f.requests).toHaveLength(requests);expect(target.hits).toHaveLength(2);
    }finally{target.release();await f.client.close();await aReport;await bReport;await target.close();}
  });
  it('r50_owned_cleanup_stops_a_ready_local_before_any_business_and_prevents_later_start',async()=>{
    const target=await ownedCleanupTarget(),f=fixture(project=>setCleanupTarget(project,target.baseUrl));
    try{
      const input=savedCaseInput(f),prepared=await f.client.prepare(input,signal());
      expect(target.hits).toHaveLength(0);
      const requests=f.requests.length,stopped=await cleanupResult(()=>f.client.stopOwnedLocalRun(prepared));
      expect.soft(stopped.error).toBeNull();expect(stopped.value).toBeUndefined();
      expect(f.requests).toHaveLength(requests);
      const started=await f.client.start(prepared,'must-not-start-after-owned-stop',signal()).then(()=>({error:null}),error=>({error:error.message}));
      expect.soft(started.error).toBe('prepared-member-run-discarded');
      if(started.error===null)await vi.waitFor(()=>expect(target.hits).toHaveLength(1));
      expect(target.hits).toHaveLength(0);
    }finally{target.release();await f.client.close();await target.close();}
  });
  it('r50_owned_cleanup_is_void_and_idempotent_for_a_real_terminal_local',async()=>{
    const f=fixture();try{
      const prepared=await f.client.prepare(f.input,signal());await f.client.start(prepared,'terminal-owned-cleanup',signal());
      expect(await f.client.report(context,f.input.location,f.input.runId,signal())).toMatchObject({output:{kind:'workflow'}});
      const requests=f.requests.length;
      for(let repeat=0;repeat<2;repeat++){
        const stopped=await cleanupResult(()=>f.client.stopOwnedLocalRun(prepared));
        expect.soft(stopped.error).toBeNull();expect(stopped.value).toBeUndefined();
      }
      expect(f.requests).toHaveLength(requests);
    }finally{await f.client.close();}
  });
  it('r50_owned_cleanup_rejects_unknown_structural_foreign_and_agent_without_touching_active_work',async()=>{
    const target=await ownedCleanupTarget();
    const owner=await agentFixture(false,defaultPolicyConfig,project=>setCleanupTarget(project,target.baseUrl)),foreign=fixture();
    try{
      const localInput={...savedCaseInput(owner),runId:randomUUID(),location:{kind:'local' as const}},local=await owner.client.prepare(localInput,signal());
      await owner.client.start(local,'protected-owned-local',signal());await vi.waitFor(()=>expect(target.hits).toHaveLength(1));
      const other=await foreign.client.prepare(foreign.input,signal()),agent=await owner.client.prepare(owner.input,signal());
      await owner.client.start(agent,'protected-owned-agent',signal());
      const requests=owner.requests.length,foreignRequests=foreign.requests.length;
      for(const [candidate,reason] of [[{} as PreparedMemberRun,'unknown-prepared-member-run'],[{summary:local.summary} as PreparedMemberRun,'unknown-prepared-member-run'],[other,'unknown-prepared-member-run'],[agent,'owned-local-cleanup-not-supported']] as const){
        expect.soft((await cleanupResult(()=>owner.client.stopOwnedLocalRun(candidate))).error).toBe(reason);
      }
      expect(owner.requests).toHaveLength(requests);expect(foreign.requests).toHaveLength(foreignRequests);
      expect(await owner.client.status(context,localInput.location,localInput.runId,signal())).toMatchObject({state:'running'});
      expect(target.closed).toEqual([]);expect(target.hits).toHaveLength(1);
      expect(owner.requests.filter(row=>row.url.endsWith('/cancel'))).toHaveLength(0);expect(owner.counts()).toEqual({submissions:1,verifications:0});
    }finally{target.release();await owner.client.close();await foreign.client.close();await target.close();}
  });
  it('releases a known settled result after the existing history policy already evicted its run',async()=>{
    const f=fixture();try{
      const old=await f.client.prepare(f.input,signal());await f.client.start(old,'old-result-evicted-by-history',signal());await f.client.report(context,f.input.location,f.input.runId,signal());
      for(let index=0;index<100;index++){
        const input={...f.input,runId:randomUUID()},prepared=await f.client.prepare(input,signal());await f.client.start(prepared,`history-${index}`,signal());await f.client.report(context,input.location,input.runId,signal());
      }
      await expect(f.client.status(context,f.input.location,f.input.runId,signal())).rejects.toThrow('local-run-unavailable-no-backend-handoff');
      await f.client.releaseLocalResult(old);await expect(f.client.start(old,'old-result-evicted-by-history',signal())).rejects.toThrow('unknown-prepared-member-run');
    }finally{await f.client.close();}
  });
  it('does not release a later local run that reuses an evicted result runId',async()=>{
    const f=fixture();try{
      const old=await f.client.prepare(f.input,signal());await f.client.start(old,'old-evicted-result',signal());await f.client.report(context,f.input.location,f.input.runId,signal());
      for(let index=0;index<100;index++){
        const input={...f.input,runId:randomUUID()},prepared=await f.client.prepare(input,signal());await f.client.start(prepared,`evict-${index}`,signal());await f.client.report(context,input.location,input.runId,signal());
      }
      const replacement=await f.client.prepare(f.input,signal());await f.client.start(replacement,'replacement-with-same-run-id',signal());await f.client.report(context,f.input.location,f.input.runId,signal());
      await f.client.releaseLocalResult(old);
      expect(await f.client.report(context,f.input.location,f.input.runId,signal())).toMatchObject({output:{kind:'workflow'}});await f.client.releaseLocalResult(replacement);
    }finally{await f.client.close();}
  });
  it('r55_releases_exact_known_not_started_failure_without_touching_another_active_owner',async()=>{
    const target=await ownedCleanupTarget();let deny=false;
    const f=fixture(project=>setCleanupTarget(project,target.baseUrl),{response:url=>deny&&url.endsWith('/local-materials')?Response.json({code:'forbidden'},{status:403}):undefined}),foreign=fixture();
    try{
      const failed=await f.client.prepare(f.input,signal());deny=true;
      await expect(f.client.start(failed,'known-preinvoke-release',signal())).rejects.toMatchObject({code:'forbidden'});
      const fact=await f.client.report(context,f.input.location,f.input.runId,signal());
      expect(fact).toMatchObject({executionFact:'not-started',reasonCode:'forbidden'});expect(target.hits).toHaveLength(0);
      deny=false;const activeInput={...savedCaseInput(f),runId:randomUUID()},active=await f.client.prepare(activeInput,signal());
      await f.client.start(active,'other-active-owner',signal());await vi.waitFor(()=>expect(target.hits).toHaveLength(1));
      await expect(foreign.client.releaseLocalResult(failed)).rejects.toThrow('unknown-prepared-member-run');
      await expect(f.client.releaseLocalResult(active)).rejects.toThrow('local-result-not-releasable');
      const requests=f.requests.length,result=await cleanupResult(()=>f.client.releaseLocalResult(failed));
      expect.soft(result.error).toBeNull();expect(f.requests).toHaveLength(requests);
      expect.soft((await cleanupResult(async()=>{await f.client.status(context,f.input.location,f.input.runId,signal());})).error).toBe('local-run-unavailable-no-backend-handoff');
      expect(await f.client.status(context,activeInput.location,activeInput.runId,signal())).toMatchObject({state:'running'});
      expect(target.closed).toEqual([]);expect(target.hits).toHaveLength(1);
      target.release();expect(await f.client.report(context,activeInput.location,activeInput.runId,signal())).toMatchObject({output:{kind:'debug'}});
    }finally{target.release();await f.client.close();await foreign.client.close();await target.close();}
  });
  it('releases a known settled local result and its prepared ticket without issuing control requests',async()=>{
    const f=fixture();try{
      const prepared=await f.client.prepare(f.input,signal());await f.client.start(prepared,'release-known-terminal',signal());
      expect(await f.client.report(context,f.input.location,f.input.runId,signal())).toMatchObject({output:{kind:'workflow'}});
      const requests=f.requests.length;await f.client.releaseLocalResult(prepared);expect(f.requests).toHaveLength(requests);
      await expect(f.client.status(context,f.input.location,f.input.runId,signal())).rejects.toThrow('local-run-unavailable-no-backend-handoff');
      await expect(f.client.report(context,f.input.location,f.input.runId,signal())).rejects.toThrow('local-run-unavailable-no-backend-handoff');
      await expect(f.client.start(prepared,'release-known-terminal',signal())).rejects.toThrow('unknown-prepared-member-run');
    }finally{await f.client.close();}
  });
  it.each(['unknown','foreign'] as const)('rejects %s local result release without affecting the owning preparation',async kind=>{
    const owner=fixture(),other=fixture();try{
      const prepared=await owner.client.prepare(owner.input,signal());
      await expect(other.client.releaseLocalResult(kind==='unknown'?{summary:prepared.summary} as PreparedMemberRun:prepared)).rejects.toThrow('unknown-prepared-member-run');
      await owner.client.start(prepared,'foreign-release-owner-still-live',signal());expect(await owner.client.report(context,owner.input.location,owner.input.runId,signal())).toMatchObject({output:{kind:'workflow'}});
      expect(other.requests).toHaveLength(0);
    }finally{await owner.client.close();await other.client.close();}
  });
  it('rejects local result release before any start and leaves the ticket usable',async()=>{
    const f=fixture();try{
      const prepared=await f.client.prepare(f.input,signal());await expect(f.client.releaseLocalResult(prepared)).rejects.toThrow('local-result-not-releasable');
      await f.client.start(prepared,'not-released-unused',signal());expect(await f.client.report(context,f.input.location,f.input.runId,signal())).toMatchObject({output:{kind:'workflow'}});
    }finally{await f.client.close();}
  });
  it('releases only a terminal local run while another run and its reusable debug session remain live',async()=>{
    let entered!:()=>void,release!:()=>void;const active=new Promise<void>(resolve=>{entered=resolve;});let traffic=0;
    const target=createServer((_request,response)=>{traffic++;release=()=>response.end('owned-running-target');entered();});
    await new Promise<void>(resolve=>target.listen(0,'127.0.0.1',resolve));const address=target.address();if(!address||typeof address==='string')throw new Error('owned target missing');
    const f=fixture(project=>{const request=project.collections[0]!.apis[0]!.contract.request;request.baseUrl=`http://127.0.0.1:${address.port}`;request.path='/';request.auth={kind:'none'};if(request.protocol==='http')request.body={kind:'none'};});
    try{
      const terminal=await f.client.prepare(f.input,signal());await f.client.start(terminal,'terminal-for-isolation',signal());await f.client.report(context,f.input.location,f.input.runId,signal());
      const input={...savedCaseInput(f),runId:randomUUID()},running=await f.client.prepare(input,signal());await f.client.start(running,'active-for-isolation',signal());await active;
      const requests=f.requests.length;await f.client.releaseLocalResult(terminal);expect(f.requests).toHaveLength(requests);
      await expect(f.client.releaseLocalResult(running)).rejects.toThrow('local-result-not-releasable');
      expect(await f.client.status(context,input.location,input.runId,signal())).toMatchObject({state:'running'});expect(traffic).toBe(1);
      release();const result=await f.client.report(context,input.location,input.runId,signal());if(!('debugSessionId' in result)||!result.debugSessionId)throw new Error('expected reusable debug session');
      await f.client.releaseLocalResult(running);
      const reused=await f.client.prepare({...input,runId:randomUUID(),debugSessionId:result.debugSessionId},signal());await f.client.discardPrepared(reused);expect(traffic).toBe(1);
    }finally{release?.();await f.client.close();target.closeAllConnections();await new Promise<void>(resolve=>target.close(()=>resolve()));}
  });
  it('rejects releasing an actively executing local result without cancelling it',async()=>{
    let entered!:()=>void,release!:()=>void;const active=new Promise<void>(resolve=>{entered=resolve;});let traffic=0;
    const target=createServer((_request,response)=>{traffic++;release=()=>response.end('owned-active-result');entered();});
    await new Promise<void>(resolve=>target.listen(0,'127.0.0.1',resolve));const address=target.address();if(!address||typeof address==='string')throw new Error('owned target missing');
    const f=fixture(project=>{const request=project.collections[0]!.apis[0]!.contract.request;request.baseUrl=`http://127.0.0.1:${address.port}`;request.path='/';request.auth={kind:'none'};if(request.protocol==='http')request.body={kind:'none'};});
    try{
      const input=savedCaseInput(f),prepared=await f.client.prepare(input,signal());await f.client.start(prepared,'active-release-rejected',signal());await active;
      await expect(f.client.releaseLocalResult(prepared)).rejects.toThrow('local-result-not-releasable');
      expect(await f.client.status(context,input.location,input.runId,signal())).toMatchObject({state:'running'});release();expect(await f.client.report(context,input.location,input.runId,signal())).toMatchObject({output:{kind:'debug'}});expect(traffic).toBe(1);
    }finally{release?.();await f.client.close();target.closeAllConnections();await new Promise<void>(resolve=>target.close(()=>resolve()));}
  });
  it('refuses to release a settled uncertain local failure without forgetting its outcome',async()=>{
    let changed=false,traffic=0;const target=createServer((_request,response)=>{traffic++;changed=true;response.end('owned-response');});
    await new Promise<void>(resolve=>target.listen(0,'127.0.0.1',resolve));const address=target.address();if(!address||typeof address==='string')throw new Error('owned target missing');
    const f=fixture(project=>{const request=project.collections[0]!.apis[0]!.contract.request;request.baseUrl=`http://127.0.0.1:${address.port}`;request.path='/';request.auth={kind:'none'};if(request.protocol==='http')request.body={kind:'none'};},{assertCurrent:()=>{if(changed){changed=false;throw new Error('owned-after-start-failure');}}});
    try{
      const input=savedCaseInput(f),prepared=await f.client.prepare(input,signal());await f.client.start(prepared,'uncertain-local-result',signal());
      const report=await f.client.report(context,input.location,input.runId,signal());expect(report).toMatchObject({executionFact:'uncertain',reasonCode:'owned-after-start-failure'});
      await expect(f.client.releaseLocalResult(prepared)).rejects.toThrow('local-result-not-releasable');
      expect(await f.client.report(context,input.location,input.runId,signal())).toEqual(report);expect(traffic).toBe(1);
    }finally{await f.client.close();target.closeAllConnections();await new Promise<void>(resolve=>target.close(()=>resolve()));}
  });
  it.each([false,true])('refuses agent result release without cancelling or resubmitting (uncertain=%s)',async uncertain=>{
    const f=await agentFixture(uncertain);try{
      const prepared=await f.client.prepare(f.input,signal());await f.client.start(prepared,'agent-result-not-local',signal()).catch(error=>{if(!uncertain)throw error;});
      const requests=f.requests.length;await expect(f.client.releaseLocalResult(prepared)).rejects.toThrow('local-result-not-releasable');expect(f.requests).toHaveLength(requests);
      expect(await f.client.findIntent(context,'agent-result-not-local',signal())).toMatchObject({jobId:'99'});expect(f.counts()).toEqual({submissions:1,verifications:0});
    }finally{await f.client.close();}
  });
  it('abandons a local cancel wait while the already requested business cancellation continues',async()=>{
    let holding=false,entered!:()=>void,release!:()=>void,businessCancelled=false;
    const active=new Promise<void>(resolve=>{entered=resolve;});
    const f=fixture(undefined,{response:(url,init)=>{
      if(!holding||!url.endsWith('/local-materials'))return undefined;
      return new Promise<Response>(resolve=>{release=()=>resolve(Response.json({snapshotId:'66',scope:context.scope,credentials:[],attachments:[]}));init!.signal!.addEventListener('abort',()=>{businessCancelled=true;},{once:true});entered();});
    }});
    let starting:Promise<unknown>|undefined,waiting:Promise<unknown>|undefined;
    try{
      const prepared=await f.client.prepare(f.input,signal());holding=true;starting=f.client.start(prepared,'cancel-held-admission',signal()).catch(error=>error);await active;
      const controller=new AbortController();waiting=f.client.cancel(context,f.input.location,f.input.runId,controller.signal).then(value=>({value}),error=>({error:error.message}));
      expect(businessCancelled).toBe(true);controller.abort(new Error('stop-cancel-wait'));
      expect(await Promise.race([waiting,new Promise(resolve=>setImmediate(()=>resolve({error:'still-waiting'})))])).toEqual({error:'stop-cancel-wait'});
      release();await starting;expect(await f.client.report(context,f.input.location,f.input.runId,signal())).toMatchObject({verdict:'cancelled',executionFact:'not-started'});
      expect(f.requests.some(row=>row.url.endsWith('/jobs'))).toBe(false);
    }finally{release?.();await starting;await waiting;await f.client.close();}
  });
  it.each(['failure','abort','cancel'] as const)('reclaims fresh unused debug sessions after repeated %s without closing the client',async mode=>{
    let phase:'failing'|'valid'='failing',entered:()=>void=()=>{};
    const f=fixture(undefined,{response:(url,init)=>{
      if(!url.endsWith('/local-materials')||phase==='valid'||mode==='cancel')return undefined;
      if(mode==='failure')return Response.json({code:'material_access_denied'},{status:403});
      return new Promise<Response>((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>reject(init!.signal!.reason),{once:true});entered();});
    }});
    try{
      for(let index=0;index<defaultAgentConfig.maxDebugSessions;index++){
        const input={...savedCaseInput(f),runId:randomUUID()},controller=new AbortController();
        if(mode==='abort'){
          const active=new Promise<void>(resolve=>{entered=resolve;}),pending=f.client.prepare(input,controller.signal);
          await active;controller.abort(new Error('prepare-cancelled'));
          await expect(pending).rejects.toThrow('prepare-cancelled');
        }else if(mode==='failure')await expect(f.client.prepare(input,controller.signal)).rejects.toMatchObject({status:403});
        else{await f.client.prepare(input,controller.signal);await f.client.cancel(context,input.location,input.runId,signal());}
      }
      phase='valid';const prepared=await f.client.prepare({...savedCaseInput(f),runId:randomUUID()},signal());await f.client.discardPrepared(prepared);
      expect(f.requests.some(row=>row.url.endsWith('/jobs'))).toBe(false);
    }finally{await f.client.close();}
  });
  it('keeps a reused debug session available after a later preparation fails',async()=>{
    let fail=false;const f=fixture(project=>{project.collections[0]!.preOperations=[{id:'stop-before-target',type:'script',content:"throw new Error('owned-script-stop');"}];},{response:url=>fail&&url.endsWith('/local-materials')?Response.json({code:'material_access_denied'},{status:403}):undefined});
    try{
      const input=savedCaseInput(f),prepared=await f.client.prepare(input,signal());await f.client.start(prepared,'seed-session',signal());
      const result=await f.client.report(context,input.location,input.runId,signal());if(!('debugSessionId' in result)||!result.debugSessionId)throw new Error('expected owned debug session');
      const reuse={...input,runId:randomUUID(),debugSessionId:result.debugSessionId};fail=true;await expect(f.client.prepare(reuse,signal())).rejects.toMatchObject({status:403});
      fail=false;await f.client.discardPrepared(await f.client.prepare({...reuse,runId:randomUUID()},signal()));
    }finally{await f.client.close();}
  });
  it('redacts malformed successful local materials before rejecting prepare',async()=>{
    const f=fixture(undefined,{response:url=>url.endsWith('/local-materials')?new Response('private-material-response-marker',{status:200}):undefined});
    try{await expect(f.client.prepare(f.input,signal())).rejects.toThrow('execution-invalid-response');}finally{await f.client.close();}
  });
  it('cancels a pending asynchronous member token before transferring an HTTP request',async()=>{
    let entered!:()=>void,release!:(token:string)=>void,traffic=0;const active=new Promise<void>(resolve=>{entered=resolve;}),token=new Promise<string>(resolve=>{release=resolve;});
    const client=createMemberExecutionClient({session:{captureExecution:()=>({serverId:context.serverId,userId:'7',token:()=>{entered();return token;},assertCurrent(){}})},fetch:async()=>{traffic++;return Response.json(projectFixture().assets);}}),controller=new AbortController();
    const outcome=client.assets(context,controller.signal).then(value=>({value}),error=>({error:error.message}));
    try{await active;controller.abort(new Error('token-wait-cancelled'));expect(await Promise.race([outcome,new Promise(resolve=>setImmediate(()=>resolve({error:'still-waiting'})))])).toEqual({error:'token-wait-cancelled'});expect(traffic).toBe(0);}finally{release('member-token');await outcome;await client.close();}
  });
  it('cancels a pending material-token lookup during prepare without waiting for the provider',async()=>{
    let count=0,entered!:()=>void,release!:(token:string)=>void;const active=new Promise<void>(resolve=>{entered=resolve;}),pending=new Promise<string>(resolve=>{release=resolve;});
    const f=fixture(undefined,{token:()=>++count===3?(entered(),pending):'member-token'}),controller=new AbortController();
    const outcome=f.client.prepare(f.input,controller.signal).then(value=>({value}),error=>({error:error.message}));
    try{await active;controller.abort(new Error('material-token-cancelled'));expect(await Promise.race([outcome,new Promise(resolve=>setImmediate(()=>resolve({error:'still-waiting'})))])).toEqual({error:'material-token-cancelled'});expect(f.requests.some(row=>row.url.endsWith('/local-materials'))).toBe(false);}finally{release('member-token');await outcome;await f.client.close();}
  });
  it('rechecks the captured identity after an asynchronous material token resolves before sending it',async()=>{
    let count=0,changed=false;const f=fixture(undefined,{token:async()=>{if(++count===3)changed=true;return'member-token';},assertCurrent:()=>{if(changed)throw new Error('online-session-changed');}});
    try{await expect(f.client.prepare(f.input,signal())).rejects.toThrow('online-session-changed');expect(f.requests.some(row=>row.url.endsWith('/local-materials'))).toBe(false);}finally{await f.client.close();}
  });
  it('compiles scripted case preparation without running its script until start',async()=>{
    const f=fixture(project=>{project.collections[0]!.preOperations=[{id:'only-at-start',type:'script',content:"throw new Error('only-at-start-marker');"}];});
    try{const input=savedCaseInput(f),prepared=await f.client.prepare(input,signal());expect(prepared.summary.executionProfile).toBe('trusted-core-script');await f.client.start(prepared,'scripted-local',signal());const report=await f.client.report(context,input.location,input.runId,signal());expect(JSON.stringify(report)).toContain('only-at-start-marker');}finally{await f.client.close();}
  });
  it('closes an active local invocation and settles its existing report wait without replaying target traffic',async()=>{
    let entered!:()=>void,disconnected!:()=>void;const active=new Promise<void>(resolve=>{entered=resolve;}),gone=new Promise<void>(resolve=>{disconnected=resolve;});let traffic=0;
    const target=createServer((request,_response)=>{traffic++;request.once('close',disconnected);entered();});
    await new Promise<void>(resolve=>target.listen(0,'127.0.0.1',resolve));const address=target.address();if(!address||typeof address==='string')throw new Error('owned target missing');
    const f=fixture(project=>{const request=project.collections[0]!.apis[0]!.contract.request;request.baseUrl=`http://127.0.0.1:${address.port}`;request.path='/';request.auth={kind:'none'};if(request.protocol==='http')request.body={kind:'none'};});
    try{const input=savedCaseInput(f),prepared=await f.client.prepare(input,signal());await f.client.start(prepared,'close-running',signal());await active;const waiting=f.client.report(context,input.location,input.runId,signal());await f.client.close();expect(await waiting).toBeDefined();await gone;expect(traffic).toBe(1);}finally{await f.client.close();target.closeAllConnections();await new Promise<void>(resolve=>target.close(()=>resolve()));}
  });
  it.each([false,true])('reports fixed effective budgets and honest available configuration provenance (run overrides=%s)',async overrides=>{
    const policy={...defaultPolicyConfig,defaultJobTimeoutMs:15000,maxJobTimeoutMs:60000,scriptTimeoutMs:1500,maxScriptTimeoutMs:2500,cancelGraceMs:500,totalInputBytes:1048576,snapshotBytes:262144,singleAttachmentBytes:262144,reportBytes:1048576,workflowMetadataBytes:262144};
    const f=fixture(undefined,{response:url=>url.endsWith('/execution-agents')?Response.json({agents:[],defaultAgentId:null,canManageScripts:false,policyVersion:'4',policy}):undefined});
    const input={...f.input,environmentId:f.project.environments[0]!.id,...(overrides?{runConfig:{jobTimeoutMs:12345,scriptTimeoutMs:2222}}:{})};
    try{const prepared=await f.client.prepare(input,signal());expect(prepared.summary).toMatchObject({assetVersion:'1',environmentId:'00000000-0000-4000-8000-000000000019',targetKind:'workflow',executionProfile:'no-script',policyVersion:'4',budgets:{jobTimeoutMs:overrides?12345:15000,scriptTimeoutMs:overrides?2222:1500,cancelGraceMs:500,maxJobTimeoutMs:60000,maxScriptTimeoutMs:2500,totalInputBytes:1048576,reportBytes:1048576},sources:{policy:'project-effective',jobTimeoutMs:overrides?'run':'server-effective-policy',scriptTimeoutMs:overrides?'run':'server-effective-policy'},limitations:['policy-layer-provenance-unavailable','start-rechecks-current-authority']});expect(Object.isFrozen((prepared.summary as any).budgets)).toBe(true);}finally{await f.client.close();}
  });
  it('labels an agents server-calculated effective policy without claiming the original configuration layer',async()=>{
    const f=await agentFixture();try{const prepared=await f.client.prepare(f.input,signal());expect(prepared.summary).toMatchObject({location:{kind:'agent',agentId:'5'},sources:{policy:'agent-effective'},limitations:['policy-layer-provenance-unavailable','start-rechecks-current-authority']});}finally{await f.client.close();}
  });
  it('releases unused debug session handles on discard instead of exhausting the existing session capacity',async()=>{
    const f=fixture();try{for(let index=0;index<=defaultAgentConfig.maxDebugSessions;index++){const input={...savedCaseInput(f),runId:randomUUID()};const prepared=await f.client.prepare(input,signal());await f.client.discardPrepared(prepared);}expect(f.requests.some(row=>row.url.endsWith('/jobs'))).toBe(false);}finally{await f.client.close();}
  });
  // Inherited protections: these must pass on the extracted real preparation path, not be called new REDs.
  it('keeps insufficient script approval on the selected agent from reaching submission',async()=>{
    const f=await agentFixture(false,defaultPolicyConfig,project=>{project.collections[0]!.preOperations=[{id:'requires-approval',type:'script',content:"request.headers['X-Approved']='required';"}];});
    try{await expect(f.client.prepare(savedCaseInput(f),signal())).rejects.toThrow('script-admission-denied');expect(f.counts().submissions).toBe(0);}finally{await f.client.close();}
  });
  it('does not fall back from an unavailable fixed agent to local or a different agent',async()=>{
    const f=await agentFixture();try{await expect(f.client.prepare({...f.input,location:{kind:'agent',agentId:'6'}},signal())).rejects.toThrow('agent-unavailable');expect(f.requests.some(row=>row.url.endsWith('/execution-snapshots'))).toBe(false);expect(f.counts().submissions).toBe(0);}finally{await f.client.close();}
  });
  it('rejects an undeclared selected case data file before starting a run',async()=>{
    const f=fixture(project=>{project.collections[0]!.apis[0]!.cases[0]!.dataDriver={sourcePath:'missing.csv',format:'csv'};});
    try{await expect(f.client.prepare(savedCaseInput(f),signal())).rejects.toThrow('Declared input file is unavailable');expect(f.requests.some(row=>row.url.endsWith('/jobs'))).toBe(false);}finally{await f.client.close();}
  });
  it('discards only an unused preparation and releases its declared files while another local run stays active',async()=>{
    let release!:()=>void,entered!:()=>void;const active=new Promise<void>(resolve=>{entered=resolve;});let traffic=0;
    const target=createServer((_request,response)=>{traffic++;release=()=>response.end('other-run');entered();});
    await new Promise<void>(resolve=>target.listen(0,'127.0.0.1',resolve));const address=target.address();if(!address||typeof address==='string')throw new Error('owned target missing');
    const marker=`discard-${randomUUID()}`,bytes=Buffer.from(marker),hash=createHash('sha256').update(bytes).digest('hex'),ref={refId:'declared-file',version:'1',hash};
    const f=fixture(project=>{const request=project.collections[0]!.apis[0]!.contract.request;request.baseUrl=`http://127.0.0.1:${address.port}`;request.path='/';request.auth={kind:'none'};if(request.protocol==='http')request.body={kind:'none'};},{response:url=>url.endsWith('/local-materials')?Response.json({snapshotId:'66',scope:context.scope,credentials:[],attachments:[{...ref,kind:'file',size:bytes.length,contentBase64:bytes.toString('base64')}]}):undefined});
    const input:MemberRunInput={...f.input,materials:{projectId:'33',credentials:[],attachments:[ref],attachmentPaths:{'discard-fixture.txt':ref}}};
    try{
      const unused=await f.client.prepare(input,signal());expect(traffic).toBe(0);
      const files:string[]=[];for(const entry of await readdir(tmpdir(),{withFileTypes:true})){if(entry.isDirectory()&&entry.name.startsWith('apicc-run-materials-')){const file=join(tmpdir(),entry.name,'discard-fixture.txt');if(await readFile(file,'utf8').catch(()=>null)===marker)files.push(file);}}
      expect(files).toHaveLength(1);
      const asset=f.project.collections[0]!.apis[0]!,other:MemberRunInput={...f.input,runId:randomUUID(),target:{kind:'debug',invocation:{mode:'request',locator:{workspaceId:'11',groupId:'22',projectId:f.project.id,collectionId:f.project.collections[0]!.id,folderIds:[],apiId:asset.contract.id},request:asset.contract.request,parameters:{},fields:[]}}};
      const running=await f.client.prepare(other,signal());await f.client.start(running,'other-running',signal());await active;
      const controls=f.requests.length;await f.client.discardPrepared(unused);expect(f.requests).toHaveLength(controls);
      await expect(access(files[0]!)).rejects.toMatchObject({code:'ENOENT'});
      await expect(f.client.start(unused,'discarded',signal())).rejects.toThrow('prepared-member-run-discarded');
      expect(await f.client.status(context,other.location,other.runId,signal())).toMatchObject({state:'running'});expect(traffic).toBe(1);
      release();expect(await f.client.report(context,other.location,other.runId,signal())).toMatchObject({output:{kind:'debug'}});
    }finally{release?.();await f.client.close();target.closeAllConnections();await new Promise<void>(resolve=>target.close(()=>resolve()));}
  });
  it('rejects unknown and foreign-instance preparations at discard without affecting their owner',async()=>{
    const owner=fixture(),other=fixture();
    try{const issued=await owner.client.prepare(owner.input,signal());await expect(owner.client.discardPrepared(structuredClone(issued) as PreparedMemberRun)).rejects.toThrow('unknown-prepared-member-run');await expect(other.client.discardPrepared(issued)).rejects.toThrow('unknown-prepared-member-run');expect(other.requests).toEqual([]);expect(await owner.client.start(issued,'owner-kept',signal())).toMatchObject({runId:owner.input.runId});}finally{await owner.client.close();await other.client.close();}
  });
  it.each([false,true])('refuses discarding an already attempted agent start (uncertain=%s) without cancelling the server job',async uncertain=>{
    const f=await agentFixture(uncertain);
    try{const prepared=await f.client.prepare(f.input,signal());if(uncertain)await expect(f.client.start(prepared,'attempted',signal())).rejects.toThrow('owned-response-lost');else await f.client.start(prepared,'attempted',signal());const before=f.requests.length;await expect(f.client.discardPrepared(prepared)).rejects.toThrow('prepared-member-run-already-started');expect(f.requests).toHaveLength(before);expect(await f.client.findIntent(context,'attempted',signal())).toMatchObject({jobId:'99',state:'queued'});}finally{await f.client.close();}
  });
  it('keeps an issued preparation usable when its completed prepare call signal is later aborted',async()=>{
    const f=fixture(),preparing=new AbortController();
    try{const prepared=await f.client.prepare(f.input,preparing.signal);preparing.abort(new Error('old-prepare-cancel'));await expect(f.client.start(prepared,'independent-start',signal())).resolves.toMatchObject({runId:f.input.runId});expect(await f.client.report(context,f.input.location,f.input.runId,signal())).toMatchObject({output:{kind:'workflow'}});}finally{await f.client.close();}
  });
  it('aborts a pending local start admission through its own signal before invoking a target',async()=>{
    let holding=false,sawAbort=false,entered!:()=>void;const active=new Promise<void>(resolve=>{entered=resolve;});
    const f=fixture(undefined,{response:(url,init)=>holding&&url.endsWith('/local-materials')?new Promise<Response>((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>{sawAbort=true;reject(init.signal!.reason);},{once:true});entered();}):undefined});
    let outcome:Promise<unknown>|undefined;
    try{const prepared=await f.client.prepare(f.input,signal());holding=true;const controller=new AbortController();outcome=f.client.start(prepared,'cancel-admission',controller.signal).then(value=>({value}),error=>({error:error.message}));await active;controller.abort(new Error('start-interrupted'));await new Promise<void>(resolve=>setImmediate(resolve));expect(sawAbort).toBe(true);expect(await outcome).toEqual({error:'start-interrupted'});expect(await f.client.report(context,f.input.location,f.input.runId,signal())).toMatchObject({executionFact:'not-started'});}finally{await f.client.close();await outcome;}
  });
  it('aborts a report wait without cancelling an already started local invocation',async()=>{
    let release!:()=>void,entered!:()=>void;const active=new Promise<void>(resolve=>{entered=resolve;});
    const target=createServer((_request,response)=>{release=()=>response.end('completed');entered();});
    await new Promise<void>(resolve=>target.listen(0,'127.0.0.1',resolve));const address=target.address();if(!address||typeof address==='string')throw new Error('owned target missing');
    const f=fixture(project=>{const request=project.collections[0]!.apis[0]!.contract.request;request.baseUrl=`http://127.0.0.1:${address.port}`;request.path='/';request.auth={kind:'none'};if(request.protocol==='http')request.body={kind:'none'};});
    const asset=f.project.collections[0]!.apis[0]!,input:MemberRunInput={...f.input,target:{kind:'debug',invocation:{mode:'request',locator:{workspaceId:'11',groupId:'22',projectId:f.project.id,collectionId:f.project.collections[0]!.id,folderIds:[],apiId:asset.contract.id},request:asset.contract.request,parameters:{},fields:[]}}};
    try{const prepared=await f.client.prepare(input,signal()),starting=new AbortController();await f.client.start(prepared,'report-wait',starting.signal);await active;starting.abort(new Error('completed-start-call'));const reading=new AbortController();const outcome=f.client.report(context,input.location,input.runId,reading.signal).then(value=>({value}),error=>({error:error.message}));reading.abort(new Error('read-interrupted'));expect(await Promise.race([outcome,new Promise(resolve=>setImmediate(()=>resolve({error:'still-waiting'})))])).toEqual({error:'read-interrupted'});expect(await f.client.status(context,input.location,input.runId,signal())).toMatchObject({state:'running'});release();expect(await f.client.report(context,input.location,input.runId,signal())).toMatchObject({output:{kind:'debug'}});}finally{release?.();await f.client.close();target.closeAllConnections();await new Promise<void>(resolve=>target.close(()=>resolve()));}
  });
  it('reconciles an already accepted intent before rejecting an expired preparation',async()=>{
    const f=await agentFixture(false,{...defaultPolicyConfig,cancelGraceMs:10});f.input.runConfig={jobTimeoutMs:1000};
    try{const first=await f.client.prepare(f.input,signal());await f.client.start(first,'accepted-before-expiry',signal());const second=await f.client.prepare({...f.input,runId:randomUUID()},signal());await new Promise(resolve=>setTimeout(resolve,1050));const before=f.requests.filter(row=>row.url.endsWith('/execution-snapshots')).length;expect(await f.client.start(second,'accepted-before-expiry',signal())).toMatchObject({runId:'99',snapshotId:'66'});expect(f.requests.filter(row=>row.url.endsWith('/execution-snapshots'))).toHaveLength(before);expect(f.counts()).toEqual({submissions:1,verifications:1});}finally{await f.client.close();}
  });
  it('reports malformed control JSON without returning its private response text',async()=>{
    const client=createMemberExecutionClient({session:{captureExecution:()=>({serverId:context.serverId,userId:'7',token:()=> 'member-token',assertCurrent(){}})},fetch:async()=>new Response('private-response-marker-not-json')});
    try{const error=await client.assets(context,signal()).then(()=>null,cause=>cause as Error);expect(error?.message).toBe('execution-invalid-response');expect(error?.message).not.toContain('private-response-marker');}finally{await client.close();}
  });
  it.each(['','member\nbad'])('rejects a missing or malformed captured member token before HTTP (%j)',async token=>{
    let transferred=0;const client=createMemberExecutionClient({session:{captureExecution:()=>({serverId:context.serverId,userId:'7',token:async()=>token,assertCurrent(){}})},fetch:async()=>{transferred++;return Response.json(projectFixture().assets);}});
    try{await expect(client.assets(context,signal())).rejects.toThrow('missing-or-invalid-control-identity');expect(transferred).toBe(0);}finally{await client.close();}
  });
  it('rejects a captured user that differs from the context owner before preparation',async()=>{
    const f=fixture();let transferred=0;const client=createMemberExecutionClient({session:{captureExecution:()=>({serverId:context.serverId,userId:'8',token:()=> 'member-token',assertCurrent(){}})},fetch:async()=>{transferred++;return Response.json(f.assets);}});
    try{await expect(client.prepare(f.input,signal())).rejects.toThrow('online-session-changed');expect(transferred).toBe(0);}finally{await client.close();await f.client.close();}
  });
  it('bounds material transfer during prepare using the same member transport boundary',async()=>{
    const f=fixture(undefined,{response:url=>url.endsWith('/local-materials')?new Response(' '.repeat(1024),{headers:{'content-length':String(70*1024*1024)}}):undefined});
    try{await expect(f.client.prepare(f.input,signal())).rejects.toThrow('execution-response-too-large');}finally{await f.client.close();}
  });
  it.each(['http://control.test/api/v1','https://member:secret@control.test/api/v1','https://control.test/api/v1?secret=query','https://control.test/api/v1#secret'])('refuses an unsafe member control URL before transferring a token (%s)',async serverId=>{
    let transferred=0;const assets=projectFixture().assets;
    const client=createMemberExecutionClient({session:{captureExecution:()=>({serverId,userId:'7',token:()=> 'member-token',assertCurrent(){}})},fetch:async()=>{transferred++;return Response.json(assets);}});
    try{await expect(client.assets({...context,serverId},signal())).rejects.toThrow('execution-requires-https');expect(transferred).toBe(0);}finally{await client.close();}
  });
  it('bounds a streamed control response before parsing or exposing its private contents',async()=>{
    let chunks=0,cancelled=false;
    const client=createMemberExecutionClient({session:{captureExecution:()=>({serverId:context.serverId,userId:'7',token:()=> 'member-token',assertCurrent(){}})},fetch:async()=>new Response(new ReadableStream({pull(controller){if(chunks++<1100)controller.enqueue(new TextEncoder().encode(' '.repeat(65536)));else controller.close();},cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}})});
    try{await expect(client.assets(context,signal())).rejects.toThrow('execution-response-too-large');expect(chunks).toBeLessThan(1100);expect(cancelled).toBe(true);}finally{await client.close();}
  });
  it('reconciles an uncertain accepted agent intent through read-only verification without another submission',async()=>{
    const f=await agentFixture(true);
    try{
      const prepared=await f.client.prepare(f.input,signal());
      expect(f.counts()).toEqual({submissions:0,verifications:0});
      await expect(f.client.start(prepared,'uncertain-intent',signal())).rejects.toThrow('owned-response-lost');
      expect(await f.client.findIntent(context,'uncertain-intent',signal())).toMatchObject({jobId:'99'});
      const started=await f.client.start(prepared,'uncertain-intent',signal());
      expect(started).toMatchObject({runId:'99',location:{kind:'agent',agentId:'5'},snapshotId:'66',manifestHash:f.assets.manifestHash});
      expect(f.counts()).toEqual({submissions:1,verifications:1});
      expect(f.requests.filter(row=>row.url.endsWith('/execution-snapshots'))).toHaveLength(1);
    }finally{await f.client.close();}
  });
  it('cannot reuse the same prepared start under a different intent after acceptance',async()=>{
    const f=await agentFixture();
    try{const prepared=await f.client.prepare(f.input,signal());await f.client.start(prepared,'first-intent',signal());await expect(f.client.start(prepared,'different-intent',signal())).rejects.toThrow('intent_conflict');expect(f.counts().submissions).toBe(1);}finally{await f.client.close();}
  });
  it('does not resubmit an uncertain agent outcome when exact reconciliation still finds no job',async()=>{
    const f=await agentFixture(true);
    try{const prepared=await f.client.prepare(f.input,signal());await expect(f.client.start(prepared,'uncertain-absent',signal())).rejects.toThrow('owned-response-lost');f.hide();await expect(f.client.start(prepared,'uncertain-absent',signal())).rejects.toThrow('execution-outcome-uncertain');expect(f.counts().submissions).toBe(1);}finally{await f.client.close();}
  });
  it('verifies a second prepared input against the accepted intent instead of silently accepting changed run settings',async()=>{
    const f=await agentFixture();
    try{const first=await f.client.prepare(f.input,signal());await f.client.start(first,'fixed-intent',signal());const changed=await f.client.prepare({...f.input,runConfig:{jobTimeoutMs:59000}},signal());await expect(f.client.start(changed,'fixed-intent',signal())).rejects.toMatchObject({status:409,code:'intent_conflict'});expect(f.counts()).toEqual({submissions:1,verifications:1});}finally{await f.client.close();}
  });
  it('rejects local start after current server execution authorization is revoked with zero target requests', async () => {
    let revoked = false, traffic = 0;
    const target = createServer((_request,response)=>{traffic++;response.end('unexpected');});
    await new Promise<void>(resolve=>target.listen(0,'127.0.0.1',resolve));const address=target.address();if(!address||typeof address==='string')throw new Error('owned target missing');
    const f=fixture(project=>{const request=project.collections[0]!.apis[0]!.contract.request;request.baseUrl=`http://127.0.0.1:${address.port}`;request.path='/';request.auth={kind:'none'};if(request.protocol==='http')request.body={kind:'none'};},{response:url=>revoked&&url.endsWith('/local-materials')?Response.json({code:'forbidden'},{status:403}):undefined});
    const asset=f.project.collections[0]!.apis[0]!;
    const input:MemberRunInput={...f.input,target:{kind:'debug',invocation:{mode:'request',locator:{workspaceId:'11',groupId:'22',projectId:f.project.id,collectionId:f.project.collections[0]!.id,folderIds:[],apiId:asset.contract.id},request:asset.contract.request,parameters:{},fields:[]}}};
    try {
      const prepared=await f.client.prepare(input,signal());revoked=true;
      await expect(f.client.start(prepared,'revoked',signal())).rejects.toMatchObject({status:403,code:'forbidden'});
      expect(await f.client.report(context,input.location,input.runId,signal())).toMatchObject({executionFact:'not-started',reasonCode:'forbidden'});
      expect(traffic).toBe(0);expect(f.requests.filter(row=>row.url.endsWith('/execution-snapshots'))).toHaveLength(1);
    } finally {await f.client.close();target.closeAllConnections();await new Promise<void>(resolve=>target.close(()=>resolve()));}
  });
  it('rejects starting an issued preparation after the owning client closes', async()=>{
    const f=fixture();const prepared=await f.client.prepare(f.input,signal());await f.client.close();const before=f.requests.length;
    await expect(f.client.start(prepared,'after-close',signal())).rejects.toThrow('member-client-closed');
    expect(f.requests).toHaveLength(before);
  });
  // The network-only proxy password must be resolved only at start, never cached by prepare.
  it.each(['unchanged', 'changed'] as const)('pins a network-only secret version at prepare and resolves it only at start (%s)', async mode => {
    let resolved = 0, version = '1', proxyRequests = 0, authorized = false;
    const proxy = createServer((request,response) => { proxyRequests++; authorized = request.headers['proxy-authorization'] === `Basic ${Buffer.from('proxy-user:private-network-marker').toString('base64')}`; response.end('proxied'); });
    await new Promise<void>(resolve => proxy.listen(0,'127.0.0.1',resolve));
    const address = proxy.address(); if (!address || typeof address === 'string') throw new Error('owned proxy missing');
    const store: SecretStore = { async put() {}, async remove() {}, async status() { return 'available'; }, async version() { return version; }, async resolve(_scope,_ref,expected) { resolved++; if (expected !== version) throw new Error('unexpected-secret-version'); return 'private-network-marker'; } };
    const f = fixture(project => { const request = project.collections[0]!.apis[0]!.contract.request; request.baseUrl = 'http://owned-target.invalid'; request.path = '/fixed'; request.auth = {kind:'none'}; if(request.protocol === 'http')request.body={kind:'none'}; }, {localStore:()=>store});
    const asset = f.project.collections[0]!.apis[0]!;
    const input: MemberRunInput = { ...f.input, localOnlyRefIds: ['proxy-password'], target: {kind:'debug',invocation:{mode:'request',locator:{workspaceId:'11',groupId:'22',projectId:f.project.id,collectionId:f.project.collections[0]!.id,folderIds:[],apiId:asset.contract.id},request:asset.contract.request,parameters:{},fields:[]}}, network: { revision:'1', configuration:{formatVersion:1,profiles:[{id:'owned-proxy',name:'Owned proxy',kind:'proxy',proxyUrl:`http://127.0.0.1:${address.port}`,username:'proxy-user',passwordRef:{id:'proxy-password',policy:'test-auto'},targetTlsBindings:[]}],environmentSelections:[],projectSelection:{kind:'profile',profileId:'owned-proxy'}} } };
    try {
      const prepared = await f.client.prepare(input,signal());
      expect(prepared.summary.materialVersions).toEqual({'proxy-password':'1'});
      expect(resolved).toBe(0); expect(proxyRequests).toBe(0);
      expect(JSON.stringify(prepared)).not.toContain('private-network-marker');
      if(mode==='changed') version='2';
      if(mode==='changed') await expect(f.client.start(prepared,`network-${mode}`,signal())).rejects.toThrow('CREDENTIAL_VERSION_CONFLICT');
      else await f.client.start(prepared,`network-${mode}`,signal());
      const result = await f.client.report(context,input.location,input.runId,signal());
      if(mode==='changed') { expect(result).toMatchObject({executionFact:'not-started',reasonCode:'CREDENTIAL_VERSION_CONFLICT'}); expect(proxyRequests).toBe(0); expect(resolved).toBe(0); }
      else { expect(result).toMatchObject({output:{kind:'debug'}}); expect(proxyRequests).toBe(1); expect(authorized).toBe(true); expect(resolved).toBeGreaterThan(0); }
    } finally { await f.client.close(); proxy.closeAllConnections(); await new Promise<void>(resolve=>proxy.close(()=>resolve())); }
  });
  // Catches accepting a serialized/reconstructed ticket or crashing with an internal TypeError.
  it('rejects a reconstructed prepared value at the public boundary without starting a run', async () => {
    const f = fixture();
    try {
      const issued = await f.client.prepare(f.input, signal());
      const reconstructed = structuredClone(issued) as PreparedMemberRun;
      const before = f.requests.length;
      await expect(f.client.start(reconstructed, 'not-issued', signal())).rejects.toThrow('unknown-prepared-member-run');
      expect(f.requests).toHaveLength(before);
      expect(await f.client.status(context, f.input.location, f.input.runId, signal())).toMatchObject({ state: 'preparing' });
    } finally { await f.client.close(); }
  });
  it('rejects a ticket issued by another live client before using that clients preparation', async () => {
    const owner = fixture(), other = fixture();
    try {
      const ticket = await owner.client.prepare(owner.input, signal());
      await expect(other.client.start(ticket, 'foreign-instance', signal())).rejects.toThrow('unknown-prepared-member-run');
      expect(other.requests).toEqual([]);
      expect(await owner.client.status(context, owner.input.location, owner.input.runId, signal())).toMatchObject({ state: 'preparing' });
    } finally { await owner.client.close(); await other.client.close(); }
  });
  // Catches rebuilding latest assets at start or invoking Core during preparation.
  it('prepares without target traffic and starts the exact prepared snapshot before local completion', async () => {
    const paths: string[] = []; let release!: () => void; let entered!: () => void;
    const active = new Promise<void>(resolve => { entered = resolve; });
    const target = createServer((request, response) => { paths.push(request.url!); release = () => response.end('done'); entered(); });
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
    const address = target.address(); if (!address || typeof address === 'string') throw new Error('owned target missing');
    const f = fixture(project => { const request = project.collections[0]!.apis[0]!.contract.request; request.baseUrl = `http://127.0.0.1:${address.port}`; request.path = '/fixed'; request.auth = { kind: 'none' }; if (request.protocol === 'http') request.body = { kind: 'none' }; });
    const asset = f.project.collections[0]!.apis[0]!;
    const input = { ...f.input, target: { kind: 'debug' as const, invocation: { mode: 'request' as const, locator: { workspaceId: '11', groupId: '22', projectId: f.project.id, collectionId: f.project.collections[0]!.id, folderIds: [], apiId: asset.contract.id }, request: asset.contract.request, parameters: {}, fields: [] } } };
    try {
      const prepared = await f.client.prepare(input, signal());
      expect(paths).toEqual([]);
      expect(prepared.summary).toMatchObject({ snapshotId: '66', manifestHash: f.assets.manifestHash, location: { kind: 'local' } });
      input.target.invocation.request.path = '/changed-after-prepare';
      const started = await f.client.start(prepared, 'intent-local', signal());
      expect(started).toMatchObject({ runId: input.runId, location: { kind: 'local' }, snapshotId: '66', manifestHash: f.assets.manifestHash });
      await active;
      expect(await f.client.status(context, { kind: 'local' }, input.runId, signal())).toMatchObject({ state: 'running' });
      expect(paths).toEqual(['/fixed']); release();
      expect(await f.client.report(context, { kind: 'local' }, input.runId, signal())).toMatchObject({ runId: input.runId, snapshotId: '66', output: { kind: 'debug' } });
      expect(f.requests.filter(row => row.url.endsWith('/execution-snapshots'))).toHaveLength(1);
    } finally { release?.(); await f.client.close(); target.closeAllConnections(); await new Promise<void>(resolve => target.close(() => resolve())); }
  });
});
