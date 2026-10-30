// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it } from 'vitest';
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils';
import { createAdminI18n } from '../../src/i18n/index.js';
import { createAdminClient } from '../../src/api/client.js';
import { createSessionStore } from '../../src/stores/session.js';
import { createWorkspacesStore } from '../../src/stores/workspaces.js';
import { createUsersStore } from '../../src/stores/users.js';
import { createOrgStore } from '../../src/stores/org.js';
import { createAppRouter } from '../../src/router/index.js';
import App from '../../src/App.vue';
import { readFileSync } from 'node:fs';
import SchedulePolicyView from '../../src/views/SchedulePolicyView.vue';
import { actualPolicy,jsonResponse,schedulingHarness,mountSchedulingRoute } from '../helpers/scheduling.js';

beforeAll(()=>{Object.defineProperty(window,'matchMedia',{writable:true,value:(query:string)=>({matches:false,media:query,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}})});});
enableAutoUnmount(afterEach);
const response=(data:unknown)=>new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
describe('workspace scheduling navigation',()=>{
  it('offers the selected workspace administrator a scheduling policy entry',async()=>{
    const client=createAdminClient({token:'t7-session',fetch:async(input)=>{
      const url=String(input);
      if(url.endsWith('/workspaces/1'))return response({id:'1',name:'团队',myRole:'OWNER',memberCount:1});
      if(url.endsWith('/me'))return response({id:'1',username:'admin',displayName:'管理员',role:'USER'});
      return response([]);
    }});
    localStorage.setItem('apicc.admin.token','t7-session');localStorage.setItem('apicc.admin.locale','zh-CN');
    const session=createSessionStore({client});await session.initialize();
    const workspaces=createWorkspacesStore({client});await workspaces.select('1');
    const router=createAppRouter({client,session,workspaces,users:createUsersStore({client}),org:createOrgStore({client})});
    await router.push('/workspaces/1/org');await router.isReady();
    const {i18n}=createAdminI18n();const wrapper=mount(App,{global:{plugins:[router,i18n]}});await flushPromises();
    expect(wrapper.find('[data-testid="menu-schedule-policy"]').exists()).toBe(true);
  });
  it('opens a policy table with default, scope explicit, effective, source and versions',async()=>{
    const view=JSON.parse(readFileSync('../../server/src/test/resources/scheduling/t7-project-policy.json','utf8'));
    const client=createAdminClient({token:'t7-session',fetch:async(input)=>{
      const url=String(input);if(url.endsWith('/schedule-policy'))return response(view);
      if(url.endsWith('/workspaces/1'))return response({id:'1',name:'团队',myRole:'OWNER',memberCount:1});
      if(url.endsWith('/me'))return response({id:'1',username:'admin',displayName:'管理员',role:'USER'});return response([]);
    }});
    localStorage.setItem('apicc.admin.token','t7-session');localStorage.setItem('apicc.admin.locale','zh-CN');
    const session=createSessionStore({client});await session.initialize();const workspaces=createWorkspacesStore({client});await workspaces.select('1');
    const router=createAppRouter({client,session,workspaces,users:createUsersStore({client}),org:createOrgStore({client})});await router.push('/workspaces/1/org');await router.isReady();
    const {i18n}=createAdminI18n();const wrapper=mount(App,{global:{plugins:[router,i18n]}});await flushPromises();
    await wrapper.get('[data-testid="menu-schedule-policy"]').trigger('click');await flushPromises();
    expect(wrapper.text()).toContain('默认值');
    expect(wrapper.text()).toContain('工作区显式值');expect(wrapper.text()).toContain('生效值');expect(wrapper.text()).toContain('来源');expect(wrapper.text()).toContain('版本');
    expect(wrapper.findAll('[data-testid^="policy-row-"]')).toHaveLength(11);
    const row=wrapper.get('[data-testid="policy-row-minIntervalMs"]');expect(row.text()).toContain('最小间隔');expect(row.text()).toContain('120');expect(row.text()).toContain('秒');
    expect(wrapper.text()).toContain('新准入');expect(wrapper.find('pre').exists()).toBe(false);
  });
});
describe('platform scheduler control',()=>{
  it('offers infrastructure control only in the platform navigation',async()=>{
    const h=await mountSchedulingRoute('/workspaces/1/org',()=>jsonResponse([]),{platform:true,workspaceRole:'EDITOR'});expect(h.wrapper.find('[data-testid="menu-scheduler-control"]').exists()).toBe(true);expect(h.wrapper.find('[data-testid="menu-schedule-policy"]').exists()).toBe(false);
  });
  it('shows the persisted mode, generation and version with controlled handoff help',async()=>{
    const control=JSON.parse(readFileSync('../../server/src/test/resources/scheduling/t7-scheduler-control.json','utf8'));const h=await mountSchedulingRoute('/scheduler-control',()=>jsonResponse(control),{platform:true,workspaceRole:'EDITOR'});
    expect(h.wrapper.text()).toContain('嵌入式');expect(h.wrapper.text()).toContain('代次');expect(h.wrapper.text()).toContain('受控交接');expect(h.wrapper.find('option[value="external"]').exists()).toBe(false);expect(h.wrapper.find('[data-testid="policy-save"]').exists()).toBe(false);
  });
  it('redirects a non-platform deep link before requesting infrastructure control',async()=>{
    const h=await mountSchedulingRoute('/scheduler-control',()=>jsonResponse({mode:'embedded',generation:'1',version:'1'}));expect(h.router.currentRoute.value.name).toBe('workspaces');expect(h.calls.some(c=>c.path.endsWith('/scheduler/control'))).toBe(false);expect(h.wrapper.find('[data-testid="menu-scheduler-control"]').exists()).toBe(false);
  });
  it('saves a supported mode with the current expectedVersion',async()=>{
    const h=await mountSchedulingRoute('/scheduler-control',c=>jsonResponse(c.method==='PUT'?{mode:'disabled',generation:'2',version:'2'}:{mode:'embedded',generation:'1',version:'1'}),{platform:true});expect(h.wrapper.find('[data-testid="control-mode"]').exists()).toBe(true);await h.wrapper.get('[data-testid="control-mode"]').setValue('disabled');await h.wrapper.get('[data-testid="control-save"]').trigger('click');await flushPromises();expect(h.calls.find(c=>c.method==='PUT')?.body).toEqual({mode:'disabled',expectedVersion:'1'});expect(h.wrapper.text()).toContain('代次 2');
  });
  it('reloads a control conflict while keeping the chosen mode until explicit save',async()=>{
    let reads=0;const h=await mountSchedulingRoute('/scheduler-control',c=>c.method==='PUT'?jsonResponse({code:'version_conflict',message:'opaque'},409):jsonResponse({mode:'embedded',generation:reads?'8':'1',version:reads++?'8':'1'}),{platform:true});await h.wrapper.get('[data-testid="control-mode"]').setValue('disabled');await h.wrapper.get('[data-testid="control-save"]').trigger('click');await flushPromises();expect(h.wrapper.find('[data-testid="control-reload"]').exists()).toBe(true);expect(h.wrapper.get('[data-testid="control-save"]').attributes('disabled')).toBeDefined();await h.wrapper.get('[data-testid="control-reload"]').trigger('click');await flushPromises();expect((h.wrapper.get('[data-testid="control-mode"]').element as HTMLSelectElement).value).toBe('disabled');expect(h.wrapper.text()).toContain('版本 8');expect(h.calls.filter(c=>c.method==='PUT')).toHaveLength(1);
  });
});
describe('project policy navigation and units',()=>{
  it('lets a workspace EDITOR enter the authorized project policy from Org without workspace CRUD',async()=>{
    const h=await mountSchedulingRoute('/workspaces/1/org',c=>c.path.endsWith('/projects/2/schedule-policy')?jsonResponse(actualPolicy()):jsonResponse({code:'forbidden',message:'opaque'},403),{workspaceRole:'EDITOR'});
    expect(h.wrapper.find('[data-testid="org-project-schedule-policy-2"]').exists()).toBe(true);await h.wrapper.get('[data-testid="org-project-schedule-policy-2"]').trigger('click');await flushPromises();expect(h.wrapper.find('[data-testid="policy-save"]').exists()).toBe(true);expect(h.calls.some(c=>c.path==='/api/v1/workspaces/1/schedule-policy')).toBe(false);expect(h.wrapper.find('[data-testid="org-project-rename-2"]').exists()).toBe(false);
  });
  it('groups policy rows by units and explains parameter-specific application time',async()=>{
    const h=await mountSchedulingRoute('/workspaces/1/schedule-policy',()=>jsonResponse(actualPolicy()));expect(h.wrapper.text()).toContain('时长（秒）');expect(h.wrapper.text()).toContain('保留期（天）');expect(h.wrapper.get('[data-testid="policy-row-maxSchedules"]').text()).toContain('新建计划时');expect(h.wrapper.get('[data-testid="policy-row-queueTimeoutMs"]').text()).toContain('绝对截止');expect(h.wrapper.get('[data-testid="policy-row-minIntervalMs"]').text()).toContain('1–86400');
  });
});
describe('policy drafts',()=>{
  it('locks numeric, behavior and inherit edits until a slow save completes',async()=>{
    let release!:(reply:Response)=>void;const reply=new Promise<Response>(resolve=>release=resolve);
    const h=schedulingHarness(c=>c.method==='PUT'?reply:jsonResponse(actualPolicy()));
    const wrapper=mount(SchedulePolicyView,{props:{scheduling:h.scheduling,workspaceId:'1',projectId:'2'},global:{plugins:[h.i18n]}});await flushPromises();
    await wrapper.get('[data-testid="policy-input-minIntervalMs"]').setValue('120');await wrapper.get('[data-testid="policy-save"]').trigger('click');await flushPromises();
    const controls=wrapper.findAll('[data-testid^="policy-input-"], [data-testid^="policy-reset-"]');
    const locks=controls.map(control=>({id:control.attributes('data-testid'),disabled:(control.element as HTMLInputElement).disabled}));
    const input=wrapper.get('[data-testid="policy-input-minIntervalMs"]'),reset=wrapper.get('[data-testid="policy-reset-minIntervalMs"]');
    if(!(input.element as HTMLInputElement).disabled)await input.setValue('180');
    if(!(reset.element as HTMLButtonElement).disabled)await reset.trigger('click');
    const draft={...h.scheduling.policyDraft},resets=[...h.scheduling.resetKeys];
    release(jsonResponse({...actualPolicy(),version:'1'}));await flushPromises();
    for(const lock of locks)expect.soft(lock.disabled,lock.id).toBe(true);
    expect.soft(draft).toEqual({minIntervalMs:'120'});expect.soft(resets).toEqual([]);
    expect(h.calls.find(c=>c.method==='PUT')?.body).toEqual({expectedVersion:'0',policy:{minIntervalMs:120000},resetKeys:[]});
    expect((wrapper.get('[data-testid="policy-input-minIntervalMs"]').element as HTMLInputElement).disabled).toBe(false);
    await wrapper.get('[data-testid="policy-input-minIntervalMs"]').setValue('180');expect(h.scheduling.policyDraft.minIntervalMs).toBe('180');
  });
  it('saves exact millisecond conversion and leaves empty fields unchanged',async()=>{
    const h=schedulingHarness(call=>jsonResponse(call.method==='PUT'?{...actualPolicy(),version:'1'}:actualPolicy()));
    const wrapper=mount(SchedulePolicyView,{props:{scheduling:h.scheduling,workspaceId:'1',projectId:'2'},global:{plugins:[h.i18n]}});await flushPromises();
    expect(wrapper.find('[data-testid="policy-input-minIntervalMs"]').exists()).toBe(true);
    await wrapper.get('[data-testid="policy-input-minIntervalMs"]').setValue('120.001');
    await wrapper.get('[data-testid="policy-save"]').trigger('click');await flushPromises();
    expect(h.calls.filter(c=>c.method==='PUT').map(c=>c.body)).toEqual([{expectedVersion:'0',policy:{minIntervalMs:120001},resetKeys:[]}]);
  });
  it('marks inherit as a pending draft until explicit save',async()=>{
    const h=schedulingHarness(()=>jsonResponse(actualPolicy()));const wrapper=mount(SchedulePolicyView,{props:{scheduling:h.scheduling,workspaceId:'1',projectId:'2'},global:{plugins:[h.i18n]}});await flushPromises();
    expect(wrapper.find('[data-testid="policy-reset-minIntervalMs"]').exists()).toBe(true);
    await wrapper.get('[data-testid="policy-reset-minIntervalMs"]').trigger('click');await flushPromises();
    expect(h.calls.filter(c=>c.method==='PUT')).toHaveLength(0);expect(wrapper.text()).toContain('待恢复继承');
    await wrapper.get('[data-testid="policy-save"]').trigger('click');await flushPromises();
    expect(h.calls.find(c=>c.method==='PUT')?.body).toEqual({expectedVersion:'0',policy:{},resetKeys:['minIntervalMs']});
  });
  it('requires conflict reload and preserves the draft for explicit resubmission',async()=>{
    let reads=0;const h=schedulingHarness(call=>call.method==='PUT'?jsonResponse({code:'version_conflict',message:'opaque'},409):jsonResponse({...actualPolicy(),version:reads++?'9':'0'}));
    const wrapper=mount(SchedulePolicyView,{props:{scheduling:h.scheduling,workspaceId:'1',projectId:'2'},global:{plugins:[h.i18n]}});await flushPromises();await wrapper.get('[data-testid="policy-input-minIntervalMs"]').setValue('180');await wrapper.get('[data-testid="policy-save"]').trigger('click');await flushPromises();
    expect(wrapper.text()).toContain('版本已变化');expect(wrapper.find('[data-testid="policy-reload"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="policy-save"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-testid="policy-reload"]').trigger('click');await flushPromises();
    expect((wrapper.get('[data-testid="policy-input-minIntervalMs"]').element as HTMLInputElement).value).toBe('180');expect(wrapper.text()).toContain('9');expect(h.calls.filter(c=>c.method==='PUT')).toHaveLength(1);
  });
  it('explains a fractional base millisecond locally and does not send the invalid draft',async()=>{
    const h=schedulingHarness(()=>jsonResponse(actualPolicy()));const wrapper=mount(SchedulePolicyView,{props:{scheduling:h.scheduling,workspaceId:'1',projectId:'2'},global:{plugins:[h.i18n]}});await flushPromises();await wrapper.get('[data-testid="policy-input-minIntervalMs"]').setValue('120.0001');await wrapper.get('[data-testid="policy-save"]').trigger('click');await flushPromises();
    expect(h.calls.filter(c=>c.method==='PUT')).toHaveLength(0);expect(wrapper.text()).toContain('最小间隔');expect(wrapper.text()).toContain('整数毫秒');
  });
  it('shows a readable English authorization rejection without management controls',async()=>{
    const h=schedulingHarness(()=>jsonResponse({code:'forbidden',message:'opaque'},403),'en');const wrapper=mount(SchedulePolicyView,{props:{scheduling:h.scheduling,workspaceId:'1',projectId:'2'},global:{plugins:[h.i18n]}});await flushPromises();
    expect(wrapper.text()).toContain('permission');expect(wrapper.text()).toContain('forbidden');expect(wrapper.find('[data-testid="policy-save"]').exists()).toBe(false);
  });
});
