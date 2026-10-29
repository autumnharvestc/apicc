import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { copyFileSync } from "node:fs";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { encodeContractProjectFiles, type DebugInvocation } from "@apicc/core";
import { createContractExecutionProject, contractExecutionIds as ids } from "../../../packages/core/tests/helpers/contractExecutionFixtures.js";
import { prepareProjectFiles } from "@apicc/execution/host";
import { readBuildIdentity, type BuildIdentity } from "@apicc/execution/buildIdentity";
import { AgentCommandV1Schema, defaultAgentConfig, defaultPolicyConfig, executionInputsDigestText, runtimeCompatibilityIdForRuntime, type AgentConfig, type AgentCommandV1, type AgentMessageV1, type ExecutionInputs, type ProjectRunMaterials, type TaskDeliveryV1 } from "@apicc/execution/contract";
import { AgentSupervisor, type SettledExecution } from "../src/supervisor.js";
import { bootstrapAgent } from "../src/bootstrap.js";
import { ExecutionLedger } from "../src/ledger.js";
import { runAgentControl } from "../src/transport/control.js";
import { ExecutionHttpError } from "@apicc/execution/client";
import { stressFixture } from "./helpers/stressFixture.js";
import { alive } from "./helpers/processEvidence.js";
import { readProcessIdentity, sameProcessIdentity } from "../src/processIdentity.js";
import * as processIdentity from "../src/processIdentity.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const requests: string[] = [], gates = new Map<string, ServerResponse>();
const target = createServer((request, response) => { request.resume(); request.on("end", () => { const path = new URL(request.url!, "http://target").pathname; requests.push(path); response.setHeader("content-type", "application/json"); if (path.includes("hold")) gates.set(path, response); else response.end('{"value":"ok"}'); }); });
let identity: BuildIdentity, compatibility: string, baseUrl: string;
beforeAll(async () => { identity = await readBuildIdentity(); compatibility = runtimeCompatibilityIdForRuntime(process.versions.node, process.versions.v8, identity.scriptApiId); await new Promise<void>(resolve => target.listen(0, "127.0.0.1", resolve)); baseUrl = `http://127.0.0.1:${(target.address() as { port: number }).port}`; });
afterAll(async () => { for (const response of gates.values()) response.end("{}"); target.closeAllConnections(); await new Promise<void>(resolve => target.close(() => resolve())); });
const wait = (assertion: () => void) => vi.waitFor(assertion, { timeout: 6000, interval: 20 });
const config = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({ ...defaultAgentConfig, minFreeDiskBytes: 1, sharedDebugIdleMs: 10000, ...overrides });
async function fixture(id: number, path: string, dedicated = false) {
  const project = createContractExecutionProject(baseUrl), collection = project.collections[0]!, folder = collection.folders[0]!.folders[0]!, api = folder.apis[0]!;
  if (api.contract.request.protocol !== "http") throw new Error("HTTP fixture required");
  folder.preOperations = []; folder.postOperations = []; api.cases[0]!.preOperations = []; project.environments = []; project.variables = {}; collection.variables = {};
  api.contract.request.baseUrl = baseUrl; api.contract.request.path = path; api.contract.request.query = []; api.contract.request.headers = []; api.contract.request.body = { kind: "json", content: "{}" };
  project.workflows[0]!.id = "10000000-0000-4000-8000-000000000092";
  const locator = { workspaceId: "workspace", groupId: "group", projectId: project.id, collectionId: collection.id, folderIds: [ids.outerFolder, ids.innerFolder], apiId: api.contract.id };
  const invocation: DebugInvocation = { mode: "case", locator, case: { ...locator, caseId: ids.case, scope: "base" } };
  const selected = dedicated ? { kind: "workflow" as const, workflowId: project.workflows[0]!.id } : { kind: "debug" as const, invocation };
  const files = [...encodeContractProjectFiles(project).files].map(([path, content]) => ({ path, content, version: "1", hash: hash(content), size: Buffer.byteLength(content) })).sort((a, b) => a.path.localeCompare(b.path));
  const assets = { workspaceId: "11", groupId: "22", projectId: "33", contractProjectId: project.id, format: "contract-files-v1" as const, version: "1", files, manifestHash: hash(files.map(file => `${file.path}\0${file.version}\0${file.hash}\0${file.size}\n`).join("")) };
  const prepared = await prepareProjectFiles(assets, { target: selected, profile: "no-script" });
  const executionId = String(id), snapshotId = String(id + 1000);
  const delivery: TaskDeliveryV1 = { messageId: `delivery-${id}`, task: { protocolVersion: 1, jobId: String(id + 100), executionId, snapshotId, scope: { workspaceId: "11", groupId: "22", projectId: "33" }, submittedByUserId: "44", contractProjectId: project.id, manifestHash: assets.manifestHash, target: selected, executionProfile: "no-script", dispatchKind: dedicated ? "dedicated-task" : "shared-debug", scriptPlanDigest: prepared.scriptPlanDigest, requiredCoreBuildId: identity.coreBuildId, requiredCapabilities: [...prepared.prepared.requiredCapabilities], policyVersion: "1", runtimeCompatibilityId: compatibility } };
  const materials: ProjectRunMaterials = { snapshotId, scope: delivery.task.scope, credentials: [{ refId: ids.credential, version: "1", value: `recovery-secret-${id}` }], attachments: [] };
  const policy = { ...defaultPolicyConfig, reportBytes: 32768, caseEvidenceBytes: 8192, bodyPreviewBytes: 4096, valuePreviewBytes: 1024, workflowMetadataBytes: 4096, cancelGraceMs: 200 };
  const inputs: ExecutionInputs = { executionId, snapshot: { snapshotId, createdByUserId: "44", assets }, policy, runConfig: {}, materials: { projectId: "33", credentials: [{ refId: ids.credential, version: "1" }], attachments: [] }, inputsDigest: "0".repeat(64) };
  inputs.inputsDigest = hash(executionInputsDigestText(inputs)); return { delivery, materials, inputs };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function permit(message: Extract<AgentMessageV1, { kind: "start-request" }>, item: Fixture): AgentCommandV1 { return AgentCommandV1Schema.parse({ kind: "start-permit", messageId: `permit-${message.executionId}`, jobId: message.jobId, executionId: message.executionId, permitId: message.executionId, effectivePolicy: item.inputs.policy, policyVersion: message.policyVersion, scriptPlanDigest: message.scriptPlanDigest, executionProfile: message.executionProfile, runtimeCompatibilityId: message.runtimeCompatibilityId, credentialVersions: message.credentialVersions }); }
function harness(items: Fixture[], dataDirectory: string, overrides: Partial<AgentConfig> = {}) {
  const completed: SettledExecution[] = [], messages: AgentMessageV1[] = []; let offline = false;
  const options = { dataDirectory, serverId: "https://control.test/api/v1", agentId: "7", sessionId: "recovery-host", runtimeCompatibilityId: compatibility, identity, config: config(overrides), configVersion: "1",
    loadInputs: async (task: TaskDeliveryV1["task"]) => items.find(item => item.delivery.task.executionId === task.executionId)!.inputs,
    loadMaterials: async (task: TaskDeliveryV1["task"]) => items.find(item => item.delivery.task.executionId === task.executionId)!.materials,
    transport: { exchange: async () => ({ deliveries: [], commands: [] }), send: async (batch: readonly AgentMessageV1[]) => { if (offline) throw new Error("Controlled control disconnection"); messages.push(...batch); for (const message of batch) if (message.kind === "start-request") queueMicrotask(() => supervisor.command(permit(message, items.find(item => item.delivery.task.executionId === message.executionId)!))); return { acknowledged: batch.map(message => message.messageId) }; } },
    onSettled: (result: SettledExecution) => completed.push(result),
  };
  const supervisor = new AgentSupervisor(options); return { supervisor, completed, messages, options, setOffline(value: boolean) { offline = value; } };
}
const release = (path: string) => { gates.get(path)?.end('{"value":"ok"}'); gates.delete(path); };

it("finishes recovery for a persisted old birth without killing the actual replacement PID owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "apicc-reused-pid-recovery-")), item = await stressFixture(baseUrl, 972, 2, "/must-not-replay-reused-pid");
  const scriptPath = fileURLToPath(new URL("../dist/stressWorkerChild.js", import.meta.url));
  const neighbor = fork(scriptPath, [randomUUID(), "worker-1"], { execPath: process.execPath, execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const neighborExited = new Promise<void>(resolve => neighbor.once("exit", () => resolve()));
  let h: ReturnType<typeof harness> | undefined, expected: Awaited<ReturnType<typeof readProcessIdentity>>;
  const before = requests.length;
  try {
    expected = await readProcessIdentity(neighbor.pid!); expect(expected).toBeDefined(); expect(alive(neighbor.pid!)).toBe(true);
    const ledger = new ExecutionLedger(directory, "https://control.test/api/v1", "7", config()), runId = randomUUID(), workerId = "worker-1", id = `${runId}/${workerId}`;
    ledger.accept(item.delivery); ledger.mark("972", "uncertain");
    ledger.recordProcessIntent("972", { id, runId, workerId, role: "worker", scope: item.delivery.task.scope, epoch: ledger.childLease!.epoch, scriptPath });
    ledger.recordProcess("972", { id, name: "stress worker worker-1", role: "worker", pid: neighbor.pid!, scope: item.delivery.task.scope, epoch: ledger.childLease!.epoch, birth: String(BigInt(expected!.birth) - 1n), exited: false }); ledger.close();
    h = harness([item], directory); let recovered = false; void h.supervisor.ready.then(() => { recovered = true; }, () => undefined);
    await vi.waitFor(() => expect(recovered).toBe(true), { timeout: 2000, interval: 20 });
    expect(alive(neighbor.pid!)).toBe(true); expect(h.supervisor.capacity().availableSlots).toBe(1);
    expect(h.supervisor["ledger"].intents[0]!.processes).toMatchObject([{ pid: neighbor.pid, exited: true }]);
    expect(h.supervisor.pendingResults()).toMatchObject([{ executionId: "972", verdict: "interrupted" }]); expect(requests.length).toBe(before);
  } finally {
    await h?.supervisor.close();
    const current = await readProcessIdentity(neighbor.pid!); if (expected && current && sameProcessIdentity(expected, current)) neighbor.kill("SIGKILL"); await neighborExited;
    await rm(directory, { recursive: true, force: true });
  }
});

it("blocks stress restart recovery until its real pre-lease worker is confirmed exited without replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "apicc-pre-lease-recovery-")), item = await stressFixture(baseUrl, 861, 2, "/must-not-replay-pre-lease");
  const runId = randomUUID(), workerId = "worker-1", scriptPath = fileURLToPath(new URL("../dist/stressWorkerChild.js", import.meta.url));
  const ledger = new ExecutionLedger(directory, "https://control.test/api/v1", "7", config());
  ledger.accept(item.delivery); ledger.mark("861", "uncertain");
  ledger.recordProcessIntent("861", { id: `${runId}/${workerId}`, runId, workerId, role: "worker", scope: item.delivery.task.scope, epoch: ledger.childLease!.epoch, scriptPath });
  ledger.close();
  const child = fork(scriptPath, [runId, workerId], { execPath: process.execPath, execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  let h: ReturnType<typeof harness> | undefined; let birth: Awaited<ReturnType<typeof readProcessIdentity>>;
  const before = requests.length;
  try {
    birth = await readProcessIdentity(child.pid!); expect(birth).toBeDefined(); expect(alive(child.pid!)).toBe(true);
    h = harness([item], directory);
    console.log("pre-lease-recovery-observation", JSON.stringify({ pid: child.pid, birth: birth!.birth, alive: alive(child.pid!), capacity: h.supervisor.capacity(), reports: h.supervisor.pendingReports().length, messages: h.supervisor["ledger"].messages.map(message => ({ kind: message.kind, executionReleased: message.kind === "completed" ? message.executionReleased : undefined })) }));
    expect.soft(h.supervisor.capacity().availableSlots).toBe(0);
    expect.soft(h.supervisor.pendingReports()).toEqual([]);
    expect(h.supervisor["ledger"].messages.some(message => message.kind === "completed")).toBe(false);
    await (h.supervisor as unknown as { ready: Promise<void> }).ready;
    expect(alive(child.pid!)).toBe(false); expect(h.supervisor.capacity().availableSlots).toBe(1);
    expect(h.supervisor.pendingResults()).toMatchObject([{ executionId: "861", verdict: "interrupted", executionFact: "uncertain" }]);
    expect(requests.length).toBe(before);
  } finally {
    await h?.supervisor.close();
    if (birth) { const current = await readProcessIdentity(child.pid!); if (current && sameProcessIdentity(birth, current)) child.kill("SIGKILL"); }
    else child.kill("SIGKILL");
    await exited; await rm(directory, { recursive: true, force: true });
  }
});

it("stops bootstrap during unknown stress recovery without releasing its durable intent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "apicc-unknown-recovery-stop-")), item = await stressFixture(baseUrl, 862, 2, "/must-not-replay-unknown");
  const ledger = new ExecutionLedger(directory, "https://control.test/api/v1", "7", config());
  ledger.accept(item.delivery); const runId = randomUUID();
  ledger.recordProcessIntent("862", { id: `${runId}/worker-1`, runId, workerId: "worker-1", role: "worker", scope: item.delivery.task.scope, epoch: ledger.childLease!.epoch, scriptPath: fileURLToPath(new URL("../dist/stressWorkerChild.js", import.meta.url)) }); ledger.close();
  const tokenFile = join(directory, "identity-token"); await writeFile(tokenFile, "controlled-recovery-token");
  let entered!: () => void; const unavailable = new Promise<void>(resolve => { entered = resolve; });
  // Only the external OS inspection boundary is unavailable; ledger, supervisor, bootstrap and abort are real.
  const inspection = vi.spyOn(processIdentity, "findStressWorkerProcesses").mockImplementation(async () => { entered(); throw new Error("OS process inspection unavailable"); });
  const controller = new AbortController(); let stopped = false;
  const running = bootstrapAgent({ baseUrl: "https://control.test/api/v1", agentId: "7", tokenFile, dataDirectory: directory, bootstrapConfig: config() }, controller.signal, { fetch: async () => { throw new Error("Recovery must precede control admission"); } }).finally(() => { stopped = true; });
  try {
    await unavailable; controller.abort();
    await vi.waitFor(() => expect(stopped).toBe(true), { timeout: 1000, interval: 20 }); await running;
    const persisted = new ExecutionLedger(directory, "https://control.test/api/v1", "7", config());
    try { expect(persisted.intents[0]!.settled).not.toBe(true); expect(persisted.messages.some(message => message.kind === "completed")).toBe(false); }
    finally { persisted.close(); }
  } finally { controller.abort(); inspection.mockRestore(); await running.catch(() => undefined); await rm(directory, { recursive: true, force: true }); }
});

// The original production lost-ACK path must retain the exact stress report bytes without repeating business HTTP.
it("reuploads identical dual-worker stress report bytes after a lost archive ACK without replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "apicc-stress-recovery-")), item = await stressFixture(baseUrl, 841, 2, "/stress-recovery");
  const tokenFile = join(directory, "identity-token"); await writeFile(tokenFile, "controlled-stress-control-token");
  const controller = new AbortController(), commands: AgentCommandV1[] = [], uploads: Uint8Array[] = [], hashes: string[] = []; let delivered = false;
  const cfg = config({ heartbeatIntervalMs: 40, transferRetryMinMs: 20, transferRetryMaxMs: 30, transferRetryCycleMs: 50 });
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("runner/runtime")) { const body = JSON.parse(String(init?.body)); return Response.json({ registered: true, sessionId: body.sessionId, serverId: "https://control.test/api/v1", configuration: { configVersion: "1", config: cfg } }); }
    if (url.includes("/inputs?")) return Response.json(item.inputs);
    if (url.endsWith("/materials")) return Response.json(item.materials);
    if (url.endsWith("/report?executionId=841")) {
      const bytes = Buffer.from(init?.body as Uint8Array), digest = hash(bytes.toString("utf8"));
      expect(new Headers(init?.headers).get("X-Report-Hash")).toBe(digest); uploads.push(bytes); hashes.push(digest);
      if (uploads.length === 1) throw new Error("Report persisted; ACK deliberately lost");
      return Response.json({ archived: true, reportHash: digest, reportBytes: bytes.length });
    }
    if (url.endsWith("runner/messages")) {
      const batch = JSON.parse(String(init?.body)) as AgentMessageV1[];
      for (const message of batch) if (message.kind === "start-request") {
        expect(message.stressBinding).toEqual(item.inputs.stressBinding);
        commands.push(permit(message, item));
      }
      return Response.json({ acknowledged: batch.map(message => message.messageId) });
    }
    if (url.endsWith("runner/poll") || url.endsWith("runner/heartbeat")) { await new Promise(resolve => setTimeout(resolve, 20)); const deliveries = delivered ? [] : [item.delivery]; delivered = true; return Response.json({ deliveries, commands: commands.splice(0) }); }
    throw new Error("Unexpected controlled endpoint");
  };
  let running = bootstrapAgent({ baseUrl: "https://control.test/api/v1", agentId: "7", tokenFile, dataDirectory: directory, bootstrapConfig: cfg }, controller.signal, { fetch: fetcher });
  try {
    await vi.waitFor(() => expect(uploads).toHaveLength(2), { timeout: 10000 });
    const targetRequestsBeforeRecovery = requests.filter(path => path === "/stress-recovery").length;
    expect(targetRequestsBeforeRecovery).toBe(4); expect(Buffer.compare(Buffer.from(uploads[0]!), Buffer.from(uploads[1]!))).toBe(0); expect(hashes[1]).toBe(hashes[0]);
    expect(JSON.parse(Buffer.from(uploads[0]!).toString("utf8"))).toMatchObject({ verdict: "passed", output: { kind: "stress", result: { requests: { completed: 4 } } } });
    controller.abort(); await running;
    const restored = harness([item], directory);
    try { restored.supervisor.receive(item.delivery); await restored.supervisor.flushMessages(new AbortController().signal); expect(restored.supervisor.processState()).toEqual({ sharedPid: undefined, dedicatedPids: [] }); }
    finally { await restored.supervisor.close(); }
    const targetRequestsAfterRecovery = requests.filter(path => path === "/stress-recovery").length;
    expect(targetRequestsAfterRecovery).toBe(targetRequestsBeforeRecovery);
  } finally { controller.abort(); await running; await rm(directory, { recursive: true, force: true }); }
});

