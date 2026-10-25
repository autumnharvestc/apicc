import { createExecutionEvidenceCollector, legacyStressMetricPlan, serveLocalStressWorker } from "@apicc/core";
import { localStressClock } from "../../dist/stressPlanCommand.js";
import * as transport from "../../dist/stressWorkerTransport.js";

const identity = { runId: process.argv[2], workerId: process.argv[3] };
const injected = process.argv[4] === "injected";
const clock = injected ? { ...localStressClock } : localStressClock;
const peer = serveLocalStressWorker(transport.processStressWorkerChannel(), identity, async () => ({
  clock, metricPlan: legacyStressMetricPlan,
  evidence: createExecutionEvidenceCollector({ projectId: "p", definitionRevision: "r" }, [], { privateMarkers: true }),
  host: { async createVu(_id, _inputs, host) { return {
    async execute(context) {
      host.observe({ kind: "case", ...context.observation(), vuId: context.vuId, iterationId: context.iterationId, stageId: null,
        ok: true, status: 200, requestStarted: true, requestCompleted: true, failureKind: null,
        requestTimeMs: 1, scriptTimeMs: 0, iterationTimeMs: 1,
        locator: { collectionId: "c", folderIds: [], apiId: "a", caseId: "x", scope: "base" }, nodeKey: null });
      return { state: "passed", durationMs: 1 };
    }, async close() {},
  }; } },
}), transport.localStressClockDomain);
process.once("disconnect", () => { void peer.close(); });
