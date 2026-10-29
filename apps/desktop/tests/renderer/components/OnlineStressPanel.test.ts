// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { ContractWorkspaceSchema, StressPlanSchema, StressReportV2Schema } from '@apicc/core/schema';
import { workspaceFixture } from '../../../../../packages/core/tests/helpers/contractFixtures.js';
import { createOnlineExecutionStore } from '../../../src/renderer/src/stores/onlineExecution.js';
import OnlineStressPanel from '../../../src/renderer/src/components/online/OnlineStressPanel.vue';
import { createI18nInstance } from '../../../src/renderer/src/i18n/index.js';
import { OnlineJobSchema, OnlineLocalResultSchema, type OnlineExecutionInput } from '../../../src/shared/online/execution.js';
import { stressV2Report } from '../../helpers/stressV2.js';
import OnlineExecutionPanel from '../../../src/renderer/src/components/online/OnlineExecutionPanel.vue';
import { defaultAgentConfig,defaultPolicyConfig,ProjectExecutionAgentsSchema } from '@apicc/execution/contract';
enableAutoUnmount(afterEach);
function panelFixture(port: Parameters<typeof createOnlineExecutionStore>[0]) {
  const store = createOnlineExecutionStore(port);
  const project = ContractWorkspaceSchema.parse(workspaceFixture()).groups[0]!.projects[0]!;
  project.workflows = [{ id: '00000000-0000-4000-8000-000000000091', name: 'Scenario', status: 'enabled', nodes: [{ id: 'noop', kind: 'noop' }], edges: [] }];
  project.stressPlans = [{ formatVersion: 1, id: 'saved', name: 'Saved scenario', updatedAt: 0, plan: StressPlanSchema.parse({ formatVersion: 1, target: { kind: 'workflow', workflowId: project.workflows[0]!.id }, load: { kind: 'constant-vus', vus: 1 }, termination: { maxIterations: 1 } }) }];
  const context = { serverId: 'https://control.test/api/v1', ownerId: '7', scope: { workspaceId: '11', groupId: '22', projectId: '33' } };
  store.activate(context); store.setVisible(true); store.project = project; store.saved = JSON.stringify(project);
  store.view = { project, problems: [], assets: { ...context.scope, format: 'contract-files-v1', contractProjectId: project.id, version: '1', manifestHash: 'a'.repeat(64), files: [] } };
  const { i18n } = createI18nInstance();
  return { store, i18n, view: mount(OnlineStressPanel, { props: { execution: store }, global: { plugins: [i18n] } }) };
}
describe('online stress plan entry', () => {
  // Break caught: dotted cache reason keys fall back to internal codes in the actual jobs table.
  it.each([['cache.input','等待输入缓存容量','Waiting for input cache capacity'],['cache.result','等待报告缓存容量','Waiting for report cache capacity']])('final two fixes renders cache wait %s in both languages and keeps unknown reasons',async(code,zh,en)=>{
    const f=panelFixture({onlineExecution:async()=>[]});f.i18n.global.locale.value='zh-CN';
    const job=(reason:string,id:string)=>OnlineJobSchema.parse({jobId:id,executionId:String(Number(id)+1),agentId:'5',state:'queued',cancelState:'none',executionReleased:false,reportState:'none',capacityWaitReason:reason,task:{protocolVersion:1,jobId:id,executionId:String(Number(id)+1),scope:f.store.context!.scope,submittedByUserId:'7',contractProjectId:f.store.project!.id,snapshotId:'66',manifestHash:'a'.repeat(64),target:{kind:'stress',plan:f.store.project!.stressPlans![0]!.plan},policyVersion:'0',requiredCoreBuildId:'a'.repeat(64),scriptPlanDigest:'c'.repeat(64),executionProfile:'no-script',runtimeCompatibilityId:'compatible',dispatchKind:'dedicated-task',requiredCapabilities:['protocol:http','task:stress','stress:local-workers-v1']}});
    f.store.jobs=[job(code!,'99'),job('business-unknown-wait','101'),job('stress-capacity-exceeded','103')];
    const view=mount(OnlineExecutionPanel,{props:{execution:f.store},global:{plugins:[f.i18n]}});
    try{
      const rows=()=>view.get('[data-testid="online-jobs"]').findAll('tbody tr');
      expect.soft(rows()[0]!.text()).toContain(zh!);expect.soft(rows()[0]!.text()).not.toContain(code!);
      expect(rows()[1]!.text()).toContain('business-unknown-wait');expect(rows()[2]!.text()).toContain('代理压测容量不足');
      f.i18n.global.locale.value='en';await flushPromises();
      expect.soft(rows()[0]!.text()).toContain(en!);expect.soft(rows()[0]!.text()).not.toContain(code!);
      expect(rows()[1]!.text()).toContain('business-unknown-wait');expect(rows()[2]!.text()).toContain('Agent stress capacity exceeded');
      expect(view.find('pre').exists()).toBe(false);
    }finally{f.store.setVisible(false);}
  });
  it('final I3 shows the total node and policy worker intersection without clipping the chosen run',async()=>{
    const f=panelFixture({onlineExecution:async()=>[]});
    const project={...f.store.project!,stressPlans:[{...f.store.project!.stressPlans![0]!,plan:StressPlanSchema.parse({...f.store.project!.stressPlans![0]!.plan,maxVus:4,load:{kind:'constant-vus',vus:2}})}]};
    f.store.project=project;f.store.saved=JSON.stringify(project);f.store.view={...f.store.view!,project};
    const agent=Object.fromEntries(['maxConcurrentStressJobs','maxStressProcesses','maxStressVus','maxStressRequestConcurrency','maxStressRps','maxStressMetricMemoryBytes'].map(key=>[key,defaultAgentConfig[key as keyof typeof defaultAgentConfig]]));
    f.store.agents=ProjectExecutionAgentsSchema.parse({defaultAgentId:'5',canManageScripts:false,policy:defaultPolicyConfig,policyVersion:'3',agents:[{id:'5',name:'Selected agent',acceptingJobs:true,availability:'runtime-missing',lastSeenAt:null,configuration:{configVersion:'4',appliedConfigVersion:'4',pendingFields:[],restartRequiredFields:[],status:'applied'},policy:{...defaultPolicyConfig,maxStressWorkers:4},policyVersion:'3',scriptsAllowed:false,stressConfiguration:{agent:{...agent,maxStressProcesses:3},sources:{'agent.maxStressRps':'default','agent.maxStressRequestConcurrency':'default','policy.maxStressRps':'default','policy.maxStressRequestConcurrency':'default'}},scriptGrant:{version:'0',scope:'script-version',scripts:[]}}]});
    try{f.store.selectLocation({kind:'agent',agentId:'5'});await flushPromises();await f.view.get('[data-testid="online-stress-plan"]').setValue('saved');f.store.stressWorkerCount=4;await flushPromises();
      expect(f.view.get('[data-testid="online-stress-workers"]').attributes('max')).toBe('2');expect(f.store.stressWorkerCount).toBe(4);
    }finally{f.store.setVisible(false);}
  });
  it.each([['stress-local-budget-exceeded','本机压测预算不足','Local stress budget exceeded'],['stress-worker-policy-exceeded','压测工作进程数超出策略上限','Stress worker policy exceeded']])('final I5 localizes the known run rejection %s',async(code,zh,en)=>{
    const f=panelFixture({onlineExecution:async input=>{if(input.operation==='run')throw Error(code);return [];}});f.i18n.global.locale.value='zh-CN';
    try{await f.view.get('[data-testid="online-stress-plan"]').setValue('saved');await f.view.get('[data-testid="online-stress-origins"]').setValue('http://127.0.0.1:8123');await f.view.get('[data-testid="online-stress-confirm"]').trigger('click');await f.view.get('[data-testid="online-stress-run"]').trigger('click');await flushPromises();
      expect.soft(f.view.get('[role="alert"]').text()).toContain(zh!);f.i18n.global.locale.value='en';await flushPromises();expect.soft(f.view.get('[role="alert"]').text()).toContain(en!);
    }finally{f.store.setVisible(false);}
  });
  // Final I1: a stale outer environment must not be submitted behind a visible base-environment selection.
  it.each([false,true])('final I1 displays the effective outer environment after a plan switch and explicitly clears base=%s',async chooseBase=>{
    const calls: OnlineExecutionInput[]=[];
    const f=panelFixture({onlineExecution:async input=>{calls.push(input);if(input.operation!=='run')throw Error('unexpected-operation');return {location:{kind:'local'},runId:input.runId,snapshotId:'66',manifestHash:'a'.repeat(64),runtimeCompatibilityId:'compatible',scriptTimeoutMs:3000,output:{kind:'stress-failure',error:'worker-failed',started:false,requests:{started:0,completed:0}}};}});
    const environmentId='00000000-0000-4000-8000-000000000019';
    const withEnvironment=structuredClone(f.store.project!.stressPlans![0]!);withEnvironment.id='with-environment';withEnvironment.plan.environmentId=environmentId;
    f.store.project={...f.store.project!,stressPlans:[...f.store.project!.stressPlans!,withEnvironment]};f.store.saved=JSON.stringify(f.store.project);f.store.view={...f.store.view!,project:f.store.project};await flushPromises();
    try {
      await f.view.get('[data-testid="online-stress-plan"]').setValue('with-environment');
      expect(f.store.environmentId).toBe(environmentId);
      await f.view.get('[data-testid="online-stress-plan"]').setValue('saved');
      if(chooseBase)await f.view.get('[data-testid="online-stress-environment"]').setValue('');
      expect.soft((f.view.get('[data-testid="online-stress-environment"]').element as HTMLSelectElement).value).toBe(chooseBase?'':environmentId);
      await f.view.get('[data-testid="online-stress-origins"]').setValue('http://127.0.0.1:8123');
      await f.view.get('[data-testid="online-stress-confirm"]').trigger('click');
      await f.view.get('[data-testid="online-stress-run"]').trigger('click');await flushPromises();
      const submitted=calls.filter((input):input is Extract<OnlineExecutionInput,{operation:'run'}>=>input.operation==='run');
      expect(submitted).toHaveLength(1);expect(submitted[0]!.environmentId).toBe(chooseBase?undefined:environmentId);
      expect(submitted[0]!.target).toMatchObject({kind:'stress',plan:{target:{kind:'workflow'}}});
      if(submitted[0]!.target.kind!=='stress')throw Error('stress target required');
      expect(submitted[0]!.target.plan.environmentId).toBeUndefined();
    }finally{f.store.setVisible(false);}
  });
  // I1: rendering only execution-level reasons must lose the Core-only mismatch/notices.
  it('T7 R1 shows Core-only reasons and baseline integrity after a real pin with identical execution metadata',async()=>{
    const f=panelFixture({onlineExecution:async()=>[]});f.i18n.global.locale.value='zh-CN';
    const base=stressV2Report();base.definitionRevision='baseline-revision';base.completeness.metrics={complete:false,reasons:['worker-missing']};base.verdict={status:'incomplete',passed:false,violations:[]};StressReportV2Schema.parse(base);
    const candidate=stressV2Report();candidate.runId='10000000-0000-4000-8000-000000000002';candidate.definitionRevision='candidate-revision';candidate.target={kind:'workflow',workflowId:'candidate-workflow'};candidate.plan.target=candidate.target;candidate.environmentId='00000000-0000-4000-8000-000000000019';candidate.plan.environmentId=candidate.environmentId;StressReportV2Schema.parse(candidate);
    const localStress={workerCount:1,processBudget:1,runtime:{coreBuildId:'a'.repeat(64),scriptApiId:'b'.repeat(64),nodeVersion:'22.19.0',v8Version:'12.4',runtimeCompatibilityId:'compatible'}};
    const result=(report:ReturnType<typeof stressV2Report>)=>OnlineLocalResultSchema.parse(JSON.parse(JSON.stringify({location:{kind:'local'},runId:report.runId,snapshotId:'66',manifestHash:'a'.repeat(64),runtimeCompatibilityId:'compatible',scriptTimeoutMs:3000,localStress,output:{kind:'stress',result:report}})));
    f.store.localResult=result(base);f.store.resultSelection={kind:'local',runId:base.runId};
    const view=mount(OnlineExecutionPanel,{props:{execution:f.store},global:{plugins:[f.i18n]}});
    try {
      await view.get('[data-testid="online-stress-baseline-pin"]').trigger('click');
      f.store.localResult=result(candidate);f.store.resultSelection={kind:'local',runId:candidate.runId,environmentId:candidate.environmentId!};await flushPromises();
      const comparison=view.get('[data-testid="online-stress-comparison"]');
      for(const reason of ['执行目标不同','环境不同','定义版本已变化','包含不完整运行'])expect.soft(comparison.text()).toContain(reason);
      expect(comparison.text().split('未比较环境定义；相同 ID 不证明定义一致。')).toHaveLength(2);
      const rps=comparison.findAll('tbody tr').find(row=>row.get('th').text()==='请求吞吐率')!;
      expect(rps.findAll('td').map(cell=>cell.text())).toEqual(['1.00 请求/秒','1.00 请求/秒','0.00 请求/秒','0.00%']);
      const dropped=comparison.findAll('tbody tr').find(row=>row.get('th').text()==='丢弃迭代槽')!;expect(dropped.findAll('td').at(-1)!.text()).toBe('不可计算');
      f.i18n.global.locale.value='en';await flushPromises();for(const reason of ['Different target','Different environment','Definition revision changed','Includes an incomplete run'])expect.soft(comparison.text()).toContain(reason);
    }finally{f.store.setVisible(false);}
  });
  it.each([true,false])('T7 explains the selected queued stress capacity with recorded metadata=%s without inventing a Core report',async recorded=>{
    const f=panelFixture({onlineExecution:async()=>[]});f.i18n.global.locale.value='zh-CN';
    const runtime={coreBuildId:'a'.repeat(64),scriptApiId:'b'.repeat(64),nodeVersion:'22.19.0',v8Version:'12.4',runtimeCompatibilityId:'compatible'},reservation={jobs:1,processes:1,vus:1,requestConcurrency:1,maxRps:12.5,metricMemoryBytes:67108864};
    const job=OnlineJobSchema.parse({jobId:'99',executionId:'100',agentId:'5',state:'queued',cancelState:'none',executionReleased:false,reportState:'none',capacityWaitReason:'stress.maxRps',stressMetadata:{location:{kind:'agent',agentId:'5'},executor:{id:'5',name:'Actual selected agent'},workerCount:1,processes:1,resources:{requested:reservation,effective:reservation},runtime,status:{preparation:'pending',execution:'pending',upload:'pending'},contentionHints:[]},task:{protocolVersion:1,jobId:'99',executionId:'100',scope:f.store.context!.scope,submittedByUserId:'7',contractProjectId:f.store.project!.id,snapshotId:'66',manifestHash:'a'.repeat(64),target:{kind:'stress',plan:f.store.project!.stressPlans![0]!.plan},policyVersion:'0',requiredCoreBuildId:'a'.repeat(64),scriptPlanDigest:'c'.repeat(64),executionProfile:'no-script',runtimeCompatibilityId:'compatible',dispatchKind:'dedicated-task',requiredCapabilities:['protocol:http','task:stress','stress:local-workers-v1']}});
    job.capacityWait={dimension:'maxRps',used:12.5,requested:12.5,limit:20,draining:false};
    if(!recorded)delete job.stressMetadata;OnlineJobSchema.parse(job);
    f.store.jobs=[job];await f.store.inspect(job);const view=mount(OnlineExecutionPanel,{props:{execution:f.store},global:{plugins:[f.i18n]}});
    expect.soft(view.text()).toContain('等待压测请求速率容量');
    expect.soft(view.text()).toContain('已占 12.5 请求/秒');expect.soft(view.text()).toContain('本次需求 12.5 请求/秒');expect.soft(view.text()).toContain('总额 20 请求/秒');
    if(recorded){expect.soft(view.text()).toContain('执行进程预算: 1');expect.soft(view.text()).toContain('上传: 等待中');}
    else {expect.soft(view.text()).toContain('执行元数据未采集');expect.soft(view.find('[data-testid="stress-execution-summary"]').exists()).toBe(false);expect.soft(view.findAll('.summary > div').find(row=>row.text().includes('实际运行兼容档位'))!.text()).toContain('未采集');}
    expect(view.find('[data-testid="stress-report"]').exists()).toBe(false);f.store.setVisible(false);
  });
  it.each([true,false])('T7 keeps local started=%s separate from zero formal requests in a stress failure',started=>{
    const f=panelFixture({onlineExecution:async()=>[]});f.i18n.global.locale.value='en';
    f.store.localResult=OnlineLocalResultSchema.parse({location:{kind:'local'},runId:'10000000-0000-4000-8000-000000000001',snapshotId:'66',manifestHash:'a'.repeat(64),runtimeCompatibilityId:'compatible',scriptTimeoutMs:3000,output:{kind:'stress-failure',started,error:'worker-failed',requests:{started:0,completed:0}}});
    const view=mount(OnlineExecutionPanel,{props:{execution:f.store},global:{plugins:[f.i18n]}});
    expect(view.get('[data-testid="online-execution-report"] > p').text()).toContain(started?'Target request fact: Started':'Target request fact: Confirmed not started');
    expect.soft(view.text()).toContain('Some data was not retained');expect.soft(view.text()).toContain('0 started, 0 completed');f.store.setVisible(false);
  });
  it.each([['result-capacity-exceeded','结果超出归档预算，完整输出不可用。'],['result-persistence-failed','结果持久化失败，完整输出不可用。']])('T7 explains an unavailable stress fault report %s while retaining a known business pass',async(reasonCode,reasonText)=>{
    const f=panelFixture({onlineExecution:async input=>input.operation==='report'?{executionId:'100',verdict:'passed',executionFact:'started',reasonCode}:[]});f.i18n.global.locale.value='zh-CN';
    const job=OnlineJobSchema.parse({jobId:'99',executionId:'100',agentId:'5',state:'ended',cancelState:'none',executionReleased:true,reportState:'archived',reportKind:'stress-fault',task:{protocolVersion:1,jobId:'99',executionId:'100',scope:f.store.context!.scope,submittedByUserId:'7',contractProjectId:f.store.project!.id,snapshotId:'66',manifestHash:'a'.repeat(64),target:{kind:'stress',plan:f.store.project!.stressPlans![0]!.plan},policyVersion:'0',requiredCoreBuildId:'a'.repeat(64),scriptPlanDigest:'c'.repeat(64),executionProfile:'no-script',runtimeCompatibilityId:'compatible',dispatchKind:'dedicated-task',requiredCapabilities:['protocol:http','task:stress','stress:local-workers-v1']}});
    f.store.jobs=[job];await f.store.inspect(job);
    const view=mount(OnlineExecutionPanel,{props:{execution:f.store},global:{plugins:[f.i18n]}});
    expect.soft(view.text()).toContain('逻辑结论: 通过');expect.soft(view.text()).toContain('报告不可用，无法比较');expect.soft(view.text()).toContain(reasonText);
    expect.soft(view.text()).not.toContain('不能视为通过');
    expect(view.find('textarea').exists()).toBe(false);f.store.setVisible(false);
  });
  it('T7 exports the displayed safe report with typed execution facts and formats numeric Core times',async()=>{
    const f=panelFixture({onlineExecution:async()=>[]});f.i18n.global.locale.value='en';
    const core=stressV2Report(),runtime={coreBuildId:'a'.repeat(64),scriptApiId:'b'.repeat(64),nodeVersion:'22.19.0',v8Version:'12.4',runtimeCompatibilityId:'compatible'};
    f.store.localResult=OnlineLocalResultSchema.parse(JSON.parse(JSON.stringify({location:{kind:'local'},runId:core.runId,snapshotId:'66',manifestHash:'a'.repeat(64),runtimeCompatibilityId:'compatible',scriptTimeoutMs:3000,localStress:{workerCount:1,processBudget:1,runtime},output:{kind:'stress',result:core}})));
    const view=mount(OnlineExecutionPanel,{props:{execution:f.store},global:{plugins:[f.i18n]}});
    const dateRow=view.findAll('[data-testid="online-execution-report"] > p').find(p=>p.text().startsWith('Started:'))!;
    expect.soft(dateRow.text()).toContain('.000');expect.soft(dateRow.text()).toMatch(/GMT|UTC/);expect.soft(dateRow.text()).not.toContain('Not collected');
    const saved=Object.getOwnPropertyDescriptor(URL,'createObjectURL'),revoke=Object.getOwnPropertyDescriptor(URL,'revokeObjectURL'),click=HTMLAnchorElement.prototype.click;
    let exported:Blob|undefined;Object.defineProperty(URL,'createObjectURL',{configurable:true,value:(value:Blob)=>{exported=value;return 'blob:stress';}});Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:()=>{}});HTMLAnchorElement.prototype.click=()=>{};
    try {await view.get('[data-testid="online-stress-export"]').trigger('click');expect(exported).toBeInstanceOf(Blob);const html=await new Promise<string>(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.readAsText(exported!);});const doc=new DOMParser().parseFromString(html,'text/html');expect(doc.querySelector('[data-section="execution"]')?.textContent).toContain('执行进程预算');expect(doc.querySelector('details.raw-data')?.hasAttribute('open')).toBe(false);expect(doc.querySelector('details.raw-data pre')?.textContent).toContain(core.runId);} finally {if(saved)Object.defineProperty(URL,'createObjectURL',saved);else Reflect.deleteProperty(URL,'createObjectURL');if(revoke)Object.defineProperty(URL,'revokeObjectURL',revoke);else Reflect.deleteProperty(URL,'revokeObjectURL');HTMLAnchorElement.prototype.click=click;f.store.setVisible(false);}
  });
  it('T7 shows current admission bounds and their real sources separately from recorded runs',async()=>{
    const f=panelFixture({onlineExecution:async()=>[]});f.i18n.global.locale.value='zh-CN';
    const agent=Object.fromEntries(['maxConcurrentStressJobs','maxStressProcesses','maxStressVus','maxStressRequestConcurrency','maxStressRps','maxStressMetricMemoryBytes'].map(key=>[key,defaultAgentConfig[key as keyof typeof defaultAgentConfig]]));
    f.store.agents=ProjectExecutionAgentsSchema.parse({defaultAgentId:'5',canManageScripts:false,policy:defaultPolicyConfig,policyVersion:'3',agents:[{id:'5',name:'Selected agent',acceptingJobs:true,availability:'runtime-missing',lastSeenAt:null,configuration:{configVersion:'4',appliedConfigVersion:'3',pendingFields:['maxStressRps'],restartRequiredFields:[],status:'pending'},policy:defaultPolicyConfig,policyVersion:'3',scriptsAllowed:false,stressConfiguration:{agent:{...agent,maxStressRps:12.5},sources:{'agent.maxStressRps':'agent','agent.maxStressRequestConcurrency':'default','policy.maxStressRps':'workspace','policy.maxStressRequestConcurrency':'project'}},scriptGrant:{version:'0',scope:'script-version',scripts:[]}}]});
    f.store.selectLocation({kind:'agent',agentId:'5'});await flushPromises();
    expect.soft(f.view.text()).toContain('当前准入上界');expect.soft(f.view.text()).toContain('12.5 请求/秒');
    expect.soft(f.view.text()).toContain('节点配置');expect.soft(f.view.text()).toContain('工作区');expect.soft(f.view.text()).toContain('项目');
    expect.soft(f.view.text()).toContain('保存版本 4');expect.soft(f.view.text()).toContain('已应用版本 3');
    f.store.setVisible(false);
  });
  it('T7 pins a real local baseline, explains agent location differences and preserves fault semantics',async()=>{
    const f=panelFixture({onlineExecution:async()=>[]});f.i18n.global.locale.value='zh-CN';
    const core=stressV2Report(),runtime={coreBuildId:'a'.repeat(64),scriptApiId:'b'.repeat(64),nodeVersion:'22.19.0',v8Version:'12.4',runtimeCompatibilityId:'compatible'};
    core.plan.maxRps=1000;core.load.effectiveMaxRps=1000;
    f.store.localResult=OnlineLocalResultSchema.parse(JSON.parse(JSON.stringify({location:{kind:'local'},runId:core.runId,snapshotId:'66',manifestHash:'a'.repeat(64),runtimeCompatibilityId:'compatible',scriptTimeoutMs:3000,localStress:{workerCount:1,processBudget:1,runtime},output:{kind:'stress',result:core}})));
    const view=mount(OnlineExecutionPanel,{props:{execution:f.store},global:{plugins:[f.i18n]}});
    expect.soft(view.text()).toContain('执行进程预算: 1');
    const pin=view.find('[data-testid="online-stress-baseline-pin"]');expect(pin.exists()).toBe(true);await pin.trigger('click');
    const reservation={jobs:1,processes:1,vus:1,requestConcurrency:1,maxRps:1000,metricMemoryBytes:67108864};
    const job=OnlineJobSchema.parse({jobId:'99',executionId:'100',agentId:'5',state:'ended',cancelState:'none',executionReleased:true,reportState:'archived',reportKind:'stress',stressMetadata:{location:{kind:'agent',agentId:'5'},executor:{id:'5',name:'Actual selected agent'},workerCount:1,processes:1,resources:{requested:reservation,effective:reservation},runtime,status:{preparation:'ready',execution:'finished',upload:'complete'},contentionHints:[]},task:{protocolVersion:1,jobId:'99',executionId:'100',scope:f.store.context!.scope,submittedByUserId:'7',contractProjectId:f.store.project!.id,snapshotId:'66',manifestHash:'a'.repeat(64),target:{kind:'stress',plan:f.store.project!.stressPlans![0]!.plan},policyVersion:'0',requiredCoreBuildId:'a'.repeat(64),scriptPlanDigest:'c'.repeat(64),executionProfile:'no-script',runtimeCompatibilityId:'compatible',dispatchKind:'dedicated-task',requiredCapabilities:['protocol:http','task:stress','stress:local-workers-v1']}});
    f.store.jobs=[job];f.store.resultSelection={kind:'agent',job};f.store.report={executionId:'100',verdict:'passed',executionFact:'started',output:{kind:'stress',result:core}};await flushPromises();
    expect.soft(view.text()).toContain('执行位置不同');expect.soft(view.text()).toContain('不可直接比较');expect.soft(view.text()).toContain('请求吞吐率');
    f.store.report={executionId:'100',verdict:'passed',executionFact:'started',reasonCode:'result-capacity-exceeded'};await flushPromises();
    expect.soft(view.text()).toContain('报告不可用，无法比较');expect.soft(view.text()).toContain('结果超出归档预算，完整输出不可用。');
    expect(view.find('textarea').exists()).toBe(false);f.store.setVisible(false);
    f.store.activate({...f.store.context!,ownerId:'8'});await flushPromises();expect(view.find('[data-testid="online-stress-comparison"]').exists()).toBe(false);
  });
  // A visible edit must revoke A; a disabled form may not silently submit cached A.
  it.each(['http://127.0.0.1:9123', 'not-an-origin'])('revokes consent when the current origin text changes to %s', async origins => {
    const calls: OnlineExecutionInput[] = [];
    const f = panelFixture({ onlineExecution: async input => {
      calls.push(input); if (input.operation !== 'run' || input.target.kind !== 'stress') throw new Error('unexpected-operation');
      const report = stressV2Report(); report.plan = input.target.plan; report.target = input.target.plan.target; report.projectId = f.store.project!.id;
      return OnlineLocalResultSchema.parse(JSON.parse(JSON.stringify({ location: { kind: 'local' }, runId: input.runId, snapshotId: '66', manifestHash: 'a'.repeat(64), runtimeCompatibilityId: 'recorded-local-runtime', scriptTimeoutMs: 3000, output: { kind: 'stress', result: report } })));
    } });
    try {
      await f.view.get('[data-testid="online-stress-plan"]').setValue('saved');
      await f.view.get('[data-testid="online-stress-origins"]').setValue('http://127.0.0.1:8123');
      await f.view.get('[data-testid="online-stress-confirm"]').trigger('click');
      expect(f.view.get('[data-testid="online-stress-run"]').attributes('disabled')).toBeUndefined();
      await f.view.get('[data-testid="online-stress-origins"]').setValue(origins);
      expect.soft(f.view.get('[data-testid="online-stress-run"]').attributes('disabled')).toBeDefined();
      await f.view.get('[data-testid="online-stress-run"]').trigger('click'); await flushPromises();
      expect(calls.filter(call => call.operation === 'run')).toEqual([]);
      await f.view.get('[data-testid="online-stress-origins"]').setValue('http://127.0.0.1:9123');
      await f.view.get('[data-testid="online-stress-confirm"]').trigger('click');
      expect(f.view.get('[data-testid="online-stress-run"]').attributes('disabled')).toBeUndefined();
      await f.view.get('[data-testid="online-stress-run"]').trigger('click'); await flushPromises();
      expect(calls.filter(call => call.operation === 'run')).toMatchObject([{ runConfig: { stress: { workerCount: 1, confirmedTargetOrigins: ['http://127.0.0.1:9123'] } } }]);
    } finally { f.store.setVisible(false); }
  });
  // A pending local B may coexist with inspected agent A; Stop must follow A, not active B.
  it('stops only the inspected agent stress job while a different local stress run remains pending', async () => {
    const calls: OnlineExecutionInput[] = []; let finish!: (value: unknown) => void;
    const pending = new Promise(resolve => { finish = resolve; });
    let agentJob: ReturnType<typeof OnlineJobSchema.parse>;
    const f = panelFixture({ onlineExecution: async input => { calls.push(input); if (input.operation === 'run') return pending; if (input.operation === 'cancel') return input.location.kind === 'agent' ? { ...agentJob, cancelState: 'requested' } : {}; throw new Error('unexpected-operation'); } });
    await f.view.get('[data-testid="online-stress-plan"]').setValue('saved');
    const plan = f.store.project!.stressPlans![0]!.plan;
    agentJob = OnlineJobSchema.parse({ jobId: '99', executionId: '100', agentId: '5', state: 'running', cancelState: 'none', executionReleased: false, reportState: 'none', canCancel: true,
      task: { protocolVersion: 1, jobId: '99', executionId: '100', scope: f.store.context!.scope, submittedByUserId: '7', contractProjectId: f.store.project!.id, snapshotId: '66', manifestHash: 'a'.repeat(64), target: { kind: 'stress', plan }, policyVersion: '0', requiredCoreBuildId: 'b'.repeat(64), scriptPlanDigest: 'c'.repeat(64), executionProfile: 'no-script', runtimeCompatibilityId: 'recorded-agent-runtime', dispatchKind: 'dedicated-task', requiredCapabilities: ['protocol:http', 'task:stress', 'stress:local-workers-v1'] } });
    await f.view.get('[data-testid="online-stress-origins"]').setValue('http://127.0.0.1:8123');
    await f.view.get('[data-testid="online-stress-confirm"]').trigger('click');
    await f.view.get('[data-testid="online-stress-run"]').trigger('click'); await flushPromises();
    const run = calls.find(call => call.operation === 'run'); if (!run || run.operation !== 'run') throw new Error('expected-local-run');
    try {
      expect(f.store.activeLocalRunId).toBe(run.runId); f.store.jobs = [agentJob];
      await f.store.inspect(agentJob); await flushPromises();
      expect(f.store.resultSelection).toMatchObject({ kind: 'agent', job: { jobId: '99', executionId: '100' } });
      expect(f.view.get('[data-testid="online-stress-stop"]').attributes('disabled')).toBeUndefined();
      await f.view.get('[data-testid="online-stress-stop"]').trigger('click'); await flushPromises();
      expect(calls.filter(call => call.operation === 'cancel')).toEqual([{ operation: 'cancel', context: run.context, location: { kind: 'agent', agentId: '5' }, runId: '99' }]);
      expect(f.store.activeLocalRunId).toBe(run.runId);
    } finally {
      finish(OnlineLocalResultSchema.parse({ location: { kind: 'local' }, runId: run.runId, snapshotId: '66', manifestHash: 'a'.repeat(64), runtimeCompatibilityId: 'recorded-local-runtime', scriptTimeoutMs: 3000, output: { kind: 'stress-failure', error: 'worker-failed', started: false, requests: { started: 0, completed: 0 } } }));
      await flushPromises(); f.store.setVisible(false);
    }
  });
  // A bad user parameter must produce a readable refusal, not dump an internal Zod issue array.
  it('explains invalid worker and origin input directly without JSON diagnostics', async () => {
    const f = panelFixture({ onlineExecution: async () => [] }); f.i18n.global.locale.value = 'en';
    await f.view.get('[data-testid="online-stress-plan"]').setValue('saved');
    await f.view.get('[data-testid="online-stress-workers"]').setValue(0);
    await f.view.get('[data-testid="online-stress-origins"]').setValue('not-an-origin');
    await f.view.get('[data-testid="online-stress-confirm"]').trigger('click'); await flushPromises();
    expect(f.view.get('[role="alert"]').text()).toContain('Enter a positive worker count and canonical HTTP(S) origins.');
    expect(f.view.get('[data-testid="online-stress-run"]').attributes('disabled')).toBeDefined(); f.store.setVisible(false);
  });
  // The specification allows either the outer environment or plan environment to be the sole source.
  it('allows a confirmed saved plan with only an outer project environment selected', async () => {
    const f = panelFixture({ onlineExecution: async () => [] });
    await f.view.get('[data-testid="online-stress-plan"]').setValue('saved');
    f.store.environmentId = '00000000-0000-4000-8000-000000000019';
    await f.view.get('[data-testid="online-stress-origins"]').setValue('http://127.0.0.1:8123');
    await f.view.get('[data-testid="online-stress-confirm"]').trigger('click');
    expect(f.view.get('[data-testid="online-stress-run"]').attributes('disabled')).toBeUndefined();
    f.store.setVisible(false);
  });
  // An online project without any prior local plan still needs a real editable, unsaved draft.
  it('creates an editable new plan draft and saves it with the current assets version before running', async () => {
    let input: import('../../../src/shared/online/execution.js').OnlineExecutionInput | undefined;
    const f = panelFixture({ onlineExecution: async request => { input = request; if (request.operation !== 'saveProject') throw new Error('unexpected-operation'); return { ...f.store.view, project: request.project, assets: { ...f.store.view!.assets, version: '2' } }; } });
    f.store.project!.stressPlans = []; f.store.saved = JSON.stringify(f.store.project);
    await f.view.get('[data-testid="online-stress-new"]').trigger('click');
    expect(f.view.find('[data-testid="stress-load-editor"]').exists()).toBe(true);
    expect(f.view.get('[data-testid="online-stress-run"]').attributes('disabled')).toBeDefined();
    await f.view.get('[data-testid="online-stress-name"]').setValue('New saved scenario');
    await f.view.get('[data-testid="online-stress-save"]').trigger('click'); await flushPromises();
    expect(input).toMatchObject({ operation: 'saveProject', expectedVersion: '1', project: { stressPlans: [{ name: 'New saved scenario', plan: { formatVersion: 1, target: { kind: 'workflow', workflowId: '00000000-0000-4000-8000-000000000091' } } }] } });
    expect(f.store.view?.assets.version).toBe('2'); expect(f.view.text()).toContain('New saved scenario');
    f.store.setVisible(false);
  });
  // Start and stop must address the actual selected local run, never a new task or another context.
  it('starts the confirmed saved plan and stops exactly that pending local run', async () => {
    const calls: import('../../../src/shared/online/execution.js').OnlineExecutionInput[] = [];
    let finish!: (value: unknown) => void;
    const pending = new Promise(resolve => { finish = resolve; });
    const f = panelFixture({ onlineExecution: async input => { calls.push(input); if (input.operation === 'run') return pending; if (input.operation === 'cancel') return {}; throw new Error('unexpected-operation'); } });
    await f.view.get('[data-testid="online-stress-plan"]').setValue('saved');
    await f.view.get('[data-testid="online-stress-origins"]').setValue('http://127.0.0.1:8123');
    await f.view.get('[data-testid="online-stress-confirm"]').trigger('click');
    await f.view.get('[data-testid="online-stress-run"]').trigger('click'); await flushPromises();
    expect(calls.filter(call => call.operation === 'run')).toHaveLength(1);
    const run = calls.find(call => call.operation === 'run')!; if (run.operation !== 'run') throw new Error('expected run');
    expect(run).toMatchObject({ expectedVersion: '1', location: { kind: 'local' }, target: { kind: 'stress', plan: f.store.project!.stressPlans![0]!.plan }, runConfig: { stress: { workerCount: 1, confirmedTargetOrigins: ['http://127.0.0.1:8123'] } } });
    await f.view.get('[data-testid="online-stress-stop"]').trigger('click'); await flushPromises();
    expect(calls.filter(call => call.operation === 'cancel')).toEqual([{ operation: 'cancel', context: run.context, location: { kind: 'local' }, runId: run.runId }]);
    finish({ location: { kind: 'local' }, runId: run.runId, snapshotId: '66', manifestHash: 'a'.repeat(64), runtimeCompatibilityId: 'recorded-local-runtime', scriptTimeoutMs: 3000, output: { kind: 'stress-failure', error: 'worker-failed', started: false, requests: { started: 0, completed: 0 } } });
    await flushPromises(); expect(f.store.running).toBe(false); f.store.setVisible(false);
  });
  // Saving must use the current assets version; a conflict must not authorize an unsaved draft.
  it('keeps an edited plan blocked after an expected-version save conflict', async () => {
    let version = '';
    const f = panelFixture({ onlineExecution: async input => { if (input.operation !== 'saveProject') throw new Error('unexpected-operation'); version = input.expectedVersion; throw new Error('version_conflict'); } });
    await f.view.get('[data-testid="online-stress-plan"]').setValue('saved');
    expect(f.view.find('[data-testid="online-stress-save"]').exists()).toBe(true);
    await f.view.findAll('label').find(label => label.text() === f.i18n.global.t('stress.workbench.think'))!.get('input').setValue(1);
    await f.view.get('[data-testid="online-stress-save"]').trigger('click'); await flushPromises();
    expect(version).toBe('1'); expect(f.store.view?.assets.version).toBe('1');
    expect(f.view.get('[role="alert"]').text()).toContain(f.i18n.global.t('onlineStress.conflict'));
    expect(f.view.get('[data-testid="online-stress-run"]').attributes('disabled')).toBeDefined();
    expect(f.store.project?.stressPlans?.[0]?.plan.thinkTimeMs).toBe(0);
    f.store.setVisible(false);
  });
  // A confirmation belongs to the selected machine, environment and fixed plan, not to the form alone.
  it('requires a fresh target confirmation after changing location and preserves the plan environment', async () => {
    const f = panelFixture({ onlineExecution: async () => [] });
    await f.view.get('[data-testid="online-stress-plan"]').setValue('saved');
    expect(f.view.find('[data-testid="online-stress-origins"]').exists()).toBe(true);
    await f.view.get('[data-testid="online-stress-origins"]').setValue('http://127.0.0.1:8123');
    await f.view.get('[data-testid="online-stress-confirm"]').trigger('click');
    expect(f.view.get('[data-testid="online-stress-run"]').attributes('disabled')).toBeUndefined();
    const before = f.store.environmentId;
    f.store.selectLocation({ kind: 'agent', agentId: '5' }); await flushPromises();
    expect(f.store.environmentId).toBe(before); expect(f.store.stressConfirmedOrigins).toEqual([]);
    expect(f.view.get('[data-testid="online-stress-run"]').attributes('disabled')).toBeDefined();
    expect(f.view.text()).toContain(f.i18n.global.t('onlineStress.agentUnavailable'));
    f.store.setVisible(false);
  });
  // Removing the real plan editor or location/environment controls must break this visible consumer.
  it('shows saved plan, location, environment, run and stop with loopback semantics', async () => {
    const store = createOnlineExecutionStore({ onlineExecution: async () => [] });
    const project = ContractWorkspaceSchema.parse(workspaceFixture()).groups[0]!.projects[0]!;
    project.workflows = [{ id: '00000000-0000-4000-8000-000000000091', name: 'Scenario', status: 'enabled', nodes: [{ id: 'noop', kind: 'noop' }], edges: [] }];
    project.stressPlans = [{ formatVersion: 1, id: 'saved', name: 'Saved scenario', updatedAt: 0, plan: StressPlanSchema.parse({ formatVersion: 1, target: { kind: 'workflow', workflowId: project.workflows[0]!.id }, load: { kind: 'constant-vus', vus: 1 }, termination: { maxIterations: 1 } }) }];
    store.project = project;
    const { i18n } = createI18nInstance();
    const view = mount(OnlineStressPanel, { props: { execution: store }, global: { plugins: [i18n] } });
    expect(view.text()).toContain('Saved scenario');
    expect(view.find('[data-testid="online-stress-location"]').exists()).toBe(true);
    expect(view.find('[data-testid="online-stress-environment"]').exists()).toBe(true);
    expect(view.find('[data-testid="online-stress-run"]').text()).toBe(i18n.global.t('stress.start'));
    expect(view.find('[data-testid="online-stress-stop"]').text()).toBe(i18n.global.t('stress.stop'));
    expect(view.text()).toContain('loopback');
    expect(view.find('pre').exists()).toBe(false);
  });
});