// Break caught: replacing durable execution identities/results by per-process Maps.
it("recovers projected unconfirmed results and never reexecutes after control loss or host restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "apicc-recovery-")), item = await fixture(801, "/hold-recovery");
  item.inputs.runConfig.jobTimeoutMs = 3000; item.inputs.inputsDigest = hash(executionInputsDigestText(item.inputs));
  const beforeStart = await mkdtemp(join(tmpdir(), "apicc-before-start-")), afterStart = await mkdtemp(join(tmpdir(), "apicc-after-start-")), uncertain = await mkdtemp(join(tmpdir(), "apicc-uncertain-"));
  const first = harness([item], directory); let second: ReturnType<typeof harness> | undefined;
  try {
    first.supervisor.receive(item.delivery);
    copyFileSync(join(directory, "execution-ledger.sqlite"), join(beforeStart, "execution-ledger.sqlite"));
    await wait(() => expect({ requests: requests.filter(path => path === "/hold-recovery"), completed: first.completed, messages: first.messages.map(message => message.kind) }).toMatchObject({ requests: ["/hold-recovery"], completed: [], messages: ["accepted", "start-request", "started"] }));
    copyFileSync(join(directory, "execution-ledger.sqlite"), join(afterStart, "execution-ledger.sqlite"));
    expect(() => harness([item], directory)).toThrow();
    // Controlled loss of only this fixture's parent ownership lock. The real child is still alive.
    first.supervisor["ledger"]["owner"]!.close(); first.supervisor["ledger"]["owner"] = undefined;
    let replacement: ExecutionLedger | undefined;
    try { expect(() => { replacement = new ExecutionLedger(directory, "https://control.test/api/v1", "7", config()); }).toThrow(); }
    finally { replacement?.close(); }
    first.setOffline(true); await wait(() => expect(first.completed).toHaveLength(1));
    expect(first.completed[0]!.verdict).toBe("timed-out"); release("/hold-recovery");
    const originalCompleted = first.supervisor["ledger"].messages.find(message => message.kind === "completed")!;
    first.setOffline(false);
    await vi.waitFor(async () => { await first.supervisor.flushMessages(new AbortController().signal); expect(first.messages.find(message => message.kind === "completed")).toEqual(originalCompleted); }, { timeout: 6000, interval: 20 });
    first.supervisor.receive(item.delivery);
    expect(requests.filter(path => path === "/hold-recovery")).toHaveLength(1);
    await first.supervisor.close(); second = harness([item], directory);
    expect.soft(second.supervisor.pendingResults()).toHaveLength(1);
    expect(second.supervisor.pendingResults()[0]).toMatchObject({ executionId: "801", verdict: "timed-out", executionFact: "started" });
    expect(second.supervisor.receive(item.delivery)).toBe(true); await second.supervisor.flushMessages(new AbortController().signal);
    expect(second.completed).toEqual([]); expect(second.supervisor.processState()).toEqual({ sharedPid: undefined, dedicatedPids: [] });
    expect.soft(requests.filter(path => path === "/hold-recovery")).toHaveLength(1);
    const files = await readdir(directory); expect.soft(files.length).toBeGreaterThan(0);
    for (const file of files) expect(await readFile(join(directory, file), "utf8")).not.toContain("recovery-secret-801");
    const staleStart = first.messages.find(message => message.kind === "start-request")!;
    const ambiguous = new ExecutionLedger(uncertain, "https://control.test/api/v1", "7", config()); ambiguous.accept(item.delivery); ambiguous.mark("801", "uncertain"); ambiguous.enqueue(staleStart); ambiguous.close();
    for (const [path, fact, reasonCode] of [[beforeStart, "not-started", "agent-restarted-before-start"], [afterStart, "started", "agent-restarted-after-start"], [uncertain, "uncertain", "execution-start-unconfirmed"]] as const) {
      const recovered = harness([item], path, { reconnectMinMs: 20, reconnectMaxMs: 40, reconnectJitterRatio: 0, heartbeatIntervalMs: 40 });
      try {
        expect(recovered.supervisor.pendingResults()).toMatchObject([{ executionId: "801", verdict: "interrupted", executionFact: fact, reasonCode }]); expect(recovered.supervisor.receive(item.delivery)).toBe(true);
        if (path === uncertain) {
          const controller = new AbortController(), rejectedAt: number[] = []; let completedAcknowledged = false, polls = 0;
          recovered.options.transport.send = async batch => { for (const message of batch) { if (message.kind === "start-request") { rejectedAt.push(performance.now()); throw new ExecutionHttpError(409); } if (message.kind === "completed") completedAcknowledged = true; } return { acknowledged: batch.map(message => message.messageId) }; };
          recovered.options.transport.exchange = async () => { polls++; await new Promise(resolve => setTimeout(resolve, 20)); return { deliveries: [], commands: [] }; };
          const loop = runAgentControl({ supervisor: recovered.supervisor, sessionId: "new-host", transport: recovered.options.transport, heartbeat: async () => ({ deliveries: [], commands: [] }) }, controller.signal);
          try { await wait(() => expect({ completedAcknowledged, polling: polls > 0 }).toEqual({ completedAcknowledged: true, polling: true })); await wait(() => expect(rejectedAt.length).toBeGreaterThanOrEqual(2)); expect(rejectedAt[1]! - rejectedAt[0]!).toBeGreaterThanOrEqual(20); expect(recovered.supervisor["ledger"].messages).toEqual([staleStart]); }
          finally { controller.abort(); await loop; }
        } else await recovered.supervisor.flushMessages(new AbortController().signal);
        expect(recovered.completed).toEqual([]); expect(recovered.supervisor.processState().sharedPid).toBeUndefined();
      }
      finally { await recovered.supervisor.close(); }
    }
    expect(requests.filter(path => path === "/hold-recovery")).toHaveLength(1);
  } finally { release("/hold-recovery"); await first.supervisor.close(); await second?.supervisor.close(); for (const path of [directory, beforeStart, afterStart, uncertain]) await rm(path, { recursive: true, force: true }); }
});

