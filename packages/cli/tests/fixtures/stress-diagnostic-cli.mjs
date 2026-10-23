// Test-only entry: same built CLI and real workers; persist only selected fixed diagnostics.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDefaultRegistry, StressRunner } from "@apicc/core";
import { runCli } from "../../dist/main.js";
import { spawnLocalStressWorker } from "../../dist/stressWorkerTransport.js";

const destination = process.env.APICC_TEST_STRESS_DIAGNOSTICS;
if (!destination) throw new Error("Missing synthetic diagnostic destination");
const diagnostics = { formatVersion: 1, runs: [], workers: [] };
const persist = () => writeFileSync(destination, JSON.stringify(diagnostics, null, 2));
const original = StressRunner.prototype.run;
StressRunner.prototype.run = function (options) {
  // Existing stress-worker.test.ts probe pattern. Nothing is patched in a production entry.
  const runSchedule = this.opts.runSchedule;
  if (runSchedule) this.opts.runSchedule = async (schedule, execution) => {
    const summary = await runSchedule(schedule, execution);
    diagnostics.runs.push({ runId: execution.runId, completeness: summary.completeness,
      timeline: { aligned: summary.timeline.aligned, uncertaintyMs: summary.timeline.uncertaintyMs } });
    persist();
    return summary;
  };
  return original.call(this, options);
};
try {
  process.exitCode = await runCli(process.argv.slice(2), createDefaultRegistry(), console.log, {
    spawnLocalStressWorker: async (identity, timeoutMs) => {
      const channel = spawnLocalStressWorker([fileURLToPath(new URL("../../dist/bin.js", import.meta.url)),
        "stress-plan-worker", "--run-id", identity.runId, "--worker-id", identity.workerId], timeoutMs);
      const waitForExit = channel.waitForExit.bind(channel);
      let recorded = false;
      const recordExit = async () => {
        const exit = await waitForExit();
        if (!recorded) { recorded = true; diagnostics.workers.push({ ...identity, code: exit.code, signal: exit.signal }); persist(); }
        return exit;
      };
      // Do not call waitForExit early: it changes the transport's shutdownExpected state.
      channel.waitForExit = recordExit;
      const close = channel.close.bind(channel);
      channel.close = async () => { await close(); await recordExit(); };
      return channel;
    },
  });
} finally {
  StressRunner.prototype.run = original;
  persist();
}
