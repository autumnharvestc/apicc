// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { mount, flushPromises, enableAutoUnmount } from "@vue/test-utils";
import { createAgentsStore } from "../../src/stores/agents.js";
import { createAdminClient } from "../../src/api/client.js";
import { createAdminI18n } from "../../src/i18n/index.js";
import AgentsView from "../../src/views/AgentsView.vue";
import { defaultAgentConfig, defaultDeploymentConfig,defaultPolicyConfig } from "@apicc/execution/contract";
import type { AgentDetail,AgentPatch } from "../../src/api/agents.js";
enableAutoUnmount(afterEach);
const node = { id: "1", name: "共享节点", acceptingJobs: true, revoked: false };
function setup(platform = true, initialConfig:AgentPatch={}) {
  localStorage.setItem("apicc.admin.locale", "zh-CN");
  let saved = false;
  let config={...defaultAgentConfig,...initialConfig};let name=node.name;
  const patches:{config:AgentPatch;name?:string}[]=[];
  const detail=():AgentDetail=>({ ...node,name, configVersion: saved ? "1" : "0", appliedConfigVersion: "0", explicit: saved ? patches.at(-1)!.config : initialConfig, config, sources: { maxConcurrentJobs: saved ? "agent" : "default" }, restrictions:[],deployment:{...defaultDeploymentConfig}, pendingFields: saved ? ["maxConcurrentJobs"] : [], restartRequiredFields: [], status: saved ? "pending" : "applied", agentPolicy: { version: "0", maxQueuedJobs: 100, explicit: {} }, availability: "runtime-missing", lastSeenAt: null });
  const client = createAdminClient({ token: "member", fetch: async (url, init) => {
    if (init?.method === "PATCH") { const input = JSON.parse(String(init.body));patches.push(input);config={...config,...input.config};name=input.name??name;saved=true; }
    const result=String(url).endsWith('/agents')?[node]:String(url).endsWith('/workspace-directory')?[]:String(url).endsWith('/workspace-grants')?{workspaceIds:[]}:detail();
    return new Response(JSON.stringify(result));
  } });
  const agents = createAgentsStore({ client });
  agents.nodes = [node];
  agents.node = detail();
  const { i18n } = createAdminI18n();
  return { agents, i18n,patches, wrapper: mount(AgentsView, { attachTo:document.body, props: { agents, platform }, global: { plugins: [i18n] } }) };
}
describe("平台节点管理", () => {
  it('final I3 shows occupied resource quantities and explicit over-limit draining without JSON',async()=>{
    const {agents,wrapper,i18n}=setup();await flushPromises();
    agents.node={...agents.node!,stressCapacity:{used:{jobs:1,processes:3,vus:2,requestConcurrency:2,maxRps:1.5,metricMemoryBytes:3145728},limits:{jobs:1,processes:2,vus:100,requestConcurrency:100,maxRps:2,metricMemoryBytes:67108864},drainingDimensions:['processes']}};await flushPromises();
    expect.soft(wrapper.text()).toContain('当前资源占用');expect.soft(wrapper.text()).toContain('超额排空');expect.soft(wrapper.text()).toContain('3 / 2 执行进程');expect.soft(wrapper.text()).toContain('1.5 / 2 请求/秒');
    i18n.global.locale.value='en';await flushPromises();expect.soft(wrapper.text()).toContain('Over-limit draining');expect.soft(wrapper.text()).toContain('3 / 2 execution processes');
  });
  // Wrong business units or omitted fixed stress fields must be visible before saving.
  it('T7 shows stress admission units, authoritative sources and saves fractional request RPS', async () => {
    const {wrapper,i18n,patches}=setup();await flushPromises();
    const vectors=[['压测任务槽','任务','1'],['压测执行进程总数','执行进程','5'],['压测 VU 上限','VU','100'],['压测请求并发上限','请求','100'],['压测请求速率上限','请求/秒','1000'],['压测数值内存预算','MiB','320'],['压测进度间隔','秒','1']];
    for(const [label,unit,value] of vectors){const row=wrapper.findAll('tbody tr').find(row=>row.find('th').text().includes(label!));expect.soft(row?.text()).toContain(unit);expect.soft(row?.findAll('td')[0]?.text()).toBe(value);expect.soft(row?.text()).toContain('默认');}
    const input=wrapper.find('input[aria-label="压测请求速率上限"]');
    expect(input.exists()).toBe(true);await input.setValue('12.5');await wrapper.get('[data-testid="agent-save"]').trigger('click');await flushPromises();
    expect(patches.at(-1)?.config.maxStressRps).toBe(12.5);
    expect(wrapper.get('[data-testid="agent-application"]').text()).toContain('待应用');
    i18n.global.locale.value='en';await flushPromises();expect(wrapper.text()).toContain('requests/s');expect(wrapper.text()).toContain('execution processes');
  });
  it("分配读取完成前禁止空写，读入后保持既有选择并拒绝错误工作区写入",async()=>{
    localStorage.setItem('apicc.admin.locale','zh-CN');let finish!: (response:Response)=>void;
    const writes:string[][]=[];
    const client=createAdminClient({token:'admin',fetch:async(url,init)=>{
      if(String(url).includes('/agent-project-allocations')){
        if(init?.method==='PUT'){writes.push(JSON.parse(String(init.body)).projectIds);return new Response(null,{status:204});}
        return new Promise<Response>(resolve=>finish=resolve);
      }
      const result=String(url).endsWith('/available-agents')?[node]:String(url).endsWith('/tree')?{workspaceId:'1',rootVersion:0,files:[],projects:[{id:'2',name:'原已分配项目',myRole:'ADMIN'}]}:{configVersion:'0',policyVersion:'0',policy:{...defaultPolicyConfig},explicit:{},sources:{},restrictions:[]};
      return new Response(JSON.stringify(result));
    }});
    const agents=createAgentsStore({client});const {i18n}=createAdminI18n();
    const wrapper=mount(AgentsView,{attachTo:document.body,props:{agents,platform:false,workspaceId:'1'},global:{plugins:[i18n]}});
    await flushPromises();await wrapper.get('select').setValue('1');await flushPromises();
    const save=()=>wrapper.findAll('button').find(b=>b.text()==='保存项目分配')!;
    expect(wrapper.get('.checks input').attributes('disabled')).toBeDefined();
    expect(save().attributes('disabled')).toBeDefined();
    expect(await agents.allocate('1','1',[])).toBe(false);expect(writes).toEqual([]);
    finish(new Response(JSON.stringify({agentId:'1',projectIds:['2']})));await flushPromises();
    expect((wrapper.get('.checks input').element as HTMLInputElement).checked).toBe(true);
    expect(save().attributes('disabled')).toBeUndefined();
    expect(await agents.allocate('3','1',[])).toBe(false);expect(writes).toEqual([]);
    await wrapper.get('.checks input').setValue(false);await save().trigger('click');await flushPromises();
    expect(writes).toEqual([[]]);
  });
  it("合法1001毫秒未编辑字段不会阻止其他修改，真实亚毫秒输入不得取整保存",async()=>{
    const {wrapper,agents,patches}=setup(true,{sharedDebugIdleMs:1001});await flushPromises();
    await wrapper.findAll('input[maxlength="128"]').at(-1)!.setValue('节点改名');
    await wrapper.get('[data-testid="agent-save"]').trigger('click');await flushPromises();
    expect(agents.node?.name).toBe('节点改名');
    expect(patches[0]!.config).not.toHaveProperty('sharedDebugIdleMs');
    expect(agents.node?.config.sharedDebugIdleMs).toBe(1001);
    await wrapper.get('input[aria-label="共享调试空闲回收"]').setValue('1.003');
    await wrapper.get('[data-testid="agent-save"]').trigger('click');await flushPromises();
    expect(agents.node?.config.sharedDebugIdleMs).toBe(1003);
    const count=patches.length;
    await wrapper.get('input[aria-label="共享调试空闲回收"]').setValue('1.0001');
    await wrapper.get('[data-testid="agent-save"]').trigger('click');await flushPromises();
    expect(patches).toHaveLength(count);expect(agents.node?.config.sharedDebugIdleMs).toBe(1003);
    expect(wrapper.get('[role="alert"]').text()).toContain('共享调试空闲回收');
    expect(wrapper.get('[role="alert"]').text()).toContain('毫秒');
    await wrapper.get('input[aria-label="共享调试空闲回收"]').setValue('1.0030000000000000001');
    await wrapper.get('[data-testid="agent-save"]').trigger('click');await flushPromises();
    expect(patches).toHaveLength(count);expect(agents.node?.config.sharedDebugIdleMs).toBe(1003);
  });
  it("普通数值校验显示本地化业务字段、单位和原因而非JSON",async()=>{
    const {wrapper,i18n,patches}=setup();await flushPromises();
    await wrapper.get('[data-testid="agent-concurrency"]').setValue('0');
    await wrapper.get('[data-testid="agent-save"]').trigger('click');await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('并发任务数');
    expect(wrapper.get('[role="alert"]').text()).toContain('大于 0');
    expect(wrapper.get('[role="alert"]').text()).toContain('项');
    expect(wrapper.get('[role="alert"]').text()).not.toContain('"code"');
    expect(patches).toEqual([]);
    i18n.global.locale.value='en';await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('Concurrent jobs');
    expect(wrapper.get('[role="alert"]').text()).toContain('greater than 0');
    expect(wrapper.get('[role="alert"]').text()).toContain('items');
  });
  it("会话重置后迟到的平台目录与列表不会重新出现",async()=>{
    let finish:((response:Response)=>void)[]=[];
    const client=createAdminClient({fetch:()=>new Promise<Response>(resolve=>finish.push(resolve))});
    const agents=createAgentsStore({client});
    const pending=Promise.all([agents.refreshNodes(),agents.loadDirectory()]);
    agents.reset();
    finish[0]!(new Response(JSON.stringify([node])));
    finish[1]!(new Response(JSON.stringify([{id:'2',name:'上个账号的工作区'}])));
    await pending;
    expect(agents.nodes).toEqual([]);
    expect(agents.directory).toEqual([]);
  });
  // A project ADMIN must not gain shared node write authority from a visible form.
  it("只有项目ADMIN时不能编辑平台节点参数", () => {
    const { wrapper } = setup(false);
    expect((wrapper.get('[data-testid="agent-concurrency"]').element as HTMLInputElement).disabled).toBe(true);
    expect(wrapper.get('[data-testid="agent-save"]').attributes("disabled")).toBeDefined();
  });
  // Saving a new version is not acknowledgement by the running agent.
  it("保存并发2仍显示保存版本1、运行已应用版本0及待应用字段", async () => {
    const { wrapper,i18n } = setup();
    await wrapper.get('[data-testid="agent-concurrency"]').setValue("2");
    await wrapper.get('[data-testid="agent-save"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="agent-application"]').text()).toContain("待应用");
    expect(wrapper.get('[data-testid="agent-application"]').text()).toContain("1");
    expect(wrapper.get('[data-testid="agent-application"]').text()).toContain("0");
    expect(wrapper.text()).toContain("并发任务数");
    expect(wrapper.text()).toContain("默认");
    i18n.global.locale.value='en';await flushPromises();
    expect(wrapper.text()).toContain('Concurrent jobs');
    expect(wrapper.text()).toContain('Pending application');
    expect(wrapper.text()).toContain('seconds');
    expect(wrapper.text()).not.toContain('agents.fields.');
  });
});