// Break caught: advertising new capacity while the sole report reservation is unconfirmed.
it("stops new admission at the pending report budget and retains unconfirmed results after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "apicc-budget-")), a = await fixture(811, "/budget-one"), b = await fixture(812, "/budget-two");
  const first = harness([a, b], directory, { pendingResultBytes: 33792, faultReserveBytes: 1024 }); let second: ReturnType<typeof harness> | undefined;
  try {
    const small = new ExecutionLedger(undefined, "https://control.test/api/v1", "7", config()); small.accept(a.delivery);
    let undersizedAccepted = false; try { small.reserve("811", 64); undersizedAccepted = true; } catch { /* Must reject before any business execution. */ }
    expect.soft(undersizedAccepted).toBe(false);
    if (undersizedAccepted) { small.settle("811", { executionId: "811", verdict: "interrupted" }); expect.soft(small.reports[0]!.bytes).toBeLessThanOrEqual(64); expect.soft(small.intents[0]!.resultBudget).toBe(64); }
    small.close();
    first.supervisor.receive(a.delivery); await wait(() => expect(first.completed).toHaveLength(1));
    const bounded = new ExecutionLedger(undefined, "https://control.test/api/v1", "7", config()); bounded.accept(b.delivery); bounded.reserve("812", 1024);
    const fault = bounded.settle("812", { executionId: "untrusted-raw-field".repeat(200), verdict: "interrupted", output: first.completed[0]!.output });
    expect.soft(fault.result.executionId).toBe("812"); expect.soft(fault.result.output).toBeUndefined(); expect.soft(fault.result.reasonCode).toBe("result-capacity-exceeded"); expect.soft(bounded.reports[0]!.bytes).toBeLessThanOrEqual(1024); expect.soft(bounded.intents[0]!.resultBudget).toBe(1024); bounded.close();
    const unreserved = new ExecutionLedger(undefined, "https://control.test/api/v1", "7", config({ faultReserveBytes: 1024 })); unreserved.accept(b.delivery); unreserved.settle("812", { executionId: "812", verdict: "interrupted", output: first.completed[0]!.output });
    expect(unreserved.reports[0]!.bytes).toBeLessThanOrEqual(1024); expect(unreserved.intents[0]!.resultBudget).toBe(0); unreserved.close();
    expect.soft(first.supervisor.capacity().availableSlots).toBe(0);
    expect(first.supervisor.receive(b.delivery)).toBe(false);
    expect.soft(first.completed).toHaveLength(1); expect(requests.filter(path => path === "/budget-two")).toHaveLength(0);
    await first.supervisor.close(); second = harness([a, b], directory, { pendingResultBytes: 33792, faultReserveBytes: 1024 });
    expect.soft(second.supervisor.pendingResults()).toHaveLength(1); expect.soft(second.supervisor.capacity().availableSlots).toBe(0);
    const report = second.supervisor.pendingReports()[0]!;
    second.supervisor.acknowledgeReport("811"); second.supervisor.acknowledgeReport("811", { archived: true, reportHash: "0".repeat(64), reportBytes: report.bytes });
    expect(second.supervisor.pendingResults()).toHaveLength(1); expect(second.supervisor.capacity().availableSlots).toBe(0);
    second.supervisor.acknowledgeReport("811", { archived: true, reportHash: report.hash, reportBytes: report.bytes });
    expect(second.supervisor.pendingResults()).toEqual([]); expect(second.supervisor.capacity().availableSlots).toBe(1);
    expect(second.supervisor.receive(a.delivery)).toBe(true); expect(second.supervisor.processState().sharedPid).toBeUndefined();
  } finally { await first.supervisor.close(); await second?.supervisor.close(); await rm(directory, { recursive: true, force: true }); }
});

