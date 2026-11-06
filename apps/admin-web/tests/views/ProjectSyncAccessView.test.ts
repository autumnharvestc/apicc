import {afterEach,describe,it,expect} from 'vitest';
import {enableAutoUnmount,flushPromises} from '@vue/test-utils';
import {SyncSourceSchema,SyncCheckLookupSchema,CredentialMetadataSchema,syncErrorCodeValues} from '@apicc/execution/contract';
import {CollaborationAuditSchema} from '@apicc/execution/client/collaboration';
import {AccessPolicySchema} from '../../src/api/collaboration.js';
import {mountSyncAccessView,currentAccess,json,type Call} from './sync-fixtures.js';
import {mountSchedulingRoute} from '../helpers/scheduling.js';
enableAutoUnmount(afterEach);
const sourceId='11111111-1111-4111-8111-111111111111';
const source=SyncSourceSchema.parse({formatVersion:1,id:sourceId,revision:'2',moduleId:'22222222-2222-4222-8222-222222222222',kind:'git-ssh',repositoryUrl:'ssh://git@example.test/spec.git',ref:'main',filePath:'openapi.yaml',privateKeyRef:'ssh-key',knownHostsRef:'host-trust'});
const accessPolicy=()=>AccessPolicySchema.parse({revision:5,defaults:{'sync.manage':'deny','task.execute':'deny'},capabilities:['sync.manage','sync.check','sync.apply','task.execute'].map(code=>({code,mode:code==='sync.manage'?'allow':'inherit',effective:code!=='task.execute',source:code==='sync.manage'?'project-member':code==='task.execute'?'project-default':'builtin-role',roleFloor:'EDITOR',reason:code==='sync.manage'?'allowed':code==='task.execute'?'deny':'builtin-role'}))});
const lookup=SyncCheckLookupSchema.parse({formatVersion:1,sourceId,current:null,latestSuccess:null,latestAttempt:{formatVersion:1,sourceId,checkId:'33333333-3333-4333-8333-333333333333',state:'failed',candidateId:null,createdAtMs:1793923200123,completedAtMs:1793923201123,reasonCode:'source-read-failed',detailCode:'SYNC_HOST_KEY_MISMATCH'}});
const audit=CollaborationAuditSchema.parse({access:[],execution:[{id:'1',actorId:'1',action:'sync.source.save',time:'2026-11-06T00:00:00.123Z',revision:null,objectKind:'PROJECT',objectId:'2',agentId:null,locations:null,locationLabel:'未采集',summary:null,summaryLabel:'未采集',beforeRevision:null,afterRevision:null}],collaboration:[],nextCursor:null,scannedCount:1,pageLimit:50});
function read(c:Call){
  if(c.path.endsWith('/access'))return json(currentAccess());
  if(c.path.endsWith('/access-policy'))return json(accessPolicy());
  if(c.path.endsWith('/access-projects'))return json([{id:'2',name:'很长的项目名称用于管理目录内容隔离与布局验证'.repeat(5),contentReadable:true}]);
  if(c.path.endsWith('/sources'))return json([source]);
  if(c.path.endsWith('/credentials'))return json([CredentialMetadataSchema.parse({refId:'ssh-key',version:'3',status:'available'}),{refId:'host-trust',version:'4',status:'unavailable'}]);
  if(c.path.includes('/sync/checks?'))return json(lookup);
  if(c.path.includes('/collaboration/audit'))return json(audit);
  return json({code:'forbidden',message:'opaque'},403);
}
describe('finite sync access and safe status',()=>{
  it('shows safe material, uncollected trust, actual check reason and read-only timestamped audit',async()=>{
    const h=await mountSyncAccessView(read);expect(h.wrapper.text()).toContain('材料与主机信任');expect(h.wrapper.text()).toContain('ssh-key');expect(h.wrapper.text()).toContain('可解密');expect(h.wrapper.text()).toContain('不可用');expect(h.wrapper.text()).toContain('未采集');expect(h.wrapper.text()).toContain('不代表');
    expect(h.wrapper.text()).toContain('主机密钥不匹配');expect(h.wrapper.text()).toContain('来源保存');expect(h.wrapper.text()).toContain('2026-11-06 00:00:00.123 UTC');
    expect(h.wrapper.findAll('pre,textarea,input[type="password"]')).toHaveLength(0);expect(h.wrapper.text()).not.toContain('ssh://');expect(h.wrapper.text()).not.toContain('[object Object]');expect(h.calls.every(c=>c.method==='GET')).toBe(true);
  });
  it('does not turn management directory or NONE into source, material or audit access',async()=>{
    const h=await mountSyncAccessView(c=>c.path.endsWith('/access')?json(currentAccess([],null)):c.path.endsWith('/access-projects')?json([{id:'2',name:'仅管理目录项目',contentReadable:false}]):c.path.endsWith('/access-policy')?json({...accessPolicy(),capabilities:accessPolicy().capabilities.map(row=>({...row,effective:false,source:'unavailable',reason:'unavailable'}))}):json({code:'forbidden',message:'opaque'},403));
    expect(h.wrapper.text()).toContain('仅管理目录项目');expect(h.wrapper.text()).toContain('无项目内容读取权限');expect(h.calls.some(c=>/\/sources|\/credentials|\/audit|\/checks/.test(c.path))).toBe(false);expect(h.wrapper.find('[data-testid="sync-policy-link"]').exists()).toBe(false);
  });
  it('edits exactly finite sync defaults with current management revision while retaining server deny reasons',async()=>{
    let changed=false;const saved={...accessPolicy(),revision:6,defaults:{...accessPolicy().defaults,'sync.check':'deny'},capabilities:accessPolicy().capabilities.map(row=>row.code==='sync.check'?{...row,effective:false,source:'project-default',reason:'deny'}:row)};
    const h=await mountSyncAccessView(c=>{if(c.method==='PUT'){changed=true;return json(saved);}if(changed&&c.path.endsWith('/access'))return json(currentAccess(['sync.manage','sync.apply','audit.read']));return read(c);});expect(h.wrapper.text()).toContain('管理同步来源与策略');expect(h.wrapper.text()).toContain('项目成员覆盖');expect(h.wrapper.text()).toContain('拒绝');
    expect(h.wrapper.findAll('[data-testid^="capability-input-"]')).toHaveLength(3);expect(h.wrapper.get('[data-testid="capability-sync.manage"]').text()).toContain('编辑者');expect(h.wrapper.text()).toContain('当前有效角色: 管理员');await h.wrapper.get('[data-testid="capability-input-sync.check"]').setValue('deny');await h.wrapper.get('[data-testid="capability-save"]').trigger('click');await flushPromises();
    expect(h.calls.find(c=>c.method==='PUT')?.body).toEqual({expectedRevision:5,defaults:{'sync.check':'deny'}});expect(h.wrapper.text()).toContain('版本 6');expect(h.wrapper.get('[data-testid="capability-sync.check"]').text()).toContain('项目默认');expect(h.wrapper.find('[data-testid="capability-task.execute"]').exists()).toBe(false);
  });
  it('offers delegated EDITOR readable status but no capability administration when management is forbidden',async()=>{
    const h=await mountSyncAccessView(c=>c.path.endsWith('/access')?json(currentAccess(['sync.manage','sync.check'],'EDITOR')):c.path.endsWith('/access-policy')||c.path.endsWith('/access-projects')?json({code:'forbidden',message:'opaque'},403):read(c),'en');
    expect(h.wrapper.text()).toContain('Materials and host trust');expect(h.wrapper.text()).toContain('Host key mismatch');expect(h.wrapper.find('[data-testid="capability-save"]').exists()).toBe(false);expect(h.calls.some(c=>c.path.includes('/collaboration/audit'))).toBe(false);expect(h.wrapper.text()).toContain('permission');
  });
  it('clears and fences old metadata and errors when project scope changes',async()=>{
    let release!:(r:Response)=>void;const late=new Promise<Response>(r=>release=r);const h=await mountSyncAccessView(c=>c.path.includes('/projects/3/')?json({code:'forbidden',message:'opaque'},403):c.path.endsWith('/sources')?late:read(c));expect(h.calls.some(c=>c.path==='/api/v1/workspaces/1/projects/2/sync/sources')).toBe(true);expect(h.wrapper.text()).toContain('ssh-key');await h.wrapper.setProps({projectId:'3'});await flushPromises();release(json([source]));await flushPromises();expect(h.wrapper.text()).not.toContain(sourceId);expect(h.wrapper.text()).not.toContain('主机密钥不匹配');
  });
  it('preserves access conflict drafts for an explicit reload without repeating save',async()=>{
    const h=await mountSyncAccessView(c=>c.method==='PUT'?json({code:'access_revision_conflict',message:'opaque'},409):read(c));expect(h.wrapper.find('[data-testid="capability-save"]').exists()).toBe(true);await h.wrapper.get('[data-testid="capability-input-sync.check"]').setValue('deny');await h.wrapper.get('[data-testid="capability-save"]').trigger('click');await flushPromises();expect(h.wrapper.text()).toContain('版本已变化');await h.wrapper.get('[data-testid="sync-access-reload"]').trigger('click');await flushPromises();expect(h.calls.filter(c=>c.method==='PUT')).toHaveLength(1);expect((h.wrapper.get('[data-testid="capability-input-sync.check"]').element as HTMLSelectElement).value).toBe('deny');
  });
  it('offers project sync entry from current org and remembers the topbar language with long project names',async()=>{
    const h=await mountSchedulingRoute('/workspaces/1/org',read,{workspaceRole:'EDITOR'});expect(h.wrapper.text()).toContain('项目管理很长的名称用于悬停查看');expect(h.wrapper.find('[data-testid="org-project-sync-2"]').exists()).toBe(true);await h.wrapper.get('[data-testid="layout-locale"]').setValue('en');await flushPromises();expect(localStorage.getItem('apicc.admin.locale')).toBe('en');expect(h.wrapper.get('[data-testid="org-project-sync-2"]').text()).toContain('Synchronization');await h.wrapper.get('[data-testid="org-project-sync-2"]').trigger('click');await flushPromises();expect(h.router.currentRoute.value.name).toBe('project-sync-access');expect(h.wrapper.find('[data-testid="project-sync-access-view"]').exists()).toBe(true);expect(h.wrapper.text()).toContain('Materials and host trust');
  });
});
describe('T13 fix1 current capability authority and finite detail meanings',()=>{
  it('fix1 removes capability authority after forbidden save and recovers the draft through a fresh management read',async()=>{
    const h=await mountSyncAccessView(c=>c.method==='PUT'?json({code:'forbidden',message:'opaque'},403):read(c));expect(h.wrapper.find('[data-testid="capability-save"]').exists()).toBe(true);await h.wrapper.get('[data-testid="capability-input-sync.check"]').setValue('deny');await h.wrapper.get('[data-testid="capability-save"]').trigger('click');await flushPromises();expect(h.wrapper.text()).toContain('当前权限');expect(h.wrapper.find('[data-testid="capability-save"]').exists()).toBe(false);expect(h.wrapper.find('[data-testid="capability-sync.check"]').exists()).toBe(false);
    await h.wrapper.get('[data-testid="sync-access-reload"]').trigger('click');await flushPromises();expect((h.wrapper.get('[data-testid="capability-input-sync.check"]').element as HTMLSelectElement).value).toBe('deny');expect(h.calls.filter(c=>c.method==='PUT')).toHaveLength(1);
  });
  it('fix1 removes old capability rows when a current management reload is forbidden',async()=>{
    let reads=0,recovered=false;const h=await mountSyncAccessView(c=>c.method==='PUT'?json({code:'access_revision_conflict',message:'opaque'},409):c.path.endsWith('/access-policy')?(reads++===0||recovered?json(accessPolicy()):json({code:'forbidden',message:'opaque'},403)):read(c));
    await h.wrapper.get('[data-testid="capability-input-sync.check"]').setValue('deny');await h.wrapper.get('[data-testid="capability-save"]').trigger('click');await flushPromises();await h.wrapper.get('[data-testid="sync-access-reload"]').trigger('click');await flushPromises();expect(reads).toBe(2);expect(h.wrapper.text()).toContain('当前权限');expect(h.wrapper.find('[data-testid="capability-save"]').exists()).toBe(false);expect(h.wrapper.find('[data-testid="capability-sync.check"]').exists()).toBe(false);
    recovered=true;await h.wrapper.get('[data-testid="sync-access-reload"]').trigger('click');await flushPromises();expect((h.wrapper.get('[data-testid="capability-input-sync.check"]').element as HTMLSelectElement).value).toBe('deny');
  });
  it.each(['zh-CN','en'] as const)('fix1 explains every current finite detailCode in visible %s check rows',async(locale)=>{
    const all=syncErrorCodeValues.map((code,index)=>({code,source:SyncSourceSchema.parse({formatVersion:1,id:`55555555-5555-4555-8555-${index.toString(16).padStart(12,'0')}`,revision:'1',moduleId:source.moduleId,kind:'url',url:'https://example.test/openapi.json'})}));
    const h=await mountSyncAccessView(c=>c.path.endsWith('/sources')?json(all.map(item=>item.source)):c.path.includes('/sync/checks?')?(()=>{const sourceId=new URL(c.path,'https://admin.test').searchParams.get('sourceId');const item=all.find(item=>item.source.id===sourceId)!;return json(SyncCheckLookupSchema.parse({...lookup,sourceId:item.source.id,latestAttempt:{...lookup.latestAttempt!,sourceId:item.source.id,detailCode:item.code}}));})():read(c),locale);
    const rendered=all.map(({code})=>({code,row:h.wrapper.findAll('tr').find(row=>row.text().includes(`(${code})`))}));expect(rendered.every(item=>item.row?.exists())).toBe(true);
    const untranslated=rendered.filter(item=>item.row!.text().includes(locale==='zh-CN'?`来源检查诊断 (${item.code})`:`Source check diagnostic (${item.code})`)).map(item=>item.code);expect(untranslated).toEqual([]);
    const cache=rendered.find(item=>item.code==='SYNC_CACHE_MISS')!.row!.text();expect(cache).toContain('304');expect(cache).toContain(locale==='zh-CN'?'缓存':'cache');expect(cache).not.toContain(locale==='zh-CN'?'主机密钥':'Host key');
    const integrity=rendered.find(item=>item.code==='SYNC_CONTENT_DIGEST_MISMATCH')!.row!.text();expect(integrity).toContain('SHA-256');const parent=rendered.find(item=>item.code==='SYNC_MAPPING_PARENT_NOT_SELECTED')!.row!.text();expect(parent).toContain(locale==='zh-CN'?'父':'parent');
  });
});
