import { afterAll, beforeAll, expect, it, onTestFinished, vi } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ExecutionLedger} from '../src/ledger.js';
import { defaultAgentConfig, executionInputsDigestText, resolveEffectiveConfig, type AgentMessageV1 } from "@apicc/execution/contract";
import { assertStressExecutionDeadline, prepareProjectFiles, spawnLocalStressWorker } from "@apicc/execution/host";
import { executeInvocation, withInvocation, type StartPermit } from "../src/invocationContext.js";
import { TaskSlots } from "../src/slots.js";
import { debugFixture, hash, stressFixture, stressHarness } from "./helpers/stressFixture.js";
import { alive, descendants } from "./helpers/processEvidence.js";
import { findStressWorkerProcesses, matchesStressWorkerProcess, readProcessIdentity, sameProcessIdentity, stressIntentsNeedingDiscovery } from "../src/processIdentity.js";

let server: Server, origin: string;
const requests: string[] = [];
const gates = new Set<ServerResponse>();
const markerPorts = new Map<number, string>();
beforeAll(async () => { server = createServer((request, response) => {
  const path = new URL(request.url!, "http://target").pathname;
  requests.push(path); response.setHeader("content-type", "text/plain");
  if (path.includes("marker-union")) {
    if (path.includes("fault") && requests.filter(value => value === path).length > 2) { gates.add(response); return; }
    if (!markerPorts.has(request.socket.remotePort!)) markerPorts.set(request.socket.remotePort!, markerPorts.size === 0 ? "private-worker-one" : "private-worker-two");
    response.setHeader("set-cookie", `session=${markerPorts.get(request.socket.remotePort!)}; Path=/`); response.statusCode = 500;
    response.end("private-worker-one private-worker-two");
  } else if (path.includes("hold-tree")) gates.add(response); else response.end("ok");
}); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`; });
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

it('final I2 records partial actual startup rather than the fixed three-process budget',async()=>{
  const item=await stressFixture(origin,982,2,'/partial-start'),h=stressHarness([item]),ledger=h.supervisor['ledger'],record=ledger.recordProcess.bind(ledger);let killed:number|undefined;
  const spy=vi.spyOn(ledger,'recordProcess').mockImplementation((executionId,value)=>{record(executionId,value);if(value.role==='coordinator'&&!value.exited&&!killed){expect(alive(value.pid)).toBe(true);killed=value.pid;process.kill(value.pid,'SIGKILL');}});
  const before=requests.length;
  try{h.supervisor.receive(item.delivery);await vi.waitFor(()=>expect(h.completed).toHaveLength(1),{timeout:10000});
    expect(killed).toBeDefined();expect(alive(killed!)).toBe(false);expect(requests.length).toBe(before);expect(h.completed[0]!.verdict).not.toBe('passed');
    expect(ledger.intents[0]!.processes).toHaveLength(1);expect(ledger.intents[0]!.processes![0]!.exited).toBe(true);
    expect((JSON.parse(h.supervisor.pendingReports()[0]!.text) as Record<string,unknown>).processObservation).toEqual({completeness:'partial',started:1,exited:1,peak:1});
  }finally{spy.mockRestore();await h.supervisor.close();}
});
it('final I2 retains the real simultaneous-live high water mark after all children exit and the ledger reopens',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'apicc-final-process-')),item=await stressFixture(origin,983,2),h=stressHarness([item],{},directory);
  try{h.supervisor.receive(item.delivery);await vi.waitFor(()=>expect(h.completed).toHaveLength(1),{timeout:10000});const rows=h.supervisor['ledger'].intents[0]!.processes!;expect(rows).toHaveLength(3);expect(rows.every(row=>row.exited&&!alive(row.pid))).toBe(true);await h.supervisor.close();
    const reopened=new ExecutionLedger(directory,'https://control.test/api/v1','7',item.config);try{expect((JSON.parse(reopened.reports[0]!.text) as Record<string,unknown>).processObservation).toEqual({completeness:'complete',started:3,exited:3,peak:3});}finally{reopened.close();}
  }finally{await h.supervisor.close();rmSync(directory,{recursive:true,force:true});}
});

it("final M2 retains the specific capacity rejection and exact report bytes until a matching archive receipt",async()=>{
  const first=await stressFixture(origin,980,2,"/hold-tree"),second=await stressFixture(origin,981,2,"/capacity-refused"),h=stressHarness([first,second],{maxConcurrentJobs:2,maxConcurrentStressJobs:2,maxStressProcesses:3});
  try{
    h.supervisor.receive(first.delivery);await vi.waitFor(()=>expect(requests.filter(path=>path==='/hold-tree').length).toBeGreaterThanOrEqual(2),{timeout:10000});
    const before=requests.filter(path=>path==='/capacity-refused').length;h.supervisor.receive(second.delivery);
    await vi.waitFor(()=>expect(h.completed.find(row=>row.executionId==='981')).toBeDefined(),{timeout:10000});
    const result=h.completed.find(row=>row.executionId==='981')!;expect(result.verdict).toBe('rejected');expect(result.executionFact).toBe('not-started');
    expect.soft(result.reasonCode).toBe('stress-capacity-exceeded');expect(requests.filter(path=>path==='/capacity-refused')).toHaveLength(before);
    expect(h.messages.some(message=>message.executionId==='981'&&message.kind==='start-request')).toBe(false);
    const report=h.supervisor.pendingReports().find(row=>row.executionId==='981')!;expect.soft(JSON.parse(report.text).reasonCode).toBe('stress-capacity-exceeded');
    h.supervisor.acknowledgeReport('981',{archived:true,reportHash:'0'.repeat(64),reportBytes:report.bytes});expect(h.supervisor.pendingReports().find(row=>row.executionId==='981')).toEqual(report);
    expect(hash(report.text)).toBe(report.hash);expect(Buffer.byteLength(report.text)).toBe(report.bytes);
    h.supervisor.acknowledgeReport('981',{archived:true,reportHash:report.hash,reportBytes:report.bytes});expect(h.supervisor.pendingReports().some(row=>row.executionId==='981')).toBe(false);
  }finally{for(const response of gates)response.end('ok');gates.clear();await h.supervisor.close();}
});

// Final I2: actual native ownership must reach the persisted safe result, not just a test artifact.
it.each([1, 2])("final I2 publishes actual process observations after %i workers really exit", async workers => {
  const item = await stressFixture(origin, 970 + workers, workers), h = stressHarness([item]);
  try {
    h.supervisor.receive(item.delivery);
    await vi.waitFor(() => expect(h.completed).toHaveLength(1), { timeout: 10000 });
    expect(h.completed[0]!.output).toMatchObject({ kind: "stress", result: { requests: { completed: 4 } } });
    const records = h.supervisor["ledger"].intents[0]!.processes!;
    const count = workers === 1 ? 1 : 3;
    expect(records).toHaveLength(count);
    expect(records.every(record => record.exited && !alive(record.pid))).toBe(true);
    const report = JSON.parse(h.supervisor.pendingReports()[0]!.text) as Record<string, unknown>;
    expect.soft(report.processObservation).toEqual({ completeness: "complete", started: count, exited: count, peak: count });
    const completed = h.messages.find(message => message.kind === "completed") as unknown as Record<string, unknown>;
    expect.soft(completed.processObservation).toEqual(report.processObservation);
    if (report.processObservation) expect(Object.keys(report.processObservation).sort()).toEqual(["completeness", "exited", "peak", "started"]);
  } finally { await h.supervisor.close(); }
});

it("retains uncertainty when an OS candidate's command line is unreadable", () => {
  const intent = { runId: "fixed-run", workerId: "worker-1", scriptPath: "fixed-worker.js" };
  expect(() => matchesStressWorkerProcess(undefined, intent)).toThrow();
});

it.each(["", " "])("excludes a successfully read empty Linux cmdline %j without classifying it as unknown", command => {
  const intent = { runId: "fixed-run", workerId: "worker-1", scriptPath: "fixed-worker.js" };
  let selected: boolean | undefined, unreadable = false;
  try { selected = matchesStressWorkerProcess(command, intent); } catch { unreadable = true; }
  expect({ selected, unreadable }).toEqual({ selected: false, unreadable: false });
});

it("rediscovers a registered worker intent whose PID has not acquired a verified OS identity", () => {
  const intent = { runId: "fixed-run", workerId: "worker-1", scriptPath: "fixed-worker.js" };
  const processes = new Map([["fixed-run/worker-1", { identity: undefined }]]);
  expect(stressIntentsNeedingDiscovery([intent], processes)).toEqual([intent]);
});

it("finds the exact pre-spawn worker identity after its coordinator exits before PID registration", async () => {
  const runId = randomUUID(), workerId = "worker-1";
  const parent = fork(new URL("./fixtures/stress-orphan-parent.mjs", import.meta.url), [runId, workerId], { execPath: process.execPath, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const exited = new Promise<void>(resolve => parent.once("exit", () => resolve()));
  let pid: number | undefined, birth: Awaited<ReturnType<typeof readProcessIdentity>>;
  try {
    pid = await new Promise<number>((resolve, reject) => { parent.once("message", value => resolve((value as { pid: number }).pid)); parent.once("error", reject); });
    birth = await readProcessIdentity(pid); expect(birth).toBeDefined();
    parent.kill("SIGKILL"); await exited; expect(alive(pid)).toBe(true);
    const found = await findStressWorkerProcesses({ runId, workerId, scriptPath: fileURLToPath(new URL("./fixtures/stress-orphan-worker.mjs", import.meta.url)) });
    expect(found.map(value => value.pid)).toEqual([pid]);
  } finally {
    parent.kill("SIGKILL"); await exited;
    if (pid && birth) { const current = await readProcessIdentity(pid); if (current && sameProcessIdentity(birth, current)) process.kill(pid, "SIGKILL"); await vi.waitFor(() => expect(alive(pid!)).toBe(false)); }
  }
});

it("records the fixed worker spawn intents before acknowledging actual PID registration", async () => {
  const item = await stressFixture(origin, 955), h = stressHarness([item]);
  try {
    h.supervisor.receive(item.delivery); await vi.waitFor(() => expect(h.completed).toHaveLength(1), { timeout: 10000 });
    expect(h.completed[0]!.output).toMatchObject({ kind: "stress", result: { requests: { completed: 4 } } });
    const intents = (h.supervisor["ledger"].intents[0] as unknown as { processIntents?: Array<{ runId: string; workerId: string; epoch: string }> }).processIntents ?? [];
    expect(intents.filter(value => value.workerId !== "coordinator").map(value => value.workerId).sort()).toEqual(["worker-1", "worker-2"]);
  } finally { await h.supervisor.close(); }
});

it("persists the stress coordinator spawn identity as well as each worker before settlement", async () => {
  const item = await stressFixture(origin, 956), h = stressHarness([item]);
  try {
    h.supervisor.receive(item.delivery); await vi.waitFor(() => expect(h.completed).toHaveLength(1), { timeout: 10000 });
    expect(h.completed[0]!.output).toMatchObject({ kind: "stress", result: { requests: { completed: 4 } } });
    const intents = h.supervisor["ledger"].intents[0]!.processIntents!;
    expect(intents.filter(intent => intent.workerId === "coordinator")).toHaveLength(1);
  } finally { await h.supervisor.close(); }
});

it("reads an actual OS process creation identity rather than trusting only its PID", async () => {
  const identity = await readProcessIdentity(process.pid);
  expect(identity).toMatchObject({ pid: process.pid, parentPid: expect.any(Number), birth: expect.any(String), executable: process.execPath });
});

it.each([{ pid: 124 }, { birth: "replacement" }, { executable: "different-node" }])("refuses cleanup authority for a changed actual process identity %j", changed => {
  const held = { pid: 123, parentPid: 12, birth: "original", executable: "controlled-node", commandLine: "fixed-worker" };
  expect(sameProcessIdentity(held, { ...held, ...changed })).toBe(false);
});
it("does not mistake reparenting for a replacement OS process", () => {
  const held = { pid: 123, parentPid: 12, birth: "original", executable: "controlled-node", commandLine: "fixed-worker" };
  expect(sameProcessIdentity(held, { ...held, parentPid: 99 })).toBe(true);
});

it("rejects a compiled graceful stop budget longer than the parent's remaining deadline", async () => {
  const item = await stressFixture(origin);
  expect(() => assertStressExecutionDeadline(item.prepared.prepared, 29999)).toThrow();
});

it("exposes the actual native stress child PID and confirms its OS exit", async () => {
  const channel = spawnLocalStressWorker(["--eval", "setInterval(() => {}, 1000)"], 10000);
  const pid = channel.pid!;
  try { expect(channel.pid).toEqual(expect.any(Number)); }
  finally { await channel.close(); }
  expect(alive(pid)).toBe(false); const exit = await channel.waitForExit!(); expect(exit.code === null || Number.isInteger(exit.code)).toBe(true);
});

// Break caught: the dedicated child has no fixed multi-worker host and therefore sends zero business requests.
it("runs four bounded iterations in two actual stress workers through the strict start permit", async () => {
  const item = await stressFixture(origin, 903), h = stressHarness([item]); const before = requests.length;
  try {
    expect(h.supervisor.receive(item.delivery)).toBe(true);
    await vi.waitFor(() => expect(h.completed).toHaveLength(1), { timeout: 10000 });
    expect(h.rejectedDeclarations).toEqual([]);
    expect(h.messages.some(message => message.kind === "started")).toBe(true);
    console.log("bounded-dual-worker-observation", JSON.stringify({ result: h.completed[0], targetRequests: requests.slice(before) }));
    expect(h.completed[0]!.output).toMatchObject({ kind: "stress", result: { iterations: { completed: 4 }, requests: { started: 4, completed: 4 }, verdict: { passed: true } } });
    expect(requests.slice(before)).toHaveLength(4);
    const rows = h.supervisor["ledger"].intents[0]!.processes!;
    expect(rows).toHaveLength(3); expect(rows.every(row => row.exited && !alive(row.pid))).toBe(true);
  } finally { await h.supervisor.close(); }
});

it("publishes rich evidence only after both actual workers contribute their private marker union", async () => {
  markerPorts.clear(); const item = await stressFixture(origin, 930, 2, "/marker-union", 2), h = stressHarness([item]);
  try {
    h.supervisor.receive(item.delivery); await vi.waitFor(() => expect(h.completed).toHaveLength(1), { timeout: 10000 });
    expect([...markerPorts.values()].sort()).toEqual(["private-worker-one", "private-worker-two"]);
    const output = h.completed[0]!.output;
    expect(output?.kind).toBe("stress"); if (output?.kind !== "stress") throw new Error("Missing stress evidence");
    expect(output.result.failureEvidence).toHaveLength(2);
    expect(output.result.failureEvidence!.map(sample => sample.response?.body.text)).toEqual(["[REDACTED] [REDACTED]", "[REDACTED] [REDACTED]"]);
    expect(JSON.stringify({ messages: h.messages, completed: h.completed })).not.toMatch(/private-worker-one|private-worker-two|stress-private-/);
  } finally { await h.supervisor.close(); }
});

it("withholds rich evidence when an actual worker exits before the private marker barrier", async () => {
  markerPorts.clear(); const item = await stressFixture(origin, 933, 2, "/marker-union-fault", 4), h = stressHarness([item]);
  try {
    h.supervisor.receive(item.delivery);
    await vi.waitFor(() => expect(requests.filter(path => path === "/marker-union-fault")).toHaveLength(4), { timeout: 10000 });
    const workerPids = await descendants(h.supervisor.processState().dedicatedPids[0]!); expect(workerPids).toHaveLength(2);
    process.kill(workerPids[0]!, "SIGKILL");
    await vi.waitFor(() => expect(h.completed).toHaveLength(1), { timeout: 10000 });
    const output = h.completed[0]!.output;
    if (output?.kind === "stress") { expect(output.result.failureEvidence ?? []).toEqual([]); expect(output.result.completeness.metrics.complete).toBe(false); }
    else expect(output?.kind).toBe("stress-failure");
    expect(h.completed[0]!.verdict).not.toBe("passed");
    expect(JSON.stringify({ messages: h.messages, reports: h.supervisor.pendingReports() })).not.toMatch(/private-worker-one|private-worker-two|stress-private-/);
  } finally { for (const response of gates) response.end("ok"); gates.clear(); await h.supervisor.close(); }
});

it("independently resolves flattened policy and applied capacity while restoring verified source labels", async () => {
  const item = await stressFixture(origin, 931, 2);
  if (item.delivery.task.target.kind !== "stress") throw new Error("Stress fixture required");
  delete item.delivery.task.target.plan.maxRps; delete item.delivery.task.target.plan.maxRequestConcurrency;
  item.inputs.policy = { ...item.inputs.policy, maxStressRps: 7 };
  const configuration = resolveEffectiveConfig({ agent: item.config, project: { maxStressRps: 7 } });
  item.prepared = await prepareProjectFiles(item.inputs.snapshot.assets, { target: item.delivery.task.target, profile: "no-script", stressRun: item.inputs.runConfig.stress, stressConfig: { configuration, run: item.inputs.runConfig.stress } });
  item.inputs.stressBinding = item.prepared.prepared.stressBinding!; item.inputs.inputsDigest = hash(executionInputsDigestText(item.inputs));
  const dto = { task: item.delivery.task, inputs: item.inputs, materials: item.materials, serverId: "https://control.test/api/v1", minFreeDiskBytes: 1, runtimeCompatibilityId: item.compatibility, appliedAgentConfig: item.config };
  const metadata = await withInvocation(dto, new AbortController().signal, async value => value);
  expect(metadata.project.prepared.stressBinding!.sources.maxRps).toBe("policy.maxStressRps:project");
  expect(metadata.project.prepared.stressBinding!.reservation.maxRps).toBe(7);
  dto.appliedAgentConfig = { ...item.config, maxStressRps: 5 };
  await expect(withInvocation(dto, new AbortController().signal, async value => value)).rejects.toThrow();
});

it("refuses an impossible compiled deadline before start permission or target requests", async () => {
  const item = await stressFixture(origin, 932, 1), h = stressHarness([item]); const before = requests.length;
  item.inputs.runConfig.jobTimeoutMs = 1000; item.inputs.inputsDigest = hash(executionInputsDigestText(item.inputs));
  try {
    h.supervisor.receive(item.delivery); await vi.waitFor(() => expect(h.completed).toHaveLength(1), { timeout: 10000 });
    expect(h.completed[0]!.verdict).toBe("rejected"); expect(h.messages.some(message => message.kind === "start-request")).toBe(false);
    expect(requests.length).toBe(before); expect(h.supervisor.processState().dedicatedPids).toEqual([]);
  } finally { await h.supervisor.close(); }
});

it.each(["cancel", "worker-exit", "coordinator-exit"] as const)("confirms every actual stress descendant exits after %s before releasing resources", async mode => {
  const item = await stressFixture(origin, mode === "cancel" ? 910 : 911, 2, "/hold-tree", 4), debug = await debugFixture(origin, mode === "cancel" ? 920 : 921), h = stressHarness([item, debug], { maxConcurrentJobs: 2 }); const before = requests.length;
  let pids: number[] = [];
  try {
    h.supervisor.receive(item.delivery); await vi.waitFor(() => expect(requests.length - before).toBe(2), { timeout: 10000 });
    const coordinator = h.supervisor.processState().dedicatedPids[0]!;
    const workers = await descendants(coordinator); pids = [coordinator, ...workers];
    expect(workers).toHaveLength(2); expect(pids.every(alive)).toBe(true);
    h.supervisor.receive(debug.delivery); await vi.waitFor(() => expect(h.completed.find(row => row.executionId === debug.delivery.task.executionId)?.verdict).toBe("passed"), { timeout: 10000 });
    // Post-implementation adjacent boundary check: ordinary debug must not acquire stress observation metadata.
    expect(h.messages.filter(message=>message.executionId===debug.delivery.task.executionId).every(message=>!('processObservation' in message))).toBe(true);
    expect(h.completed.find(row=>row.executionId===debug.delivery.task.executionId)?.processObservation).toBeUndefined();
    if (mode === "cancel") h.supervisor.command({ kind: "cancel", messageId: "cancel-tree", jobId: item.delivery.task.jobId, executionId: item.delivery.task.executionId, reason: "Controlled cancellation" });
    else process.kill(mode === "coordinator-exit" ? coordinator : workers[0]!, "SIGKILL");
    await vi.waitFor(() => expect(h.completed).toHaveLength(2), { timeout: 10000 });
    const rows = (h.supervisor["ledger"].intents[0] as unknown as { processes?: Array<{ pid: number; exited: boolean }> }).processes ?? [];
    const exitRecords = rows.map(row => ({ ...row, stillAlive: alive(row.pid) }));
    const reservedStressProcesses = [...h.supervisor["slots"]["held"].values()].reduce((sum, entry) => sum + (entry.stress?.processes ?? 0), 0);
    console.log("stress-tree-exit-evidence", JSON.stringify({ mode, pids, exitRecords, reservedStressProcesses, targetRequests: requests.length - before }));
    expect.soft(h.messages.find(message => message.kind === "completed" && message.executionId === item.delivery.task.executionId)).toMatchObject({ evidenceComplete: false });
    expect(exitRecords).toHaveLength(3);
    expect(exitRecords.every(record => record.exited && !record.stillAlive)).toBe(true);
    expect(reservedStressProcesses).toBe(0);
    expect(pids.some(alive)).toBe(false);
    expect(h.completed.find(row => row.executionId === item.delivery.task.executionId)!.verdict).not.toBe("passed");
    expect(h.supervisor.capacity().availableSlots).toBe(2);
    const stopped = requests.length; await new Promise(resolve => setTimeout(resolve, 150)); expect(requests.length).toBe(stopped);
  } finally { for (const response of gates) response.end("ok"); gates.clear(); await h.supervisor.close(); }
});

// Break caught: preparation silently drops the fixed worker count or the independent compiled binding.
it("prepares the fixed stress run and independently verifies its compiled reservation", async () => {
  const item = await stressFixture(origin);
  const metadata = await withInvocation({ task: item.delivery.task, inputs: item.inputs, materials: item.materials, serverId: "https://control.test/api/v1", minFreeDiskBytes: 1, runtimeCompatibilityId: item.compatibility, appliedAgentConfig: item.config }, new AbortController().signal, async value => value);
  expect(metadata.project.prepared.stressRunConfig?.workerCount).toBe(2);
  expect(metadata.project.prepared.stressBinding).toEqual(item.inputs.stressBinding);
});

// Break caught: a not-started stress failure is incorrectly persisted as proof of a business request.
it("keeps a preparation failure distinct from an actual business start", async () => {
  const item = await stressFixture(origin, 904); let starts = 0;
  const permit: StartPermit = { kind: "start-permit", messageId: "permit-904", jobId: item.delivery.task.jobId, executionId: "904", permitId: "904", effectivePolicy: item.inputs.policy, policyVersion: "1", scriptPlanDigest: item.prepared.scriptPlanDigest, executionProfile: "no-script", runtimeCompatibilityId: item.compatibility, credentialVersions: { "credential-ref-1": "1" } };
  const output = await executeInvocation({ task: item.delivery.task, inputs: item.inputs, materials: item.materials, serverId: "https://control.test/api/v1", minFreeDiskBytes: 1, runtimeCompatibilityId: item.compatibility, appliedAgentConfig: item.config }, permit, item.identity, new AbortController().signal, undefined, () => { starts++; });
  expect(output).toMatchObject({ kind: "stress-failure", started: false });
  expect(starts).toBe(0);
});

// Break caught: a legal stress delivery reaches start permission without its frozen declaration.
it("declares the same compiled stress binding at the strict start permission boundary", async () => {
  const item = await stressFixture(origin, 902, 1);
  let observeStart!: (message: Extract<AgentMessageV1, { kind: "start-request" }>) => void;
  const startRequested = new Promise<Extract<AgentMessageV1, { kind: "start-request" }>>(resolve => { observeStart = resolve; });
  // Keep permission pending: a correct declaration must not depend on process startup or completion.
  const h = stressHarness([item], {}, undefined, {
    holdStartPermit: true, onStartRequest: observeStart,
  });
  // Also close on the runner's timeout if the expected declaration is never emitted.
  onTestFinished(() => h.supervisor.close());
  const before = requests.length;
  expect(h.supervisor.receive(item.delivery)).toBe(true);
  const declaration = await startRequested;
  expect(declaration.stressBinding).toEqual(item.inputs.stressBinding);
  expect(h.rejectedDeclarations).toEqual([]);
  expect(h.completed).toEqual([]);
  expect(h.supervisor.processState().dedicatedPids).toEqual([]);
  expect(requests.length).toBe(before);
});

it("settles a complete successful Core stress verdict as passed", async () => {
  const item = await stressFixture(origin, 905, 1), h = stressHarness([item]);
  try {
    h.supervisor.receive(item.delivery); await vi.waitFor(() => expect(h.completed).toHaveLength(1), { timeout: 10000 });
    expect(h.completed[0]!.output).toMatchObject({ kind: "stress", result: { verdict: { passed: true }, requests: { completed: 4 } } });
    expect(h.completed[0]!.verdict).toBe("passed");
    expect(h.supervisor["ledger"].intents[0]!.processes).toHaveLength(1);
  } finally { await h.supervisor.close(); }
});

it.each([1, 2])("publishes throttled cumulative safe Core stress progress with %i workers without ordinary progress frames", async workers => {
  const item = await stressFixture(origin, 906 + workers, workers, "/progress", 12), h = stressHarness([item], { stressProgressIntervalMs: 500 });
  try {
    h.supervisor.receive(item.delivery); await vi.waitFor(() => expect(h.completed).toHaveLength(1), { timeout: 10000 });
    const progress = h.messages.filter(message => message.kind === "stress-progress");
    expect(progress.some(message => message.requests.completed > 0 && message.state !== "finished")).toBe(true);
    expect(progress.at(-1)).toMatchObject({ state: "finished", requests: { started: 12, completed: 12 } });
    expect(h.messages.some(message => message.kind === "progress")).toBe(false);
    expect(JSON.stringify(progress)).not.toContain("stress-private-");
    for (let index = 1; index < progress.length; index++) {
      expect(progress[index]!.sequence).toBe(index + 1);
      expect(progress[index]!.requests.completed).toBeGreaterThanOrEqual(progress[index - 1]!.requests.completed);
      if (progress[index]!.state !== "finished") expect(Date.parse(progress[index]!.observedAt) - Date.parse(progress[index - 1]!.observedAt)).toBeGreaterThanOrEqual(490);
    }
  } finally { await h.supervisor.close(); }
});

// Break caught: two reservations each consume three processes despite a total process capacity of three.
it("reserves stress processes before dispatch while retaining the independent pending report budget", () => {
  const slots = new TaskSlots({ ...defaultAgentConfig, maxConcurrentJobs: 3, maxConcurrentStressJobs: 2, maxStressProcesses: 3, maxStressMetricMemoryBytes: 536870912 });
  const stress = { jobs: 1, processes: 3, vus: 2, requestConcurrency: 2, maxRps: 10, metricMemoryBytes: 201326592 };
  const reserve = slots.reserve.bind(slots);
  expect(reserve("ordinary")).toBe(true); expect(slots.dispatch("ordinary", "shared-debug")).toBe(true);
  expect(reserve("first", stress)).toBe(true); slots.resources("first", 10, 32768); expect(slots.dispatch("first", "dedicated-task")).toBe(true);
  expect(reserve("second", stress)).toBe(false);
  expect(slots.release("first")).toBe(true); expect(slots.committedResult()).toBe(32768);
  expect(reserve("second", stress)).toBe(true);
  slots.release("second"); slots.release("ordinary"); slots.archiveResult("first"); expect(slots.committedResult()).toBe(0);
});

it.each([
  { maxConcurrentStressJobs: 1 }, { maxStressProcesses: 5 }, { maxStressVus: 3 },
  { maxStressRequestConcurrency: 3 }, { maxStressRps: 15 }, { maxStressMetricMemoryBytes: 300 * 1024 * 1024 },
])("independently enforces the local stress resource dimension %j", ceiling => {
  const slots = new TaskSlots({ ...defaultAgentConfig, maxConcurrentJobs: 4, maxConcurrentStressJobs: 2, maxStressProcesses: 6, maxStressVus: 4, maxStressRequestConcurrency: 4, maxStressRps: 20, maxStressMetricMemoryBytes: 384 * 1024 * 1024, ...ceiling });
  const reservation = { jobs: 1, processes: 3, vus: 2, requestConcurrency: 2, maxRps: 10, metricMemoryBytes: 192 * 1024 * 1024 };
  expect(slots.reserve("one", reservation)).toBe(true); expect(slots.reserve("two", reservation)).toBe(false);
  slots.release("one"); expect(slots.reserve("two", reservation)).toBe(true);
});