// Break caught: production bootstrap omitting upload/retry, or deleting after HTTP success alone.
it("production bootstrap retries identical report bytes after a lost archive acknowledgement without replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "apicc-bootstrap-")), item = await fixture(821, "/bootstrap-upload");
  const tokenFile = join(directory, "identity-token"); await writeFile(tokenFile, "control-token-private");
  const controller = new AbortController(), commands: AgentCommandV1[] = [], uploads: string[] = [], archive = new Set<string>(); let delivered = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("runner/runtime")) { const body = JSON.parse(String(init?.body)); return Response.json({ registered: true, sessionId: body.sessionId, serverId: "https://control.test/api/v1", configuration: { configVersion: "1", config: cfg } }); }
    if (url.includes("/inputs?")) return Response.json(item.inputs);
    if (url.endsWith("/materials")) return Response.json(item.materials);
    if (url.endsWith("/report?executionId=821")) { const bytes = Buffer.from(init?.body as Uint8Array).toString("utf8"), digest = hash(bytes), headers = new Headers(init?.headers); expect(url).toBe("https://control.test/api/v1/runner/jobs/921/report?executionId=821"); expect(init?.method).toBe("PUT"); expect(headers.get("content-type")).toBe("application/octet-stream"); expect(headers.get("X-Report-Hash")).toBe(digest); expect(headers.get("authorization")).toBe("Bearer control-token-private"); uploads.push(bytes); archive.add(digest); if (uploads.length === 1) throw new Error("Archive committed; acknowledgement lost"); return Response.json({ archived: true, reportHash: digest, reportBytes: Buffer.byteLength(bytes) }); }
    if (url.endsWith("runner/messages")) { const batch = JSON.parse(String(init?.body)) as AgentMessageV1[]; for (const message of batch) if (message.kind === "start-request") commands.push(permit(message, item)); return Response.json({ acknowledged: batch.map(message => message.messageId) }); }
    if (url.endsWith("runner/poll") || url.endsWith("runner/heartbeat")) { await new Promise(resolve => setTimeout(resolve, 20)); const deliveries = delivered ? [] : [item.delivery]; delivered = true; return Response.json({ deliveries, commands: commands.splice(0) }); }
    throw new Error("Unexpected controlled endpoint");
  };
  const cfg = config({ heartbeatIntervalMs: 40, transferRetryMinMs: 20, transferRetryMaxMs: 30, transferRetryCycleMs: 50 });
  const running = bootstrapAgent({ baseUrl: "https://control.test/api/v1", agentId: "7", tokenFile, dataDirectory: directory, bootstrapConfig: cfg }, controller.signal, { fetch: fetcher });
  try { await wait(() => expect(uploads).toHaveLength(2)); expect(uploads[0]).toBe(uploads[1]); expect(archive.size).toBe(1); expect(requests.filter(path => path === "/bootstrap-upload")).toHaveLength(1); expect(uploads.join("")).not.toContain("recovery-secret-821"); }
  finally { controller.abort(); await running; await rm(directory, { recursive: true, force: true }); }
});

