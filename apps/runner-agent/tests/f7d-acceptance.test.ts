import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { f7dFixture } from './helpers/f7dFixture.js';
import { until, command } from './server-fixture.js';
import { createOnlineSession } from '../../desktop/src/main/online/session.js';
import { createOnlineClient } from '../../desktop/src/main/online/client.js';
import { prepareOnlineSchedule } from '../../desktop/src/main/online/scheduling.js';
import { prepareProjectFiles } from '@apicc/execution/host';
import { semanticProject } from './runtime-semantics.mjs';

// Regression targets: mutable snapshot use; duplicate/replayed scheduled Jobs;
// partial Job commit after backend death; deadline renewal; ACK-driven execution.
// Existing correct behavior is baseline, not manufactured RED.
describe.runIf(Boolean(process.env.APICC_F7D_ROOT))('F7d one serial private candidate',()=>{
  let f:Awaited<ReturnType<typeof f7dFixture>>;
  let session:ReturnType<typeof createOnlineSession>;
  let healthy=true;
  const plans:any[]=[];
  const history=(id:string)=>f.api('GET',f.projectPath+`/schedules/${id}/history`);
  const detail=(id:string)=>f.api('GET',f.projectPath+'/schedules/'+id);
  async function prepare(credentialBindings:any[]=[],previous?:any){return prepareOnlineSchedule({session,fetch:f.server.trustedFetch},{context:{serverId:f.context.baseUrl+'/api/v1',ownerId:f.context.ownerId,scope:{workspaceId:f.ws,groupId:f.context.group,projectId:f.projectId}},expectedVersion:f.assets().version,agentId:f.agentId,target:f.semanticTarget('suite'),environmentId:f.semanticIds.environment,runConfig:{jobTimeoutMs:30000},materials:{projectId:f.projectId,attachments:[]},credentialBindings,localOnlyRefIds:[],...(previous?{previous:{execution:previous.execution,snapshotVersion:previous.snapshotVersion,manifestHash:previous.manifestHash}}:{})});}
  async function plan(label:string,options:{delay?:number;queue?:number;execution?:any;notifications?:any;auth?:string}={}){
    const prepared=options.execution?{execution:options.execution}:await prepare();
    const row=await f.api('POST',f.projectPath+'/schedules',{name:label,rule:{kind:'once',atUtc:new Date(Date.now()+(options.delay??1500)).toISOString(),timeZone:'Asia/Shanghai'},policies:{lateToleranceMs:1000,misfire:'skip',catchupWindowMs:300000,overlap:'skip',queueTimeoutMs:options.queue??30000},execution:prepared.execution,notifications:options.notifications??{inApp:true,eventKinds:['succeeded','failed','abnormal','expired','paused'],channelIds:[]}},options.auth);
    const enabled=await f.api('PUT',f.projectPath+'/schedules/'+row.id,{expectedVersion:row.version,enabled:true},options.auth);plans.push(enabled);return enabled;
  }
  async function jobFor(id:string){return until(async()=>(await history(id)).items[0],row=>Boolean(row?.jobId));}
  async function archived(id:string){const occurrence=await jobFor(id);const job=await until(()=>f.api('GET','jobs/'+occurrence.jobId),row=>row.state==='ended'&&row.executionReleased&&row.reportState==='archived');return {occurrence,job,report:await f.api('GET','jobs/'+job.jobId+'/report')};}
  const checked=(name:string,action:()=>Promise<void>)=>async()=>{try{await action();f.evidence(name,{passed:true,targetRequests:f.targetRequests.length});}catch(error){healthy=false;f.evidence(name,{passed:false,error:String(error)});throw error;}};
  beforeAll(async()=>{
    f=await f7dFixture(process.env.APICC_F7D_ROOT!);
    session=createOnlineSession({createClient:(baseUrl,hooks)=>createOnlineClient({baseUrl,fetch:f.server.trustedFetch,onUnauthorized:hooks.onUnauthorized}),tokenStore:{save(){},load(){return null;},clear(){}}});
    await session.login({baseUrl:f.context.baseUrl,username:f.context.username,password:f.context.password});session.openWorkspace({workspaceId:f.ws,name:'F7d synthetic',myRole:'OWNER'});
    if(!process.env.APICC_F7D_RESUME_ROOT)await f.db('CREATE TRIGGER f7d_after_job_insert AFTER INSERT ON execution_jobs FOR EACH ROW CALL \'F7dDatabase$AfterJobInsert\'');
    f.evidence('baseline-db-time',{epoch:await f.db('SELECT APICC_SCHEDULER_EPOCH_MILLIS()'),databasePid:f.context.databasePid,javaPid:f.server.serverPid()});
  },120000);
  afterAll(async()=>{
    if(!f)return;
    try{
      if(healthy&&process.env.APICC_F7D_HOLD_FOR_UI==='1'){
        await f.prepareUiProfile();
        const context={...f.context,plans,assetsVersion:f.assets().version,remainingMs:1800000,readyAt:new Date().toISOString()};
        f.record('ui-context',context);console.log('F7D_UI_READY '+join(f.root,'ui-context.json'));
        const deadline=Date.now()+1800000;
        while(!existsSync(f.context.releaseFile)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,500));
        f.evidence('ui-release',{released:existsSync(f.context.releaseFile),at:new Date().toISOString()});
      }
    }finally{try{await f.barrier('release');}finally{await f.close();}}
  },process.env.APICC_F7D_HOLD_FOR_UI==='1'?1860000:60000);

  it('AC1 saves immutable snapshot and current-at-trigger resolves actual rotated version',checked('AC1-snapshot-current',async()=>{
    const fixed=await prepare();const saved=await f.api('POST',f.projectPath+'/schedules',{name:'固定快照 / Immutable snapshot '+ '长名称'.repeat(20),rule:{kind:'once',atUtc:new Date(Date.now()+30000).toISOString(),timeZone:'Asia/Shanghai'},policies:{lateToleranceMs:1000,misfire:'skip',catchupWindowMs:300000,overlap:'skip',queueTimeoutMs:30000},execution:fixed.execution,notifications:{inApp:true,eventKinds:['succeeded','failed','abnormal','expired','paused'],channelIds:[]}});plans.push(saved);
    const changed=structuredClone(f.initial);changed.variables!.path='edited-project';await f.publish(changed);
    const still=await detail(saved.id);expect(still.execution).toEqual(saved.execution);expect(still.snapshotVersion).toBe(saved.snapshotVersion);expect(still.manifestHash).toBe(saved.manifestHash);
    const refresh=await prepare([],saved);expect(refresh.snapshotDiff.areas.some(area=>area.changed)).toBe(true);f.record('snapshot-diff',{before:saved,after:refresh});
    await f.api('PUT',f.projectPath+'/credentials/synthetic-credential',{expectedVersion:'1',value:'f7d-synthetic-secret-v2'});
    const before=f.targetRequests.length;const current=await plan('current-at-trigger uses v2',{execution:fixed.execution});const result=await archived(current.id);
    expect(f.targetRequests.slice(before)).toEqual([expect.objectContaining({path:'/plain',credentialVersion:'2'})]);expect(result.report.verdict).toBe('passed');
    f.record('immutable-completed',result);
  }),60000);

  it('AC1 fixed credential rotation refuses before target and records safe cause',checked('AC1-fixed-rotation',async()=>{
    const prepared=await prepare([{refId:'synthetic-credential',mode:'fixed-version',version:'2'}]);
    const row=await plan('fixed-version rejected after rotation',{delay:2000,execution:prepared.execution});
    await f.api('PUT',f.projectPath+'/credentials/synthetic-credential',{expectedVersion:'2',value:'f7d-synthetic-secret-v1'});
    const before=f.targetRequests.length;const result=await until(()=>detail(row.id),value=>!value.enabled&&Boolean(value.pausedReasonCode));
    expect(result.pausedReasonCode).toBe('credential_version_conflict');expect(f.targetRequests).toHaveLength(before);f.record('fixed-rotation',await history(row.id));
  }),30000);

  it('AC3 actual backend down across due time records default skipped gap',checked('AC3-before-due',async()=>{
    const row=await plan('backend outage skips missed due',{delay:1500});const before=f.targetRequests.length;const pid=f.server.serverPid();await f.server.stop();
    // Absolute business boundary is read from saved rule; no guessed kill timing.
    const boundary=Date.parse(row.rule.atUtc)+1200;await until(async()=>Date.now(),value=>value>boundary,5000);
    await f.restart();expect(f.server.serverPid()).not.toBe(pid);
    const result=await until(()=>history(row.id),value=>value.missedWindows.length>0);
    expect(result.items).toHaveLength(0);expect(result.missedWindows[0].reasonCode).toBe('schedule-misfire-skipped');expect(f.targetRequests).toHaveLength(before);f.record('restart-before-due',result);
  }),60000);

  it('AC3 kill actual Java after observed partial Job insert rolls back zero Job/origin/link',checked('AC3-uncommitted-insert',async()=>{
    const before=Number(await f.db('SELECT COUNT(*) FROM execution_jobs'));
    await f.barrier('arm');const row=await plan('rollback after actual insert',{delay:1500,queue:30000});
    const observed=await until(()=>f.barrier('barrier'),value=>value.startsWith('inserted '));
    expect(observed).toContain('transactionVisibleJobs='+(before+1));
    expect(Number(await f.db('SELECT COUNT(*) FROM execution_jobs'))).toBe(before);
    const [occurrenceId,uncommittedLink]= (await f.db('SELECT id,job_id FROM execution_schedule_occurrences WHERE schedule_id='+row.id)).split('\t');expect(uncommittedLink).toBe('null');
    const killed=f.server.serverPid();await f.server.stop();await f.barrier('release');
    await until(()=>f.db('SELECT COUNT(*) FROM execution_jobs'),value=>Number(value)===before);
    const rollback={observed,killed,committedJobs:await f.db('SELECT COUNT(*) FROM execution_jobs'),originJobs:await f.db('SELECT COUNT(*) FROM execution_jobs WHERE schedule_id='+row.id),linked:await f.db('SELECT COUNT(*) FROM execution_schedule_occurrences WHERE schedule_id='+row.id+' AND job_id IS NOT NULL')};
    expect(rollback.originJobs).toBe('0');expect(rollback.linked).toBe('0');f.record('rollback-before-restart',rollback);
    await f.restart();const result=await archived(row.id);expect(result.occurrence.id).toBe(occurrenceId);expect(await f.db('SELECT COUNT(*) FROM execution_jobs WHERE schedule_id='+row.id)).toBe('1');f.record('rollback-recovery',result);
  }),90000);

  it('AC3 committed Job survives actual Java restart without replacement',checked('AC3-post-commit',async()=>{
    f.server.faults.offline=true;const before=f.targetRequests.length;
    try{
      const row=await plan('restart after committed Job');const occurrence=await jobFor(row.id);
      const committed=await f.db('SELECT id,execution_id,schedule_occurrence_id FROM execution_jobs WHERE id='+occurrence.jobId);expect(committed.split('\t')).toHaveLength(3);
      await f.restart();f.server.faults.offline=false;const result=await archived(row.id);
      expect(result.occurrence.jobId).toBe(occurrence.jobId);expect(result.occurrence.executionId).toBe(occurrence.executionId);expect(await f.db('SELECT COUNT(*) FROM execution_jobs WHERE schedule_id='+row.id)).toBe('1');expect(f.targetRequests.length-before).toBe(1);f.record('postcommit-restart',{committed,result});
    }finally{f.server.faults.offline=false;}
  }),90000);

  it('AC4 offline recovery before queue deadline preserves original assignment; after deadline expires',checked('AC4-offline-deadlines',async()=>{
    f.server.faults.offline=true;let first:any;
    try{const row=await plan('offline recovers before fixed deadline',{queue:30000});first=await jobFor(row.id);f.server.faults.offline=false;const result=await archived(row.id);expect(result.occurrence.jobId).toBe(first.jobId);expect(result.job.agentId).toBe(f.agentId);}
    finally{f.server.faults.offline=false;}
    f.server.faults.offline=true;
    try{const before=f.targetRequests.length;const row=await plan('offline expires after fixed deadline',{queue:1000});const occurrence=await jobFor(row.id);await until(async()=>Date.now(),value=>value>Date.parse(occurrence.queueDeadlineUtc),5000);f.server.faults.offline=false;const job=await until(()=>f.api('GET','jobs/'+occurrence.jobId),value=>value.state==='ended');expect(job.summary.reasonCode).toBe('queue_timeout');expect(job.agentId).toBe(f.agentId);expect(f.targetRequests).toHaveLength(before);f.record('offline-expired',{occurrence,job});}
    finally{f.server.faults.offline=false;}
  }),60000);

  it('AC3/4 after actual started event target barrier resumes same execution after restart/control outage',checked('AC3-AC4-started-recovery',async()=>{
    const changed=structuredClone(f.initial);changed.variables!.path='hold-running';await f.publish(changed);
    const row=await plan('started before backend restart');const occurrence=await jobFor(row.id);
    await until(()=>f.api('GET','jobs/'+occurrence.jobId),job=>job.state==='running');await until(async()=>f.holds.has('/hold-running'),Boolean);const intent=await f.ledger(occurrence.executionId);expect(intent.fact).toBe('started');expect(intent.jobId).toBe(occurrence.jobId);
    const before=f.targetRequests.length;f.server.faults.offline=true;
    try{await f.restart();f.holds.get('/hold-running')!.end('{"token":"fixed-token"}');f.holds.delete('/hold-running');f.server.faults.offline=false;const result=await archived(row.id);expect(result.occurrence.jobId).toBe(occurrence.jobId);expect(result.occurrence.executionId).toBe(occurrence.executionId);expect(f.targetRequests).toHaveLength(before);f.record('started-recovery',result);}
    finally{f.server.faults.offline=false;}
    await f.publish(f.initial);
  }),90000);

  it('AC8 lost webhook ACK retries stable event/body without another Job or target call',checked('AC8-lost-ack',async()=>{
    const channel=await f.api('POST',`workspaces/${f.ws}/notification-channels`,{expectedVersion:'0',name:'F7d HTTP synthetic sink',url:f.sinkOrigin+'/events?synthetic=1',hmacSecret:'f7d-synthetic-hmac-key-32-bytes',enabled:true});
    f.dropWebhookAck();const offset=f.sinkRequests.length,before=f.targetRequests.length;
    const row=await plan('Webhook ACK lost / 通知回执丢失',{notifications:{inApp:true,eventKinds:['succeeded','failed','abnormal','expired','paused'],channelIds:[channel.id]}});const result=await archived(row.id);
    await until(async()=>f.sinkRequests.slice(offset),requests=>requests.length>=2);const requests=f.sinkRequests.slice(offset);
    expect(requests[0].body).toBe(requests[1].body);expect(requests[0].eventId).toBe(JSON.parse(requests[0].body).id);expect(requests[1].eventId).toBe(requests[0].eventId);expect(f.targetRequests.length-before).toBe(1);expect(await f.db('SELECT COUNT(*) FROM execution_jobs WHERE schedule_id='+row.id)).toBe('1');
    const publicView=await until(()=>f.api('GET',f.projectPath+`/schedules/${row.id}/notification-history`),value=>value.items.some((item:any)=>item.deliveries.some((delivery:any)=>delivery.state==='acknowledged')));expect(JSON.stringify(publicView)).not.toContain('f7d-synthetic-hmac-key');f.record('lost-ack',{result,requests,publicView});
  }),60000);

  it('AC7 current subject, membership, project and scheduling grant are rechecked before any request',checked('AC7-authority-revocation',async()=>{
    // Removing these authority checks would send a target request under revoked rights.
    const execution=(await prepare()).execution;
    const results=[];
    for(const change of ['disabled','membership','project-role','schedule-grant']){
      const username='f7d-'+change;
      await f.api('POST','auth/register',{username,password:'f7d-password8',displayName:'F7d '+change+' '+ '长名称'.repeat(3)},'');
      const member=await f.api('POST','auth/login',{username,password:'f7d-password8'},'');const userId=member.user.id;
      await f.api('PUT',`workspaces/${f.ws}/members/${userId}`,{role:'EDITOR'});
      let grant=await f.api('GET',f.projectPath+'/schedule-grants');await f.api('PUT',f.projectPath+'/schedule-grants',{expectedVersion:grant.version,userIds:[...grant.userIds,userId]});
      const row=await plan('原主体撤销 / '+change,{execution,auth:member.token,delay:2000});const before=f.targetRequests.length;
      if(change==='disabled')await f.db('UPDATE users SET disabled=TRUE WHERE id='+userId);
      else if(change==='membership')await f.api('DELETE',`workspaces/${f.ws}/members/${userId}`);
      else if(change==='project-role')await f.api('PUT',f.projectPath+'/acl',{userId,role:'VIEWER'});
      else{grant=await f.api('GET',f.projectPath+'/schedule-grants');await f.api('PUT',f.projectPath+'/schedule-grants',{expectedVersion:grant.version,userIds:grant.userIds.filter((id:string)=>id!==userId)});}
      const final=await until(()=>detail(row.id),value=>!value.enabled&&Boolean(value.pausedReasonCode));
      expect(final.pausedReasonCode).toBe(change==='disabled'?'schedule-subject-unavailable':'schedule-subject-unauthorized');expect(f.targetRequests).toHaveLength(before);expect(await f.db('SELECT COUNT(*) FROM execution_jobs WHERE schedule_id='+row.id)).toBe('0');results.push({change,final,history:await history(row.id)});
    }
    const paused=plans[0];await expect(f.api('PUT',f.projectPath+'/schedules/'+paused.id,{expectedVersion:'999',name:'must conflict'})).rejects.toThrow('version_conflict');
    f.record('authority-revocation',results);
  }),60000);

  it('AC1/7 queued material rotation and script approval removal deny actual start before target',checked('AC1-AC7-start-authority',async()=>{
    const results=[];
    for(const change of ['material','script']){
      if(change==='script'){
        await f.publish(semanticProject(f.origin,true));
        const prepared=await prepareProjectFiles(f.assets(),{target:f.semanticTarget('suite'),environmentId:f.semanticIds.environment,profile:'trusted-core-script'});
        const grant=await f.api('GET',f.projectPath+'/script-grants?agentId='+f.agentId);
        await f.api('PUT',f.projectPath+'/script-grants',{agentId:f.agentId,expectedVersion:grant.version,scope:'script-version',scripts:prepared.scriptRequirements.map(({scriptId,contentHash})=>({scriptId,contentHash})),riskConfirmed:true});
      }
      f.server.faults.offline=true;
      try{
        const row=await plan('排队后撤销 / '+change);const occurrence=await jobFor(row.id);const before=f.targetRequests.length;
        if(change==='material'){
          const metadata=await f.api('GET',f.projectPath+'/schedules/material-options');const old=metadata.credentials.find((value:any)=>value.refId==='synthetic-credential');
          await f.api('PUT',f.projectPath+'/credentials/synthetic-credential',{expectedVersion:old.version,value:'f7d-synthetic-secret-v2'});
        }else{
          const grant=await f.api('GET',f.projectPath+'/script-grants?agentId='+f.agentId);
          await f.api('PUT',f.projectPath+'/script-grants',{agentId:f.agentId,expectedVersion:grant.version,scope:'script-version',scripts:[],riskConfirmed:true});
        }
        f.server.faults.offline=false;
        const job=await until(()=>f.api('GET','jobs/'+occurrence.jobId),value=>value.state==='ended');
        expect(job.summary.reasonCode).toBe(change==='material'?'credential_version_conflict':'script_grant_missing');expect(f.targetRequests).toHaveLength(before);results.push({change,occurrence,job});
      }finally{f.server.faults.offline=false;}
    }
    await f.publish(f.initial);f.record('queued-authority-revocation',results);
  }),60000);

  it('AC7 revoked project agent association blocks original queued Job without selecting another agent',checked('AC7-agent-association',async()=>{
    f.server.faults.offline=true;
    try{
      const row=await plan('代理项目授权撤销');const occurrence=await jobFor(row.id);const before=f.targetRequests.length;
      await f.api('PUT',`workspaces/${f.ws}/agent-project-allocations`,{agentId:f.agentId,projectIds:[]});f.server.faults.offline=false;
      const job=await until(()=>f.api('GET','jobs/'+occurrence.jobId),value=>value.state==='ended');expect(job.agentId).toBe(f.agentId);expect(job.summary.reasonCode).toBe('agent_not_associated');expect(f.targetRequests).toHaveLength(before);f.record('agent-association-revocation',{occurrence,job});
    }finally{
      f.server.faults.offline=false;await f.api('PUT',`workspaces/${f.ws}/agent-project-allocations`,{agentId:f.agentId,projectIds:[f.projectId]});const settings=await f.api('GET',f.projectPath+'/execution-settings');await f.api('PUT',f.projectPath+'/execution-settings',{expectedVersion:settings.configVersion,agentIds:[f.agentId],defaultAgentId:f.agentId});
    }
  }),60000);

  it.runIf(process.env.APICC_F7D_FINAL_FIX==='1')('final unified repair real history, outbound reason, safe pause and sealed caps',checked('final-unified-repair',async()=>{
    const pass=await plan('Final repair passed / 成功通知关闭',{notifications:{inApp:false,eventKinds:[],channelIds:[]}});const passed=await archived(pass.id);
    expect((await history(pass.id)).items[0].execution.verdict).toBe('passed');expect((await f.api('GET',f.projectPath+'/schedules/'+pass.id+'/notification-history')).items).toHaveLength(0);
    const failing=structuredClone(f.initial);failing.collections[0]!.apis[0]!.cases[0]!.assertions=[{id:'controlled-failure',target:'status',op:'eq',expected:'201'}];await f.publish(failing);
    const channel=await f.api('POST',`workspaces/${f.ws}/notification-channels`,{expectedVersion:'0',name:'Final repair real 302 receiver',url:f.sinkOrigin+'/final-events',hmacSecret:'f7d-synthetic-hmac-key-32-bytes',enabled:true});f.setWebhookStatus(302);
    const failed=await plan('Final repair failed / 真实302通知',{notifications:{inApp:true,eventKinds:['failed'],channelIds:[channel.id]}});const failure=await archived(failed.id);
    expect((await history(failed.id)).items[0].execution.verdict).toBe('failed');
    const notification=await until(()=>f.api('GET',f.projectPath+'/schedules/'+failed.id+'/notification-history'),page=>page.items.some((event:any)=>event.deliveries.some((d:any)=>d.reasonCode==='http-terminal')));
    expect(notification.items[0].deliveries[0]).toMatchObject({state:'failed',reasonCode:'http-terminal',status:302,attempts:1});expect(f.targetRequests).toHaveLength(2);
    const pause=await plan('Final repair revoked-channel pause',{delay:60000,notifications:{inApp:false,eventKinds:[],channelIds:[channel.id]}});
    await f.api('PUT',`workspaces/${f.ws}/notification-channels/${channel.id}`,{expectedVersion:'1',enabled:false});
    const paused=await f.api('PUT',f.projectPath+'/schedules/'+pause.id,{expectedVersion:pause.version,enabled:false});expect(paused.enabled).toBe(false);expect(paused.notifications.channelIds).toEqual([channel.id]);expect((await history(pause.id)).items).toHaveLength(0);
    await f.publish(f.initial);f.server.faults.offline=true;
    let caps;
    try{
      const first=await plan('Final cap sealed before lower',{delay:1500,queue:30000,notifications:{inApp:false,eventKinds:[],channelIds:[]}});
      const second=await plan('Final cap admitted after lower',{delay:6000,queue:30000,notifications:{inApp:false,eventKinds:[],channelIds:[]}});
      const old=await jobFor(first.id);const policy=await f.api('GET',`workspaces/${f.ws}/schedule-policy`);
      await f.api('PUT',`workspaces/${f.ws}/schedule-policy`,{expectedVersion:policy.version,policy:{queueTimeoutMs:1000,maxQueueTimeoutMs:1000}});
      const fresh=await jobFor(second.id);expect(Date.parse(old.queueDeadlineUtc)-Date.parse(old.plannedAtUtc)).toBe(30000);expect(Date.parse(fresh.queueDeadlineUtc)-Date.parse(fresh.plannedAtUtc)).toBe(1000);
      expect((await history(first.id)).items[0].queueDeadlineUtc).toBe(old.queueDeadlineUtc);expect((await detail(second.id)).policies.queueTimeoutMs).toBe(30000);expect((await detail(second.id)).revision).toBe('1');
      await f.api('POST','jobs/'+old.jobId+'/cancel',{});await f.api('POST','jobs/'+fresh.jobId+'/cancel',{});caps={old,fresh,loweredPolicy:await f.api('GET',`workspaces/${f.ws}/schedule-policy`)};
    }finally{f.server.faults.offline=false;}
    expect(f.targetRequests).toHaveLength(2);f.record('final-repair-facts',{passed:{plan:pass,...passed,history:await history(pass.id)},failed:{plan:failed,...failure,history:await history(failed.id),notification},paused,caps,targetRequests:f.targetRequests,receiverRequests:f.sinkRequests});
  }),60000);

  it.runIf(Boolean(process.env.APICC_F7D_RESUME_ROOT))('UI context resumes retained identities without replaying prior jobs',checked('UI-resume-history',async()=>{
    const saved=await f.api('GET',f.projectPath+'/schedules?limit=100');plans.push(...saved.items);
    expect(saved.items.length).toBeGreaterThanOrEqual(11);
    const completed=await f.db("SELECT id,execution_id FROM execution_jobs WHERE state='ended' AND report_state='archived' ORDER BY id LIMIT 1");
    const [jobId,executionId]=completed.split('\t');expect(jobId).toMatch(/^\d+$/);
    const job=await f.api('GET','jobs/'+jobId),report=await f.api('GET','jobs/'+jobId+'/report');expect(job.executionId).toBe(executionId);expect(report.verdict).toBe('passed');
    const ledger=await f.ledger(executionId);expect(ledger.jobId).toBe(jobId);expect(ledger.settled).toBe(true);
    if(saved.items.some((row:any)=>row.name==='AC2 desktop-close UI')){
      const identity=await f.db("SELECT o.id,j.id,j.execution_id,j.agent_id,j.report_hash,j.report_bytes FROM execution_schedule_occurrences o JOIN execution_schedules s ON s.id=o.schedule_id JOIN execution_jobs j ON j.schedule_occurrence_id=o.id WHERE s.name='AC2 desktop-close UI'");
      expect(identity).toBe('16\t29\t30\t1\t06306e7b2f5c0033a6ed00377b24f6566498dee7ee345d1db5e979e74c7d5a56\t3469');
      const original=await f.api('GET','jobs/29');expect(original).toMatchObject({executionId:'30',agentId:'1',reportState:'archived'});
      expect((await f.api('GET','jobs/29/report')).verdict).toBe('passed');
      f.record('ac2-resumed-identity',{identity,job:original,newTargetRequests:f.targetRequests.length});
    }
    expect(f.targetRequests).toHaveLength(0);f.record('resumed-history',{source:f.context.resumedFrom,jobId,executionId,ledger,reportVerdict:report.verdict,plans:saved.items.map((row:any)=>({id:row.id,snapshotVersion:row.snapshotVersion,revision:row.revision})),newTargetRequests:0});
  }),30000);
});
