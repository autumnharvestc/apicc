import { z } from "zod";
import {
  AgentConfigSchema, AgentConfigPatchSchema, ConfigApplicationStateSchema, ConfigVersionSchema,
  DeploymentConfigSchema, EntityIdSchema, PolicyConfigSchema, PolicyConfigPatchSchema,
  ProjectExecutionAgentsSchema, RuntimeRegistrationSchema, defaultAgentConfig, defaultPolicyConfig, resolveEffectiveConfig,
} from "@apicc/execution/contract";
import type { AdminClient } from "./client.js";

export { defaultAgentConfig, defaultPolicyConfig };
export const defaultProjectPolicy=Object.freeze(resolveEffectiveConfig().policy);
export const AgentSummarySchema = z.object({ id: EntityIdSchema, name: z.string(), acceptingJobs: z.boolean(), revoked: z.boolean() }).strict();
const RestrictionsSchema = z.array(z.object({ field: z.string(), reason: z.string(), effectiveValue: z.number() }).strict());
export const AgentDetailSchema = ConfigApplicationStateSchema.safeExtend({
  ...AgentSummarySchema.shape, explicit: AgentConfigPatchSchema, config: AgentConfigSchema,
  sources: z.record(z.string(), z.string()), restrictions: RestrictionsSchema,
  deployment: DeploymentConfigSchema,
  agentPolicy: z.object({ version: ConfigVersionSchema, explicit: z.object({ maxQueuedJobs: z.number().optional() }).strict(), maxQueuedJobs: z.number() }).strict(),
  availability: ProjectExecutionAgentsSchema.shape.agents.element.shape.availability,
  lastSeenAt: z.string().datetime().nullable(), runtime: RuntimeRegistrationSchema.optional(),
});
const PolicyStateSchema = z.object({ configVersion: ConfigVersionSchema, policyVersion: ConfigVersionSchema,
  policy: PolicyConfigSchema, sources: z.record(z.string(), z.string()), restrictions: RestrictionsSchema });
