import { z } from 'zod';
import type { AdminClient } from './client.js';
import {
  CollaborationPolicySchema, CollaborationPublicationsSchema, CollaborationPublicationSchema,
  CollaborationGrantsSchema, CollaborationGrantSchema, CollaborationAuditSchema,
  CollaborationMockLogsSchema, ProjectCollaborationAccessSchema, CollaborationCapabilitySchema,
  CollaborationCreateGrantSchema,GrantOperationSchema,
} from '@apicc/execution/client/collaboration';
import { AdminRoleSchema, AdminAclRoleSchema } from './contract.js';

const revision=z.number().int().nonnegative().safe();
export const CapabilityModeSchema=z.enum(['inherit','allow','deny']);
export const CapabilityRowSchema=z.object({code:CollaborationCapabilitySchema,mode:CapabilityModeSchema,effective:z.boolean(),source:z.string(),roleFloor:z.string(),reason:z.string()}).strict();
export const AccessMemberSchema=z.object({userId:z.string(),member:z.boolean(),accountEnabled:z.boolean(),workspaceRole:AdminRoleSchema.nullable(),projectOverride:AdminAclRoleSchema.nullable(),overrideState:z.string(),effectiveRole:AdminRoleSchema.nullable(),revision,membershipEpoch:revision,responsibilityEpoch:revision,capabilities:z.array(CapabilityRowSchema)}).strict();
export const AccessPolicySchema=z.object({revision,defaults:z.partialRecord(CollaborationCapabilitySchema,CapabilityModeSchema),capabilities:z.array(CapabilityRowSchema)}).strict();
export const ManagementProjectsSchema=z.array(z.object({id:z.string(),name:z.string(),contentReadable:z.boolean()}).strict());
const AdminWorkspaceRoleSchema=z.object({userId:z.string(),workspaceId:z.string(),role:AdminRoleSchema.nullable(),revision}).strict();
export type AccessMember=z.infer<typeof AccessMemberSchema>;
export type AccessPolicy=z.infer<typeof AccessPolicySchema>;
export type ManagementProject=z.infer<typeof ManagementProjectsSchema>[number];
export type CapabilityRow=z.infer<typeof CapabilityRowSchema>;
export type CapabilityMode=z.infer<typeof CapabilityModeSchema>;
export const DeploymentSchema=z.object({
  runtime:z.object({enabled:z.boolean(),endpointConfigured:z.boolean(),secretConfigured:z.boolean(),expectedProtocolVersion:revision,health:z.enum(['disabled','unconfigured','unchecked'])}).strict(),
  publicAccess:z.object({enabled:z.boolean(),bindAddress:z.string(),port:revision,baseUrl:z.string().nullable(),managementBaseUrl:z.string().nullable(),originConfigured:z.boolean(),originStatus:z.enum(['valid','unconfigured','invalid-origin-or-separation']),managementOriginStatus:z.enum(['valid','unconfigured','invalid-origin']),boundPort:revision.nullable(),startupReconciled:z.boolean()}).strict(),
  resources:z.array(z.object({code:z.string(),defaultValue:z.number().nullable(),value:z.number().nullable(),minimum:z.number().nullable(),maximum:z.number().nullable(),unit:z.enum(['bytes','vCPU']),source:z.enum(['builtin','deployment']),effect:z.enum(['external-enforcement','deployment-configuration','runtime-startup']),constraint:z.enum(['external-enforcement-unverified','heap-not-rss','complete-total-memory-budget'])}).strict()),
  resourceConstraint:z.literal('heap-cache-inflight-headroom-within-total'),
  fields:z.array(z.object({code:z.string(),defaultValue:z.string(),minimum:revision.nullable(),maximum:revision.nullable(),unit:z.string(),constraint:z.string(),source:z.literal('deployment'),effect:z.literal('restart-required')}).strict()),
}).strict();
export type DeploymentView=z.infer<typeof DeploymentSchema>;

