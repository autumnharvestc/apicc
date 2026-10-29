import { z } from "zod";
import { StressPlanSchema } from "@apicc/core/schema";
import type { AgentConfig, PolicyConfig, ConfigSource } from "./config.js";

/** Project-safe compilation input. No unrelated slots, caches or supervision defaults are invented. */
export interface StressAdmissionConfiguration {
  agent: Pick<AgentConfig, "maxConcurrentStressJobs" | "maxStressProcesses" | "maxStressVus" | "maxStressRequestConcurrency" | "maxStressRps" | "maxStressMetricMemoryBytes">;
  policy: PolicyConfig;
  sources: Record<string, ConfigSource>;
}

/** Per-intent confirmation only; callers bind this to location/environment/snapshot. */
const OriginWireSchema = z.string().regex(/^https?:\/\/[^\s\/?#@]+$/);
const OriginSchema = OriginWireSchema.refine(value => {
  try { const url = new URL(value); return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value; }
  catch { return false; }
}, "expected canonical HTTP(S) origin").meta({ apiccJsonWireSchema: OriginWireSchema });
export const StressRunConfigSchema = z.object({ workerCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(1), confirmedTargetOrigins: z.array(OriginSchema).default([]) }).strict();
export type StressRunConfig = z.infer<typeof StressRunConfigSchema>;
export interface StressReservation { jobs: number; processes: number; vus: number; requestConcurrency: number; maxRps: number; metricMemoryBytes: number; }
export interface StressAdmission {
  stage: "admission-limits"; runConfig: StressRunConfig; effectiveWorkerLimit: number;
  requested: { maxRequestConcurrency: number | null; maxRps: number | null };
  effective: { maxRequestConcurrency: number; maxRps: number };
  sources: { maxRequestConcurrency: string; maxRps: string };
  reservation: StressReservation;
}
/** Administrative admission bounds, before Core snapshot/workflow compilation.
 * Request concurrency/RPS reservations are upper bounds, not observed or compiled load.
 * The host must intersect Core project policy and freeze the true compiled limits.
 */
export function resolveStressExecutionConfig(rawPlan: unknown, rawRun: unknown, config: StressAdmissionConfiguration): StressAdmission {
  const plan = StressPlanSchema.parse(rawPlan);
  const runConfig = StressRunConfigSchema.parse(rawRun ?? {});
  const { agent, policy } = config;
  const processes = runConfig.workerCount === 1 ? 1 : runConfig.workerCount + 1;
  const requestLimit = Math.min(agent.maxStressRequestConcurrency, policy.maxStressRequestConcurrency);
  const rpsLimit = Math.min(agent.maxStressRps, policy.maxStressRps);
  const processCapacity = Math.min(agent.maxStressProcesses, Math.floor(agent.maxStressMetricMemoryBytes / policy.stressMetricMemoryBytes));
  if (agent.maxConcurrentStressJobs === 0) throw new Error("stress job capacity is paused");
  if (processes > agent.maxStressProcesses) throw new Error("stress process capacity exceeded");
  if (runConfig.workerCount > policy.maxStressWorkers) throw new Error("stress worker policy exceeded");
  if (runConfig.workerCount > plan.maxVus) throw new Error("stress workers exceed plan maxVus");
  if (plan.maxVus > Math.min(agent.maxStressVus, policy.maxStressVus)) throw new Error("stress VU capacity exceeded");
  if (plan.maxRequestConcurrency !== undefined && plan.maxRequestConcurrency > requestLimit) throw new Error("stress request concurrency capacity exceeded");
  if (plan.maxRps !== undefined && plan.maxRps > rpsLimit) throw new Error("stress request RPS capacity exceeded");
  if (processes * policy.stressMetricMemoryBytes > agent.maxStressMetricMemoryBytes) throw new Error("stress numeric memory capacity exceeded");
  const source = (field: "maxStressRequestConcurrency" | "maxStressRps") => {
    const section = agent[field] < policy[field] ? "agent" : "policy";
    return `${section}.${field}:${config.sources[`${section}.${field}`]}`;
  };
  return { stage: "admission-limits", runConfig,
    effectiveWorkerLimit: Math.min(policy.maxStressWorkers, plan.maxVus, processCapacity <= 2 ? 1 : processCapacity - 1),
    requested: { maxRequestConcurrency: plan.maxRequestConcurrency ?? null, maxRps: plan.maxRps ?? null },
    effective: { maxRequestConcurrency: plan.maxRequestConcurrency ?? requestLimit, maxRps: plan.maxRps ?? rpsLimit },
    sources: { maxRequestConcurrency: plan.maxRequestConcurrency === undefined ? source("maxStressRequestConcurrency") : "plan", maxRps: plan.maxRps === undefined ? source("maxStressRps") : "plan" },
    reservation: { jobs: 1, processes, vus: plan.maxVus, requestConcurrency: plan.maxRequestConcurrency ?? requestLimit, maxRps: plan.maxRps ?? rpsLimit, metricMemoryBytes: processes * policy.stressMetricMemoryBytes },
  };
}
const positiveCount = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const StressReservationSchema = z.object({ jobs: z.literal(1), processes: positiveCount, vus: positiveCount.max(1000), requestConcurrency: positiveCount.max(1000), maxRps: z.number().finite().positive(), metricMemoryBytes: positiveCount }).strict();
/** Fixed declaration, independently recomputed by the execution host before requesting a permit. */
const StressCompiledBindingWireSchema = z.object({ stage: z.literal("compiled-limits"),
  admissionLimits: z.object({ maxVus: positiveCount.max(1000), maxRequestConcurrency: positiveCount.max(1000), maxRps: z.number().finite().positive() }).strict(),
  requested: z.object({ maxRequestConcurrency: positiveCount.max(1000).nullable(), maxRps: z.number().finite().positive().nullable() }).strict(),
  sources: z.object({ maxRequestConcurrency: z.string().min(1), maxRps: z.string().min(1) }).strict(),
  evidenceMaxSamples: positiveCount.max(20), numericMemoryBytes: positiveCount.min(1048576).max(67108864),
  reservation: StressReservationSchema,
}).strict();
export const StressCompiledBindingSchema = StressCompiledBindingWireSchema.superRefine((binding, ctx) => {
  const r = binding.reservation;
  if (r.vus > binding.admissionLimits.maxVus || r.requestConcurrency > binding.admissionLimits.maxRequestConcurrency || r.maxRps > binding.admissionLimits.maxRps) ctx.addIssue({ code: "custom", path: ["reservation"], message: "compiled reservation exceeds admission limits" });
  if (r.metricMemoryBytes !== r.processes * binding.numericMemoryBytes) ctx.addIssue({ code: "custom", path: ["reservation", "metricMemoryBytes"], message: "numeric reservation must cover every execution process" });
}).meta({ apiccJsonWireSchema: StressCompiledBindingWireSchema });
export type StressCompiledBinding = z.infer<typeof StressCompiledBindingSchema>;

const observedCount=z.number().int().min(0).max(1001);
/** Optional ownership facts; absent means not collected, never a synthetic zero. */
export const StressProcessObservationSchema=z.object({completeness:z.enum(['complete','partial']),started:observedCount,exited:observedCount,peak:observedCount}).strict().refine(value=>value.exited<=value.started&&value.peak<=value.started,'observed exits and peak cannot exceed actual starts');
export type StressProcessObservation=z.infer<typeof StressProcessObservationSchema>;
export const processObservationFitsBudget=(value:StressProcessObservation,budget:number)=>value.started<=budget&&(value.completeness!=='complete'||value.started===budget);
export const StressContentionHintSchema=z.object({code:z.literal('shared-agent-capacity'),jobLimit:positiveCount,stressJobLimit:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),activeOtherJobs:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)}).strict();
export const StressCapacityDimensionSchema=z.enum(['jobs','processes','vus','requestConcurrency','maxRps','metricMemoryBytes']);
const capacityCount=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const CapacityVectorSchema=z.object({jobs:capacityCount,processes:capacityCount,vus:capacityCount,requestConcurrency:capacityCount,maxRps:z.number().finite().min(0),metricMemoryBytes:capacityCount}).strict();
export const StressCapacitySchema=z.object({used:CapacityVectorSchema,limits:CapacityVectorSchema,drainingDimensions:z.array(StressCapacityDimensionSchema).max(6)}).strict();
export const StressCapacityWaitSchema=z.object({dimension:StressCapacityDimensionSchema,used:z.number().finite().min(0),requested:z.number().finite().min(0),limit:z.number().finite().min(0),draining:z.boolean()}).strict();
