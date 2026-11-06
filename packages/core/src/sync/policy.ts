import { defaultSyncPolicyValues, SyncDeploymentLimitsSchema, SyncPolicySchema, SyncPolicyValuesSchema, type SyncDeploymentLimits, type SyncEffectivePolicy, type SyncPolicy, type SyncPolicyValues } from "./types.js";

/** Structural wire checks are generated separately; these are explicit cross-field rules. */
export function resolveSyncPolicy(
  requested: SyncPolicy,
  deployment: SyncDeploymentLimits,
  inherited?: SyncEffectivePolicy,
): SyncEffectivePolicy {
  const policyResult = SyncPolicySchema.safeParse(requested);
  const deploymentResult = SyncDeploymentLimitsSchema.safeParse(deployment);
  if (!policyResult.success || !deploymentResult.success) throw new Error("SYNC_POLICY_INVALID");
  const saved = policyResult.data;
  const sources = {} as SyncEffectivePolicy["sources"];
  const selected: Partial<SyncPolicyValues> = {};
  for (const field of Object.keys(defaultSyncPolicyValues) as (keyof SyncPolicyValues)[]) {
    const explicit = saved[field];
    if (explicit !== undefined && inherited && explicit > inherited.policy[field]) throw new Error("SYNC_POLICY_INVALID");
    selected[field] = explicit ?? inherited?.policy[field] ?? defaultSyncPolicyValues[field];
    sources[field] = explicit !== undefined ? saved.scope : inherited?.sources[field] ?? "default";
  }
  const policy = SyncPolicyValuesSchema.parse(selected);
  const limits = inherited ? {
    maxWireBytes: Math.min(deploymentResult.data.maxWireBytes, inherited.deploymentLimits.maxWireBytes),
    envelopeReserveBytes: Math.max(deploymentResult.data.envelopeReserveBytes, inherited.deploymentLimits.envelopeReserveBytes),
  } : deploymentResult.data;
  if (limits.envelopeReserveBytes >= limits.maxWireBytes
    || policy.maxCompareInputBytes > limits.maxWireBytes - limits.envelopeReserveBytes
    || policy.maxCompareOutputBytes > limits.maxWireBytes - limits.envelopeReserveBytes
    || policy.maxSourceBytes > policy.maxCompareInputBytes
    || policy.connectTimeoutMs > policy.urlDeadlineMs || policy.connectTimeoutMs > policy.gitDeadlineMs
    || policy.projectConcurrency > policy.hostConcurrency) throw new Error("SYNC_POLICY_INVALID");
  return { policy, savedRevision: saved.revision, deploymentLimits: limits, sources, appliesTo: "next-check" };
}