export interface AccessScope { workspaceId:string; projectId?:string }
export interface PolicyScope { workspaceId?:string; projectId?:string }
export type MetadataQuery = { cursor?:string; limit?:number; object?:string; actor?:string; time?:string };
const e=encodeURIComponent;
export const accessPath=(s:AccessScope)=>`/workspaces/${e(s.workspaceId)}${s.projectId?`/projects/${e(s.projectId)}`:''}`;
const policyPath=(s:PolicyScope)=>s.workspaceId?`${accessPath(s as AccessScope)}/collaboration/policy`:'/admin/collaboration/policy';
function query(input:object){return Object.fromEntries(Object.entries(input).filter(([,v])=>v!==undefined).map(([k,v])=>[k,String(v)]));}

export function createCollaborationApi(client:AdminClient){
  const request=<T extends z.ZodTypeAny>(method:string,path:string,schema:T,body?:unknown,q?:object)=>client.request({method,path,schema,body,...(q?{query:query(q)}:{})}) as Promise<z.infer<T>>;
  const project=(s:AccessScope)=>`${accessPath(s)}/collaboration`;
  return {
    deployment:()=>request('GET','/admin/collaboration/deployment',DeploymentSchema),
    directory:(workspaceId:string)=>request('GET',`/workspaces/${e(workspaceId)}/access-projects`,ManagementProjectsSchema),
    member:(s:AccessScope,userId:string)=>request('GET',`${accessPath(s)}/access-members/${e(userId)}`,AccessMemberSchema),
    putMember:(s:AccessScope,userId:string,input:unknown)=>request('PUT',`${accessPath(s)}/access-members/${e(userId)}`,AccessMemberSchema,input),
    accessPolicy:(s:AccessScope)=>request('GET',`${accessPath(s)}/access-policy`,AccessPolicySchema),
    putAccessPolicy:(s:AccessScope,input:unknown)=>request('PUT',`${accessPath(s)}/access-policy`,AccessPolicySchema,input),
    access:(s:AccessScope)=>request('GET',`${accessPath(s)}/access`,ProjectCollaborationAccessSchema),
    adminWorkspaceRole:(userId:string,workspaceId:string)=>request('GET',`/admin/users/${e(userId)}/workspace-role`,AdminWorkspaceRoleSchema,undefined,{workspaceId}),
    policy:(s:PolicyScope)=>request('GET',policyPath(s),CollaborationPolicySchema),
    savePolicy:(s:PolicyScope,input:unknown)=>request('PUT',policyPath(s),CollaborationPolicySchema,input),
    publications:(s:AccessScope,q:MetadataQuery={})=>request('GET',`${project(s)}/publications`,CollaborationPublicationsSchema,undefined,q),
    publication:(s:AccessScope,id:string)=>request('GET',`${project(s)}/publications/${e(id)}`,CollaborationPublicationSchema),
    grants:(s:AccessScope,id:string,q:MetadataQuery={})=>request('GET',`${project(s)}/publications/${e(id)}/grants`,CollaborationGrantsSchema,undefined,q),
    createGrant:async(s:AccessScope,id:string,input:unknown)=>{const {publicationId,...body}=CollaborationCreateGrantSchema.parse({...(input as object),publicationId:id});return request('POST',`${project(s)}/publications/${e(publicationId)}/grants`,CollaborationGrantSchema,body);},
    grantOperation:(s:AccessScope,intent:string)=>request('GET',`${project(s)}/grant-operations/${e(intent)}`,GrantOperationSchema),
    rotateGrant:(s:AccessScope,id:string,input:unknown)=>request('POST',`${project(s)}/grants/${e(id)}/rotate`,CollaborationGrantSchema,input),
    revokeGrant:(s:AccessScope,id:string,expectedRevision:number)=>client.request({method:'DELETE',path:`${project(s)}/grants/${e(id)}`,body:{expectedRevision}}),
    setMockEnabled:(s:AccessScope,id:string,enabled:boolean,expectedRevision:number)=>request('POST',`${project(s)}/publications/${e(id)}/${enabled?'enable':'disable'}`,CollaborationPublicationSchema,{expectedRevision}),
    audit:(s:AccessScope,q:MetadataQuery={})=>request('GET',`${project(s)}/audit`,CollaborationAuditSchema,undefined,q),
    mockLogs:(s:AccessScope,id:string,q:MetadataQuery={})=>request('GET',`${project(s)}/publications/${e(id)}/mock-logs`,CollaborationMockLogsSchema,undefined,q),
  };
}
export type CollaborationApi=ReturnType<typeof createCollaborationApi>;
