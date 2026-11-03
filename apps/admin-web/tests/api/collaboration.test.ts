import { describe, expect, it } from 'vitest';
import { createAdminClient } from '../../src/api/client.js';
import { createCollaborationApi } from '../../src/api/collaboration.js';
import { member, directory, capabilities, deployment,grant } from '../helpers/collaboration.js';
import { createUsersStore } from '../../src/stores/users.js';

const account = { id:'7', username:'alice', displayName:'Alice', role:'USER', disabled:false, createdAt:'2026-11-03T00:00:00Z', revision:4 };
function transport(payload:unknown = null) {
  const calls:{url:string;method:string;body:unknown}[]=[];
  const client=createAdminClient({token:'admin',fetch:async (url,init)=>{
    calls.push({url:String(url),method:init?.method??'GET',body:init?.body?JSON.parse(String(init.body)):null});
    return payload===null?new Response(null,{status:204}):Response.json(payload);
  }});
  return {client,calls};
}
describe('legacy collaboration CAS migration',()=>{
  it('I6 I7 reads the current typed deployment origin and resource producer metadata',async()=>{
    const {client}=transport({...deployment,publicAccess:{...deployment.publicAccess,enabled:false,baseUrl:'https://public.example.test',managementBaseUrl:'https://management.example.test',managementOriginStatus:'valid'}});
    const value=await createCollaborationApi(client).deployment();expect(value).toMatchObject({publicAccess:{enabled:false,originConfigured:true,originStatus:'valid',baseUrl:'https://public.example.test'},resourceConstraint:'heap-cache-inflight-headroom-within-total'});expect(value.resources[0]).toMatchObject({code:'externalLimits.cpuVcpu',minimum:0.25,maximum:8});
  });
  it('account store forwards the listed account-state identity',async()=>{
    const {client,calls}=transport([account]); const store=createUsersStore({client});
    await store.refresh();expect(store.items[0]?.revision).toBe(4);
    expect(await store.setDisabled('7',true)).toBe(true);
    expect(calls.find(c=>c.method==='POST')?.body).toEqual({expectedRevision:4});
  });
  // Breakage caught: dropping the separate account-state revision on disable or enable.
  it.each([true,false])('sends account-state revision for disabled=%s',async(disabled)=>{
    const {client,calls}=transport([account]);
    expect(await client.adminListUsers()).toHaveLength(1); // legal producer shape first
    await client.adminSetDisabled('7',disabled,4);
    expect(calls[1]?.body).toEqual({expectedRevision:4});
  });
  it('retains authoritative account revision',async()=>{
    expect((await transport([account]).client.adminListUsers())[0]?.revision).toBe(4);
  });
  it('rejects account metadata with a missing revision after legal account read',async()=>{
    expect(await transport([account]).client.adminListUsers()).toHaveLength(1);
    const {revision,...legacy}=account;
    await expect(transport([legacy]).client.adminListUsers()).rejects.toMatchObject({code:'protocol_error'});
  });
  // Breakage caught: omitted expected revisions on every old mutation entry point.
  it('keeps member/ACL/transfer revisions in their own scopes',async()=>{
    const {client,calls}=transport();
    await client.setMemberRole('1','7','OWNER',8,3);
    await client.removeMember('1','7',9);
    await client.setAclEntry('1','2',{userId:'7',role:'NONE',expectedRevision:5});
    await client.deleteAclEntry('1','2','7',6);
    await client.adminSetWorkspaceRole('7','1','EDITOR',11);
    expect(calls.map(c=>({method:c.method,url:c.url,body:c.body}))).toEqual([
      {method:'PUT',url:'/api/v1/workspaces/1/members/7',body:{role:'OWNER',expectedRevision:8,expectedActorRevision:3}},
      {method:'DELETE',url:'/api/v1/workspaces/1/members/7?expectedRevision=9',body:null},
      {method:'PUT',url:'/api/v1/workspaces/1/projects/2/acl',body:{userId:'7',role:'NONE',expectedRevision:5}},
      {method:'DELETE',url:'/api/v1/workspaces/1/projects/2/acl?userId=7&expectedRevision=6',body:null},
      {method:'PUT',url:'/api/v1/admin/users/7/workspace-role',body:{workspaceId:'1',role:'EDITOR',expectedRevision:11}},
    ]);
  });
});

describe('access management wire contracts',()=>{
  it.each([{durationMs:59999},{durationMs:60000,expiresAt:2000000000123}])('create reuses the strict relative-duration contract after a valid command',async(invalid)=>{
    const {client,calls}=transport({...grant,state:'active',key:'one-time'});const api=createCollaborationApi(client);const scope={workspaceId:'1',projectId:'2'};
    const valid={purpose:'call',audience:'external',expectedRevision:3,operationIntent:'new-intent',durationMs:60000};
    expect((await api.createGrant(scope,'41',valid)).key).toBe('one-time');
    await expect(api.createGrant(scope,'41',{...valid,...invalid})).rejects.toBeDefined();
    expect(calls).toHaveLength(1);
  });
  it.each([{...deployment,runtime:{...deployment.runtime,health:undefined}},{...deployment,secretFile:'PRIVATE_PATH'}])('deployment metadata is finite after an authorized valid read',async(invalid)=>{
    const read=(payload:unknown)=>createCollaborationApi(transport(payload).client).deployment();
    expect(await read(deployment)).toEqual(deployment);
    await expect(read(invalid)).rejects.toMatchObject({code:'protocol_error'});
  });
  it.each([
    ['member',member(),{...member(),revision:undefined}],
    ['member',member(),{...member(),membershipEpoch:undefined}],
    ['member',member(),{...member(),responsibilityEpoch:undefined}],
    ['member',member(),{...member(),capabilities:[{...capabilities[0],source:undefined}]}],
    ['member',member(),{...member(),workspaceRole:undefined}],
    ['member',member(),{...member(),privateKey:'do-not-return'}],
    ['directory',directory,[{...directory[0],contentReadable:undefined}]],
    ['accessPolicy',{revision:2,defaults:{},capabilities},{revision:2,defaults:{},capabilities:[{...capabilities[0],reason:undefined}]}],
    ['adminWorkspaceRole',{userId:'7',workspaceId:'1',role:null,revision:12},{userId:'7',workspaceId:'1',role:null}],
  ])('%s rejects malformed management metadata after legal read',async(method,valid,invalid)=>{
    const read=(payload:unknown)=>{
      const api=createCollaborationApi(transport(payload).client);
      return method==='member'?api.member({workspaceId:'1',projectId:'2'},'7'):method==='directory'?api.directory('1'):method==='accessPolicy'?api.accessPolicy({workspaceId:'1'}):api.adminWorkspaceRole('7','1');
    };
    expect(await read(valid)).toEqual(valid);
    await expect(read(invalid)).rejects.toMatchObject({code:'protocol_error'});
  });
});
