import { DatabaseSync } from "node:sqlite";
import { bindPreparedStressExecution, collectCredentialMarkersForRequests, selectCredentialRequests, createExecutionEvidenceCollector, createPreparedStressHost, serveLocalStressWorker, type StressWorkerRuntime } from "@apicc/core";
import { createExecutionRegistry, localStressClock, localStressClockDomain, processStressWorkerChannel, assertStressExecutionDeadline } from "@apicc/execution/host";
import { readBuildIdentity } from "@apicc/execution/buildIdentity";
import { withInvocation, validateRuntime, validatePermit, type InvocationDTO, type StartPermit } from "./invocationContext.js";
import type { ChildLease } from "./ledger.js";

interface FixedWorkerConfiguration { dto: InvocationDTO; permit: StartPermit; lease?: ChildLease }
const identity = { runId: process.argv[2]!, workerId: process.argv[3]! };
let lease: DatabaseSync | undefined;
let release: (() => void) | undefined, lifetime: Promise<void> | undefined;
let registry: ReturnType<typeof createExecutionRegistry> | undefined;
let deadline: ReturnType<typeof setTimeout> | undefined;
const cleanup = async () => { clearTimeout(deadline); await registry?.close(); release?.(); await lifetime; };
const peer = serveLocalStressWorker(processStressWorkerChannel(), identity, async (raw, signal) => {
  const configuration = raw as FixedWorkerConfiguration;
  const { dto, permit } = configuration;
  validateRuntime(dto.task, await readBuildIdentity(), dto.runtimeCompatibilityId);
  if (configuration.lease) {
    lease = new DatabaseSync(configuration.lease.file, { readOnly: true }); lease.exec("PRAGMA busy_timeout=0; BEGIN");
    const row = lease.prepare("SELECT value FROM epoch WHERE id=1").get() as { value: string } | undefined;
    if (row?.value !== configuration.lease.epoch) throw new Error("Expired supervision epoch");
  }
  let resolveReady!: (runtime: StressWorkerRuntime) => void, rejectReady!: (error: unknown) => void;
  const ready = new Promise<StressWorkerRuntime>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const held = new Promise<void>(resolve => { release = resolve; });
  lifetime = withInvocation(dto, signal, async (metadata, materials) => {
    validatePermit(dto, metadata, permit);
    const prepared = metadata.project.prepared;
    if (prepared.target.kind !== "stress" || !dto.deadlineAt) throw new Error("Missing fixed stress deadline");
    assertStressExecutionDeadline(prepared, dto.deadlineAt - Date.now());
    deadline = setTimeout(() => { void cleanup().finally(() => process.exit(1)); }, Math.max(1, dto.deadlineAt - Date.now()));
    registry = createExecutionRegistry({ profile: prepared.profile, scriptTimeoutMs: prepared.scriptTimeoutMs });
    const markers = [...collectCredentialMarkersForRequests(prepared.snapshot.project, selectCredentialRequests(prepared.snapshot, prepared.selections), materials.credentialBindings), ...(materials.network?.outputMarkers ?? [])];
    const evidence = createExecutionEvidenceCollector({ projectId: prepared.snapshot.project.id, definitionRevision: prepared.snapshot.definitionRevision, environmentId: prepared.environmentId, dataDigest: materials.preparedTestData!.digest }, markers,
      { privateMarkers: true, maxSamples: prepared.stressPlan!.metricPlan.evidence.maxSamples, limits: prepared.evidenceLimits });
    const execution = bindPreparedStressExecution(prepared.stressPlan!, { snapshot: prepared.snapshot, credentialBindings: materials.credentialBindings, preparedTestData: materials.preparedTestData, network: materials.network });
    const host = createPreparedStressHost(execution, { registry, evidence, workspaceRoot: materials.workspaceRoot, requestSettings: prepared.requestSettings }, { confirmedTargetOrigins: prepared.stressRunConfig!.confirmedTargetOrigins });
    resolveReady({ clock: localStressClock, metricPlan: execution.compiled.metricPlan, lifecycle: prepared.target.plan.lifecycle, evidence,
      host: { ...host, async closeRun() { await host.closeRun?.(); await registry?.close(); release?.(); } } });
    await held;
  }, undefined, dto.minFreeDiskBytes).catch(error => { rejectReady(error); });
  return ready;
}, localStressClockDomain);
process.once("disconnect", () => { void peer.close().finally(cleanup); });
