// @vitest-environment jsdom
import {afterEach,describe,expect,it} from 'vitest';
import {enableAutoUnmount,flushPromises} from '@vue/test-utils';
import {actualChannels,actualChannelMetadata,jsonResponse,mountSchedulingRoute} from '../helpers/scheduling.js';
enableAutoUnmount(afterEach);
describe('notification channel administration',()=>{
  it('locks material edits and channel switching until a slow channel save completes',async()=>{
    let release!:(reply:Response)=>void;const reply=new Promise<Response>(resolve=>release=resolve),row=actualChannels().created['host-case'];
    const h=await mountSchedulingRoute('/workspaces/1/notification-channels',c=>c.method==='PUT'?reply:jsonResponse({items:[row]}));
    await h.wrapper.get(`[data-testid="channel-edit-${row.id}"]`).trigger('click');await h.wrapper.get('[data-testid="channel-name"]').setValue('Submitted A');await h.wrapper.get('[data-testid="channel-save"]').trigger('click');await flushPromises();
    const controls=h.wrapper.findAll('form input, form button, [data-testid="channel-create"], [data-testid^="channel-edit-"], [data-testid^="channel-delete-"]');
    const locks=controls.map(control=>({id:control.attributes('data-testid')??control.text(),disabled:(control.element as HTMLInputElement).disabled}));
    const create=h.wrapper.get('[data-testid="channel-create"]');if(!(create.element as HTMLButtonElement).disabled){await create.trigger('click');await h.wrapper.get('[data-testid="channel-name"]').setValue('Unsaved B');await h.wrapper.get('[data-testid="channel-secret"]').setValue('synthetic-new-B');}
    const during={id:h.scheduling.channelDraft?.id,name:h.scheduling.channelDraft?.name,secret:h.scheduling.channelDraft?.hmacSecret};
    release(jsonResponse({...row,name:'Submitted A',version:'2'}));await flushPromises();
    for(const lock of locks)expect.soft(lock.disabled,lock.id).toBe(true);
    expect.soft(during).toEqual({id:row.id,name:'Submitted A',secret:''});expect(h.calls.find(c=>c.method==='PUT')?.body.name).toBe('Submitted A');
    expect(h.scheduling.channelDraft).toBeNull();expect((h.wrapper.get('[data-testid="channel-create"]').element as HTMLButtonElement).disabled).toBe(false);
    await h.wrapper.get('[data-testid="channel-create"]').trigger('click');await h.wrapper.get('[data-testid="channel-name"]').setValue('New B after response');expect(h.scheduling.channelDraft?.name).toBe('New B after response');
  });
  it('offers workspace administrators a channel navigation entry',async()=>{
    const h=await mountSchedulingRoute('/workspaces/1/org',()=>jsonResponse([]));
    expect(h.wrapper.find('[data-testid="menu-notification-channels"]').exists()).toBe(true);
  });
  it('shows redacted channel state and explains an unavailable origin in Chinese and English',async()=>{
    const metadata=actualChannels();const h=await mountSchedulingRoute('/workspaces/1/notification-channels',()=>jsonResponse({items:[metadata.created['host-case'],metadata.legacy]}));
    expect(h.wrapper.text()).toContain('来源不可用');expect(h.wrapper.text()).toContain('https://hook.example.test');expect(h.wrapper.text()).toContain('可用');expect(h.wrapper.text()).toContain('版本');expect(h.wrapper.find('pre').exists()).toBe(false);
    const locale=h.wrapper.get('[data-testid="layout-locale"]');await locale.setValue('en');await flushPromises();
    expect(h.wrapper.text()).toContain('Origin unavailable');expect(h.wrapper.text()).toContain('internationalized domain names');expect(h.wrapper.text()).toContain('ASCII');expect(h.wrapper.text()).toContain('HTTP');
  });
  it('creates a disabled channel with write-only fields and never calls a test-send endpoint',async()=>{
    const h=await mountSchedulingRoute('/workspaces/1/notification-channels',c=>jsonResponse(c.method==='POST'?actualChannelMetadata(false,true,true):{items:[]}));
    expect(h.wrapper.find('[data-testid="channel-create"]').exists()).toBe(true);await h.wrapper.get('[data-testid="channel-create"]').trigger('click');
    await h.wrapper.get('[data-testid="channel-name"]').setValue('新渠道');await h.wrapper.get('[data-testid="channel-url"]').setValue('https://hook.example.test/private?key=synthetic-write-only');await h.wrapper.get('[data-testid="channel-secret"]').setValue('synthetic-write-only-hmac');await h.wrapper.get('[data-testid="channel-save"]').trigger('click');await flushPromises();
    const writes=h.calls.filter(c=>c.method!=='GET');expect(writes).toHaveLength(1);expect(writes[0]?.path).toBe('/api/v1/workspaces/1/notification-channels');expect(writes[0]?.body.enabled).toBe(false);expect(writes[0]?.body.expectedVersion).toBe('0');
    expect(h.wrapper.html()).not.toContain('synthetic-write-only');
  });
  it('keeps URL and secret unchanged when blank during an edit',async()=>{
    const row=actualChannels().created['host-case'];const h=await mountSchedulingRoute('/workspaces/1/notification-channels',c=>jsonResponse(c.method==='PUT'?{...row,name:'新名称',version:'2'}:{items:[row]}));
    expect(h.wrapper.find(`[data-testid="channel-edit-${row.id}"]`).exists()).toBe(true);await h.wrapper.get(`[data-testid="channel-edit-${row.id}"]`).trigger('click');
    expect((h.wrapper.get('[data-testid="channel-url"]').element as HTMLInputElement).value).toBe('');expect((h.wrapper.get('[data-testid="channel-secret"]').element as HTMLInputElement).value).toBe('');
    await h.wrapper.get('[data-testid="channel-name"]').setValue('新名称');await h.wrapper.get('[data-testid="channel-save"]').trigger('click');await flushPromises();
    const input=h.calls.find(c=>c.method==='PUT')?.body;expect(input).toMatchObject({expectedVersion:'1',name:'新名称'});expect(input).not.toHaveProperty('url');expect(input).not.toHaveProperty('hmacSecret');
  });
  it('does not expose a form after a real channel-list permission rejection',async()=>{
    const h=await mountSchedulingRoute('/workspaces/1/notification-channels',()=>jsonResponse({code:'forbidden',message:'opaque'},403),{workspaceRole:'EDITOR',locale:'en'});
    expect(h.wrapper.text()).toContain('permission');expect(h.wrapper.find('[data-testid="channel-create"]').exists()).toBe(false);expect(h.wrapper.find('[data-testid="menu-notification-channels"]').exists()).toBe(false);
  });
  it('requires an explicit old-delivery acknowledgement before rotating URL or secret',async()=>{
    const row=actualChannels().created['host-case'];const h=await mountSchedulingRoute('/workspaces/1/notification-channels',c=>jsonResponse(c.method==='PUT'?{...row,version:'2'}:{items:[row]}));await h.wrapper.get(`[data-testid="channel-edit-${row.id}"]`).trigger('click');await h.wrapper.get('[data-testid="channel-url"]').setValue('https://hook.example.test/rotated');await h.wrapper.get('[data-testid="channel-save"]').trigger('click');await flushPromises();
    expect(h.calls.filter(c=>c.method==='PUT')).toHaveLength(0);expect(h.wrapper.text()).toContain('请明确确认');
    await h.wrapper.get('[data-testid="channel-rotation-confirm"]').setValue(true);await h.wrapper.get('[data-testid="channel-save"]').trigger('click');await flushPromises();expect(h.calls.filter(c=>c.method==='PUT')).toHaveLength(1);
  });
  it('reloads channel conflicts while preserving the write draft and requiring explicit retry',async()=>{
    const row=actualChannels().created['host-case'];let reads=0;const h=await mountSchedulingRoute('/workspaces/1/notification-channels',c=>c.method==='PUT'?jsonResponse({code:'version_conflict',message:'opaque'},409):jsonResponse({items:[{...row,version:reads++?'8':'1'}]}));await h.wrapper.get(`[data-testid="channel-edit-${row.id}"]`).trigger('click');await h.wrapper.get('[data-testid="channel-name"]').setValue('保留草稿');await h.wrapper.get('[data-testid="channel-save"]').trigger('click');await flushPromises();
    expect(h.wrapper.find('[data-testid="channel-reload"]').exists()).toBe(true);await h.wrapper.get('[data-testid="channel-reload"]').trigger('click');await flushPromises();expect((h.wrapper.get('[data-testid="channel-name"]').element as HTMLInputElement).value).toBe('保留草稿');expect(h.scheduling.channelDraft?.version).toBe('8');expect(h.calls.filter(c=>c.method==='PUT')).toHaveLength(1);
  });
  it('deletes only after the channel-specific confirmation',async()=>{
    const row=actualChannels().created['host-case'];const h=await mountSchedulingRoute('/workspaces/1/notification-channels',c=>c.method==='DELETE'?new Response(null,{status:204}):jsonResponse({items:[row]}));
    expect(h.wrapper.find(`[data-testid="channel-delete-${row.id}"]`).exists()).toBe(true);await h.wrapper.get(`[data-testid="channel-delete-${row.id}"]`).trigger('click');await flushPromises();expect(h.calls.filter(c=>c.method==='DELETE')).toHaveLength(0);
    await h.wrapper.get('[data-testid="channel-delete-confirm"]').trigger('click');await flushPromises();expect(h.calls.find(c=>c.method==='DELETE')?.path).toBe(`/api/v1/workspaces/1/notification-channels/${row.id}?expectedVersion=1`);expect(h.wrapper.find(`[data-testid="channel-row-${row.id}"]`).exists()).toBe(false);
  });
  it('clears channel secrets when leaving for the organization page',async()=>{
    const h=await mountSchedulingRoute('/workspaces/1/notification-channels',()=>jsonResponse({items:[]}));await h.wrapper.get('[data-testid="channel-create"]').trigger('click');await h.wrapper.get('[data-testid="channel-secret"]').setValue('synthetic-leaving-secret');await h.router.push('/workspaces/1/org');await flushPromises();expect(h.scheduling.channelDraft).toBeNull();
  });
  it.each([
    [true,true,true,'加密材料可读'],[true,true,false,'加密材料可读'],[true,false,true,'部署密钥或渠道加密材料不可读'],[true,false,false,'部署密钥或渠道加密材料不可读'],
    [false,true,true,'未检查'],[false,true,false,'未检查'],[false,false,true,'未检查'],[false,false,false,'未检查'],
  ] as const)('shows actual independent key state enabled=%s readable=%s supported=%s',async(enabled,readable,supported,want)=>{
    const row=actualChannelMetadata(enabled,readable,supported);const h=await mountSchedulingRoute('/workspaces/1/notification-channels',()=>jsonResponse({items:[row]}));expect(h.wrapper.get(`[data-testid="channel-row-${row.id}"]`).text()).toContain(want);
  });
  it.each([
    [true,true,'无已知安全失败'],[false,true,'channel-key-unavailable'],[true,false,'unsupported-origin'],[false,false,'channel-key-unavailable'],
  ] as const)('explains actual reasons independently readable=%s supported=%s',async(readable,supported,want)=>{
    const row=actualChannelMetadata(true,readable,supported);const h=await mountSchedulingRoute('/workspaces/1/notification-channels',()=>jsonResponse({items:[row]}));const text=h.wrapper.get(`[data-testid="channel-row-${row.id}"]`).text();expect(text).toContain(want);if(!readable&&!supported)expect(text).toContain('unsupported-origin');
  });
  it('explains an actual write key-unavailable code without reflecting the raw error',async()=>{
    const h=await mountSchedulingRoute('/workspaces/1/notification-channels',c=>c.method==='POST'?jsonResponse({code:'channel_unavailable',message:'opaque'},503):jsonResponse({items:[]}));await h.wrapper.get('[data-testid="channel-create"]').trigger('click');await h.wrapper.get('[data-testid="channel-name"]').setValue('渠道');await h.wrapper.get('[data-testid="channel-url"]').setValue('https://hook.example.test/private');await h.wrapper.get('[data-testid="channel-secret"]').setValue('synthetic-key-unavailable');await h.wrapper.get('[data-testid="channel-save"]').trigger('click');await flushPromises();expect(h.wrapper.get('[role="alert"]').text()).toContain('部署密钥或渠道加密材料不可读');expect(h.wrapper.text()).not.toContain('opaque');
  });
  it('explains a fractional byte budget by field while blocking the write',async()=>{
    const h=await mountSchedulingRoute('/workspaces/1/notification-channels',()=>jsonResponse({items:[]}));await h.wrapper.get('[data-testid="channel-create"]').trigger('click');await h.wrapper.get('[data-testid="channel-name"]').setValue('渠道');await h.wrapper.get('[data-testid="channel-url"]').setValue('https://hook.example.test/private');await h.wrapper.get('[data-testid="channel-secret"]').setValue('synthetic-byte-secret');await h.wrapper.get('[data-testid="channel-limit-maxPayloadBytes"]').setValue('1.0001');await h.wrapper.get('[data-testid="channel-save"]').trigger('click');await flushPromises();expect(h.calls.filter(c=>c.method==='POST')).toHaveLength(0);expect(h.wrapper.get('[role="alert"]').text()).toContain('正文上限');expect(h.wrapper.get('[role="alert"]').text()).toContain('整数字节');
  });
});
