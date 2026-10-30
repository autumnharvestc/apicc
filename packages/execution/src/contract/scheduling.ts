import { z } from "zod";
import { EntityIdSchema, HashSchema, TaskTargetSchema } from "./task.js";
import { ConfigVersionSchema, RunConfigSchema } from "./config.js";
import { MaterialRefSchema, AttachmentSelectionSchema, AttachmentPathsSchema, AttachmentMetadataSchema } from "./materials.js";
import { JobPreparationSchema, FixedNetworkInputSchema } from './jobs.js';

const integer = (min: number, max: number) => z.number().int().min(min).max(max);
export const ScheduleInstantSchema = z.iso.datetime({ precision: null }).refine(v => v.endsWith("Z"), "expected UTC Instant");
export const ScheduleTimeZoneSchema = z.string().refine(value => {
  if (/^[+-]/.test(value)) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}, "expected IANA time zone");
/** Calendar and frequency evaluation remain authoritative on the server's Spring CronExpression. */
export const ScheduleRuleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), atUtc: ScheduleInstantSchema, timeZone: ScheduleTimeZoneSchema }).strict(),
  z.object({ kind: z.literal("cron"), expression: z.string().trim().refine(v => v.split(/\s+/).length === 6 && v.split(/\s+/).every(f => /^[\dA-Za-z*?,/#L\-]+$/.test(f)), "expected six Cron fields"), timeZone: ScheduleTimeZoneSchema, dstOverlap: z.enum(["first", "both"]) }).strict(),
]);
const policyFields = {
  lateToleranceMs: integer(1000, 300000).default(10000), misfire: z.enum(["skip", "catch-up-one"]).default("skip"),
  catchupWindowMs: integer(1000, 86400000).default(300000), overlap: z.enum(["skip", "queue-one"]).default("skip"),
  queueTimeoutMs: integer(1000, 86400000).default(300000),
};
export const SchedulePoliciesSchema = z.object(policyFields).strict();
export const ScheduleCredentialBindingSchema = z.discriminatedUnion("mode", [
  z.object({ refId: MaterialRefSchema, mode: z.literal("current-at-trigger") }).strict(),
  z.object({ refId: MaterialRefSchema, mode: z.literal("fixed-version"), version: EntityIdSchema }).strict(),
]);
export const SchedulerDeploymentSchema = z.object({
  mode: z.enum(["embedded", "disabled"]).default("embedded"), scanIntervalMs: integer(100, 60000).default(1000),
  claimLeaseMs: integer(3000, 300000).default(30000), batchSize: integer(1, 1000).default(50),
  evaluationMaxCandidates: integer(10, 100000).default(5000), maxSchedules: integer(1, 100000).default(10000),
}).strict().refine(v => v.claimLeaseMs >= 3 * v.scanIntervalMs, "claim lease must cover three scans");
const notificationFields = {
  requestTimeoutMs: integer(1000, 30000).default(5000), maxAttempts: integer(1, 20).default(5),
  retryMinMs: integer(1000, 3600000).default(5000), retryMaxMs: integer(1000, 3600000).default(300000),
  jitterRatio: z.number().min(0).max(1).default(0.2), deliveryTtlMs: integer(1000, 604800000).default(86400000),
  maxPayloadBytes: integer(1024, 65536).default(16384), maxResponseBytes: integer(0, 65536).default(8192),
};
export const NotificationChannelPolicySchema = z.object(notificationFields).strict().refine(v => v.retryMinMs <= v.retryMaxMs, "retry minimum exceeds maximum");
const origin = z.string().refine(v => {
  try { const u = new URL(v); return ["https:", "http:"].includes(u.protocol) && u.origin === v && !u.username && !u.password && !u.hostname.split('.').some(label=>label.startsWith('xn--')); } catch { return false; }
}, "expected exact HTTP(S) origin");
const cidr = z.string().refine(v => {
  const [address, prefix, extra] = v.split("/");
  if (extra !== undefined || !prefix || !/^\d+$/.test(prefix)) return false;
  if (address!.includes(":")) { try { new URL(`http://[${address}]/`); return Number(prefix) <= 128; } catch { return false; } }
  return address!.split(".").length === 4 && address!.split(".").every(n => /^(0|[1-9]\d{0,2})$/.test(n) && Number(n) <= 255) && Number(prefix) <= 32;
}, "expected IP CIDR");
export const NotificationDeploymentSchema = z.object({
  ...notificationFields, scanIntervalMs: integer(100, 60000).default(1000), leaseMs: integer(3000, 300000).default(30000),
  concurrency: integer(1, 16).default(2), maxPendingDeliveries: integer(1, 100000).default(10000),
  allowedWebhookOrigins: z.array(origin).default([]), allowedWebhookCidrs: z.array(cidr).default([]), allowHttpOrigins: z.array(origin).default([]),
}).strict().superRefine((v, ctx) => {
  if (v.leaseMs <= v.requestTimeoutMs + 2 * v.scanIntervalMs) ctx.addIssue({ code: "custom", path: ["leaseMs"], message: "notification lease must exceed timeout and two scans" });
  if (v.retryMinMs > v.retryMaxMs) ctx.addIssue({ code: "custom", path: ["retryMinMs"], message: "retry minimum exceeds maximum" });
  if (v.allowHttpOrigins.some(o => !o.startsWith("http:") || !v.allowedWebhookOrigins.includes(o))) ctx.addIssue({ code: "custom", path: ["allowHttpOrigins"], message: "HTTP origins require exact deployment authorization" });
});
const schedulePolicyFields = {
  ...policyFields, maxSchedules: integer(1, 100000).default(1000), minIntervalMs: integer(1000, 86400000).default(60000),
  maxQueueTimeoutMs: integer(1000, 86400000).default(3600000), maxPendingDeliveries: integer(1, 100000).default(1000),
  historyRetentionDays: integer(1, 3650).default(30), notificationRetentionDays: integer(1, 3650).default(30),
};
export const SchedulePolicySchema = z.object(schedulePolicyFields).strict().refine(v => v.queueTimeoutMs <= v.maxQueueTimeoutMs, "queue timeout exceeds maximum");
export const SchedulePolicyPatchSchema = z.object({
  lateToleranceMs: policyFields.lateToleranceMs.removeDefault().optional(), misfire: policyFields.misfire.removeDefault().optional(),
  catchupWindowMs: policyFields.catchupWindowMs.removeDefault().optional(), overlap: policyFields.overlap.removeDefault().optional(),
  queueTimeoutMs: policyFields.queueTimeoutMs.removeDefault().optional(), maxSchedules: schedulePolicyFields.maxSchedules.removeDefault().optional(),
  minIntervalMs: schedulePolicyFields.minIntervalMs.removeDefault().optional(), maxQueueTimeoutMs: schedulePolicyFields.maxQueueTimeoutMs.removeDefault().optional(),
  maxPendingDeliveries: schedulePolicyFields.maxPendingDeliveries.removeDefault().optional(), historyRetentionDays: schedulePolicyFields.historyRetentionDays.removeDefault().optional(),
  notificationRetentionDays: schedulePolicyFields.notificationRetentionDays.removeDefault().optional(),
}).strict();
export const SchedulePolicyUpdateSchema = z.object({ expectedVersion: ConfigVersionSchema, policy: SchedulePolicyPatchSchema, resetKeys:z.array(SchedulePolicyPatchSchema.keyof()).transform(v=>[...new Set(v)]).optional() }).strict().refine(v=>!(v.resetKeys??[]).some(key=>key in v.policy),'a policy field cannot be set and reset together');
export const SchedulePolicyViewSchema=z.object({default:SchedulePolicyPatchSchema.required(),explicit:SchedulePolicyPatchSchema,explicitByScope:z.object({workspace:SchedulePolicyPatchSchema,project:SchedulePolicyPatchSchema}).strict(),effective:SchedulePolicyPatchSchema.required().refine(v=>v.queueTimeoutMs<=v.maxQueueTimeoutMs,'queue timeout exceeds maximum'),source:z.record(SchedulePolicyPatchSchema.keyof(),z.enum(['default','deployment','workspace','project'])),version:ConfigVersionSchema,versions:z.object({workspace:ConfigVersionSchema,project:ConfigVersionSchema}).strict(),appliesTo:z.literal('new-admissions')}).strict();
export type SchedulePolicyView=z.infer<typeof SchedulePolicyViewSchema>;
export const SchedulePreviewRequestSchema = z.object({ rule: ScheduleRuleSchema, afterUtc: ScheduleInstantSchema }).strict();
export const ScheduleCandidateSchema = z.object({ plannedAtUtc: ScheduleInstantSchema, localTime: z.string(), offset: z.string() }).strict();
export const SchedulePreviewSchema = z.object({ candidates: z.array(ScheduleCandidateSchema), notices: z.array(z.string()), limits: z.record(z.string(), z.unknown()) }).strict();
export const ScheduleNotificationEventsSchema = z.array(z.enum(["failed", "abnormal", "expired", "paused", "succeeded", "skipped"])).refine(v => new Set(v).size === v.length, "duplicate event").default(["failed", "abnormal", "expired", "paused"]);
export const defaultSchedulerDeployment = Object.freeze(SchedulerDeploymentSchema.parse({}));
export const defaultNotificationDeployment = Object.freeze(NotificationDeploymentSchema.parse({}));
export const defaultSchedulePolicies = Object.freeze(SchedulePoliciesSchema.parse({}));
export const defaultSchedulePolicy = Object.freeze(SchedulePolicySchema.parse({}));
export const ScheduleMaterialsSchema = z.object({projectId:EntityIdSchema,credentials:z.array(ScheduleCredentialBindingSchema),attachments:z.array(AttachmentSelectionSchema),attachmentPaths:AttachmentPathsSchema.optional()}).strict().superRefine((v,ctx)=>{
  for(const field of ['credentials','attachments'] as const)if(new Set(v[field].map(r=>r.refId)).size!==v[field].length)ctx.addIssue({code:'custom',path:[field],message:'duplicate reference'});
  for(const [path,a] of Object.entries(v.attachmentPaths??{}))if(!v.attachments.some(b=>a.refId===b.refId&&a.version===b.version&&a.hash===b.hash))ctx.addIssue({code:'custom',path:['attachmentPaths',path],message:'path requires an explicitly uploaded fixed attachment'});
});
export const ScheduleExecutionSchema=z.object({agentId:EntityIdSchema,snapshotId:EntityIdSchema,target:TaskTargetSchema,environmentId:z.string().uuid().optional(),runConfig:RunConfigSchema,materials:ScheduleMaterialsSchema,preparation:JobPreparationSchema,network:FixedNetworkInputSchema.optional()}).strict().superRefine((v,ctx)=>{
  if(v.target.kind!=='suite'&&v.target.kind!=='workflow')ctx.addIssue({code:'custom',path:['target'],message:'schedules require suite or workflow'});
  if(v.preparation.dispatchKind!=='dedicated-task'||v.preparation.stressBinding!==undefined||v.runConfig.stress!==undefined)ctx.addIssue({code:'custom',path:['preparation'],message:'schedules require dedicated execution without stress settings'});
  if(v.materials.projectId!==v.preparation.scope.projectId)ctx.addIssue({code:'custom',path:['materials'],message:'material scope mismatch'});
});
export const ScheduleNotificationsSchema=z.object({inApp:z.boolean(),eventKinds:ScheduleNotificationEventsSchema.removeDefault(),channelIds:z.array(EntityIdSchema).refine(v=>new Set(v).size===v.length,'duplicate channel')}).strict();
const saveFields={name:z.string().min(1).max(128).refine(v=>v.trim().length>0,'name cannot be blank'),rule:ScheduleRuleSchema,policies:SchedulePoliciesSchema,execution:ScheduleExecutionSchema,notifications:ScheduleNotificationsSchema};
export const ScheduleSaveSchema=z.object(saveFields).strict();
export const ScheduleUpdateSchema=z.object({expectedVersion:ConfigVersionSchema,name:saveFields.name.optional(),rule:saveFields.rule.optional(),policies:saveFields.policies.optional(),execution:saveFields.execution.optional(),notifications:saveFields.notifications.optional(),enabled:z.boolean().optional(),reauthorize:z.boolean().optional(),refreshExecution:z.boolean().optional()}).strict().refine(v=>(v.execution!==undefined)===(v.refreshExecution===true),'execution refresh requires execution and refreshExecution=true');
export const ScheduleViewSchema=z.object({...saveFields,id:EntityIdSchema,workspaceId:EntityIdSchema,projectId:EntityIdSchema,version:EntityIdSchema,revision:EntityIdSchema,enabled:z.boolean(),subjectUserId:EntityIdSchema,snapshotVersion:ConfigVersionSchema,manifestHash:HashSchema,pausedReasonCode:z.string().nullable(),nextPlannedAtUtc:ScheduleInstantSchema.nullable(),cancellationVersion:ConfigVersionSchema,evaluatedThroughUtc:ScheduleInstantSchema.nullable(),lastAdmittedPlannedAtUtc:ScheduleInstantSchema.nullable()}).strict();
export const ScheduleOptionsSchema=z.object({canManageSchedules:z.boolean(),schedulerAvailable:z.boolean(),policy:SchedulePolicySchema,sources:z.record(z.string(),z.string()),policyVersion:z.object({workspace:ConfigVersionSchema,project:ConfigVersionSchema}).strict(),channels:z.array(z.object({id:EntityIdSchema,name:z.string(),kind:z.literal('webhook')}).strict())}).strict();
export const SchedulePageSchema=z.object({items:z.array(ScheduleViewSchema),nextBeforeId:EntityIdSchema.nullable()}).strict();
export const ScheduleGrantsSchema=z.object({version:ConfigVersionSchema,userIds:z.array(EntityIdSchema)}).strict();
export const ScheduleGrantOptionsSchema=z.object({items:z.array(z.object({userId:EntityIdSchema,username:z.string(),displayName:z.string(),effectiveRole:z.enum(['OWNER','ADMIN','EDITOR','VIEWER']).nullable(),eligible:z.boolean(),reasonCode:z.enum(['account-disabled','project-access-denied','editor-required']).nullable()}).strict().refine(v=>v.eligible?v.effectiveRole==='EDITOR'&&v.reasonCode===null:v.reasonCode==='account-disabled'||v.reasonCode==='project-access-denied'&&v.effectiveRole===null||v.reasonCode==='editor-required'&&v.effectiveRole!==null&&v.effectiveRole!=='EDITOR','eligibility, effective role and reason must agree')).refine(items=>new Set(items.map(row=>row.userId)).size===items.length,'duplicate member identity')}).strict();
export type ScheduleGrantOptions=z.infer<typeof ScheduleGrantOptionsSchema>;
export const ScheduleGrantUpdateSchema=z.object({expectedVersion:ConfigVersionSchema,userIds:z.array(EntityIdSchema).refine(v=>new Set(v).size===v.length,'duplicate member')}).strict();
export const ScheduleMaterialOptionsSchema=z.object({credentialValidation:z.literal('metadata-only'),credentials:z.array(z.object({refId:MaterialRefSchema,version:EntityIdSchema,status:z.literal('registered')}).strict()),attachments:z.array(AttachmentMetadataSchema)}).strict();
export type ScheduleSave=z.infer<typeof ScheduleSaveSchema>;
export type ScheduleUpdate=z.infer<typeof ScheduleUpdateSchema>;
export type ScheduleView=z.infer<typeof ScheduleViewSchema>;
export type ScheduleExecution=z.infer<typeof ScheduleExecutionSchema>;
export type ScheduleOptions=z.infer<typeof ScheduleOptionsSchema>;
export type ScheduleRule = z.infer<typeof ScheduleRuleSchema>;
export type SchedulePolicies = z.infer<typeof SchedulePoliciesSchema>;
export type ScheduleCredentialBinding = z.infer<typeof ScheduleCredentialBindingSchema>;
export type SchedulerDeployment = z.infer<typeof SchedulerDeploymentSchema>;
export type NotificationDeployment = z.infer<typeof NotificationDeploymentSchema>;
export type NotificationChannelPolicy = z.infer<typeof NotificationChannelPolicySchema>;
export type SchedulePolicy = z.infer<typeof SchedulePolicySchema>;
export type SchedulePolicyPatch = z.infer<typeof SchedulePolicyPatchSchema>;
const scheduleReason=z.string().min(1).max(96).nullable();
export const ScheduleOccurrenceStateSchema=z.enum(['pending','waiting-overlap','submitted','skipped','rejected','expired']);
export const ScheduleHistoryMaterialsSchema=z.object({status:z.enum(['sealed','unavailable']),projectId:EntityIdSchema.nullable(),credentials:z.array(z.object({refId:MaterialRefSchema,version:EntityIdSchema}).strict()),attachments:z.array(AttachmentSelectionSchema)}).strict().refine(v=>v.status==='sealed'?v.projectId!==null:v.projectId===null&&v.credentials.length===0&&v.attachments.length===0,'unavailable materials cannot claim sealed facts');
export const ScheduleHistoryExecutionSchema=z.object({availability:z.enum(['not-submitted','not-integrated','available']),state:z.enum(['queued','preparing','running','ended']).nullable(),released:z.boolean().nullable(),reportState:z.enum(['none','pending','archived','expired']).nullable(),verdict:z.enum(['passed','failed','cancelled','timed-out','interrupted','rejected']).nullable().optional()}).strict().refine(v=>v.availability==='available'?v.state!==null&&v.released!==null&&v.reportState!==null:v.state===null&&v.released===null&&v.reportState===null&&v.verdict==null,'execution facts require the original job projection');
export const ScheduleOccurrenceSchema=z.object({id:EntityIdSchema,workspaceId:EntityIdSchema,projectId:EntityIdSchema,scheduleId:EntityIdSchema,revision:EntityIdSchema,cancellationVersion:ConfigVersionSchema,subjectUserId:EntityIdSchema,plannedAtUtc:ScheduleInstantSchema,observedAtUtc:ScheduleInstantSchema,delayMs:z.number().int().nonnegative(),queueDeadlineUtc:ScheduleInstantSchema,state:ScheduleOccurrenceStateSchema,reasonCode:scheduleReason,materials:ScheduleHistoryMaterialsSchema,jobId:EntityIdSchema.nullable(),executionId:EntityIdSchema.nullable(),execution:ScheduleHistoryExecutionSchema}).strict().refine(v=>v.state==='submitted'?v.jobId!==null&&v.executionId!==null&&v.execution.availability!=='not-submitted':v.jobId===null&&v.executionId===null&&v.execution.availability==='not-submitted','occurrence and original job identity must agree');
export const ScheduleMissedWindowSchema=z.object({id:EntityIdSchema,revision:EntityIdSchema,fromUtc:ScheduleInstantSchema,throughUtc:ScheduleInstantSchema,observedAtUtc:ScheduleInstantSchema,reasonCode:z.string().min(1).max(96),missedCount:ConfigVersionSchema.nullable()}).strict();
export const ScheduleHistoryPageSchema=z.object({workspaceId:EntityIdSchema,projectId:EntityIdSchema,scheduleId:EntityIdSchema,evaluationStatus:z.enum(['active','paused','deleted','finished']),pausedReasonCode:scheduleReason,evaluatedThroughUtc:ScheduleInstantSchema.nullable(),lastAdmittedPlannedAtUtc:ScheduleInstantSchema.nullable(),items:z.array(ScheduleOccurrenceSchema),nextBeforeId:EntityIdSchema.nullable(),missedWindows:z.array(ScheduleMissedWindowSchema),nextMissedBeforeId:EntityIdSchema.nullable()}).strict().refine(v=>v.items.every(row=>row.workspaceId===v.workspaceId&&row.projectId===v.projectId&&row.scheduleId===v.scheduleId&&(row.materials.projectId===null||row.materials.projectId===v.projectId)),'history scope mismatch');
export const SchedulerControlSchema=z.object({mode:z.enum(['embedded','disabled']),generation:EntityIdSchema,version:EntityIdSchema}).strict();
export const SchedulerControlUpdateSchema=z.object({mode:z.enum(['embedded','disabled']),expectedVersion:ConfigVersionSchema}).strict();
export type ScheduleHistoryPage=z.infer<typeof ScheduleHistoryPageSchema>;
export type ScheduleOccurrence=z.infer<typeof ScheduleOccurrenceSchema>;
export type ScheduleMissedWindow=z.infer<typeof ScheduleMissedWindowSchema>;
export type SchedulerControl=z.infer<typeof SchedulerControlSchema>;
export type SchedulerControlUpdate=z.infer<typeof SchedulerControlUpdateSchema>;
const safeNotificationReason=z.string().regex(/^[a-z][a-z0-9_-]{0,95}$/);
const sourceId=z.string().regex(/^(occurrence|schedule)\/[1-9]\d*$/).refine(v=>EntityIdSchema.safeParse(v.split('/')[1]).success,'invalid source identity');
export const NotificationStateSchema=z.enum(['in-app','not-requested','pending','acknowledged','failed']);
export const NotificationDeliverySchema=z.object({id:EntityIdSchema,channelId:EntityIdSchema,channelVersion:EntityIdSchema,state:z.enum(['pending','sending','acknowledged','failed','rejected','stopped','expired']),reasonCode:safeNotificationReason.nullable(),attempts:integer(0,20),status:integer(100,599).nullable(),deadlineUtc:ScheduleInstantSchema,nextAttemptAtUtc:ScheduleInstantSchema.nullable()}).strict();
export const NotificationEventSchema=z.object({id:EntityIdSchema,workspaceId:EntityIdSchema,projectId:EntityIdSchema,scheduleId:EntityIdSchema,scheduleName:z.string().min(1).max(128),projectName:z.string().min(1).max(128),sourceId,sourceVersion:EntityIdSchema,eventKind:ScheduleNotificationEventsSchema.removeDefault().element,reasonCode:safeNotificationReason,link:z.string().regex(/^\/workspaces\/[1-9]\d*\/projects\/[1-9]\d*\/schedules\/[1-9]\d*$/),plannedAtUtc:ScheduleInstantSchema.nullable(),revision:EntityIdSchema.nullable(),snapshotVersion:ConfigVersionSchema.nullable(),jobId:EntityIdSchema.nullable(),executionId:EntityIdSchema.nullable(),verdict:z.enum(['passed','failed','cancelled','timed-out','interrupted','rejected']).nullable(),evidenceState:z.enum(['not-applicable','complete','incomplete']),reportState:z.enum(['none','pending','archived','expired']),createdAtUtc:ScheduleInstantSchema,notificationState:NotificationStateSchema,read:z.boolean(),deliveries:z.array(NotificationDeliverySchema),snapshotId:EntityIdSchema.nullable(),observedAtUtc:ScheduleInstantSchema,startedAtUtc:ScheduleInstantSchema.nullable(),finishedAtUtc:ScheduleInstantSchema.nullable()}).strict().refine(v=>v.link===`/workspaces/${v.workspaceId}/projects/${v.projectId}/schedules/${v.scheduleId}`,'notification link scope mismatch');
export const NotificationPageSchema=z.object({items:z.array(NotificationEventSchema),nextBeforeId:EntityIdSchema.nullable()}).strict();
export const NotificationHistoryEventSchema=z.object({eventId:EntityIdSchema,sourceId,sourceVersion:EntityIdSchema,eventKind:ScheduleNotificationEventsSchema.removeDefault().element,createdAtUtc:ScheduleInstantSchema,detailState:z.enum(['available','expired']),inApp:z.boolean(),notificationState:NotificationStateSchema,reasonCodes:z.array(safeNotificationReason),deliveries:z.array(NotificationDeliverySchema)}).strict();
export const NotificationSourceObservationSchema=z.discriminatedUnion('observationState',[
  z.object({sourceId,sourceVersion:EntityIdSchema,observationState:z.enum(['not-ready','not-observed','not-selected']),eventId:z.null(),inApp:z.null()}).strict(),
  z.object({sourceId,sourceVersion:EntityIdSchema,observationState:z.literal('recorded'),eventId:EntityIdSchema,inApp:z.boolean()}).strict(),
  z.object({sourceId:sourceId.refine(v=>v.startsWith('schedule/'),'unknown provenance is a legacy pause'),sourceVersion:z.null(),observationState:z.literal('unknown'),eventId:z.null(),inApp:z.null()}).strict(),
]);
export const NotificationHistoryPageSchema=z.object({workspaceId:EntityIdSchema,projectId:EntityIdSchema,scheduleId:EntityIdSchema,items:z.array(NotificationHistoryEventSchema),nextBeforeId:EntityIdSchema.nullable(),sources:z.array(NotificationSourceObservationSchema),nextSourceBeforeId:EntityIdSchema.nullable(),pauseSource:NotificationSourceObservationSchema.nullable()}).strict();
export const NotificationReadSchema=z.object({id:EntityIdSchema,read:z.literal(true)}).strict();
export const NotificationLimitsSchema=z.object({requestTimeoutMs:notificationFields.requestTimeoutMs.removeDefault(),maxAttempts:notificationFields.maxAttempts.removeDefault(),retryMinMs:notificationFields.retryMinMs.removeDefault(),retryMaxMs:notificationFields.retryMaxMs.removeDefault(),jitterRatio:notificationFields.jitterRatio.removeDefault(),deliveryTtlMs:notificationFields.deliveryTtlMs.removeDefault(),maxPayloadBytes:notificationFields.maxPayloadBytes.removeDefault(),maxResponseBytes:notificationFields.maxResponseBytes.removeDefault()}).strict().refine(v=>v.retryMinMs<=v.retryMaxMs,'retry minimum exceeds maximum');
const channelName=z.string().min(1).max(128).refine(v=>v.trim().length>0&&!/[\u0000-\u001f]/.test(v),'invalid channel name');
const channelUrl=z.string().refine(v=>{try{const u=new URL(v);return new TextEncoder().encode(v).length<=8192&&['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.hash&&!u.hostname.split('.').some(label=>label.startsWith('xn--'));}catch{return false;}},'invalid or unsupported channel endpoint');
const channelSecret=z.string().refine(v=>{const n=new TextEncoder().encode(v).length;return n>=16&&n<=256;},'invalid signature byte length');
export const NotificationChannelSchema=z.object({id:EntityIdSchema,workspaceId:EntityIdSchema,name:channelName,kind:z.literal('webhook'),version:EntityIdSchema,enabled:z.boolean(),origin:origin.nullable(),status:z.enum(['available','unavailable','disabled']),limits:NotificationLimitsSchema,appliesTo:z.literal('new-deliveries'),keyState:z.enum(['available','unavailable','not-checked']),reasonCodes:z.array(z.enum(['unsupported-origin','channel-key-unavailable']))}).strict().refine(v=>v.origin!==null||v.status!=='available','available channels require a supported canonical origin').refine(v=>{
  const expected:string[]=[];if(v.keyState==='unavailable')expected.push('channel-key-unavailable');if(v.origin===null)expected.push('unsupported-origin');
  return (v.enabled?v.keyState!=='not-checked':v.keyState==='not-checked')&&v.status===(v.enabled?v.keyState==='available'&&v.origin!==null?'available':'unavailable':'disabled')&&new Set(v.reasonCodes).size===v.reasonCodes.length&&v.reasonCodes.length===expected.length&&v.reasonCodes.every(reason=>expected.includes(reason));
},'channel status, independent material state and reasons must agree');
export const NotificationChannelPageSchema=z.object({items:z.array(NotificationChannelSchema)}).strict();
export const NotificationChannelCreateSchema=z.object({expectedVersion:z.literal('0'),name:channelName,url:channelUrl,hmacSecret:channelSecret,enabled:z.boolean(),limits:NotificationLimitsSchema.optional()}).strict();
export const NotificationChannelUpdateSchema=z.object({expectedVersion:ConfigVersionSchema,name:channelName.optional(),url:channelUrl.optional(),hmacSecret:channelSecret.optional(),enabled:z.boolean().optional(),limits:NotificationLimitsSchema.optional()}).strict();
export type NotificationEvent=z.infer<typeof NotificationEventSchema>;
export type NotificationPage=z.infer<typeof NotificationPageSchema>;
export type NotificationHistoryPage=z.infer<typeof NotificationHistoryPageSchema>;
export type NotificationSourceObservation=z.infer<typeof NotificationSourceObservationSchema>;
export type NotificationDelivery=z.infer<typeof NotificationDeliverySchema>;
export type NotificationChannel=z.infer<typeof NotificationChannelSchema>;
export type NotificationChannelCreate=z.infer<typeof NotificationChannelCreateSchema>;
export type NotificationChannelUpdate=z.infer<typeof NotificationChannelUpdateSchema>;
export type NotificationLimits=z.infer<typeof NotificationLimitsSchema>;
