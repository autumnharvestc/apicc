import {mount,flushPromises} from '@vue/test-utils';
import {defaultSyncPolicyValues,SyncPolicySchema,SyncEffectivePolicySchema} from '@apicc/execution/contract';
import {ProjectCollaborationAccessSchema} from '@apicc/execution/client/collaboration';
import SyncPolicyView from '../../src/views/SyncPolicyView.vue';
import ProjectSyncAccessView from '../../src/views/ProjectSyncAccessView.vue';
import {createAdminClient} from '../../src/api/client.js';
import {createAdminI18n} from '../../src/i18n/index.js';
export const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
export type Call={path:string;method:string;body:any};
export function policyFixture(invalid=false){
  const saved=SyncPolicySchema.parse({formatVersion:1,scope:'project',revision:'7',maxAttempts:1,...(invalid?{gitDeadlineMs:120000}:{})});
  const inherited=SyncPolicySchema.parse({formatVersion:1,scope:'workspace',revision:'4',gitDeadlineMs:60000});
  const effective=SyncEffectivePolicySchema.parse({policy:{...defaultSyncPolicyValues,gitDeadlineMs:60000},savedRevision:'7',sources:Object.fromEntries(Object.keys(defaultSyncPolicyValues).map(k=>[k,k==='maxAttempts'?'project':k==='gitDeadlineMs'?'workspace':'default'])),appliesTo:'next-check',deploymentLimits:{maxWireBytes:33554432,envelopeReserveBytes:1048576}});
  return {saved,inherited,workspaceRevision:'4',units:Object.fromEntries(Object.keys(defaultSyncPolicyValues).map(k=>[k,k.endsWith('Ms')?'milliseconds':k.endsWith('Bytes')?'bytes':k.endsWith('Days')?'days':'count'])),deploymentLimits:effective.deploymentLimits,deploymentCeilings:{gitDeadlineMs:120000},status:invalid?'invalid':'valid',reasonCode:invalid?'SYNC_POLICY_INVALID':null,effective:invalid?null:effective};
}
export function currentAccess(capabilities:string[]=['sync.manage','sync.check','sync.apply','audit.read'],role:'ADMIN'|'EDITOR'|null='ADMIN'){
  return ProjectCollaborationAccessSchema.parse({accountEnabled:true,member:true,workspaceRole:role??'ADMIN',projectOverride:role===null?'NONE':null,overrideState:role===null?'explicit':'inherited',effectiveRole:role,capabilities:role===null?[]:capabilities,accessRevision:3,membershipEpoch:1,responsibilityEpoch:1,reasonCode:role===null?'project-none':null});
}
export async function mountSyncPolicyView(options:{invalid?:boolean;locale?:'zh-CN'|'en';access?:ReturnType<typeof currentAccess>;handler?:(c:Call)=>Response|Promise<Response>;workspace?:boolean}={}){
  const h=harness(options);const wrapper=mount(SyncPolicyView,{props:{client:h.client,workspaceId:'1',...(options.workspace?{}:{projectId:'2'})},global:{plugins:[h.i18n]}});await flushPromises();
  return {...h,wrapper,row:(label:string)=>wrapper.findAll('tr').find(r=>r.find('th').text()===label)!,primaryConfigurationPre:()=>wrapper.findAll('pre')};
}
export function harness(options:{invalid?:boolean;locale?:'zh-CN'|'en';access?:ReturnType<typeof currentAccess>;handler?:(c:Call)=>Response|Promise<Response>}={}){
  const calls:Call[]=[];const client=createAdminClient({token:'synthetic-admin',fetch:async(input,init)=>{const c={path:String(input),method:init?.method??'GET',body:init?.body?JSON.parse(String(init.body)):undefined};calls.push(c);if(options.handler)return options.handler(c);if(c.path.endsWith('/access'))return json(options.access??currentAccess());if(c.path.endsWith('/sync/policy'))return json(policyFixture(options.invalid));return json({code:'forbidden',message:'opaque'},403);}});
  localStorage.setItem('apicc.admin.locale',options.locale??'zh-CN');const {i18n}=createAdminI18n();return {client,calls,i18n};
}
export async function mountSyncAccessView(handler:(c:Call)=>Response|Promise<Response>,locale:'zh-CN'|'en'='zh-CN'){
  const h=harness({handler,locale});const wrapper=mount(ProjectSyncAccessView,{props:{client:h.client,workspaceId:'1',projectId:'2'},global:{plugins:[h.i18n]}});await flushPromises();return {...h,wrapper};
}
