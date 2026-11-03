import { describe, expect, it } from 'vitest';
import { OnlineJobSchema, FullOnlineJobSchema } from '../../src/client/memberTypes.js';
import { createMemberExecutionClient } from '../../src/client/member.js';
import { ExecutionHttpError } from '../../src/client/http.js';
import { stressReportFixture } from '../../../core/tests/helpers/stressReport.js';

const context = { serverId: 'https://control.test/api/v1', ownerId: '7', scope: { workspaceId: '11', groupId: '22', projectId: '33' } };
const minimum = { jobId: '99', executionId: '100', agentId: '5', state: 'running', cancelState: 'none', executionReleased: false, canCancel: true, view: 'active-status', scope: context.scope };
const full = { jobId: '99', executionId: '100', agentId: '5', state: 'running', cancelState: 'none', executionReleased: false, reportState: 'none', task: { protocolVersion: 1, jobId: '99', executionId: '100', scope: context.scope, submittedByUserId: '7', contractProjectId: '00000000-0000-4000-8000-000000000018', snapshotId: '66', manifestHash: 'a'.repeat(64), target: { kind: 'workflow', workflowId: '00000000-0000-4000-8000-000000000091' }, policyVersion: '0', requiredCoreBuildId: 'b'.repeat(64), scriptPlanDigest: 'c'.repeat(64), executionProfile: 'no-script', runtimeCompatibilityId: 'recorded-runtime', dispatchKind: 'dedicated-task', requiredCapabilities: ['task:workflow'] } };
const signal = () => new AbortController().signal;
describe('F7f minimum/full job contract', () => {
  it.each(['running', 'ended'])('accepts exact minimum %s status without invented history fields', state => {
    const value = { ...minimum, state };
    expect(OnlineJobSchema.parse(value)).toEqual(value);
  });
  it('preserves the full strict historical view', () => expect(OnlineJobSchema.parse(full)).toEqual(full));
  it('rejects the superseded scope-less minimum and unknown scope fields',()=>{
    const {scope:_scope,...old}=minimum;
    expect.soft(OnlineJobSchema.safeParse(old).success).toBe(false);
    expect(OnlineJobSchema.safeParse({...minimum,scope:{...context.scope,private:'not-scope'}}).success).toBe(false);
  });
  it.each(['task', 'reportState', 'summary', 'progress'])('rejects mixed minimum with private %s', key => {
    expect(OnlineJobSchema.safeParse({ ...minimum, [key]: key === 'task' ? full.task : key === 'reportState' ? 'archived' : {} }).success).toBe(false);
  });
  it.each(['status', 'intent', 'cancel', 'report'])('real member %s consumes minimum and preserves actual report denial', async route => {
    const requests: string[] = [];
    const client = createMemberExecutionClient({ session: { captureExecution: () => ({ serverId: context.serverId, userId: '7', token: async () => 'synthetic-token', assertCurrent() {} }) }, fetch: async (url, init) => {
      requests.push(`${init?.method ?? 'GET'} ${String(url)}`);
      if (String(url).endsWith('/report')) return Response.json({ code: 'forbidden', message: 'F7F_PRIVATE_BODY' }, { status: 403 });
      if (String(url).endsWith('/cancel')) return Response.json({ ...minimum, state: 'ended', cancelState: 'confirmed', executionReleased: true, canCancel: false });
      // Full positive preflight lets cancel reach the distinct receipt parser before it is changed.
      return Response.json(route === 'cancel' ? full : minimum);
    } });
    try {
      const location = { kind: 'agent' as const, agentId: '5' };
      if (route === 'report') {
        const error = await client.report(context, location, '99', signal()).then(() => null, cause => cause);
        expect.soft(error).toBeInstanceOf(ExecutionHttpError);
        expect.soft(error).toMatchObject({ status: 403, code: 'forbidden' });
        expect.soft(String(error)).not.toContain('F7F_PRIVATE_BODY');
        expect(requests.filter(request => request.endsWith('/report'))).toHaveLength(1);
      } else {
        const result = route === 'status' ? await client.status(context, location, '99', signal()) : route === 'intent' ? await client.findIntent(context, 'intent', signal()) : await client.cancel(context, location, '99', signal());
        expect(result).toEqual(route === 'cancel' ? { ...minimum, state: 'ended', cancelState: 'confirmed', executionReleased: true, canCancel: false } : minimum);
      }
    } finally { await client.close(); }
  });
  it.each(['full-success','minimum-full','still-minimum','scope','agent','job','execution','target','plan'])('report200 %s retains exact full binding with at most one current status read',async route=>{
    const result=stressReportFixture();result.projectId=full.task.contractProjectId;
    const original={...full,task:{...full.task,target:{kind:'stress',plan:result.plan}}};
    const current=structuredClone(original);
    if(route==='scope')current.task.scope.projectId='34';
    if(route==='agent')current.agentId='6';
    if(route==='job')current.jobId='101';
    if(route==='execution')current.executionId='102';
    if(route==='target')current.task.target.plan.target={kind:'workflow',workflowId:'another-workflow'};
    if(route==='plan')current.task.target.plan.termination={maxIterations:2};
    expect(FullOnlineJobSchema.safeParse(current).success).toBe(true);
    const report={executionId:'100',verdict:'passed',output:{kind:'stress',result}};
    let reads=0,reports=0;
    const client=createMemberExecutionClient({session:{captureExecution:()=>({serverId:context.serverId,userId:'7',token:async()=>'synthetic-token',assertCurrent(){}})},fetch:async(url)=>{
      if(String(url).endsWith('/report')){reports++;return Response.json(report);}
      reads++;return Response.json(route==='full-success'?original:reads===1||route==='still-minimum'?minimum:current);
    }});
    try{
      const outcome=await client.report(context,{kind:'agent',agentId:'5'},'99',signal()).then(value=>({value,error:null}),error=>({value:null,error}));
      if(route==='full-success'||route==='minimum-full'){expect.soft(outcome.error).toBeNull();expect.soft(outcome.value).toEqual(report);}
      else expect.soft(outcome.error).toMatchObject({message:route==='scope'||route==='agent'?'online-project-scope-mismatch':'fixed-input-mismatch'});
      expect.soft(reports).toBe(1);expect(reads).toBe(route==='full-success'?1:2);
    }finally{await client.close();}
  });
});
