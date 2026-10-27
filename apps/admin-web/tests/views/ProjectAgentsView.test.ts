// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { mount, flushPromises, enableAutoUnmount } from "@vue/test-utils";
import { createAgentsStore } from "../../src/stores/agents.js";
import { createAdminClient } from "../../src/api/client.js";
import { createAdminI18n } from "../../src/i18n/index.js";
import ProjectAgentsView from "../../src/views/ProjectAgentsView.vue";
import { defaultPolicyConfig } from "@apicc/execution/contract";
import type { ScriptGrant } from "../../src/api/agents.js";
enableAutoUnmount(afterEach);
async function projectFixture(){
  localStorage.setItem('apicc.admin.locale','zh-CN');
  const grants:Record<string,ScriptGrant>=Object.fromEntries(['1','2'].map(id=>[id,{agentId:id,version:'0',scope:'script-version',scripts:[],grantedByUserId:'7'}]));
  const policy={...defaultPolicyConfig,maxQueuedJobs:50};
  const settings={configVersion:'0',policyVersion:'0',agentIds:['1','2'],defaultAgentId:'1',jobTimeoutMs:1800000,versions:{workspace:'0',project:'0'},queueLimits:{global:1000,agent:null,project:50},explicit:{workspace:{},project:{},run:{}},policy,sources:{},restrictions:[]};
  const candidates=['1','2'].map(id=>({id,name:`受信节点${id}`,acceptingJobs:true,revoked:false}));
  const client=createAdminClient({token:'admin',fetch:async(url,init)=>{
    const uri=new URL(String(url),'http://localhost');
    if(uri.pathname.endsWith('/script-grants')){
      const value=init?.method==='PUT'?JSON.parse(String(init.body)):null;
      const id=value?.agentId??uri.searchParams.get('agentId')!;
      if(value){if(value.expectedVersion!==grants[id]!.version)return new Response(JSON.stringify({code:'version_conflict',message:'批准版本已变化'}),{status:409});grants[id]={...grants[id]!,version:String(Number(grants[id]!.version)+1),scope:value.scope,scripts:value.scripts};}
      return new Response(JSON.stringify(grants[id]));
    }
    const projection={canManageScripts:true,defaultAgentId:'1',policyVersion:'0',policy,agents:candidates.map(n=>({id:n.id,name:n.name,acceptingJobs:true,availability:'runtime-missing',lastSeenAt:null,configuration:{configVersion:'0',appliedConfigVersion:'0',pendingFields:[],restartRequiredFields:[],status:'applied'},policy,policyVersion:'0',scriptsAllowed:true,scriptGrant:{version:grants[n.id]!.version,scope:grants[n.id]!.scope,scripts:grants[n.id]!.scripts}}))};
    return new Response(JSON.stringify(uri.pathname.endsWith('/execution-agents')?projection:uri.pathname.endsWith('/agent-candidates')?candidates:settings));
  }});
  const agents=createAgentsStore({client});const {i18n}=createAdminI18n();
  const wrapper=mount(ProjectAgentsView,{attachTo:document.body,props:{agents,workspaceId:'1',projectId:'2',agentId:'1'},global:{plugins:[i18n]}});
  await flushPromises();await flushPromises();return {wrapper,agents,grants};
}
describe("项目代理管理", () => {
  it("批准CAS冲突后重新加载同项目可恢复编辑器并读取最新批准版本",async()=>{
    const {wrapper,agents,grants}=await projectFixture();
    expect(wrapper.find('[data-testid="script-save"]').exists()).toBe(true);
    grants['1']!.version='6';
    await wrapper.get('[data-testid="script-save"]').trigger('click');await flushPromises();
    expect(agents.conflict).toBe(true);
    await wrapper.findAll('button').find(b=>b.text()==='重新加载')!.trigger('click');await flushPromises();await flushPromises();
    expect(wrapper.find('[data-testid="script-save"]').exists()).toBe(true);
    expect(agents.grant?.version).toBe('6');
    expect((wrapper.get('[data-testid="script-agent"]').element as HTMLSelectElement).value).toBe('1');
  });
  it("同项目显式代理切换定位新范围，无效目标保留可行动拒绝提示",async()=>{
    const {wrapper,agents}=await projectFixture();
    await wrapper.setProps({agentId:'2'});await flushPromises();
    expect((wrapper.get('[data-testid="script-agent"]').element as HTMLSelectElement).value).toBe('2');
    expect(agents.grant?.agentId).toBe('2');
    await wrapper.get('[data-testid="script-save"]').trigger('click');await flushPromises();
    expect(agents.grant?.agentId).toBe('2');expect(agents.grant?.version).toBe('1');
    await wrapper.setProps({agentId:'999'});await flushPromises();
    expect((wrapper.get('[data-testid="script-agent"]').element as HTMLSelectElement).value).toBe('');
    expect(wrapper.get('[role="alert"]').text()).toContain('链接指定的代理不在本项目已关联集合');
    expect(wrapper.get('[role="alert"]').text()).toContain('联系工作区/项目管理员');
    expect(wrapper.find('[data-testid="script-save"]').exists()).toBe(false);
  });
  it("按真实脚本版本批准，整项目信任须显式风险确认，并可撤销",async()=>{
    localStorage.setItem('apicc.admin.locale','zh-CN');
    let approved:ScriptGrant={agentId:'1',version:'0',scope:'script-version',scripts:[],grantedByUserId:'7'};
    const policy={...defaultPolicyConfig,maxQueuedJobs:50};
    const settings={configVersion:'0',policyVersion:'0',agentIds:['1'],defaultAgentId:'1',jobTimeoutMs:1800000,versions:{workspace:'0',project:'0'},queueLimits:{global:1000,agent:null,project:50},explicit:{workspace:{},project:{},run:{}},policy,sources:{},restrictions:[]};
    const client=createAdminClient({token:'admin',fetch:async(url,init)=>{
      if(String(url).includes('/script-grants')){
        if(init?.method==='PUT'){
          const value=JSON.parse(String(init.body));
          if(value.agentId!=='1'||value.expectedVersion!==approved.version||(value.scope==='project'&&!value.riskConfirmed))return new Response(JSON.stringify({code:'version_conflict',message:'批准版本不符或风险未确认'}),{status:409});
          approved={agentId:'1',version:String(Number(approved.version)+1),scope:value.scope,scripts:value.scripts,grantedByUserId:'7'};
        }
        return new Response(JSON.stringify(approved));
      }
      const projection={canManageScripts:true,defaultAgentId:'1',policyVersion:'0',policy,agents:[{id:'1',name:'受信节点',acceptingJobs:true,availability:'runtime-missing',lastSeenAt:null,configuration:{configVersion:'0',appliedConfigVersion:'0',pendingFields:[],restartRequiredFields:[],status:'applied'},policy,policyVersion:'0',scriptsAllowed:true,scriptGrant:{version:approved.version,scope:approved.scope,scripts:approved.scripts}}]};
      return new Response(JSON.stringify(String(url).endsWith('/execution-agents')?projection:String(url).endsWith('/agent-candidates')?[{id:'1',name:'受信节点',acceptingJobs:true,revoked:false}]:settings));
    }});
    const agents=createAgentsStore({client});const {i18n}=createAdminI18n();
    const wrapper=mount(ProjectAgentsView,{attachTo:document.body,props:{agents,workspaceId:'1',projectId:'2',agentId:'1'},global:{plugins:[i18n]}});
    await flushPromises();await flushPromises();
    const scriptSection=wrapper.get('[data-testid="project-script-management"]');
    expect(scriptSection.text()).toContain('并非项目现行源码扫描结果');
    const add=scriptSection.findAll('button').find(b=>b.text()==='添加脚本版本')!;
    await add.trigger('click');
    await scriptSection.get('input[aria-label="真实脚本 ID"]').setValue('project:before-request');
    await scriptSection.get('input[aria-label="完整内容摘要（SHA-256）"]').setValue('a'.repeat(64));
    await wrapper.get('[data-testid="script-save"]').trigger('click');await flushPromises();
    expect(agents.grant?.version).toBe('1');
    expect(agents.grant?.scripts).toEqual([{scriptId:'project:before-request',contentHash:'a'.repeat(64)}]);
    await wrapper.get('[data-testid="script-scope"]').setValue('project');
    expect(wrapper.get('[data-testid="script-save"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-testid="script-risk"]').setValue(true);
    await wrapper.get('[data-testid="script-save"]').trigger('click');await flushPromises();
    expect(agents.grant?.version).toBe('2');expect(agents.grant?.scope).toBe('project');
    await wrapper.get('[data-testid="script-revoke"]').trigger('click');await flushPromises();
    expect(agents.grant?.version).toBe('3');expect(agents.grant?.scope).toBe('script-version');expect(agents.grant?.scripts).toEqual([]);
    i18n.global.locale.value='en';await flushPromises();
    expect(wrapper.text()).toContain('Tasks without scripts need no script approval.');
    expect(wrapper.text()).toContain('seconds');
    expect(wrapper.text()).not.toContain('agents.fields.');
  });
  // A project must select only its allocated candidate pool, never global nodes.
  it("未授权全局节点不进入候选下拉；写入被后端拒绝时直接显示原因", async () => {
    localStorage.setItem("apicc.admin.locale", "zh-CN");
    const candidate={id:"1",name:"本项目已分配节点",acceptingJobs:true,revoked:false};
    const policy={...defaultPolicyConfig,maxQueuedJobs:50};
    const projection={canManageScripts:true,agents:[],defaultAgentId:null,policyVersion:"0",policy};
    const settings={configVersion:"0",policyVersion:"0",agentIds:[],defaultAgentId:null,jobTimeoutMs:1800000,versions:{workspace:'0',project:'0'},queueLimits:{global:1000,agent:null,project:50},explicit:{workspace:{},project:{},run:{}},policy,sources:{},restrictions:[]};
    const client = createAdminClient({ token: "member", fetch: async (url,init) => {
      if(init?.method==='PUT')return new Response(JSON.stringify({ code: "agent_not_allocated", message: "代理未获工作区及本项目分配授权" }), { status: 403 });
      return new Response(JSON.stringify(String(url).endsWith('/execution-agents')?projection:String(url).endsWith('/agent-candidates')?[candidate]:settings));
    } });
    const agents = createAgentsStore({ client });
    agents.nodes = [{ id: "9", name: "无权全局节点", acceptingJobs: true, revoked: false }];
    const { i18n } = createAdminI18n();
    const wrapper = mount(ProjectAgentsView, { attachTo:document.body, props: { agents, workspaceId: "1", projectId: "2" }, global: { plugins: [i18n] } });
    await flushPromises();
    const choices = wrapper.get('[data-testid="project-agent-choice"]');
    expect(choices.findAll("option").map(o => o.attributes("value"))).not.toContain("9");
    expect(choices.text()).toContain("本项目已分配节点");
    await choices.setValue("1");
    await wrapper.get('[data-testid="project-agents-save"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("代理未获工作区及本项目分配授权");
  });
});