export const WorkspacePolicySchema = PolicyStateSchema.extend({ explicit: PolicyConfigPatchSchema });
export const ProjectSettingsSchema = PolicyStateSchema.extend({
  agentIds: z.array(EntityIdSchema), defaultAgentId: EntityIdSchema.nullable(),
  jobTimeoutMs:z.number().int().positive(),versions:z.object({workspace:ConfigVersionSchema,project:ConfigVersionSchema}).strict(),
  queueLimits:z.object({global:z.number().int().positive(),agent:z.number().int().positive().nullable(),project:z.number().int().positive()}).strict(),
  explicit: z.object({ workspace: PolicyConfigPatchSchema, project: PolicyConfigPatchSchema, run: z.record(z.string(), z.unknown()) }),
}).strict();
export const ScriptGrantSchema = z.object({ agentId: EntityIdSchema, version: ConfigVersionSchema,
  scope: z.enum(["script-version", "project"]), grantedByUserId: z.string(),
  scripts: z.array(z.object({ scriptId: z.string().min(1).max(512), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
}).strict();
export type AgentSummary = z.infer<typeof AgentSummarySchema>;
export type AgentDetail = z.infer<typeof AgentDetailSchema>;
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;
export type WorkspacePolicy = z.infer<typeof WorkspacePolicySchema>;
export type ScriptGrant = z.infer<typeof ScriptGrantSchema>;
export type ProjectExecutionAgents = z.infer<typeof ProjectExecutionAgentsSchema>;
export type PolicyPatch = z.infer<typeof PolicyConfigPatchSchema>;
export type AgentPatch = z.infer<typeof AgentConfigPatchSchema>;
export type ProjectUpdate = { agentIds: string[]; defaultAgentId: string | null; policy: PolicyPatch };
const e = encodeURIComponent;
const ws = (id: string) => `/workspaces/${e(id)}`;
const project = (w: string, p: string) => `${ws(w)}/projects/${e(p)}`;
export function createAgentsApi(client: AdminClient) {
  const call = async <T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown, query?: Record<string, string>) =>
    await client.request({ method, path, schema, body, query }) as T;
  const empty = (method: string, path: string, body?: unknown) => client.request({ method, path, body });
  return {
    list: () => call("GET", "/agents", z.array(AgentSummarySchema)),
    directory: () => call("GET", "/agents/workspace-directory", z.array(z.object({ id: EntityIdSchema, name: z.string() }).strict())),
    create: (name: string) => call("POST", "/agents", AgentSummarySchema, { name }),
    get: (id: string) => call("GET", `/agents/${e(id)}`, AgentDetailSchema),
    save: (id: string, expectedVersion: string, config: AgentPatch, extra: { name?: string; acceptingJobs?: boolean; expectedPolicyVersion?: string; policy?: { maxQueuedJobs: number } } = {}) =>
      call("PATCH", `/agents/${e(id)}`, AgentDetailSchema, { expectedVersion, config: AgentConfigPatchSchema.parse(config), ...extra }),
    revoke: (id: string) => empty("POST", `/agents/${e(id)}/revoke`),
    enrollment: (id: string) => call("POST", `/agents/${e(id)}/enrollments`, z.object({ agentId: EntityIdSchema, enrollmentToken: z.string(), expiresAt: z.string().datetime() }).strict()),
    grants: (id: string) => call("GET", `/agents/${e(id)}/workspace-grants`, z.object({ workspaceIds: z.array(EntityIdSchema) }).strict()),
    saveGrants: (id: string, workspaceIds: string[]) => empty("PUT", `/agents/${e(id)}/workspace-grants`, { workspaceIds }),
    available: (w: string) => call("GET", `${ws(w)}/available-agents`, z.array(AgentSummarySchema)),
    allocations: (w: string, agentId: string) => call("GET", `${ws(w)}/agent-project-allocations`, z.object({ agentId: EntityIdSchema, projectIds: z.array(EntityIdSchema) }).strict(), undefined, { agentId }),
    allocate: (w: string, agentId: string, projectIds: string[]) => empty("PUT", `${ws(w)}/agent-project-allocations`, { agentId, projectIds }),
    workspace: (w: string) => call("GET", `${ws(w)}/execution-settings`, WorkspacePolicySchema),
    saveWorkspace: (w: string, expectedVersion: string, policy: PolicyPatch) => call("PUT", `${ws(w)}/execution-settings`, WorkspacePolicySchema, { expectedVersion, policy: PolicyConfigPatchSchema.parse(policy) }),
    project: (w: string, p: string) => call("GET", `${project(w,p)}/execution-agents`, ProjectExecutionAgentsSchema),
    candidates: (w: string, p: string) => call("GET", `${project(w,p)}/agent-candidates`, z.array(AgentSummarySchema)),
    settings: (w: string, p: string) => call("GET", `${project(w,p)}/execution-settings`, ProjectSettingsSchema),
    saveProject: (w: string, p: string, expectedVersion: string, value: ProjectUpdate) => call("PUT", `${project(w,p)}/execution-settings`, ProjectSettingsSchema, { ...value, expectedVersion, policy: PolicyConfigPatchSchema.parse(value.policy) }),
    scriptGrant: (w: string, p: string, agentId: string) => call("GET", `${project(w,p)}/script-grants`, ScriptGrantSchema, undefined, { agentId }),
    saveScriptGrant: (w: string, p: string, value: Omit<ScriptGrant, "version" | "grantedByUserId"> & { expectedVersion: string; riskConfirmed: boolean }) => call("PUT", `${project(w,p)}/script-grants`, ScriptGrantSchema, value),
  };
}
/** Presentation conversions only. Effective values and inheritance always come from the server. */
export function fieldUnit(key: string): string { return key.endsWith("Ms") ? "s" : ["bodyPreviewBytes","valuePreviewBytes","caseEvidenceBytes"].includes(key)?"KiB":key.endsWith("Bytes") ? "MiB" : key.endsWith("Days") ? "days" : key.endsWith("Ratio") ? "%" : key.endsWith("MiB") ? "MiB" : "count"; }
function unitFactor(key:string){return key.endsWith("Ms")?1000:fieldUnit(key)==="KiB"?1024:key.endsWith("Bytes")?1048576:key.endsWith("Ratio")?0.01:1;}
export function displayValue(key: string, value: unknown): string | number {
  if (value === null || value === undefined) return "—";
  return typeof value !== "number" ? String(value) : value / unitFactor(key);
}
export function wireValue(key: string, value: string | number): number {
  const factor=unitFactor(key);
  if(factor===0.01)return Number(value)/100;
  // Parse the decimal the user entered, rather than multiplying a binary float.
  const match=String(value).trim().match(/^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
  if(!match||!(match[2]||match[3]))return NaN;
  const exponent=Number(match[4]??0),fraction=match[3]??"";
  if(!Number.isSafeInteger(exponent)||Math.abs(exponent)>400||fraction.length>400)return NaN;
  const scale=fraction.length-exponent;
  let numerator=BigInt((match[2]||"0")+fraction)*BigInt(factor);
  if(match[1]==="-")numerator=-numerator;
  if(scale<=0)return Number(numerator*10n**BigInt(-scale));
  const denominator=10n**BigInt(scale);
  if(numerator%denominator===0n)return Number(numerator/denominator);
  const result=Number(numerator)/Number(denominator);
  // A real fractional base unit must remain invalid, even below float resolution.
  return Number.isInteger(result)?NaN:result;
}
export interface FormValidationIssue { field:string;rule:"integer"|"greaterThan"|"atLeast"|"atMost"|"lessThan"|"number"|"invalid";limit?:number }
export function formValidationIssues(error:z.ZodError):FormValidationIssue[]{
  return error.issues.map<FormValidationIssue>(issue=>{
    const field=issue.path.filter(part=>typeof part==="string"&&(part in defaultAgentConfig||part in defaultPolicyConfig)).at(-1);
    const base={field:typeof field==="string"?field:""};
    if(issue.code==="too_small")return {...base,rule:issue.inclusive?"atLeast":"greaterThan",limit:Number(issue.minimum)};
    if(issue.code==="too_big")return {...base,rule:issue.inclusive?"atMost":"lessThan",limit:Number(issue.maximum)};
    if(issue.code==="invalid_type")return {...base,rule:issue.expected==="int"?"integer":"number"};
    return {...base,rule:"invalid"};
  });
}
export function validationMessage(issue:FormValidationIssue,t:(key:string,values?:Record<string,string|number>)=>string):string{
  const field=issue.field?t(`agents.fields.${issue.field}`):t("agents.field");
  const unit=t(`agents.units.${fieldUnit(issue.field)}`);
  const reason=issue.rule==="integer"?t(issue.field.endsWith("Ms")?"agents.validation.integerMilliseconds":"agents.validation.integer"):
    t(`agents.validation.${issue.rule==='number'&&issue.field.endsWith('Ms')?'numberMilliseconds':issue.rule}`,{limit:displayValue(issue.field,issue.limit)});
  return `${field} (${unit}): ${reason}`;
}
export function readableTime(value: string | null | undefined): string { return value ? new Date(value).toISOString().replace("T", " ").replace("Z", " UTC") : "—"; }
