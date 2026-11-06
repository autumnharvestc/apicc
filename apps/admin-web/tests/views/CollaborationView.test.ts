import {afterEach,describe,expect,it} from 'vitest';
import {mount,flushPromises,enableAutoUnmount} from '@vue/test-utils';
import {createAdminClient} from '../../src/api/client.js';
import {createCollaborationApi,type PolicyScope} from '../../src/api/collaboration.js';
import {createAdminI18n} from '../../src/i18n/index.js';
import CollaborationView from '../../src/views/CollaborationView.vue';
import {policy,capabilities,deployment,currentAccess,publication,publicationBody,grants,grant,logs,audit} from '../helpers/collaboration.js';
enableAutoUnmount(afterEach);
it.each([['zh-CN','访问明细','已认证公共查看','成功'],['en','Access observations','Authenticated public view','Succeeded']] as const)('final I01 renders %s bounded access observations within the existing authorized audit feed',async(language,title,viewLabel,success)=>{
  const supplied={...audit,collaboration:[...audit.collaboration,{id:'99',actorId:null,objectKind:'ARTIFACT',objectId:'41',action:'PUBLIC_VIEW',reason:'SUCCESS',revision:null,time:'2026-11-02T00:00:00Z'}],accessDetails:{state:'bounded',retentionMs:604800000}};
  const {wrapper,api}=await sharingHarness(call=>call.path.includes('/audit')?Response.json(supplied):undefined,language);
  expect((await api.audit({workspaceId:'1',projectId:'2'})).collaboration).toHaveLength(supplied.collaboration.length);
  await wrapper.get('[data-testid=audit-load]').trigger('click');await flushPromises();
  expect.soft(wrapper.text()).toContain(title);expect.soft(wrapper.text()).toContain(viewLabel);expect.soft(wrapper.text()).toContain(success);expect.soft(wrapper.text()).toContain('604800000 ms');expect(wrapper.find('details[data-testid=audit-raw]').attributes('open')).toBeUndefined();
});
const activeGrant={...grant,state:'active',reason:undefined};
type Call={path:string;method:string;body:any};
async function harness(handler:(call:Call)=>Response|Promise<Response>=()=>Response.json(policy),locale='zh-CN',scope:PolicyScope={workspaceId:'1',projectId:'2'}){
  localStorage.setItem('apicc.admin.locale',locale);const {i18n}=createAdminI18n();const calls:Call[]=[];
  const client=createAdminClient({token:'member',fetch:async(url,init)=>{const call={path:String(url),method:init?.method??'GET',body:init?.body?JSON.parse(String(init.body)):undefined};calls.push(call);return call.path.endsWith('/access-policy')?Response.json({revision:3,defaults:{'history.publish':'deny'},capabilities}):handler(call);}});const api=createCollaborationApi(client);
  // The independently valid complete producer shape must parse before DOM targets.
  expect(await api.policy(scope)).toMatchObject({revision:2});calls.length=0;
  const wrapper=mount(CollaborationView,{props:{api,scope},global:{plugins:[i18n]}});await flushPromises();
  return {wrapper,calls,api,i18n};
}
async function sharingHarness(override?:(call:Call)=>Response|undefined|Promise<Response|undefined>,locale='zh-CN'){
  const sharingPolicy={...policy,settings:policy.settings.map(row=>row.code==='externalSharingAllowed'?{...row,local:true,effective:true}:row)};
  const h=await harness(async call=>(await override?.(call))??Response.json(call.path.endsWith('/collaboration/policy')?sharingPolicy:call.path.endsWith('/access')?currentAccess:call.path.includes('/mock-logs')?logs:call.path.includes('/audit')?audit:call.path.includes('/grants?')?grants:call.path.includes('/publications?')?{items:[{...publication,enabled:true}],nextCursor:'publications-next'}:publicationBody),locale);
  await h.wrapper.get('[data-testid=publications-load]').trigger('click');await flushPromises();
  expect(h.wrapper.text()).toContain('v2');
  await h.wrapper.get('[data-testid=publication-select-41]').trigger('click');await flushPromises();
  expect(h.wrapper.find('[data-testid=grant-42]').exists()).toBe(true);
  return h;
}
describe('publication and grant management',()=>{
  it('I3 a discarded reconciliation reply keeps the original intent available on return',async()=>{
    let release!:(response:Response)=>void;const gate=new Promise<Response>(resolve=>{release=resolve;});
    const {wrapper,calls}=await sharingHarness(call=>call.path.includes('/publications?')?Response.json({items:[{...publication,enabled:true},{...publication,id:'43',version:3,enabled:true}],nextCursor:null}):call.path.includes('/publications/43/grants?')?Response.json({...grants,items:[]}):call.path.includes('/grant-operations/')?gate:call.method==='POST'?Promise.reject(new TypeError('lost original reply')):undefined);
    await wrapper.get('[data-testid=grant-create]').trigger('click');await flushPromises();const original=calls.find(call=>call.method==='POST')!.body.operationIntent;
    await wrapper.get('[data-testid=grant-reconcile]').trigger('click');await flushPromises();expect(calls.some(call=>call.path.endsWith('/grant-operations/'+original))).toBe(true);
    await wrapper.get('[data-testid=publication-select-43]').trigger('click');await flushPromises();await wrapper.get('[data-testid=publication-select-41]').trigger('click');await flushPromises();
    release(Response.json({grantId:'45',command:'create',revision:1,generation:1,keyObtained:false}));await flushPromises();
    expect((wrapper.get('[data-testid=grant-reconcile]').element as HTMLButtonElement).disabled).toBe(false);
  });
  it('I3 original scope intent survives a temporary scope change without keeping a secret',async()=>{
    let release!:(response:Response)=>void;const gate=new Promise<Response>(resolve=>{release=resolve;});
    const {wrapper,calls}=await sharingHarness(call=>call.path.endsWith('/projects/3/collaboration/policy')?Response.json({...policy,identity:{...policy.identity,lineage:policy.identity.lineage.map(item=>item.scope==='project'?{...item,projectId:'3'}:item)}}):call.path.includes('/grant-operations/')?Response.json({grantId:'45',command:'create',revision:1,generation:1,keyObtained:false}):call.method==='POST'?gate:undefined);
    await wrapper.get('[data-testid=grant-create]').trigger('click');await flushPromises();const original=calls.find(call=>call.method==='POST')!.body.operationIntent;
    await wrapper.setProps({scope:{workspaceId:'1',projectId:'3'}});await flushPromises();await wrapper.setProps({scope:{workspaceId:'1',projectId:'2'}});await flushPromises();
    await wrapper.get('[data-testid=publications-load]').trigger('click');await flushPromises();await wrapper.get('[data-testid=publication-select-41]').trigger('click');await flushPromises();
    release(Response.json({...activeGrant,id:'45',revision:1,operationIntent:original,key:'s'.repeat(43)}));await flushPromises();expect(wrapper.text()).not.toContain('s'.repeat(43));
    expect.soft((wrapper.get('[data-testid=grant-reconcile]').element as HTMLButtonElement).disabled).toBe(false);await wrapper.get('[data-testid=grant-create]').trigger('click');await flushPromises();expect.soft(calls.filter(call=>call.method==='POST')).toHaveLength(1);
    await wrapper.get('[data-testid=grant-reconcile]').trigger('click');await flushPromises();expect(calls.some(call=>call.path.endsWith('/projects/2/collaboration/grant-operations/'+original))).toBe(true);
  });
  it.each(['create','rotate'] as const)('I3 discarded %s success retains its original intent for metadata reconciliation',async(command)=>{
    let release!:(response:Response)=>void;const gate=new Promise<Response>(resolve=>{release=resolve;});
    const {wrapper,calls}=await sharingHarness(call=>call.path.includes('/publications?')?Response.json({items:[{...publication,enabled:true},{...publication,id:'43',version:3,enabled:true}],nextCursor:null}):call.path.includes('/publications/43/grants?')?Response.json({...grants,items:[]}):call.path.includes('/grants?')?Response.json({...grants,items:[activeGrant]}):call.path.includes('/grant-operations/')?Response.json({grantId:command==='create'?'45':'42',command,revision:command==='create'?1:3,generation:command==='create'?1:2,keyObtained:false}):call.method==='POST'?gate:undefined);
    await wrapper.get(`[data-testid=${command==='create'?'grant-create':'grant-rotate-42'}]`).trigger('click');await flushPromises();const original=calls.find(call=>call.method==='POST')!;expect(original.body).toMatchObject({expectedRevision:command==='create'?3:2,operationIntent:expect.any(String)});
    await wrapper.get('[data-testid=publication-select-43]').trigger('click');await flushPromises();await wrapper.get('[data-testid=publication-select-41]').trigger('click');await flushPromises();expect(wrapper.get('[data-testid=selected-publication]').text()).toContain('v2');
    release(Response.json({...activeGrant,id:command==='create'?'45':'42',revision:command==='create'?1:3,generation:command==='create'?1:2,operationIntent:original.body.operationIntent,key:'k'.repeat(43)}));await flushPromises();expect(wrapper.text()).not.toContain('k'.repeat(43));
    expect.soft((wrapper.get('[data-testid=grant-reconcile]').element as HTMLButtonElement).disabled).toBe(false);expect.soft(wrapper.text()).toContain('目录快照已过时');
    await wrapper.get('[data-testid=grant-create]').trigger('click');await flushPromises();expect.soft(calls.filter(call=>call.method==='POST')).toHaveLength(1);
    await wrapper.get('[data-testid=grant-reconcile]').trigger('click');await flushPromises();expect.soft(calls.some(call=>call.path.endsWith('/grant-operations/'+original.body.operationIntent))).toBe(true);expect.soft(wrapper.text()).toContain('对账完成');
  });
  it.each([true,false])('I4 initial Mock enabled=%s shows saved state and an explicit next action',async(enabled)=>{
    const {wrapper,calls}=await sharingHarness(call=>call.path.includes('/publications?')?Response.json({items:[{...publication,enabled}],nextCursor:null}):undefined);
    expect(wrapper.get('[data-testid=selected-publication]').text()).toContain('v2');expect.soft(wrapper.text()).toContain(enabled?'对象开关：已启用':'对象开关：已停用');expect.soft(wrapper.text()).toContain('来源：发布目录元数据');
    expect.soft(wrapper.get('[data-testid=mock-enable]').text()).toBe(enabled?'停用共享 Mock':'启用共享 Mock');expect.soft(wrapper.text()).toContain('未采集');expect(calls.filter(call=>call.method!=='GET')).toHaveLength(0);
  });
  it.each([['grant_revision_conflict','revision conflict'],['collaboration_grant_limit','grant quota'],['grant_inactive','inactive'],['grant_publication_disabled','publication is disabled']] as const)('I5 known %s has a readable English reason and safe next step',async(code,reason)=>{
    const {wrapper,calls}=await sharingHarness(call=>call.path.includes('/publications?')&&code==='grant_publication_disabled'?Response.json({items:[publication],nextCursor:null}):call.path.includes('/grants?')?Response.json({...grants,items:[activeGrant]}):call.method==='POST'?Response.json({code,message:'授权操作不满足当前条件'},{status:409}):undefined,'en');
    expect(wrapper.find('[data-testid=grant-42]').exists()).toBe(true);await wrapper.get(`[data-testid=${code==='grant_revision_conflict'||code==='grant_inactive'?'grant-rotate-42':'grant-create'}]`).trigger('click');await flushPromises();
    expect.soft(wrapper.get('[role=alert]').text()).toContain(reason);expect.soft(wrapper.get('[role=alert]').text()).toMatch(/Reload|adjust|administrator|new grant/);expect.soft(wrapper.get('[role=alert]').text()).toContain(code);expect(calls.filter(call=>call.method==='POST')).toHaveLength(1);
  });
  it.each(['next','logs','mock','revoke','refresh'] as const)('late %s response stays bound to its original publication selection',async(command)=>{
    let release!:(response:Response)=>void;const gate=new Promise<Response>(resolve=>{release=resolve;});
    const second={...publication,id:'43',version:3,revision:7,enabled:true};const secondGrant={...activeGrant,id:'44',publicationId:'43',version:3};
    const {wrapper,calls}=await sharingHarness(call=>{
      if(call.path.includes('/publications?'))return Response.json({items:[{...publication,enabled:true},second],nextCursor:null});
      if(command==='next'&&call.path.includes('/publications/41/grants?')&&call.path.includes('cursor='))return gate;
      if(command==='logs'&&call.path.includes('/publications/41/mock-logs'))return gate;
      if(command==='mock'&&call.path.endsWith('/publications/41/disable'))return gate;
      if(command==='revoke'&&call.method==='DELETE')return gate;
      if(command==='refresh'&&call.path.endsWith('/publications/41'))return gate;
      if(call.path.includes('/publications/43/grants?'))return Response.json({...grants,items:[secondGrant]});
      if(call.path.includes('/publications/43/mock-logs'))return Response.json({...logs,items:[{...logs.items[0],id:'2',publicationId:'43',version:3,routeTemplate:'/B-visible'}]});
      if(call.path.endsWith('/publications/43/grants')&&call.method==='POST')return Response.json({...secondGrant,id:'45',revision:1,key:'B-current-secret'});
      if(call.path.includes('/publications/41/grants?'))return Response.json({...grants,nextCursor:'A-next'});
    });
    await wrapper.get(`[data-testid=${{next:'grants-next',logs:'mock-logs-load',mock:'mock-enable',revoke:'grant-revoke-42',refresh:'grants-refresh'}[command]}]`).trigger('click');await flushPromises();
    expect(calls.some(call=>command==='next'?call.path.includes('cursor=A-next'):command==='logs'?call.path.includes('/41/mock-logs'):command==='mock'?call.path.endsWith('/41/disable'):command==='revoke'?call.method==='DELETE':call.path.endsWith('/publications/41'))).toBe(true);
    await wrapper.get('[data-testid=publication-select-43]').trigger('click');await flushPromises();expect(wrapper.get('[data-testid=selected-publication]').text()).toContain('当前修订 7');
    if(command==='logs'){await wrapper.get('[data-testid=mock-logs-load]').trigger('click');await flushPromises();expect(wrapper.text()).toContain('/B-visible');}
    if(command==='revoke'){await wrapper.get('[data-testid=grant-create]').trigger('click');await flushPromises();expect(wrapper.text()).toContain('B-current-secret');}
    const before=calls.length;
    release(command==='revoke'?new Response(null,{status:204}):Response.json(command==='next'?grants:command==='logs'?{...logs,items:[{...logs.items[0],routeTemplate:'/A-late'}]}:{...publicationBody,revision:4,enabled:false}));await flushPromises();
    if(command==='next')expect(wrapper.find('[data-testid=grant-44]').exists()).toBe(true);
    if(command==='logs'){expect.soft(wrapper.text()).toContain('/B-visible');expect(wrapper.text()).not.toContain('/A-late');}
    if(command==='mock'||command==='refresh')expect.soft(wrapper.get('[data-testid=selected-publication]').text()).toContain('当前修订 7');
    if(command==='refresh')expect(calls.slice(before)).toHaveLength(0);
    if(command==='revoke')expect(wrapper.text()).toContain('B-current-secret');
  });
  it.each(['document','report'] as const)('a legal %s selection has no Mock-only activity, toggle or log controls',async(kind)=>{
    const row={...publication,id:'43',version:3,kind,enabled:true,trust:kind==='document'?'saved-contract':'server-archive',source:{...publication.source,kind:kind==='document'?'document':'server-report',jobId:kind==='report'?'19':null}};
    const {wrapper}=await sharingHarness(call=>call.path.includes('/publications?')?Response.json({items:[{...publication,enabled:true},row],nextCursor:null}):call.path.includes('/publications/43/grants?')?Response.json({...grants,items:[]}):undefined);
    await wrapper.get('[data-testid=publication-select-43]').trigger('click');await flushPromises();expect(wrapper.get('[data-testid=selected-publication]').text()).toContain('v3');
    expect.soft(wrapper.find('[data-testid=mock-enable]').exists()).toBe(false);expect.soft(wrapper.find('[data-testid=mock-logs-load]').exists()).toBe(false);expect.soft(wrapper.text()).not.toContain('对象启用只代表');
  });
  it('a late prior-publication log error cannot replace the current selection error',async()=>{
    let release!:(response:Response)=>void;const gate=new Promise<Response>(resolve=>{release=resolve;});
    const {wrapper}=await sharingHarness(call=>call.path.includes('/publications?')?Response.json({items:[{...publication,enabled:true},{...publication,id:'43',version:3,enabled:true}],nextCursor:null}):call.path.includes('/publications/43/grants?')?Response.json({...grants,items:[]}):call.path.includes('/publications/41/mock-logs')?gate:call.path.includes('/publications/43/mock-logs')?Response.json({code:'B_current_error',message:'B current error'},{status:500}):undefined);
    await wrapper.get('[data-testid=mock-logs-load]').trigger('click');await flushPromises();await wrapper.get('[data-testid=publication-select-43]').trigger('click');await flushPromises();await wrapper.get('[data-testid=mock-logs-load]').trigger('click');await flushPromises();expect(wrapper.get('[role=alert]').text()).toContain('B current error');
    release(Response.json({code:'A_old_error',message:'A old error'},{status:500}));await flushPromises();expect(wrapper.get('[role=alert]').text()).toContain('B current error');
  });
  it.each([['publication_revision_conflict',409,'revision conflict'],['grant_policy_disabled',403,'policy no longer'],['public_origin_unavailable',503,'public origin']] as const)('explains %s without hiding the producer code or replaying the write',async(code,status,message)=>{
    const {wrapper,calls}=await sharingHarness(call=>call.method==='POST'?Response.json({code,message:'opaque'},{status}):undefined,'en');
    await wrapper.get('[data-testid=grant-create]').trigger('click');await flushPromises();expect.soft(wrapper.get('[role=alert]').text()).toContain(message);expect.soft(wrapper.get('[role=alert]').text()).toContain(code);expect(calls.filter(c=>c.method==='POST')).toHaveLength(1);
  });
  it('Mock caller without mock.manage cannot toggle an otherwise visible publication',async()=>{
    const {wrapper,calls}=await sharingHarness(call=>call.path.endsWith('/access')?Response.json({...currentAccess,capabilities:currentAccess.capabilities.filter(code=>code!=='mock.manage')}):undefined);
    expect(wrapper.find('[data-testid=grant-42]').exists()).toBe(true);await wrapper.get('[data-testid=mock-enable]').trigger('click');await flushPromises();
    expect.soft((wrapper.get('[data-testid=mock-enable]').element as HTMLButtonElement).disabled).toBe(true);expect(calls.filter(c=>c.method==='POST')).toHaveLength(0);
  });
  it('a late grants directory cannot replace the currently selected publication directory',async()=>{
    let release!:(value:Response)=>void;const gate=new Promise<Response>(resolve=>{release=resolve;});let delayed=false;
    const {wrapper}=await sharingHarness(call=>call.path.includes('/publications?')?Response.json({items:[publication,{...publication,id:'43',version:3}],nextCursor:null}):call.path.includes('/publications/41/grants?')&&delayed?gate:call.path.includes('/publications/43/grants?')?Response.json({...grants,items:[{...grant,id:'44'}]}):undefined);
    delayed=true;await wrapper.get('[data-testid=publication-select-41]').trigger('click');await flushPromises();await wrapper.get('[data-testid=publication-select-43]').trigger('click');await flushPromises();expect(wrapper.find('[data-testid=grant-44]').exists()).toBe(true);
    release(Response.json(grants));await flushPromises();expect(wrapper.find('[data-testid=grant-44]').exists()).toBe(true);
  });
  it.each(['success','error'] as const)('scope change discards a late policy %s and clears the previous draft',async(kind)=>{
    let release!:(value:Response)=>void;const gate=new Promise<Response>(resolve=>{release=resolve;});let delay=false;
    const {wrapper}=await harness(call=>call.path.includes('/projects/2/')&&delay?gate:Response.json(policy));
    await wrapper.get('[data-testid=collaboration-input-defaultShareDurationMs]').setValue('150000');
    delay=true;await wrapper.get('[data-testid=collaboration-policy-reload]').trigger('click');await flushPromises();
    await wrapper.setProps({scope:{workspaceId:'1',projectId:'3'}});await flushPromises();
    release(kind==='success'?Response.json({...policy,revision:77}):Response.json({code:'old_scope_error',message:'old scope error'},{status:500}));await flushPromises();
    expect.soft(wrapper.text()).not.toContain('old scope error');expect.soft(wrapper.text()).not.toContain('当前修订: 77');
    expect((wrapper.get('[data-testid=collaboration-input-defaultShareDurationMs]').element as HTMLInputElement).value).not.toBe('150000');
  });
  it('scope change clears an already displayed one-time secret immediately',async()=>{
    const {wrapper}=await sharingHarness(call=>call.method==='POST'?Response.json({...activeGrant,key:'old-scope-secret'}):undefined);
    await wrapper.get('[data-testid=grant-create]').trigger('click');await flushPromises();expect(wrapper.text()).toContain('old-scope-secret');
    await wrapper.setProps({scope:{workspaceId:'1',projectId:'3'}});await flushPromises();expect(wrapper.text()).not.toContain('old-scope-secret');
  });
  it('an uncertain create is reconciled using its original intent before another create is allowed',async()=>{
    const {wrapper,calls}=await sharingHarness(call=>{if(call.method==='POST')throw new TypeError('lost reply');if(call.path.includes('/grant-operations/'))return Response.json({grantId:'42',command:'create',revision:2,generation:1,keyObtained:false});});
    await wrapper.get('[data-testid=grant-create]').trigger('click');await flushPromises();const intent=calls.find(c=>c.method==='POST')!.body.operationIntent;
    await wrapper.get('[data-testid=grant-create]').trigger('click');await flushPromises();expect.soft(calls.filter(c=>c.method==='POST')).toHaveLength(1);
    await wrapper.get('[data-testid=grant-reconcile]').trigger('click');await flushPromises();
    expect.soft(calls.some(c=>c.method==='GET'&&c.path.endsWith('/grant-operations/'+intent))).toBe(true);
    expect.soft(wrapper.text()).toContain('对账完成');expect(wrapper.text()).not.toContain('keyObtained');
  });
  it.each(['B','A-again'] as const)('a late grant reply for A cannot populate %s selection',async(selection)=>{
    let release!:(value:Response)=>void;const response=new Promise<Response>(resolve=>{release=resolve;});
    const {wrapper}=await sharingHarness(call=>call.method==='POST'?response:call.path.includes('/publications?')?Response.json({items:[{...publication,enabled:true},{...publication,id:'43',version:3,enabled:true}],nextCursor:null}):call.path.includes('/publications/43/grants?')?Response.json({...grants,items:[]}):undefined);
    await wrapper.get('[data-testid=grant-create]').trigger('click');await flushPromises();
    await wrapper.get('[data-testid=publication-select-43]').trigger('click');await flushPromises();
    if(selection==='A-again'){await wrapper.get('[data-testid=publication-select-41]').trigger('click');await flushPromises();}
    expect(wrapper.get('[data-testid=selected-publication]').text()).toContain(selection==='B'?'v3':'v2');
    release(Response.json({...activeGrant,key:'late-secret-from-A'}));await flushPromises();
    expect(wrapper.text()).not.toContain('late-secret-from-A');
  });
  it('switching publication removes an already displayed secret before the next directory reply',async()=>{
    let release!:(value:Response)=>void;const response=new Promise<Response>(resolve=>{release=resolve;});
    const {wrapper}=await sharingHarness(call=>call.method==='POST'?Response.json({...activeGrant,key:'old-secret-from-A'}):call.path.includes('/publications?')?Response.json({items:[{...publication,enabled:true},{...publication,id:'43',version:3,enabled:true}],nextCursor:null}):call.path.includes('/publications/43/grants?')?response:undefined);
    await wrapper.get('[data-testid=grant-create]').trigger('click');await flushPromises();expect(wrapper.text()).toContain('old-secret-from-A');
    await wrapper.get('[data-testid=publication-select-43]').trigger('click');await flushPromises();
    expect.soft(wrapper.text()).not.toContain('old-secret-from-A');release(Response.json({...grants,items:[]}));await flushPromises();
  });
  it('uses current policy metadata defaults rather than a fixed fifty-item request',async()=>{
    const small={...policy,settings:[...policy.settings,{code:'defaultPageSize',valueType:'integer',builtin:50,local:5,effective:5,minimum:1,maximum:200,source:'project',unit:'count',effect:'each-list-read'}]};
    const {wrapper,calls}=await sharingHarness(call=>call.path.endsWith('/collaboration/policy')?Response.json(small):undefined);
    expect.soft(calls.find(c=>c.path.includes('/publications?'))?.path).toContain('limit=5');
    expect.soft(calls.find(c=>c.path.includes('/grants?'))?.path).toContain('limit=5');
    expect.soft((wrapper.get('[data-testid=logs-limit]').element as HTMLInputElement).value).toBe('5');
    expect((wrapper.get('[data-testid=audit-limit]').element as HTMLInputElement).value).toBe('5');
  });
  it.each(['publications','grants'] as const)('%s directory can continue a finite empty page with a cursor',async(kind)=>{
    let next=false;const {wrapper,calls}=await sharingHarness(call=>next&&call.path.includes(kind==='grants'?'/grants?':'/publications?')?Response.json(kind==='grants'?{...grants,items:[],nextCursor:'still-more'}:{items:[],nextCursor:'still-more'}):kind==='grants'&&call.path.includes('/grants?')?Response.json({...grants,nextCursor:'next'}):undefined);
    const before=calls.length;next=true;
    await wrapper.get(`[data-testid=${kind}-next]`).trigger('click');await flushPromises();
    expect.soft(calls.slice(before).filter(c=>c.method==='GET').at(-1)?.path??'').toContain('cursor=');
    expect(wrapper.find(`[data-testid=${kind}-next]`).exists()).toBe(true);
  });
  it.each(['mock.logs.read','audit.read'] as const)('a visible Mock card does not grant independent %s reads',async(capability)=>{
    const {wrapper,calls}=await sharingHarness(call=>call.path.endsWith('/access')?Response.json({...currentAccess,capabilities:currentAccess.capabilities.filter(code=>code!==capability)}):undefined);
    const before=calls.length;const id=capability==='audit.read'?'audit-load':'mock-logs-load';
    expect.soft(wrapper.get(`[data-testid=${id}]`).attributes('disabled')).toBeDefined();
    await wrapper.get(`[data-testid=${id}]`).trigger('click');await flushPromises();
    expect(calls.slice(before).filter(c=>c.path.includes(capability==='audit.read'?'/audit':'/mock-logs'))).toHaveLength(0);
  });
  it('management policy visibility with content NONE does not query publication content',async()=>{
    const {wrapper,calls}=await harness(call=>Response.json(call.path.endsWith('/access')?{...currentAccess,projectOverride:'NONE',overrideState:'explicit-none',effectiveRole:null,capabilities:[]}:call.path.includes('/publications?')?{items:[publication],nextCursor:null}:policy));
    expect(wrapper.findAll('[data-testid^=collaboration-setting-]')).toHaveLength(5);
    await wrapper.get('[data-testid=publications-load]').trigger('click');await flushPromises();
    expect.soft(calls.some(c=>c.path.includes('/publications?'))).toBe(false);expect(wrapper.text()).toContain('不可读内容');
  });
  it.each(['audit','logs'] as const)('%s empty filtered page keeps a cursor and uses applied filters for continuation',async(kind)=>{
    const empty=kind==='audit'?{...audit,access:[],execution:[],collaboration:[],scannedCount:5,nextCursor:'continue'}:{...logs,items:[],scannedCount:5,nextCursor:'continue'};
    const {wrapper,calls}=await sharingHarness(call=>call.path.includes(kind==='audit'?'/audit':'/mock-logs')?Response.json(empty):undefined);
    const actor=kind==='audit'?'7':'a'.repeat(22),object=kind==='audit'?'PROJECT:2':'rule-1';
    await wrapper.get(`[data-testid=${kind}-object]`).setValue(object);await wrapper.get(`[data-testid=${kind}-actor]`).setValue(actor);
    await wrapper.get(`[data-testid=${kind}-from]`).setValue('2026-11-03T00:00:00.000Z');await wrapper.get(`[data-testid=${kind}-to]`).setValue('2026-11-04T00:00:00.000Z');await wrapper.get(`[data-testid=${kind}-limit]`).setValue('5');
    await wrapper.get(`[data-testid=${kind==='audit'?'audit-load':'mock-logs-load'}]`).trigger('click');await flushPromises();
    expect(wrapper.find(`[data-testid=${kind}-next]`).exists()).toBe(true);
    const before=calls.length;await wrapper.get(`[data-testid=${kind}-actor]`).setValue('changed-draft');
    await wrapper.get(`[data-testid=${kind}-next]`).trigger('click');await flushPromises();
    const next=calls.slice(before).at(-1);expect.soft(next?.method).toBe('GET');
    const url=new URL(next?.path??'http://missing','http://admin.test');
    expect.soft(url.searchParams.get('cursor')).toBe('continue');expect.soft(url.searchParams.get('actor')).toBe(actor);expect.soft(url.searchParams.get('object')).toBe(object);expect.soft(url.searchParams.get('limit')).toBe('5');expect(url.searchParams.get('time')).toBe('2026-11-03T00:00:00.000Z/2026-11-04T00:00:00.000Z');
  });
  it('Mock state and three audit provenances are readable with nullable facts and observation limits in English',async()=>{
    const {wrapper,calls}=await sharingHarness(call=>call.path.includes('/publications?')?Response.json({items:[publication],nextCursor:null}):undefined,'en');
    await wrapper.get('[data-testid=mock-enable]').trigger('click');await flushPromises();
    expect(calls.find(c=>c.path.endsWith('/enable'))?.body).toEqual({expectedRevision:3});
    await wrapper.get('[data-testid=mock-logs-load]').trigger('click');await wrapper.get('[data-testid=audit-load]').trigger('click');await flushPromises();
    expect(wrapper.get('[data-testid=logs-loaded]').text()).toBe('1');expect(wrapper.get('[data-testid=audit-loaded]').text()).toBe('3');
    expect.soft(wrapper.text()).toContain('Runtime readiness is not established');
    expect.soft(wrapper.text()).toContain('since startup');expect.soft(wrapper.text()).toContain('may involve this version');
    expect.soft(wrapper.text()).toContain('Permission management');expect.soft(wrapper.text()).toContain('Execution management');expect.soft(wrapper.text()).toContain('Collaboration management records');
    expect.soft(wrapper.text()).toContain('Script changed');expect.soft(wrapper.text()).toContain('Not collected');
    expect.soft(wrapper.text()).toContain('No HTTP response observed');expect.soft(wrapper.text()).toContain('0 milliseconds');
    expect.soft(wrapper.text()).toContain('apis/orders\\\\draft\\r\\nitem');
    expect.soft(wrapper.get('[data-testid=audit-visible]').text()).not.toContain('脚本已变更');expect(wrapper.get('[data-testid=audit-visible]').text()).not.toContain('已采集业务位置');
  });
  it.each([59999,180001])('keeps invalid requested duration %s visible and sends no create',async(value)=>{
    const {wrapper,calls}=await sharingHarness(call=>call.method==='POST'?Response.json({...activeGrant,key:'secret'}):undefined);
    await wrapper.get('[data-testid=grant-duration]').setValue(String(value));await wrapper.get('[data-testid=grant-create]').trigger('click');await flushPromises();
    expect.soft(calls.filter(c=>c.method==='POST')).toHaveLength(0);expect.soft((wrapper.get('[data-testid=grant-duration]').element as HTMLInputElement).value).toBe(String(value));expect(wrapper.text()).toContain('期限必须');
  });
  it.each(['external','download'] as const)('honors the current %s policy constraint without changing the chosen draft',async(kind)=>{
    const {wrapper,calls}=await sharingHarness(call=>call.path.includes('/grants?')?Response.json({...grants,constraints:{...grants.constraints,externalSharingAllowed:{value:kind!=='external',source:'workspace'}}}):call.method==='POST'?Response.json({...activeGrant,key:'secret'}):undefined);
    if(kind==='download')await wrapper.get('[data-testid=grant-download]').setValue(true);
    await wrapper.get('[data-testid=grant-create]').trigger('click');await flushPromises();
    expect.soft(calls.filter(c=>c.method==='POST')).toHaveLength(0);expect(wrapper.text()).toContain(kind==='external'?'分享未获':'下载未获');
  });
  it('CAS refresh reads current publication and changed constraints while retaining the edited duration',async()=>{
    let refreshed=false;const {wrapper,calls}=await sharingHarness(call=>call.method==='POST'?Response.json({code:'publication_revision_conflict',message:'opaque'},{status:409}):call.path.includes('/grants?')&&refreshed?Response.json({...grants,constraints:{...grants.constraints,defaultShareDurationMs:{value:60000,source:'workspace'},maxShareDurationMs:{value:90000,source:'upper-ceiling'}}}):undefined);
    await wrapper.get('[data-testid=grant-duration]').setValue('150000');await wrapper.get('[data-testid=grant-create]').trigger('click');await flushPromises();refreshed=true;
    const before=calls.length;await wrapper.get('[data-testid=grants-refresh]').trigger('click');await flushPromises();
    expect.soft(calls.slice(before).map(c=>c.path)).toEqual(['/api/v1/workspaces/1/projects/2/collaboration/publications/41','/api/v1/workspaces/1/projects/2/collaboration/publications/41/grants?limit=50']);
    expect.soft((wrapper.get('[data-testid=grant-duration]').element as HTMLInputElement).value).toBe('150000');
    expect.soft(calls.filter(c=>c.method==='POST')).toHaveLength(1);
    await wrapper.get('[data-testid=grant-create]').trigger('click');await flushPromises();
    expect.soft(calls.filter(c=>c.method==='POST')).toHaveLength(1);expect(wrapper.text()).toContain('期限必须');
  });
  it('shows actual inactive reason, full identity, authoritative expiry and bounded directories',async()=>{
    const {wrapper,calls}=await sharingHarness();
    expect.soft(wrapper.text()).toContain('策略变化');expect.soft(wrapper.text()).toContain('60000');expect.soft(wrapper.text()).toContain('180000');
    expect.soft(wrapper.text()).toContain('UTC');expect.soft(wrapper.text()).toContain('123');expect.soft(wrapper.text()).toContain('bbbbbbbbbbbb');
    expect.soft(wrapper.text()).toContain('后续准入');expect(calls.filter(c=>c.method!=='GET')).toHaveLength(0);
  });
  it.each(['create','rotate','revoke'] as const)('%s uses displayed CAS and shows a secret only for an actual one-time reply',async(command)=>{
    const {wrapper,calls}=await sharingHarness(call=>call.path.includes('/grants?')&&command==='rotate'?Response.json({...grants,items:[activeGrant]}):call.method==='DELETE'?new Response(null,{status:204}):call.method==='POST'?Response.json({...activeGrant,key:'one-time-secret'}):undefined);
    if(command==='create')await wrapper.get('[data-testid=grant-duration]').setValue('60000');
    await wrapper.get(`[data-testid=${command==='create'?'grant-create':`grant-${command}-42`}]`).trigger('click');await flushPromises();
    const write=calls.find(c=>c.method!=='GET');
    expect.soft(write?.path).toBe(`/api/v1/workspaces/1/projects/2/collaboration/${command==='create'?'publications/41/grants':command==='rotate'?'grants/42/rotate':'grants/42'}`);
    expect.soft(write?.body).toEqual(command==='create'?{purpose:'call',audience:'external',durationMs:60000,downloadAllowed:false,expectedRevision:3,operationIntent:expect.any(String)}:command==='rotate'?{expectedRevision:2,operationIntent:expect.any(String)}:{expectedRevision:2});
    if(command!=='revoke'){expect.soft(wrapper.text()).toContain('仅本次');expect(wrapper.text()).toContain('one-time-secret');}
    else {expect.soft(wrapper.text()).toContain('重新加载');expect(wrapper.text()).not.toContain('one-time-secret');}
  });
});
describe('collaboration readable policy table',()=>{
  it('I6 I7 platform shows disabled saved origins, actual resource constraints and the complete memory relationship',async()=>{
    const current={...deployment,publicAccess:{...deployment.publicAccess,enabled:false,baseUrl:'https://public.example.test',managementBaseUrl:'https://management.example.test',managementOriginStatus:'valid'}};
    const {wrapper,api}=await harness(call=>Response.json(call.path.endsWith('/deployment')?current:policy),'en',{});expect(await api.deployment()).toMatchObject({publicAccess:{enabled:false,originStatus:'valid'},resources:expect.any(Array)});
    expect.soft(wrapper.text()).toContain('Saved origins are valid');expect.soft(wrapper.text()).toContain('https://public.example.test');expect.soft(wrapper.text()).toContain('https://management.example.test');
    expect.soft(wrapper.text()).toContain('Node cache');expect.soft(wrapper.text()).toContain('Heap + cache + in-flight budget + host headroom');expect.soft(wrapper.text()).toContain('No standalone maximum');
    expect.soft(wrapper.text()).toContain('External enforcement is not verified');expect.soft(wrapper.text()).toContain('Runtime startup');
    const rows=wrapper.findAll('[data-testid^=deployment-resource-]');expect.soft(rows).toHaveLength(6);const table=rows.map(row=>row.text()).join(' ');expect.soft(table).toContain('0.25');expect.soft(table).toContain('8589934592');expect.soft(table).toContain('134217728');expect.soft(table).toContain('8388608');expect.soft(table).toContain('67108864');expect.soft(table).toContain('Unconfigured');
  });
  it('platform separates unchecked runtime, unbound listener, configured origin and resource recommendations',async()=>{
    const {wrapper,api}=await harness(call=>Response.json(call.path.endsWith('/deployment')?deployment:policy),'zh-CN',{});
    expect(await api.deployment()).toMatchObject({runtime:{health:'unchecked'},publicAccess:{boundPort:null}});
    expect.soft(wrapper.text()).toContain('运行服务未检查');expect.soft(wrapper.text()).toContain('未绑定');
    expect.soft(wrapper.text()).toContain('本端期望协议');expect.soft(wrapper.text()).toContain('http://127.0.0.1:9081');
    expect.soft(wrapper.text()).toContain('外部 CPU 硬限制');expect.soft(wrapper.text()).toContain('未配置');expect.soft(wrapper.text()).toContain('805306368');
    expect.soft(wrapper.text()).toContain('重启');expect(wrapper.text()).not.toContain('"runtime"');
  });
  it('saves a scope capability default with its independent displayed revision',async()=>{
    const {wrapper,calls}=await harness();expect(wrapper.findAll('[data-testid^=capability-]').length).toBeGreaterThan(9);
    await wrapper.get('[data-testid="capability-input-history.publish"]').setValue('allow');
    await wrapper.get('[data-testid=capability-save]').trigger('click');await flushPromises();
    expect(calls.filter(c=>c.method==='PUT').map(c=>({path:c.path,body:c.body}))).toEqual([{path:'/api/v1/workspaces/1/projects/2/access-policy',body:{expectedRevision:3,defaults:{'history.publish':'allow'}}}]);
  });
  it.each([
    ['zh-CN',['协作权限点','本层覆盖','生效值','来源','角色下限','权限原因','待保存修改'],['历史发布','拒绝','允许','内置角色','编辑者','内置角色'],['历史读取','继承','允许','内置角色','只读成员','内置角色']],
    ['en',['Collaboration capability','Local override','Effective','Source','Role floor','Permission reason','Unsaved changes'],['Publish history','Deny','Allow','Built-in role','Editor','Built-in role'],['Read history','Inherit','Allow','Built-in role','Viewer','Built-in role']],
  ] as const)('renders finite capability meanings, local default, current effective source and role floor in %s',async(locale,headers,publish,read)=>{
    const {wrapper}=await harness(undefined,locale);const table=wrapper.get('.access-table table');
    // This controlled fixture supplies nine capabilities; count rows, not draft controls.
    expect(table.findAll('tbody tr')).toHaveLength(9);
    expect.soft(table.findAll('thead th').map(cell=>cell.text())).toEqual(headers);
    expect.soft(table.get('[data-testid="capability-history.publish"]').findAll('th,td').slice(0,6).map(cell=>cell.text())).toEqual(publish);
    expect(table.get('[data-testid="capability-history.read"]').findAll('th,td').slice(0,6).map(cell=>cell.text())).toEqual(read);
  });
  it.each(['','9007199254740992'])('does not turn invalid numeric draft %s into an inheritance command',async(raw)=>{
    const {wrapper,calls}=await harness();expect(wrapper.findAll('[data-testid^=collaboration-setting-]')).toHaveLength(5);
    await wrapper.get('[data-testid=collaboration-input-defaultShareDurationMs]').setValue(raw);
    await wrapper.get('[data-testid=collaboration-policy-save]').trigger('click');await flushPromises();
    expect.soft(calls.filter(c=>c.method==='PUT')).toHaveLength(0);
    expect(wrapper.text()).toContain('整数');
  });
  it('conflict retains draft and explicit reload compares current policy without replaying a write',async()=>{
    let reads=0;const current={...policy,revision:4,settings:policy.settings.map(row=>row.code==='defaultShareDurationMs'?{...row,local:90000,effective:90000}:row)};
    const {wrapper,calls}=await harness(call=>call.method==='PUT'?Response.json({code:'collaboration_policy_revision_conflict',message:'opaque'},{status:409}):Response.json(reads++<2?policy:current));
    await wrapper.get('[data-testid=collaboration-input-defaultShareDurationMs]').setValue('150000');
    await wrapper.get('[data-testid=collaboration-policy-save]').trigger('click');await flushPromises();
    expect.soft(wrapper.text()).toContain('修订冲突');
    expect.soft((wrapper.get('[data-testid=collaboration-input-defaultShareDurationMs]').element as HTMLInputElement).value).toBe('150000');
    expect.soft(calls.filter(c=>c.method==='PUT')).toHaveLength(1);expect.soft(calls.at(-1)?.method).toBe('PUT');
    await wrapper.get('[data-testid=collaboration-policy-reload]').trigger('click');await flushPromises();
    expect.soft(calls.filter(c=>c.method==='GET'&&c.path.endsWith('/collaboration/policy'))).toHaveLength(2);
    expect.soft(wrapper.get('[data-testid=collaboration-setting-defaultShareDurationMs]').text()).toContain('90000');
    expect.soft((wrapper.get('[data-testid=collaboration-input-defaultShareDurationMs]').element as HTMLInputElement).value).toBe('150000');
    expect(calls.filter(c=>c.method==='PUT')).toHaveLength(1);
  });
  it('saves only edited typed values with the displayed scope revision',async()=>{
    const {wrapper,calls}=await harness();expect(wrapper.findAll('[data-testid^=collaboration-setting-]')).toHaveLength(5);
    await wrapper.get('[data-testid=collaboration-input-defaultShareDurationMs]').setValue('150000');
    await wrapper.get('[data-testid=collaboration-list-extraSensitiveFields-0]').setValue('newSecret');
    await wrapper.get('[data-testid=collaboration-inherit-externalSharingAllowed]').trigger('click');
    await wrapper.get('[data-testid=collaboration-policy-save]').trigger('click');await flushPromises();
    expect(calls.filter(c=>c.method==='PUT').map(c=>({path:c.path,body:c.body}))).toEqual([{path:'/api/v1/workspaces/1/projects/2/collaboration/policy',body:{expectedRevision:2,settings:{defaultShareDurationMs:150000,extraSensitiveFields:['newSecret'],externalSharingAllowed:null}}}]);
  });
  it('shows saved/default/effective/source/range/unit and editable sensitive entries',async()=>{
    const {wrapper}=await harness();
    expect(wrapper.findAll('[data-testid^=collaboration-setting-]')).toHaveLength(5);
    expect.soft(wrapper.text()).toContain('默认值');expect.soft(wrapper.text()).toContain('本层覆盖');expect.soft(wrapper.text()).toContain('生效值');expect.soft(wrapper.text()).toContain('来源');
    const duration=wrapper.get('[data-testid=collaboration-setting-defaultShareDurationMs]');
    expect.soft(duration.text()).toContain('默认分享期限');expect.soft(duration.text()).toContain('毫秒');expect.soft(duration.text()).toContain('60000');expect.soft(duration.text()).toContain('180000');
    expect.soft(wrapper.text()).toContain('customerToken');expect.soft(wrapper.text()).toContain('upperSecret');
    expect.soft(wrapper.find('pre').exists()).toBe(false);
  });
  it('deployment-only parameters cannot be edited in the web policy form',async()=>{
    const {wrapper}=await harness();expect(wrapper.findAll('[data-testid^=collaboration-setting-]')).toHaveLength(5);
    expect(wrapper.get('[data-testid=collaboration-input-rpcConnectTimeoutMs]').attributes('disabled')).toBeDefined();
  });
});
