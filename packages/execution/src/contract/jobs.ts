import { z } from "zod";
import { ConfigVersionSchema, RunConfigSchema, PolicyConfigSchema } from "./config.js";
import { ExecutionSnapshotSchema } from "./assets.js";
import { MaterialSelectionSchema } from "./materials.js";
import { NetworkConfigurationSchema, NetworkSelectionSchema } from "@apicc/core/schema";
import { DebugSessionHandleSchema } from "./task.js";
import { StressCompiledBindingSchema } from "./stress.js";
import { EntityIdSchema, HashSchema, OpaqueIdSchema, ServerProjectScopeSchema, TaskTargetSchema, ScriptRequirementSchema, ExecutionProfileSchema, DispatchKindSchema, checkScriptGrant } from "./task.js";

/** Fixed data-path metadata. Credential values and attachment/report bytes use dedicated APIs. */
export const FixedMaterialSelectionSchema = MaterialSelectionSchema.superRefine((selection, ctx) => {
  if (selection.credentials.some(ref => ref.version === undefined)) ctx.addIssue({ code: "custom", path: ["credentials"], message: "submitted credentials require fixed versions" });
  for (const key of ["credentials", "attachments"] as const) {
    if (new Set(selection[key].map(ref => ref.refId)).size !== selection[key].length) ctx.addIssue({ code: "custom", path: [key], message: "duplicate material reference" });
  }
  for (const [path, selected] of Object.entries(selection.attachmentPaths ?? {})) {
    if (!selection.attachments.some(ref => ref.refId === selected.refId && ref.version === selected.version && ref.hash === selected.hash)) ctx.addIssue({ code: "custom", path: ["attachmentPaths", path], message: "attachment path must reference an exactly selected attachment" });
  }
});
export const JobPreparationSchema = z.object({
  stressBinding: StressCompiledBindingSchema.optional(),
  scope: ServerProjectScopeSchema, manifestHash: HashSchema,
  scriptPlanDigest: HashSchema, scriptGrantVersion: ConfigVersionSchema.optional(),
  scriptRequirements: z.array(ScriptRequirementSchema), executionProfile: ExecutionProfileSchema,
  dispatchKind: DispatchKindSchema, requiredCoreBuildId: HashSchema,
  requiredCapabilities: z.array(OpaqueIdSchema).refine(values => new Set(values).size === values.length, "duplicate capability"),
  runtimeCompatibilityId: OpaqueIdSchema,
}).strict().superRefine((value, ctx) => {
  checkScriptGrant(value, ctx);
  if (value.executionProfile === "no-script" && (value.scriptRequirements.length || value.scriptGrantVersion !== undefined)) ctx.addIssue({ code: "custom", path: ["scriptRequirements"], message: "no-script declaration cannot include scripts or grants" });
  if (value.executionProfile === "trusted-core-script" && !value.scriptRequirements.length) ctx.addIssue({ code: "custom", path: ["scriptRequirements"], message: "trusted-script declaration requires actual scripts" });
});
export const FixedNetworkInputSchema = z.object({ revision: OpaqueIdSchema, configuration: NetworkConfigurationSchema, selection: NetworkSelectionSchema.optional() }).strict();
export const SubmitJobSchema = z.object({
  intentId: OpaqueIdSchema, agentId: EntityIdSchema, snapshotId: EntityIdSchema, target: TaskTargetSchema,
  environmentId: z.string().uuid().optional(), debugSessionId: OpaqueIdSchema.optional(),
  runConfig: RunConfigSchema, materials: FixedMaterialSelectionSchema, preparation: JobPreparationSchema, network: FixedNetworkInputSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.materials.projectId !== value.preparation.scope.projectId) ctx.addIssue({ code: "custom", path: ["materials"], message: "material scope mismatch" });
  if (value.preparation.dispatchKind === "shared-debug" && (value.target.kind !== "debug" || value.preparation.executionProfile !== "no-script")) ctx.addIssue({ code: "custom", path: ["preparation", "dispatchKind"], message: "shared dispatch requires no-script debug" });
  if (value.debugSessionId && value.target.kind !== "debug") ctx.addIssue({ code: "custom", path: ["debugSessionId"], message: "debug session is only valid for debug targets" });
  if (value.target.kind !== "stress" && value.runConfig.stress !== undefined) ctx.addIssue({ code: "custom", path: ["runConfig", "stress"], message: "stress run settings require a stress target" });
  if (value.target.kind === "stress") {
    if (value.environmentId !== undefined && value.target.plan.environmentId !== undefined && value.environmentId !== value.target.plan.environmentId) ctx.addIssue({ code: "custom", path: ["environmentId"], message: "stress plan environment conflicts with outer environment" });
    if ((value.runConfig.stress?.workerCount ?? 1) > value.target.plan.maxVus) ctx.addIssue({ code: "custom", path: ["runConfig", "stress", "workerCount"], message: "stress workers exceed plan maxVus" });
    const b = value.preparation.stressBinding, p = value.target.plan, workers = value.runConfig.stress?.workerCount ?? 1;
    if (!b) ctx.addIssue({ code: "custom", path: ["preparation", "stressBinding"], message: "stress requires a fixed compiled binding" });
    else if (b.reservation.vus !== p.maxVus || b.reservation.processes !== (workers === 1 ? 1 : workers + 1)
      || b.requested.maxRequestConcurrency !== (p.maxRequestConcurrency ?? null) || b.requested.maxRps !== (p.maxRps ?? null)) ctx.addIssue({ code: "custom", path: ["preparation", "stressBinding"], message: "stress binding disagrees with original plan or worker topology" });
  } else if (value.preparation.stressBinding !== undefined) {
    ctx.addIssue({ code: "custom", path: ["preparation", "stressBinding"], message: "compiled stress binding requires a stress target" });
  }
});
export const ExecutionInputsSchema = z.object({
  stressBinding: StressCompiledBindingSchema.optional(),
  stressExecutor: z.object({ id: EntityIdSchema, name: z.string().max(512) }).strict().optional(),
  executionId: EntityIdSchema, snapshot: ExecutionSnapshotSchema, policy: PolicyConfigSchema,
  runConfig: RunConfigSchema, materials: FixedMaterialSelectionSchema, inputsDigest: HashSchema,
  network: FixedNetworkInputSchema.optional(), debugSession: DebugSessionHandleSchema.extend({ hostSessionId: OpaqueIdSchema }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.materials.projectId !== value.snapshot.assets.projectId) ctx.addIssue({ code: "custom", path: ["materials"], message: "fixed input scope mismatch" });
  const b = value.stressBinding, workers = value.runConfig.stress?.workerCount ?? 1;
  if (Boolean(b) !== Boolean(value.stressExecutor)) ctx.addIssue({ code: "custom", path: ["stressExecutor"], message: "fixed stress executor and binding must be present together" });
  if (value.runConfig.stress && !b) ctx.addIssue({ code: "custom", path: ["stressBinding"], message: "fixed stress inputs require a compiled binding" });
  if (b && b.reservation.processes !== (workers === 1 ? 1 : workers + 1)) ctx.addIssue({ code: "custom", path: ["stressBinding"], message: "fixed stress topology mismatch" });
});
export type SubmitJob = z.infer<typeof SubmitJobSchema>;
export type ExecutionInputs = z.infer<typeof ExecutionInputsSchema>;
/** SHA-256 this UTF-8 text in the host, then compare inputsDigest before requesting a permit. */
export function executionInputsDigestText(raw: unknown): string {
  const { inputsDigest: _digest, ...fixed } = ExecutionInputsSchema.parse(raw);
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)])) : value;
  return JSON.stringify(canonical(fixed));
}
