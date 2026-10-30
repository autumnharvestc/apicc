// @vitest-environment jsdom
import { describe,expect,it } from 'vitest';
import { actualPolicy,actualChannels,actualGrantOptions,actualGrants,jsonResponse,schedulingHarness } from '../helpers/scheduling.js';
import { createSessionStore } from '../../src/stores/session.js';
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};
describe('pending save draft locks',()=>{
  it('does not accept policy inheritance while its submitted draft is pending',async()=>{
    const reply=deferred<Response>();const h=schedulingHarness(c=>c.method==='PUT'?reply.promise:jsonResponse(actualPolicy()));
    await h.scheduling.loadPolicy('1','2');h.scheduling.policyDraft.minIntervalMs='120';const pending=h.scheduling.savePolicy('1','2');
    h.scheduling.inherit('minIntervalMs');const draft={...h.scheduling.policyDraft},resets=[...h.scheduling.resetKeys];
    reply.resolve(jsonResponse({...actualPolicy(),version:'1'}));await pending;
    expect(draft).toEqual({minIntervalMs:'120'});expect(resets).toEqual([]);expect(h.scheduling.busy).toBe(false);
    h.scheduling.inherit('minIntervalMs');expect(h.scheduling.resetKeys).toEqual(['minIntervalMs']);
  });
  it.each(['new','existing'] as const)('does not replace a pending channel draft with a %s channel',async kind=>{
    const reply=deferred<Response>(),row=actualChannels().created['host-case'];const h=schedulingHarness(c=>c.method==='PUT'?reply.promise:jsonResponse({items:[row]}));
    await h.scheduling.loadChannels('1');h.scheduling.editChannel(row);h.scheduling.channelDraft!.name='Submitted A';const original=h.scheduling.channelDraft;
    const pending=h.scheduling.saveChannel('1');h.scheduling.editChannel(kind==='new'?undefined:{...row,id:'999',name:'Other B'});const during=h.scheduling.channelDraft;
    reply.resolve(jsonResponse({...row,name:'Submitted A',version:'2'}));await pending;
    expect(during).toBe(original);expect(h.scheduling.channelDraft).toBeNull();expect(h.scheduling.busy).toBe(false);
    h.scheduling.editChannel();expect(h.scheduling.channelDraft?.name).toBe('');
  });
});
describe('scheduling request identity',()=>{
  it('ignores an earlier scope response after selecting a different project',async()=>{
    const first=deferred<Response>();const h=schedulingHarness(c=>c.path.includes('/projects/2/')?first.promise:jsonResponse({...actualPolicy(),version:'7'}));
    const pending=h.scheduling.loadPolicy('1','2');await h.scheduling.loadPolicy('1','3');first.resolve(jsonResponse(actualPolicy()));await pending;
    expect(h.scheduling.policy?.version).toBe('7');
  });
  it('invalidates in-flight results when the session is reset',async()=>{
    const reply=deferred<Response>();const h=schedulingHarness(()=>reply.promise);const pending=h.scheduling.loadPolicy('1','2');
    (h.scheduling as typeof h.scheduling&{reset?:()=>void}).reset?.();reply.resolve(jsonResponse(actualPolicy()));await pending;
    expect(h.scheduling.policy).toBeNull();
  });
  it('ignores a save response after leaving its scope',async()=>{
    const reply=deferred<Response>();const h=schedulingHarness(c=>c.method==='PUT'?reply.promise:jsonResponse({...actualPolicy(),version:c.path.includes('/projects/3/')?'7':'0'}));
    await h.scheduling.loadPolicy('1','2');h.scheduling.policyDraft.minIntervalMs='120';const pending=h.scheduling.savePolicy('1','2');await h.scheduling.loadPolicy('1','3');reply.resolve(jsonResponse({...actualPolicy(),version:'1'}));await pending;
    expect(h.scheduling.policy?.version).toBe('7');
  });
  it('prevents duplicate saves while a request is pending',async()=>{
    const reply=deferred<Response>();const h=schedulingHarness(c=>c.method==='PUT'?reply.promise:jsonResponse(actualPolicy()));await h.scheduling.loadPolicy('1','2');
    const a=h.scheduling.savePolicy('1','2'),b=h.scheduling.savePolicy('1','2');expect(h.calls.filter(c=>c.method==='PUT')).toHaveLength(1);
    reply.resolve(jsonResponse({...actualPolicy(),version:'1'}));await Promise.all([a,b]);
  });
  it('clears policy drafts and pending results through the existing 401 session callback',async()=>{
    let fail=false;const h=schedulingHarness(c=>c.path.endsWith('/me')?jsonResponse({id:'1',username:'user',displayName:'用户',role:'USER'}):fail?jsonResponse({code:'unauthorized',message:'expired'},401):jsonResponse(actualPolicy()));
    localStorage.setItem('apicc.admin.token','synthetic-session');const session=createSessionStore({client:h.client,onSessionExpired:()=>{(h.scheduling as typeof h.scheduling&{reset?:()=>void}).reset?.();}});await session.initialize();await h.scheduling.loadPolicy('1','2');h.scheduling.policyDraft.minIntervalMs='120';fail=true;await h.scheduling.savePolicy('1','2');
    expect(session.token).toBeUndefined();expect(h.scheduling.policy).toBeNull();expect(h.scheduling.policyDraft).toEqual({});
  });
});
describe('channel request and secret identity',()=>{
  it('rejects metadata belonging to another workspace',async()=>{
    const row={...actualChannels().created['host-case'],workspaceId:'2'};const h=schedulingHarness(()=>jsonResponse({items:[row]}));await h.scheduling.loadChannels('1');expect(h.scheduling.channelsReady).toBe(false);expect(h.scheduling.channels).toEqual([]);
  });
  it('ignores a stale channel list after changing workspace',async()=>{
    const reply=deferred<Response>();const row=actualChannels().created['host-case'];const h=schedulingHarness(c=>c.path.includes('/workspaces/1/')?reply.promise:jsonResponse({items:[{...row,workspaceId:'2'}]}));const pending=h.scheduling.loadChannels('1');await h.scheduling.loadChannels('2');reply.resolve(jsonResponse({items:[row]}));await pending;expect(h.scheduling.channels[0]?.workspaceId).toBe('2');
  });
  it('invalidates a pending channel list on session reset',async()=>{
    const reply=deferred<Response>();const h=schedulingHarness(()=>reply.promise);const pending=h.scheduling.loadChannels('1');h.scheduling.reset();reply.resolve(jsonResponse({items:[actualChannels().created['host-case']]}));await pending;expect(h.scheduling.channels).toEqual([]);expect(h.scheduling.channelsReady).toBe(false);
  });
  it('discards write-only channel draft material on navigation to a policy',async()=>{
    const h=schedulingHarness(c=>jsonResponse(c.path.endsWith('/schedule-policy')?actualPolicy():{items:[]}));await h.scheduling.loadChannels('1');h.scheduling.editChannel();h.scheduling.channelDraft!.url='https://hook.example.test/private?synthetic-draft';h.scheduling.channelDraft!.hmacSecret='synthetic-draft-key';await h.scheduling.loadPolicy('1');expect(h.scheduling.channelDraft).toBeNull();
  });
  it('ignores a completed channel save after session reset',async()=>{
    const reply=deferred<Response>();const h=schedulingHarness(c=>c.method==='POST'?reply.promise:jsonResponse({items:[]}));await h.scheduling.loadChannels('1');h.scheduling.editChannel();Object.assign(h.scheduling.channelDraft!,{name:'渠道',url:'https://hook.example.test/private',hmacSecret:'synthetic-hmac-value'});const pending=h.scheduling.saveChannel('1');h.scheduling.reset();reply.resolve(jsonResponse(actualChannels().created['host-case']));await pending;expect(h.scheduling.channels).toEqual([]);
  });
  it('prevents duplicate channel writes while awaiting the response',async()=>{
    const reply=deferred<Response>();const h=schedulingHarness(c=>c.method==='POST'?reply.promise:jsonResponse({items:[]}));await h.scheduling.loadChannels('1');h.scheduling.editChannel();Object.assign(h.scheduling.channelDraft!,{name:'渠道',url:'https://hook.example.test/private',hmacSecret:'synthetic-hmac-value'});const a=h.scheduling.saveChannel('1'),b=h.scheduling.saveChannel('1');expect(h.calls.filter(c=>c.method==='POST')).toHaveLength(1);reply.resolve(jsonResponse(actualChannels().created['host-case']));await Promise.all([a,b]);
  });
});
describe('platform control identity',()=>{
  it('clears the mode draft on session reset',()=>{const h=schedulingHarness(()=>jsonResponse({}));h.scheduling.controlModeDraft='disabled';h.scheduling.reset();expect(h.scheduling.controlModeDraft).toBe('embedded');});
  it('invalidates a control read on session reset',async()=>{
    const reply=deferred<Response>();const h=schedulingHarness(()=>reply.promise);const pending=h.scheduling.loadControl();h.scheduling.reset();reply.resolve(jsonResponse({mode:'embedded',generation:'1',version:'1'}));await pending;expect(h.scheduling.control).toBeNull();
  });
  it('ignores an old control save after reset',async()=>{
    const reply=deferred<Response>();const h=schedulingHarness(c=>c.method==='PUT'?reply.promise:jsonResponse({mode:'embedded',generation:'1',version:'1'}));await h.scheduling.loadControl();const pending=h.scheduling.saveControl();h.scheduling.reset();reply.resolve(jsonResponse({mode:'disabled',generation:'2',version:'2'}));await pending;expect(h.scheduling.control).toBeNull();
  });
  it('prevents duplicate control writes',async()=>{
    const reply=deferred<Response>();const h=schedulingHarness(c=>c.method==='PUT'?reply.promise:jsonResponse({mode:'embedded',generation:'1',version:'1'}));await h.scheduling.loadControl();const a=h.scheduling.saveControl(),b=h.scheduling.saveControl();const count=h.calls.filter(c=>c.method==='PUT').length;reply.resolve(jsonResponse({mode:'disabled',generation:'2',version:'2'}));await Promise.all([a,b]);expect(count).toBe(1);
  });
});
describe('conflict draft boundaries',()=>{
  it('does not preserve a policy draft into a different project during a reload',async()=>{
    const h=schedulingHarness(()=>jsonResponse(actualPolicy()));await h.scheduling.loadPolicy('1','2');h.scheduling.policyDraft.minIntervalMs='180';await h.scheduling.loadPolicy('1','3',true);expect(h.scheduling.policyDraft).toEqual({});
  });
  it('does not preserve channel write material into another workspace during a reload',async()=>{
    const h=schedulingHarness(()=>jsonResponse({items:[]}));await h.scheduling.loadChannels('1');h.scheduling.editChannel();h.scheduling.channelDraft!.hmacSecret='synthetic-conflict-draft';await h.scheduling.loadChannels('2',true);expect(h.scheduling.channelDraft).toBeNull();
  });
});
describe('grant member metadata request identity',()=>{
  it('ignores an old grant options result after selecting another project',async()=>{
    const reply=deferred<Response>();const newer=actualGrantOptions();newer.items[0].displayName='新项目成员';const h=schedulingHarness(c=>!c.path.endsWith('/options')?jsonResponse(actualGrants()):c.path.includes('/projects/2/')?reply.promise:jsonResponse(newer));const pending=h.scheduling.loadGrantOptions('1','2');await h.scheduling.loadGrantOptions('1','3');reply.resolve(jsonResponse(actualGrantOptions()));await pending;expect(h.scheduling.grantOptions?.items[0]?.displayName).toBe('新项目成员');
  });
  it('does not repopulate member metadata after the session reset',async()=>{
    const reply=deferred<Response>();const h=schedulingHarness(c=>c.path.endsWith('/options')?reply.promise:jsonResponse(actualGrants()));const pending=h.scheduling.loadGrantOptions('1','2');h.scheduling.reset();reply.resolve(jsonResponse(actualGrantOptions()));await pending;expect(h.scheduling.grantOptions).toBeNull();
  });
  it.each(['ineligible','unknown','wrong-scope'])('blocks a %s member from a programmatic grant draft',async kind=>{
    const metadata=actualGrantOptions();const h=schedulingHarness(c=>jsonResponse(c.method==='PUT'?{version:'1',userIds:[]}:c.path.endsWith('/options')?metadata:actualGrants()));await h.scheduling.loadGrantOptions('1','2');h.scheduling.grantDraft=[kind==='unknown'?'999999':metadata.items.find((row:any)=>kind==='wrong-scope'?row.eligible:row.effectiveRole==='VIEWER').userId];const result=await h.scheduling.saveGrants('1',kind==='wrong-scope'?'3':'2');expect(result).toBe(false);expect(h.calls.filter(c=>c.method==='PUT')).toHaveLength(0);
  });
  it.each(['success','error'])('ignores a stale grant write %s after session reset',async kind=>{
    const reply=deferred<Response>();const h=schedulingHarness(c=>c.method==='PUT'?reply.promise:jsonResponse(c.path.endsWith('/options')?actualGrantOptions():actualGrants()));await h.scheduling.loadGrantOptions('1','2');h.scheduling.grantDraft=[actualGrantOptions().items.find((row:any)=>row.eligible).userId];const pending=h.scheduling.saveGrants('1','2');h.scheduling.reset();reply.resolve(kind==='success'?jsonResponse({version:'1',userIds:[]}):jsonResponse({code:'forbidden',message:'opaque'},403));await pending;expect(h.scheduling.grants).toBeNull();expect(h.scheduling.error).toBe('');expect(h.scheduling.grantDraft).toEqual([]);
  });
  it('ignores a stale grant save after selecting another project',async()=>{
    const reply=deferred<Response>();const h=schedulingHarness(c=>c.method==='PUT'?reply.promise:jsonResponse(c.path.endsWith('/options')?actualGrantOptions():{...actualGrants(),version:c.path.includes('/projects/3/')?'7':'0'}));await h.scheduling.loadGrantOptions('1','2');h.scheduling.grantDraft=[actualGrantOptions().items.find((row:any)=>row.eligible).userId];const pending=h.scheduling.saveGrants('1','2');await h.scheduling.loadGrantOptions('1','3');reply.resolve(jsonResponse({version:'1',userIds:[]}));await pending;expect(h.scheduling.grants?.version).toBe('7');
  });
  it('prevents duplicate grant writes',async()=>{
    const reply=deferred<Response>();const h=schedulingHarness(c=>c.method==='PUT'?reply.promise:jsonResponse(c.path.endsWith('/options')?actualGrantOptions():actualGrants()));await h.scheduling.loadGrantOptions('1','2');const a=h.scheduling.saveGrants('1','2'),b=h.scheduling.saveGrants('1','2');const count=h.calls.filter(c=>c.method==='PUT').length;reply.resolve(jsonResponse({version:'1',userIds:[]}));await Promise.all([a,b]);expect(count).toBe(1);
  });
  it('preserves a draft only when reloading the same project',async()=>{
    const h=schedulingHarness(c=>jsonResponse(c.path.endsWith('/options')?actualGrantOptions():actualGrants()));await h.scheduling.loadGrantOptions('1','2');const id=actualGrantOptions().items.find((row:any)=>row.eligible).userId;h.scheduling.grantDraft=[id];await (h.scheduling.loadGrantOptions as (ws:string,project:string,preserve?:boolean)=>Promise<void>)('1','2',true);expect(h.scheduling.grantDraft).toEqual([id]);
  });
  it('requires metadata reload after a server eligibility refusal',async()=>{
    const h=schedulingHarness(c=>c.method==='PUT'?jsonResponse({code:'schedule-grant-ineligible',message:'opaque'},403):jsonResponse(c.path.endsWith('/options')?actualGrantOptions():actualGrants()));await h.scheduling.loadGrantOptions('1','2');h.scheduling.grantDraft=[actualGrantOptions().items.find((row:any)=>row.eligible).userId];await h.scheduling.saveGrants('1','2');await h.scheduling.saveGrants('1','2');expect(h.calls.filter(c=>c.method==='PUT')).toHaveLength(1);
  });
});
