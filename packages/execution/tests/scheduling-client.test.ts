import { describe,it,expect } from 'vitest';
import { ScheduleSaveSchema,ScheduleUpdateSchema,ScheduleViewSchema,ScheduleOptionsSchema } from '../src/contract/scheduling.js';
import type {ScheduleExecution,ScheduleSave} from '../src/contract/scheduling.js';
import { createSchedulingClient } from '../src/client/scheduling.js';
import {ScheduleHistoryPageSchema,ScheduleHistoryExecutionSchema,SchedulerControlSchema} from '../src/contract/scheduling.js';
import {readFileSync} from 'node:fs';
const realHistory=JSON.parse(readFileSync(new URL('../../../server/src/test/resources/scheduling/history.json',import.meta.url),'utf8'));

const hash='a'.repeat(64),uuid='10000000-0000-4000-8000-000000000001';
export const execution:ScheduleExecution={agentId:'5',snapshotId:'6',target:{kind:'suite',suiteId:uuid,allowDraft:false},runConfig:{jobTimeoutMs:60000},materials:{projectId:'3',credentials:[{refId:'api',mode:'current-at-trigger'}],attachments:[]},preparation:{scope:{workspaceId:'1',groupId:'2',projectId:'3'},manifestHash:hash,scriptPlanDigest:hash,scriptRequirements:[],executionProfile:'no-script',dispatchKind:'dedicated-task',requiredCoreBuildId:hash,requiredCapabilities:['task:suite'],runtimeCompatibilityId:'node-test'}};
export const save:ScheduleSave={name:'每日回归',rule:{kind:'once',atUtc:'2030-01-01T00:00:00Z',timeZone:'Asia/Shanghai'},policies:{lateToleranceMs:10000,misfire:'skip',catchupWindowMs:300000,overlap:'skip',queueTimeoutMs:300000},execution,notifications:{inApp:true,eventKinds:['failed'],channelIds:[]}};
describe('fixed scheduling contract',()=>{
  it('preserves business names at the cross-language boundary',()=>{expect(ScheduleSaveSchema.parse({...save,name:'  nightly  '}).name).toBe('  nightly  ');});
  it.each(['intent','debug','stress','shared','secret','local-path','channel-body','duplicate-ref','scope'] as const)('rejects %s from saved execution',invalid=>{
    const input=structuredClone(save) as any;
    if(invalid==='intent')input.execution.intentId='manual';
    if(invalid==='debug')input.execution.debugSessionId='reuse';
    if(invalid==='stress')input.execution.runConfig.stress={workerCount:1};
    if(invalid==='shared')input.execution.preparation.dispatchKind='shared-debug';
    if(invalid==='secret')input.execution.materials.credentials[0].value='PRIVATE';
    if(invalid==='local-path')input.execution.materials.attachmentPaths={'C:/private.key':{refId:'file',version:'1',hash}};
    if(invalid==='channel-body')input.notifications.body='PRIVATE';
    if(invalid==='duplicate-ref')input.execution.materials.credentials.push(input.execution.materials.credentials[0]);
    if(invalid==='scope')input.execution.materials.projectId='99';
    expect(ScheduleSaveSchema.safeParse(input).success).toBe(false);
  });
  it('validates update patches without defaulting omitted fields',()=>{
    expect(ScheduleUpdateSchema.parse({expectedVersion:'1',name:'Renamed'})).toEqual({expectedVersion:'1',name:'Renamed'});
    expect(ScheduleUpdateSchema.safeParse({expectedVersion:'1',enabled:null}).success).toBe(false);
    expect(ScheduleUpdateSchema.safeParse({expectedVersion:'1',execution}).success).toBe(false);
    expect(ScheduleUpdateSchema.safeParse({expectedVersion:'1',refreshExecution:true}).success).toBe(false);
  });
  it('requires stable view identity and safe options projection',()=>{
    expect(ScheduleViewSchema.safeParse({...save,id:'7'}).success).toBe(false);
    expect(ScheduleOptionsSchema.safeParse({canManageSchedules:true,channels:[{id:'9',name:'Webhook',kind:'webhook',url:'https://secret/'}]}).success).toBe(false);
  });
});
const scope={workspaceId:'1',projectId:'3'};
const view={...save,id:'7',workspaceId:'1',projectId:'3',version:'1',revision:'1',enabled:false,subjectUserId:'8',snapshotVersion:'1',manifestHash:hash,pausedReasonCode:'schedule-paused',nextPlannedAtUtc:null,cancellationVersion:'0',evaluatedThroughUtc:null,lastAdmittedPlannedAtUtc:null};
describe('member scheduling HTTP client',()=>{
  it.each(['passed','failed'])('reads the actual repaired Java %s capture through the strict client',async verdict=>{
    const page=JSON.parse(readFileSync(new URL('../../../server/src/test/resources/scheduling/final-history-'+verdict+'.json',import.meta.url),'utf8'));
    const client=createSchedulingClient({baseUrl:'https://control.test/api/v1',token:()=> 'TOKEN',fetch:async()=>Response.json(page)});
    expect((await client.history({workspaceId:page.workspaceId,projectId:page.projectId},page.scheduleId,{},new AbortController().signal)).items[0]!.execution.verdict).toBe(verdict);
  });
  it.each(['passed','failed','cancelled','timed-out','interrupted','rejected'] as const)('preserves safe original summary verdict %s through the strict HTTP client',async verdict=>{
    const page={...realHistory,items:realHistory.items.map((row:any)=>({...row,state:'submitted',jobId:'1',executionId:'2',execution:{availability:'available',state:'ended',released:true,reportState:'pending',verdict}}))};
    const client=createSchedulingClient({baseUrl:'https://control.test/api/v1',token:()=> 'TOKEN',fetch:async()=>Response.json(page)});
    expect((await client.history({workspaceId:page.workspaceId,projectId:page.projectId},page.scheduleId,{},new AbortController().signal)).items[0]!.execution.verdict).toBe(verdict);
    expect(ScheduleHistoryExecutionSchema.safeParse({...page.items[0].execution,verdict:'PRIVATE https://secret/?token=x'}).success).toBe(false);
  });
  it('parses the real Java business history response with strict typed fields',()=>{expect(ScheduleHistoryPageSchema.parse(realHistory)).toEqual(realHistory);});
  it.each([
    {released:null,reportState:null},
    {released:null,reportState:'pending'},
    {released:false,reportState:null},
  ])('rejects an available execution projection with unknown release/report facts: %j',facts=>{
    expect(ScheduleHistoryExecutionSchema.safeParse({availability:'available',state:'running',...facts}).success).toBe(false);
  });
  it('accepts an available execution projection only with observed facts',()=>{
    const projection={availability:'available',state:'running',released:false,reportState:'pending'};
    expect(ScheduleHistoryExecutionSchema.parse(projection)).toEqual(projection);
  });
  it('accepts persistent control modes and string generations for the management consumer',()=>{expect(SchedulerControlSchema.parse({mode:'embedded',generation:'3',version:'4'})).toEqual({mode:'embedded',generation:'3',version:'4'});});
  it('requests independent member history cursors using the existing control identity',async()=>{
    const calls:Array<{url:string,init?:RequestInit}>=[];
    const client=createSchedulingClient({baseUrl:'https://control.test/api/v1',token:()=> 'TOKEN',fetch:async(url,init)=>{calls.push({url:String(url),init});return Response.json(realHistory);}});
    const actualScope={workspaceId:realHistory.workspaceId,projectId:realHistory.projectId};
    expect(await client.history(actualScope,realHistory.scheduleId,{limit:2,beforeId:'99',missedBeforeId:'88'},new AbortController().signal)).toEqual(realHistory);
    expect(calls[0]?.url).toBe(`https://control.test/api/v1/workspaces/${actualScope.workspaceId}/projects/${actualScope.projectId}/schedules/${realHistory.scheduleId}/history?limit=2&beforeId=99&missedBeforeId=88`);
  });
  it.each(['scope','submitted-without-job','pending-with-job','invented-job-state','unavailable-material'] as const)('rejects inconsistent history fact: %s',invalid=>{
    const input=structuredClone(realHistory);
    if(invalid==='scope')input.items[0].projectId='999';
    if(invalid==='submitted-without-job')input.items[0].state='submitted';
    if(invalid==='pending-with-job')input.items[0].jobId='99';
    if(invalid==='invented-job-state')input.items[0].execution={availability:'not-integrated',state:'running',released:false,reportState:'pending'};
    if(invalid==='unavailable-material')input.items[0].materials.status='unavailable';
    expect(ScheduleHistoryPageSchema.safeParse(input).success).toBe(false);
  });
  it('rejects a valid history page returned for another requested project',async()=>{
    const client=createSchedulingClient({baseUrl:'https://control.test/api/v1',token:()=> 'TOKEN',fetch:async()=>Response.json(realHistory)});
    await expect(client.history({workspaceId:realHistory.workspaceId,projectId:'999'},realHistory.scheduleId,{},new AbortController().signal)).rejects.toThrow('schedule-scope-mismatch');
  });
  it('saves and performs versioned writes with control identity, no redirect and no cache',async()=>{
    const calls:Array<{url:string,init?:RequestInit}>=[];
    const client=createSchedulingClient({baseUrl:'https://control.test/api/v1',token:()=> 'TOKEN',fetch:async(url,init)=>{calls.push({url:String(url),init});return init?.method==='DELETE'?new Response(null,{status:204}):Response.json(view);}});
    expect(await client.save(scope,save,new AbortController().signal)).toEqual(view);
    expect(await client.update(scope,'7',{expectedVersion:'1',name:'Renamed'},new AbortController().signal)).toEqual(view);
    await client.remove(scope,'7','1',new AbortController().signal);
    expect(calls.map(c=>[c.url,c.init?.method])).toEqual([['https://control.test/api/v1/workspaces/1/projects/3/schedules','POST'],['https://control.test/api/v1/workspaces/1/projects/3/schedules/7','PUT'],['https://control.test/api/v1/workspaces/1/projects/3/schedules/7?expectedVersion=1','DELETE']]);
    for(const {init}of calls){expect(init?.redirect).toBe('error');expect(init?.cache).toBe('no-store');expect(init?.headers).toMatchObject({authorization:'Bearer TOKEN'});}
  });
  it('rejects unsafe payloads before network and rejects cross-project responses',async()=>{
    let calls=0;const client=createSchedulingClient({baseUrl:'https://control.test/api/v1',token:()=> 'TOKEN',fetch:async()=>{calls++;return Response.json({...view,projectId:'99'});}});
    await expect(client.save(scope,{...save,execution:{...execution,debugSessionId:'private'}} as unknown as ScheduleSave,new AbortController().signal)).rejects.toThrow();expect(calls).toBe(0);
    await expect(client.detail(scope,'7',new AbortController().signal)).rejects.toThrow('schedule-scope-mismatch');
  });
  it('never retries errors or forwards raw exception text',async()=>{
    let calls=0;const client=createSchedulingClient({baseUrl:'https://control.test/api/v1',token:()=> 'TOKEN',fetch:async()=>{calls++;return Response.json({code:'schedule-subject-unauthorized',message:'PRIVATE'}, {status:403});}});
    await expect(client.list(scope,{limit:2},new AbortController().signal)).rejects.toMatchObject({status:403,code:'schedule-subject-unauthorized',message:'execution control request failed: HTTP 403'});expect(calls).toBe(1);
  });
});