// Break caught: worker generation exit cancelling dedicated work or releasing before exit confirmation.
it("records both shared invocations after a controlled worker exit and leaves the dedicated invocation alive", async () => {
  const directory = await mkdtemp(join(tmpdir(), "apicc-generation-"));
  const a = await fixture(831, "/hold-generation-a"), b = await fixture(832, "/hold-generation-b"), c = await fixture(833, "/hold-dedicated", true), next = await fixture(834, "/hold-generation-new");
  const h = harness([a, b, c, next], directory, { maxConcurrentJobs: 3 });
  try {
    for (const item of [a, b, c]) h.supervisor.receive(item.delivery);
    await wait(() => expect(requests.filter(path => ["/hold-generation-a", "/hold-generation-b", "/hold-dedicated"].includes(path))).toHaveLength(3));
    const oldWorker = h.supervisor["shared"]!, oldPid = oldWorker.pid!; let oldExited = false, newStartedAfterExit = false;
    void oldWorker.exited.then(() => { oldExited = true; });
    const send = h.options.transport.send; h.options.transport.send = async batch => { if (batch.some(message => message.kind === "started" && message.executionId === "834")) newStartedAfterExit = oldExited; return send(batch); };
    process.kill(oldPid, "SIGTERM");
    h.supervisor.receive(next.delivery);
    await wait(() => expect(h.completed.filter(result => ["831", "832"].includes(result.executionId))).toHaveLength(2));
    expect(h.completed.filter(result => ["831", "832"].includes(result.executionId)).map(result => result.verdict)).toEqual(["interrupted", "interrupted"]);
    expect(h.completed.some(result => result.executionId === "833")).toBe(false);
    await wait(() => expect(gates.has("/hold-generation-new")).toBe(true)); expect(newStartedAfterExit).toBe(true);
    const current = h.supervisor["shared"]!;
    // Deliver a delayed old-generation frame to the real current generation handler.
    current.child.emit("message", { generation: oldWorker.generation, kind: "done", executionId: "834", scope: next.delivery.task.scope, output: h.completed[0]!.output });
    expect(h.completed.some(result => result.executionId === "834")).toBe(false); expect(current.inFlight).toBe(1);
    release("/hold-generation-new");
    release("/hold-dedicated"); await wait(() => expect(h.completed).toHaveLength(4));
    for (const path of ["/hold-generation-a", "/hold-generation-b", "/hold-generation-new"]) expect(requests.filter(value => value === path)).toHaveLength(1);
    expect(h.completed.find(result => result.executionId === "834")!.pid).not.toBe(oldPid);
  } finally { for (const path of ["/hold-generation-a", "/hold-generation-b", "/hold-generation-new", "/hold-dedicated"]) release(path); await h.supervisor.close(); await rm(directory, { recursive: true, force: true }); }
});
