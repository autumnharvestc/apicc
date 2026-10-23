import { serveLocalStressWorker, legacyStressMetricPlan, createExecutionEvidenceCollector } from "@apicc/core";
import { processStressWorkerChannel } from "../../dist/stressWorkerTransport.js";
const mode = process.argv[2], channel = processStressWorkerChannel();
const finish = channel.finish.bind(channel);
let releaseExit;
const exitFence = new Promise((resolve) => { releaseExit = resolve; });
if (mode === "fenced") channel.finish = async () => { await exitFence; await finish(); };
const send = channel.send.bind(channel);
const subscribe = channel.subscribe.bind(channel);
channel.subscribe = (listener) => subscribe((value) => {
  if (mode === "fenced" && value.kind === "release-exit") { releaseExit(); return; }
  const frame = JSON.parse(value.data);
  if (mode.startsWith("early-") && frame.kind === "request" && frame.command.type === "shutdown") return;
  listener(value);
});
channel.send = (value) => {
  const result = send(value);
  const frame = JSON.parse(value.data);
  if (frame.kind === "response" && frame.value?.type === "evidence" && mode.startsWith("early-")) {
    setImmediate(() => process.exit(mode === "early-zero" ? 0 : 7));
  }
  return result;
};
serveLocalStressWorker(channel, { runId: "exit-run", workerId: "worker-1" }, async () => ({
  clock: { now: () => performance.now(), wallNow: () => Date.now(), sleep: async () => {} }, metricPlan: legacyStressMetricPlan,
  evidence: createExecutionEvidenceCollector({ projectId: "p", definitionRevision: "r" }, [], { privateMarkers: true }),
  host: { createVu: async () => ({ execute: async () => ({ state: "passed", durationMs: 1 }), close: async () => {} }) },
}));
