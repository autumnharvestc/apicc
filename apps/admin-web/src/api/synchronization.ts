import {z} from 'zod';
import {SyncPolicySchema,SyncPolicyValuesSchema,SyncRevisionSchema,SyncEffectivePolicySchema,SyncDeploymentLimitsSchema,SyncPolicySaveInputSchema,SyncSourceSchema,SyncCheckLookupSchema,CredentialMetadataSchema} from '@apicc/execution/contract';
import type {AdminClient} from './client.js';
import {accessPath,type AccessScope} from './collaboration.js';

const policyBase={saved:SyncPolicySchema,inherited:SyncPolicySchema.nullable(),workspaceRevision:SyncRevisionSchema,units:z.record(SyncPolicyValuesSchema.keyof(),z.enum(['milliseconds','bytes','days','count'])),deploymentLimits:SyncDeploymentLimitsSchema,deploymentCeilings:z.partialRecord(SyncPolicyValuesSchema.keyof(),z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER))};
/** The finite public policy view from SyncPolicyService, including invalid saved overrides. */
export const SyncPolicyViewSchema=z.discriminatedUnion('status',[
  z.object({...policyBase,status:z.literal('valid'),effective:SyncEffectivePolicySchema,reasonCode:z.null()}).strict(),
  z.object({...policyBase,status:z.literal('invalid'),effective:z.null(),reasonCode:z.literal('SYNC_POLICY_INVALID')}).strict(),
]);
export type SyncPolicyView=z.infer<typeof SyncPolicyViewSchema>;
export type SyncPolicyField=keyof z.infer<typeof SyncPolicyValuesSchema>;
export function createSynchronizationApi(client:AdminClient){
  const path=(s:AccessScope)=>`${accessPath(s)}/sync/policy`;
  async function read(method:string,s:AccessScope,body?:unknown){
    const value=SyncPolicyViewSchema.parse(await client.request({method,path:path(s),schema:SyncPolicyViewSchema,body}));
    if(value.saved.scope!==(s.projectId?'project':'workspace'))throw Error('SYNC_POLICY_SCOPE_MISMATCH');
    return value;
  }
  const request=async<T extends z.ZodTypeAny>(s:AccessScope,suffix:string,schema:T,query?:Record<string,string>):Promise<z.infer<T>>=>{
    if(!s.projectId)throw Error('SYNC_PROJECT_REQUIRED');
    return schema.parse(await client.request({method:'GET',path:`${accessPath(s)}${suffix}`,schema,query}));
  };
  return {
    policy:(s:AccessScope)=>read('GET',s),savePolicy:(s:AccessScope,input:unknown)=>read('PUT',s,SyncPolicySaveInputSchema.parse(input)),
    sources:(s:AccessScope)=>request(s,'/sync/sources',z.array(SyncSourceSchema)),
    materials:(s:AccessScope)=>request(s,'/credentials',z.array(CredentialMetadataSchema)),
    checks:(s:AccessScope,sourceId:string)=>request(s,'/sync/checks',SyncCheckLookupSchema,{sourceId}),
  };
}
