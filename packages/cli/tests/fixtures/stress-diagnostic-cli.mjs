// Test-only entry: same built CLI and real workers; persist only selected fixed diagnostics.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDefaultRegistry, StressRunner } from "@apicc/core";
import { runCli } from "../../dist/main.js";
import { spawnLocalStressWorker } from "../../dist/stressWorkerTransport.js";
import { createDiagnosticRecorder } from "../helpers/stressDiagnosticTrace.mjs";

const destination = process.env.APICC_TEST_STRESS_DIAGNOSTICS;
if (!destination) throw new Error("Missing synthetic diagnostic destination");
const recorder = createDiagnosticRecorder();
const observe = (work) => { try { work(); } catch { /* Never replace a CLI/worker failure with a diagnostic failure. */ } };
// One bounded write at the end: synchronous per-event IO would perturb the timing being observed.
const persist = () => observe(() => writeFileSync(destination, JSON.stringify(recorder.snapshot())));
const original = StressRunner.prototype.run;
StressRunner.prototype.run = function (options) {
  // Existing stress-worker.test.ts probe pattern. Nothing is patched in a production entry.
  const runSchedule = this.opts.runSchedule;
  if (runSchedule) this.opts.runSchedule = async (schedule, execution) => {
    const finish = execution.metrics.finish;
    execution.metrics.finish = function (context) {
      observe(() => recorder.windows(execution.runId, context.phaseWindows));
      return finish.call(this, context);
    };
    try {
      const summary = await runSchedule(schedule, execution);
      observe(() => recorder.summary(execution.runId, summary));
      return summary;
    } finally { execution.metrics.finish = finish; }
  };
  return original.call(this, options);
};
try {
  process.exitCode = await runCli(process.argv.slice(2), createDefaultRegistry(), console.log, {
    spawnLocalStressWorker: async (identity, timeoutMs) => {
      const channel = spawnLocalStressWorker([fileURLToPath(new URL("../../dist/bin.js", import.meta.url)),
        "stress-plan-worker", "--run-id", identity.runId, "--worker-id", identity.workerId], timeoutMs);
      const tap = recorder.tap(identity);
      const send = channel.send.bind(channel), subscribe = channel.subscribe.bind(channel);
      channel.send = (value) => { observe(() => tap("send", value, performance.now())); return send(value); };
      channel.subscribe = (listener) => subscribe((value) => { observe(() => tap("receive", value, performance.now())); return listener(value); });
      const waitForExit = channel.waitForExit.bind(channel);
      let recorded = false;
      const recordExit = async () => {
        const exit = await waitForExit();
        if (!recorded) { recorded = true; observe(() => recorder.exit(identity, exit)); }
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
