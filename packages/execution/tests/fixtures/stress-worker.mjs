import { createProjectSnapshot, bindPreparedStressExecution, createExecutionEvidenceCollector, collectCredentialMarkersForRequests, selectCredentialRequests, createPreparedStressHost, serveLocalStressWorker } from "@apicc/core";
import { prepareExecution, createExecutionRegistry, processStressWorkerChannel, localStressClock, localStressClockDomain } from "../../dist/host/index.js";

const identity = { runId: process.argv[2], workerId: process.argv[3] };
const peer = serveLocalStressWorker(processStressWorkerChannel(), identity, async configuration => {
  const prepared = prepareExecution({ snapshot: createProjectSnapshot(configuration.project), target: { kind: "stress", plan: configuration.plan }, profile: "no-script", requestSettings: configuration.requestSettings });
  const credentialBindings = { versions: configuration.credentialVersions, resolve: () => configuration.token };
  const execution = bindPreparedStressExecution(prepared.stressPlan, { snapshot: prepared.snapshot, credentialBindings, preparedTestData: configuration.data });
  const registry = createExecutionRegistry({ profile: prepared.profile });
  const markers = collectCredentialMarkersForRequests(prepared.snapshot.project, selectCredentialRequests(prepared.snapshot, prepared.selections), credentialBindings);
  const evidence = createExecutionEvidenceCollector({ projectId: prepared.snapshot.project.id, definitionRevision: prepared.snapshot.definitionRevision, dataDigest: configuration.data.digest }, markers, { privateMarkers: true });
  const host = createPreparedStressHost(execution, { registry, evidence, requestSettings: prepared.requestSettings });
  return { clock: localStressClock, metricPlan: execution.compiled.metricPlan, lifecycle: configuration.plan.lifecycle, evidence,
    host: { ...host, async closeRun() { try { await host.closeRun?.(); } finally { await registry.close(); } } } };
}, localStressClockDomain);
process.once("disconnect", () => { void peer.close(); });
