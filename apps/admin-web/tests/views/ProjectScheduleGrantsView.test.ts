// @vitest-environment jsdom
import {afterEach,describe,expect,it} from 'vitest';
import {enableAutoUnmount,flushPromises} from '@vue/test-utils';
import {actualGrantOptions,actualGrants,jsonResponse,mountSchedulingRoute} from '../helpers/scheduling.js';
enableAutoUnmount(afterEach);
describe('project schedule authorization',()=>{
  it('locks member selection until a slow empty-grants save completes',async()=>{
    let release!:(reply:Response)=>void;const reply=new Promise<Response>(resolve=>release=resolve),metadata=actualGrantOptions(),eligible=metadata.items.find((row:any)=>row.eligible);
    const h=await mountSchedulingRoute('/workspaces/1/projects/2/schedule-grants',c=>c.method==='PUT'?reply:jsonResponse(c.path.endsWith('/options')?metadata:actualGrants()));
    await h.wrapper.get('[data-testid="grant-save"]').trigger('click');await flushPromises();
    const selector=`[data-testid="grant-select-${eligible.userId}"]`,checkbox=h.wrapper.get(selector),locked=(checkbox.element as HTMLInputElement).disabled;
    if(!locked)await checkbox.setValue(true);const during=[...h.scheduling.grantDraft];
    release(jsonResponse({version:'1',userIds:[]}));await flushPromises();
    expect.soft(locked).toBe(true);expect.soft(during).toEqual([]);expect(h.calls.find(c=>c.method==='PUT')?.body).toEqual({expectedVersion:'0',userIds:[]});
    expect((h.wrapper.get(selector).element as HTMLInputElement).disabled).toBe(false);await h.wrapper.get(selector).setValue(true);expect(h.scheduling.grantDraft).toEqual([eligible.userId]);
  });
  it('lets a workspace EDITOR reach project schedule grants from Org',async()=>{
    const h=await mountSchedulingRoute('/workspaces/1/org',()=>jsonResponse([]),{workspaceRole:'EDITOR'});expect(h.wrapper.find('[data-testid="org-project-schedule-grants-2"]').exists()).toBe(true);
  });
  it('reads actual member names, project eligibility and reasons without workspace ACL access',async()=>{
    const metadata=actualGrantOptions();const h=await mountSchedulingRoute('/workspaces/1/projects/2/schedule-grants',c=>jsonResponse(c.path.endsWith('/options')?metadata:actualGrants()),{workspaceRole:'EDITOR'});
    expect(h.wrapper.text()).toContain(metadata.items.find((row:any)=>row.eligible).displayName);expect(h.wrapper.text()).toContain('账号已停用');expect(h.wrapper.text()).toContain('项目不可见');expect(h.wrapper.text()).toContain('项目管理员默认拥有');expect(h.wrapper.text()).toContain('编辑者');expect(h.wrapper.find('pre').exists()).toBe(false);
    expect(h.calls.some(c=>c.path.includes('/acl')||c.path.endsWith('/members'))).toBe(false);await h.wrapper.get('[data-testid="layout-locale"]').setValue('en');await flushPromises();expect(h.wrapper.text()).toContain('Account disabled');expect(h.wrapper.text()).toContain('Editor');
  });
  it('selects an eligible project editor and saves the versioned explicit grants',async()=>{
    const metadata=actualGrantOptions(),eligible=metadata.items.find((row:any)=>row.eligible);const h=await mountSchedulingRoute('/workspaces/1/projects/2/schedule-grants',c=>jsonResponse(c.method==='PUT'?{version:'1',userIds:[eligible.userId]}:c.path.endsWith('/options')?metadata:actualGrants()),{workspaceRole:'EDITOR'});
    expect(h.wrapper.find(`[data-testid="grant-select-${eligible.userId}"]`).exists()).toBe(true);await h.wrapper.get(`[data-testid="grant-select-${eligible.userId}"]`).setValue(true);await h.wrapper.get('[data-testid="grant-save"]').trigger('click');await flushPromises();expect(h.calls.find(c=>c.method==='PUT')?.body).toEqual({expectedVersion:'0',userIds:[eligible.userId]});expect(h.wrapper.text()).toContain('版本: 1');
  });
  it('shows project permission refusal even for a platform identity without project authority',async()=>{
    const h=await mountSchedulingRoute('/workspaces/1/projects/2/schedule-grants',()=>jsonResponse({code:'forbidden',message:'opaque'},403),{platform:true,workspaceRole:'EDITOR',locale:'en'});expect(h.wrapper.text()).toContain('permission');expect(h.wrapper.find('[data-testid="grant-save"]').exists()).toBe(false);expect(h.wrapper.find('input[type="checkbox"]').exists()).toBe(false);
  });
  it.each(['OWNER','ADMIN','VIEWER','account-disabled','project-access-denied'])('does not allow explicit selection of %s',async kind=>{
    const metadata=actualGrantOptions(),row=metadata.items.find((item:any)=>['OWNER','ADMIN','VIEWER'].includes(kind)?item.effectiveRole===kind:item.reasonCode===kind);const h=await mountSchedulingRoute('/workspaces/1/projects/2/schedule-grants',c=>jsonResponse(c.path.endsWith('/options')?metadata:actualGrants()));expect(h.wrapper.get(`[data-testid="grant-select-${row.userId}"]`).attributes('disabled')).toBeDefined();
  });
  it('retains a conflict draft, reloads the actual version and requires explicit retry',async()=>{
    const metadata=actualGrantOptions(),row=metadata.items.find((item:any)=>item.eligible);let reads=0;const h=await mountSchedulingRoute('/workspaces/1/projects/2/schedule-grants',c=>c.method==='PUT'?jsonResponse({code:'version_conflict',message:'opaque'},409):jsonResponse(c.path.endsWith('/options')?metadata:{...actualGrants(),version:reads++?'8':'0'}));await h.wrapper.get(`[data-testid="grant-select-${row.userId}"]`).setValue(true);await h.wrapper.get('[data-testid="grant-save"]').trigger('click');await flushPromises();expect(h.wrapper.get('[data-testid="grant-save"]').attributes('disabled')).toBeDefined();expect(h.wrapper.find('[data-testid="grant-reload"]').exists()).toBe(true);await h.wrapper.get('[data-testid="grant-reload"]').trigger('click');await flushPromises();expect((h.wrapper.get(`[data-testid="grant-select-${row.userId}"]`).element as HTMLInputElement).checked).toBe(true);expect(h.wrapper.text()).toContain('版本: 8');expect(h.calls.filter(c=>c.method==='PUT')).toHaveLength(1);
  });
  it('explains a changed eligibility and requires explicit removal of stale draft selections',async()=>{
    const metadata=actualGrantOptions(),row=metadata.items.find((item:any)=>item.eligible);const changed=structuredClone(metadata);Object.assign(changed.items.find((item:any)=>item.userId===row.userId),{eligible:false,effectiveRole:'VIEWER',reasonCode:'editor-required'});let reads=0;const h=await mountSchedulingRoute('/workspaces/1/projects/2/schedule-grants',c=>c.method==='PUT'?jsonResponse({code:'schedule-grant-ineligible',message:'opaque'},403):jsonResponse(c.path.endsWith('/options')?(reads++?changed:metadata):actualGrants()));await h.wrapper.get(`[data-testid="grant-select-${row.userId}"]`).setValue(true);await h.wrapper.get('[data-testid="grant-save"]').trigger('click');await flushPromises();expect(h.wrapper.get('[role="alert"]').text()).toContain('资格已变化');await h.wrapper.get('[data-testid="grant-reload"]').trigger('click');await flushPromises();expect(h.wrapper.get('[data-testid="grant-save"]').attributes('disabled')).toBeDefined();expect(h.wrapper.text()).toContain('失效');await h.wrapper.get('[data-testid="grant-clear-ineligible"]').trigger('click');await flushPromises();expect(h.scheduling.grantDraft).toEqual([]);
  });
  it('shows an account-disabled reason ahead of implicit administrator permission',async()=>{
    const metadata=actualGrantOptions();Object.assign(metadata.items[0],{reasonCode:'account-disabled'});const h=await mountSchedulingRoute('/workspaces/1/projects/2/schedule-grants',c=>jsonResponse(c.path.endsWith('/options')?metadata:actualGrants()));expect(h.wrapper.get(`[data-testid="grant-row-${metadata.items[0].userId}"]`).text()).toContain('账号已停用');
  });
});
