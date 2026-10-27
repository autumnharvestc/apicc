import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createServer, request as httpRequest, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import { createServer as createHttpsServer } from "node:https";
import { readFile } from "node:fs/promises";
import type { TLSSocket } from "node:tls";
import { encodeContractProjectFiles, type ContractProject, type DebugInvocation } from "@apicc/core";
import { WorkflowSchema } from '@apicc/core/schema';
import { createContractExecutionProject, contractExecutionIds as ids } from "../../../packages/core/tests/helpers/contractExecutionFixtures.js";
import { prepareProjectFiles } from "@apicc/execution/host";
import { readBuildIdentity, type BuildIdentity } from "@apicc/execution/buildIdentity";
import { defaultAgentConfig, defaultPolicyConfig, executionInputsDigestText, runtimeCompatibilityIdForRuntime, declaredNetworkPath, type AgentConfig, type AgentCommandV1, type AgentMessageV1, type ExecutionInputs, type ProjectRunMaterials, type TaskDeliveryV1 } from "@apicc/execution/contract";
import { AgentSupervisor, type SettledExecution } from "../src/supervisor.js";
import { createLongPollingTransport } from "../src/transport/longPolling.js";

const hash = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const workflowId = "10000000-0000-4000-8000-000000000092";
let server: Server; let proxyServer: Server; let baseUrl: string; let proxyUrl: string; let identity: BuildIdentity;
let compatibility: string;
const seen: Array<{ path: string; authorization?: string; proxyAuthorization?: string; cookie?: string; body: string }> = [];
const gates = new Map<string, ServerResponse>();
const proxyAuthorizations: Array<string | undefined> = [];
beforeAll(async () => {
  identity = await readBuildIdentity();
  compatibility = runtimeCompatibilityIdForRuntime(process.versions.node, process.versions.v8, identity.scriptApiId);
  server = createServer((request, response) => {
    let body = ""; request.on("data", data => { body += data; });
    request.on("end", () => {
      const path = new URL(request.url!, "http://target").pathname;
      seen.push({ path, authorization: request.headers.authorization, proxyAuthorization: request.headers["proxy-authorization"] as string | undefined, cookie: request.headers.cookie, body });
      response.setHeader("content-type", "application/json");
      if (path.includes("set-cookie")) response.setHeader("set-cookie", "login=host-memory-cookie; Path=/");
      if (path.includes("hold")) gates.set(path, response); else response.end(JSON.stringify({ value: path, body, ...(path === "/network" ? { networkEcho: "proxy-private-value", networkBasic: `Basic ${Buffer.from("proxy-user:proxy-private-value").toString("base64")}` } : {}) }));
    });
  });
  server.on("connect", (request, socket, head) => {
    proxyAuthorizations.push(request.headers["proxy-authorization"] as string | undefined);
    const target = new URL(`http://${request.url}`);
    if (target.hostname !== "127.0.0.1") { socket.destroy(); return; }
    const upstream = connect(Number(target.port), target.hostname, () => { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) upstream.write(head); socket.pipe(upstream).pipe(socket); });
    upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy()); socket.on("close", () => upstream.destroy());
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  proxyServer = createServer((request, response) => {
    proxyAuthorizations.push(request.headers["proxy-authorization"] as string | undefined);
    const target = new URL(request.url!); if (target.origin !== baseUrl) { response.writeHead(403).end(); return; }
    const headers = { ...request.headers }; delete headers["proxy-authorization"];
    const upstream = httpRequest(target, { method: request.method, headers }, incoming => { response.writeHead(incoming.statusCode!, incoming.headers); incoming.pipe(response); });
    upstream.on("error", () => response.destroy()); request.pipe(upstream);
  });
  proxyServer.on("connect", (request, socket, head) => {
    proxyAuthorizations.push(request.headers["proxy-authorization"] as string | undefined);
    const target = new URL(`http://${request.url}`); if (target.hostname !== "127.0.0.1") { socket.destroy(); return; }
    const upstream = connect(Number(target.port), target.hostname, () => { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) upstream.write(head); socket.pipe(upstream).pipe(socket); });
    upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy()); socket.on("close", () => upstream.destroy());
  });
  await new Promise<void>(resolve => proxyServer.listen(0, "127.0.0.1", resolve)); proxyUrl = `http://127.0.0.1:${(proxyServer.address() as { port: number }).port}`;
});
afterAll(async () => { for (const response of gates.values()) response.end("{}"); server.closeAllConnections(); proxyServer.closeAllConnections(); await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => proxyServer.close(() => resolve()))]); });

async function task(id: number, path: string, kind: "debug" | "workflow" | "suite" = "debug", script = "", upload = false, requestBaseUrl = baseUrl, configure?: (project: ContractProject) => void) {
  const project = createContractExecutionProject(baseUrl); const collection = project.collections[0]!;
  const folder = collection.folders[0]!.folders[0]!; const asset = folder.apis[0]!;
  if (asset.contract.request.protocol !== "http") throw new Error("Controlled fixture must be HTTP");
  folder.preOperations = []; folder.postOperations = []; asset.cases[0]!.preOperations = [];
  collection.variables = { marker: `run-${id}` }; project.variables = {}; project.environments = [];
  asset.contract.request.baseUrl = requestBaseUrl; asset.contract.request.path = path;
  asset.contract.request.query = []; asset.contract.request.headers = [];
  asset.contract.request.body = { kind: "json", content: '{"marker":"{{marker}}"}' };
  if (upload) asset.contract.request.body = { kind: "binary", file: { path: "payload.bin" }, contentType: "application/octet-stream" };
  if (script) collection.preOperations = [{ id: "inherited-script", type: "script", content: script }];
  project.workflows[0]!.id = workflowId;
  configure?.(project);
  const locator = { workspaceId: "workspace", groupId: "group", projectId: project.id, collectionId: collection.id, folderIds: [ids.outerFolder, ids.innerFolder], apiId: asset.contract.id };
  const invocation: DebugInvocation = { mode: "case", locator, case: { ...locator, caseId: ids.case, scope: "base" } };
  const target = kind === "debug" ? { kind, invocation } : kind === "workflow" ? { kind, workflowId } : { kind, suiteId: project.suites![0]!.id, allowDraft: false };
  const files = [...encodeContractProjectFiles(project).files].map(([path, content]) => ({ path, content, version: "1", hash: hash(content), size: Buffer.byteLength(content) })).sort((a, b) => a.path.localeCompare(b.path));
  const assets = { workspaceId: "11", groupId: "22", projectId: "33", contractProjectId: project.id, format: "contract-files-v1" as const, version: "1", files, manifestHash: hash(files.map(file => `${file.path}\0${file.version}\0${file.hash}\0${file.size}\n`).join("")) };
  const profile = script ? "trusted-core-script" : "no-script";
  const prepared = await prepareProjectFiles(assets, { target, profile });
  const executionId = String(id); const snapshotId = String(id + 1000);
  const delivery: TaskDeliveryV1 = { messageId: `delivery-${id}`, task: { protocolVersion: 1, jobId: String(id + 100), executionId, snapshotId, scope: { workspaceId: "11", groupId: "22", projectId: "33" }, submittedByUserId: "44", contractProjectId: project.id, manifestHash: assets.manifestHash, target, executionProfile: profile, dispatchKind: kind === "debug" && !script ? "shared-debug" : "dedicated-task", scriptPlanDigest: prepared.scriptPlanDigest, ...(script ? { scriptGrantVersion: "1" } : {}), requiredCoreBuildId: identity.coreBuildId, requiredCapabilities: [...prepared.prepared.requiredCapabilities], policyVersion: "1", runtimeCompatibilityId: compatibility } };
  const materials: ProjectRunMaterials = { snapshotId, scope: delivery.task.scope, credentials: [{ refId: ids.credential, version: "1", value: `secret-${id}` }], attachments: [] };
  const inputs: ExecutionInputs = { executionId, snapshot: { snapshotId, createdByUserId: "44", assets }, policy: { ...defaultPolicyConfig, cancelGraceMs: 200 }, runConfig: {}, materials: { projectId: "33", credentials: [{ refId: ids.credential, version: "1" }], attachments: [] }, inputsDigest: "0".repeat(64) };
  inputs.inputsDigest = hash(executionInputsDigestText(inputs));
  return { delivery, inputs, materials, prepared };
}
type Fixture = Awaited<ReturnType<typeof task>>;
function harness(fixtures: Fixture[], overrides: Partial<AgentConfig> = {}, permitChange?: (permit: Extract<AgentCommandV1, { kind: "start-permit" }>) => void, inputDelayMs = 0, hostSessionId = "host-1") {
  const completed: SettledExecution[] = []; const messages: AgentMessageV1[] = [];
  const config = { ...defaultAgentConfig, minFreeDiskBytes: 1, sharedDebugIdleMs: 150, ...overrides };
  const supervisor = new AgentSupervisor({ serverId: "https://control.test/api/v1", agentId: "7", sessionId: hostSessionId, runtimeCompatibilityId: compatibility, identity, config, configVersion: "1",
    loadInputs: async selected => { if (inputDelayMs) await new Promise(resolve => setTimeout(resolve, inputDelayMs)); return fixtures.find(item => item.delivery.task.executionId === selected.executionId)!.inputs; },
    loadMaterials: async selected => fixtures.find(item => item.delivery.task.executionId === selected.executionId)!.materials,
    transport: { exchange: async () => ({ deliveries: [], commands: [] }), send: async batch => {
      messages.push(...batch);
      for (const message of batch) if (message.kind === "start-request") {
        const permit: Extract<AgentCommandV1, { kind: "start-permit" }> = { kind: "start-permit", messageId: `permit-${message.executionId}`, jobId: message.jobId, executionId: message.executionId, permitId: message.executionId, policyVersion: "1", effectivePolicy: { ...defaultPolicyConfig, cancelGraceMs: 200 }, scriptPlanDigest: message.scriptPlanDigest, executionProfile: message.executionProfile, runtimeCompatibilityId: message.runtimeCompatibilityId, credentialVersions: message.credentialVersions, ...(message.scriptGrantVersion ? { scriptGrantVersion: message.scriptGrantVersion } : {}) };
        permitChange?.(permit); queueMicrotask(() => supervisor.command(permit));
      }
      return { acknowledged: batch.map(message => message.messageId) };
    } }, onSettled: result => completed.push(result),
  });
  return { supervisor, completed, messages, config };
}
function release(path: string) { gates.get(path)?.end(JSON.stringify({ value: path })); gates.delete(path); }
const wait = (assertion: () => void, timeout = 6000) => vi.waitFor(assertion, { timeout, interval: 20 });
function refix(item: Fixture) { item.inputs.inputsDigest = hash(executionInputsDigestText(item.inputs)); }
function session(item: Fixture, debugSessionId: string) {
  item.delivery.task.debugSessionId = debugSessionId;
  item.inputs.debugSession = { debugSessionId, serverId: "https://control.test/api/v1", scope: item.delivery.task.scope, submittedByUserId: "44", agentId: "7", expiresAt: "2099-01-01T00:00:00.000Z", hostSessionId: "host-1" };
  refix(item);
}

it("retains Core logical failures in the completed message and archive without rewriting physical counts", async () => {
  const debug = await task(301, "/logical-post-failure", "debug", "// trusted inherited operation", false, baseUrl, project => {
    project.collections[0]!.postOperations = [{ id: "post-failure", type: "script", content: "throw new Error('post script rejected')" }];
  });
  const suite = await task(302, "/logical-suite-no-http", "suite", "", false, baseUrl, project => {
    project.workflows[0] = WorkflowSchema.parse({ ...project.workflows[0]!, executionVersion: 2, nodes: [{ id: "assert", kind: "assert", predicate: { op: "eq", left: { kind: "literal", value: 1 }, right: { kind: "literal", value: 2 } } }] });
    project.suites = [{ formatVersion: 1, id: "10000000-0000-4000-8000-000000000094", name: "logical suite", tags: [], failFast: false, reporters: ["json"], selection: { kind: "explicit", entries: [{ id: "10000000-0000-4000-8000-000000000093", kind: "workflow", workflowId }] } }];
  });
  suite.inputs.materials.credentials = []; suite.materials.credentials = []; refix(suite);
  const { supervisor, completed, messages } = harness([debug, suite], { scriptMode: "trusted-core" });
  const start = seen.length;
  try {
    supervisor.receive(debug.delivery); supervisor.receive(suite.delivery);
    await wait(() => expect(completed).toHaveLength(2));
    const reports = supervisor.pendingReports().map(report => JSON.parse(report.text));
    const debugReport = reports.find(report => report.executionId === "301");
    const suiteReport = reports.find(report => report.executionId === "302");
    expect(debugReport).toMatchObject({ output: { kind: "debug", result: { run: { total: 1, passed: 1, failed: 0 }, failureKind: "script" } } });
    expect(suiteReport.output).toMatchObject({ kind: "suite", result: { total: 0, passed: 0, failed: 0, suite: { verdict: "failed" } } });
    expect(seen.slice(start).map(row => row.path)).toEqual(["/logical-post-failure"]);
    expect.soft(completed.map(result => result.verdict)).toEqual(["failed", "failed"]);
    expect.soft(messages.filter(message => message.kind === "completed").map(message => message.verdict)).toEqual(["failed", "failed"]);
    expect.soft(reports.map(report => report.verdict)).toEqual(["failed", "failed"]);
  } finally { await supervisor.close(); }
});

it("settles a durable start rejection without invoking the target and admits the next execution", async () => {
  const first = await task(401, '/must-not-start-rejected'), next = await task(402, '/after-rejected');
  const { supervisor, completed, messages } = harness([first, next]); const start = seen.length;
  let requested!: () => void; const startRequested = new Promise<void>(resolve => { requested = resolve; });
  const original = supervisor.options.transport.send;
  supervisor.options.transport.send = async (batch, signal) => {
    if (!batch.some(message => message.kind === 'start-request' && message.executionId === '401')) return original(batch, signal);
    messages.push(...batch); requested(); return { acknowledged: batch.map(message => message.messageId) };
  };
  const rejection = { kind: 'start-rejected', messageId: 'rejection-401', jobId: first.delivery.task.jobId, executionId: '401', reasonCode: 'script_grant_missing' };
  const transport = createLongPollingTransport({ baseUrl: 'https://control.test/api/v1', token: () => 'synthetic-control', config: () => supervisor.currentConfig, fetch: async () => Response.json({ deliveries: [], commands: [rejection] }) });
  try {
    supervisor.receive(first.delivery); await startRequested;
    expect(supervisor.command({ ...rejection, jobId: '999' } as unknown as AgentCommandV1)).toBe(false);
    expect(supervisor.capacity().availableSlots).toBe(0);expect(completed).toHaveLength(0);
    const batch = await transport.exchange({ sessionId: 'host-1', appliedConfigVersion: '1', availableSlots: 0, availableSharedDebugSlots: 0, acknowledgements: [] }, new AbortController().signal);
    for (const command of batch.commands) supervisor.command(command);
    await wait(() => expect(completed).toHaveLength(1), 1000);
    expect(completed[0]).toMatchObject({ executionId: '401', verdict: 'rejected', executionFact: 'not-started', reasonCode: 'script_grant_missing' });
    expect(supervisor.processState()).toEqual({ sharedPid: undefined, dedicatedPids: [] });
    expect(seen.slice(start)).toEqual([]);expect(supervisor.capacity().availableSlots).toBe(1);
    const report = JSON.parse(supervisor.pendingReports()[0]!.text); expect(report).toMatchObject({ verdict: 'rejected', reasonCode: 'script_grant_missing', executionFact: 'not-started' });
    supervisor.receive(next.delivery); await wait(() => expect(completed).toHaveLength(2));
    expect(completed[1]!.verdict).toBe('passed');expect(seen.slice(start).map(row => row.path)).toEqual(['/after-rejected']);
  } finally { await supervisor.close(); }
});

it("reserves one shared budget for real debug and workflow children, queues the third and drains a lowered limit", async () => {
  const a = await task(1, "/hold-debug"), b = await task(2, "/hold-workflow", "workflow"), c = await task(3, "/third");
  const { supervisor, completed, config } = harness([a, b, c], { maxConcurrentJobs: 2 });
  const start = seen.length;
  try {
    supervisor.receive(a.delivery); supervisor.receive(b.delivery); supervisor.receive(c.delivery);
    await wait(() => expect(seen.slice(start).map(row => row.path).sort()).toEqual(["/hold-debug", "/hold-workflow"]));
    const processes = supervisor.processState();
    expect(processes.sharedPid).not.toBe(process.pid); expect(processes.sharedPid).toBeGreaterThan(0);
    expect(processes.dedicatedPids).toHaveLength(1); expect(processes.dedicatedPids).not.toContain(processes.sharedPid);
    expect(supervisor.capacity().availableSlots).toBe(0);
    supervisor.applyConfig({ ...config, maxConcurrentJobs: 1 }, "2");
    release("/hold-debug"); await wait(() => expect(completed).toHaveLength(1));
    expect(seen.slice(start)).toHaveLength(2); expect(supervisor.capacity().availableSlots).toBe(0);
    release("/hold-workflow"); await wait(() => expect(completed).toHaveLength(3));
    expect(seen.slice(start).map(row => row.path)).toContain("/third");
    expect(completed.find(row => row.executionId === "2")!.pid).not.toBe(completed.find(row => row.executionId === "1")!.pid);
    expect(supervisor.processState().dedicatedPids).toEqual([]);
  } finally { release("/hold-debug"); release("/hold-workflow"); await supervisor.close(); }
});

it("reuses a real worker without crossing invocation variables, credential markers or cancellation", async () => {
  const a = await task(11, "/hold-a"), b = await task(12, "/hold-b");
  const { supervisor, completed } = harness([a, b], { maxConcurrentJobs: 2 }); const start = seen.length;
  try {
    supervisor.receive(a.delivery); supervisor.receive(b.delivery);
    await wait(() => expect(seen.slice(start)).toHaveLength(2));
    expect(seen.slice(start).map(row => [row.authorization, JSON.parse(row.body).marker]).sort()).toEqual([["Bearer secret-11", "run-11"], ["Bearer secret-12", "run-12"]]);
    supervisor.command({ kind: "cancel", messageId: "cancel-11", jobId: a.delivery.task.jobId, executionId: "11", reason: "cancel A" });
    await wait(() => expect(completed.find(row => row.executionId === "11")?.verdict).toBe("cancelled"));
    expect(completed.find(row => row.executionId === "12")).toBeUndefined();
    release("/hold-b"); await wait(() => expect(completed).toHaveLength(2));
    expect(completed[0]!.pid).toBe(completed[1]!.pid);
    expect(completed.find(row => row.executionId === "12")!.verdict).toBe("passed");
    expect(JSON.stringify(completed)).not.toContain("secret-11"); expect(JSON.stringify(completed)).not.toContain("secret-12");
  } finally { release("/hold-a"); release("/hold-b"); await supervisor.close(); }
});

it("denies changed runtime, inherited scripts without admission and mismatching permits before target side effects", async () => {
  const mismatch = await task(21, "/runtime-mismatch"), script = await task(22, "/script-denied", "debug", "pm.variables.set('marker','script')"), permit = await task(23, "/permit-mismatch");
  const fixed = await task(24, "/fixed-material-mismatch"), capacity = await task(25, "/input-capacity"), unknown = await task(26, "/unknown-preparation");
  mismatch.delivery.task.requiredCoreBuildId = "f".repeat(64);
  fixed.materials.credentials[0]!.version = "2";
  capacity.materials.credentials[0]!.value = "capacity-private".repeat(10000);
  const { supervisor, completed, messages } = harness([mismatch, script, permit, fixed, capacity, unknown], { inputCacheBytes: 100000 }, value => { value.credentialVersions = {}; }); const start = seen.length;
  const loadMaterials = supervisor.options.loadMaterials;
  supervisor.options.loadMaterials = async (selected, signal) => { if (selected.executionId === "26") throw new Error("private-exception-marker C:/private/credential.txt"); return loadMaterials(selected, signal); };
  try {
    for (const item of [mismatch, script, permit, fixed, capacity, unknown]) supervisor.receive(item.delivery);
    await wait(() => expect(completed).toHaveLength(6));
    expect(completed.map(row => row.verdict)).toEqual(["rejected", "rejected", "rejected", "rejected", "rejected", "rejected"]);
    expect(seen.length).toBe(start); expect(supervisor.processState().dedicatedPids).toEqual([]);
    expect.soft(completed.map(row => row.reasonCode)).toEqual(["runtime-mismatch", "script-admission-denied", "permit-mismatch", "fixed-input-mismatch", "input-capacity-exceeded", "preparation-rejected"]);
    expect.soft(messages.filter(message => message.kind === "completed").map(message => message.reasonCode)).toEqual(["runtime-mismatch", "script-admission-denied", "permit-mismatch", "fixed-input-mismatch", "input-capacity-exceeded", "preparation-rejected"]);
    expect(JSON.stringify({ completed, messages })).not.toContain("private-exception-marker"); expect(JSON.stringify({ completed, messages })).not.toContain("C:/private/credential.txt");
  } finally { await supervisor.close(); }
});

it("does not start the real target after cancellation while started acknowledgement is deferred", async () => {
  const item = await task(27, "/cancelled-before-invoke"); const { supervisor, completed } = harness([item]); const start = seen.length;
  let entered!: () => void; let releaseStarted!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { releaseStarted = resolve; });
  const send = supervisor.options.transport.send;
  supervisor.options.transport.send = async (batch, signal) => { if (batch.some(message => message.kind === "started")) { entered(); await gate; } return send(batch, signal); };
  try {
    supervisor.receive(item.delivery); await started;
    expect(supervisor.processState().sharedPid).toBeGreaterThan(0); expect(seen.length).toBe(start);
    supervisor.command({ kind: "cancel", messageId: "cancel-before-invoke", jobId: item.delivery.task.jobId, executionId: "27", reason: "cancel during started exchange" });
    releaseStarted(); await wait(() => expect(completed).toHaveLength(1));
    expect(seen.slice(start)).toEqual([]); expect(completed[0]!.verdict).toBe("cancelled");
    expect(supervisor.capacity().availableSlots).toBe(1);
  } finally { releaseStarted(); await supervisor.close(); }
});

it("preserves an explicit authorized Cookie session across shared, dedicated and recycled workers while isolating scope", async () => {
  const first = await task(31, "/set-cookie"), second = await task(32, "/cookie-dedicated", "debug", "pm.assert(true,'approved')"), third = await task(33, "/cookie-recycled"), other = await task(34, "/cookie-other");
  for (const item of [first, second, third]) session(item, "session-one"); session(other, "session-other");
  const bad = await task(35, "/cookie-bad"); session(bad, "session-one"); bad.inputs.debugSession!.submittedByUserId = "45"; refix(bad);
  const expired = await task(37, "/cookie-expired"); session(expired, "expired-session"); expired.inputs.debugSession!.expiresAt = "2000-01-01T00:00:00.000Z"; refix(expired);
  const { supervisor, completed } = harness([first, second, third, other, bad, expired], { scriptMode: "trusted-core" }); const start = seen.length;
  try {
    supervisor.receive(first.delivery); await wait(() => expect(completed).toHaveLength(1));
    expect(completed[0]!.verdict).toBe("passed");
    const firstPid = completed[0]!.pid;
    supervisor.receive(second.delivery); await wait(() => expect(completed).toHaveLength(2));
    await wait(() => expect(supervisor.processState().sharedPid).toBeUndefined());
    supervisor.receive(third.delivery); await wait(() => expect(completed).toHaveLength(3));
    supervisor.receive(other.delivery); supervisor.receive(bad.delivery); await wait(() => expect(completed).toHaveLength(5));
    expect(seen.slice(start).map(row => [row.path, row.cookie])).toEqual([["/set-cookie", undefined], ["/cookie-dedicated", "login=host-memory-cookie"], ["/cookie-recycled", "login=host-memory-cookie"], ["/cookie-other", undefined]]);
    expect(completed[2]!.pid).not.toBe(firstPid); expect(completed[4]!.verdict).toBe("rejected");
    expect.soft(completed[4]!.reasonCode).toBe("debug-session-scope-mismatch");
    supervisor.receive(expired.delivery); await wait(() => expect(completed).toHaveLength(6)); expect.soft(completed[5]!.reasonCode).toBe("debug-session-expired");
    expect(JSON.stringify(completed)).not.toContain("host-memory-cookie");
    const stale = await task(36, "/cookie-old-host"); session(stale, "session-one"); const restarted = harness([stale], {}, undefined, 0, "host-2"); const beforeRestarted = seen.length;
    try { restarted.supervisor.receive(stale.delivery); await wait(() => expect(restarted.completed).toHaveLength(1)); expect(restarted.completed[0]!.verdict).toBe("rejected"); expect.soft(restarted.completed[0]!.reasonCode).toBe("debug-session-expired"); expect(seen.length).toBe(beforeRestarted); }
    finally { await restarted.supervisor.close(); }
  } finally { await supervisor.close(); }
});

it("keeps explicitly declared upload files alive through the real Core HTTP consumer", async () => {
  const item = await task(41, "/upload", "debug", "", true); const bytes = Buffer.from("ordinary-upload-from-fixed-attachment"); const fileHash = hash(bytes);
  item.inputs.materials.attachments = [{ refId: "upload", version: "1", hash: fileHash }];
  item.inputs.materials.attachmentPaths = { "payload.bin": { refId: "upload", version: "1", hash: fileHash } };
  item.materials.attachments = [{ refId: "upload", version: "1", hash: fileHash, size: bytes.length, kind: "file", contentBase64: bytes.toString("base64") }]; refix(item);
  const { supervisor, completed } = harness([item]); const start = seen.length;
  try { supervisor.receive(item.delivery); await wait(() => expect(completed).toHaveLength(1)); expect(seen.slice(start).map(row => row.body)).toEqual(["ordinary-upload-from-fixed-attachment"]); expect(completed[0]!.verdict).toBe("passed"); }
  finally { await supervisor.close(); }
});

it("prepares the actual network profile and binds network secret versions into start permission", async () => {
  const fixture = (name: string) => readFile(new URL(`../../../packages/core/tests/http/fixtures/network/${name}`, import.meta.url), "utf8");
  const [ca, cert, key, clientCert, clientKey] = await Promise.all([fixture("synthetic-target-ca.pem"), fixture("synthetic-target-server.pem"), fixture("synthetic-target-server.key"), fixture("synthetic-client.pem"), fixture("synthetic-client.key")]);
  let authorized = false;
  const tlsTarget = createHttpsServer({ ca, cert, key, requestCert: true, rejectUnauthorized: true }, (request, response) => {
    authorized = (request.socket as TLSSocket).authorized; let body = ""; request.on("data", data => { body += data; }); request.on("end", () => { seen.push({ path: request.url!, body }); response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ networkEcho: "proxy-private-value", networkBasic: `Basic ${Buffer.from("proxy-user:proxy-private-value").toString("base64")}` })); });
  });
  await new Promise<void>(resolve => tlsTarget.listen(0, "127.0.0.1", resolve)); const tlsOrigin = `https://127.0.0.1:${(tlsTarget.address() as { port: number }).port}`;
  const item = await task(51, "/network", "debug", "", false, tlsOrigin);
  item.inputs.materials.credentials.push({ refId: "network-password", version: "2" });
  item.materials.credentials.push({ refId: "network-password", version: "2", value: "proxy-private-value" });
  item.inputs.materials.credentials.push({ refId: "client-key", version: "3" }); item.materials.credentials.push({ refId: "client-key", version: "3", value: clientKey });
  item.inputs.materials.attachmentPaths = {};
  for (const [refId, content, path] of [["ca", ca, "certs/ca.pem"], ["client-cert", clientCert, "certs/client.pem"]]) { const selected = { refId: refId!, version: "1", hash: hash(content!) }; item.inputs.materials.attachments.push(selected); item.inputs.materials.attachmentPaths[path!] = selected; item.materials.attachments.push({ ...selected, kind: "network-public", size: Buffer.byteLength(content!), contentBase64: Buffer.from(content!).toString("base64") }); }
  item.inputs.network = { revision: "network-revision-1", configuration: { formatVersion: 1, profiles: [{ kind: "proxy", id: "proxy-one", name: "controlled proxy", proxyUrl, username: "proxy-user", passwordRef: { id: "network-password", policy: "test-auto" }, targetTlsBindings: [{ origin: tlsOrigin, tls: { caCertificatePaths: [declaredNetworkPath("certs/ca.pem")], clientCertificatePaths: [declaredNetworkPath("certs/client.pem")], clientPrivateKeyRef: { id: "client-key", policy: "test-auto" } } }] }], projectSelection: { kind: "profile", profileId: "proxy-one" }, environmentSelections: [] } }; refix(item);
  const { supervisor, completed, messages } = harness([item]); const start = seen.length;
  const proxyStart = proxyAuthorizations.length;
  try {
    supervisor.receive(item.delivery); await wait(() => expect(completed).toHaveLength(1));
    expect(JSON.stringify(completed)).not.toContain("proxy-private-value");
    expect(JSON.stringify(completed)).not.toContain(Buffer.from("proxy-user:proxy-private-value").toString("base64"));
    expect(proxyAuthorizations.slice(proxyStart)).toEqual([`Basic ${Buffer.from("proxy-user:proxy-private-value").toString("base64")}`]);
    expect(seen.slice(start)).toHaveLength(1);
    expect(messages.find(message => message.kind === "start-request")).toMatchObject({ credentialVersions: { [ids.credential]: "1", "network-password": "2", "client-key": "3" } });
    expect(authorized).toBe(true);
    expect(completed[0]!.verdict).toBe("passed"); expect(JSON.stringify(completed)).not.toContain("proxy-private-value");
  } finally { await supervisor.close(); tlsTarget.closeAllConnections(); await new Promise<void>(resolve => tlsTarget.close(() => resolve())); }
});

it("uses the fixed effective preparation policy rather than process defaults before target requests", async () => {
  const item = await task(61, "/policy-denied", "debug", "pm.assert(true,'approved')");
  item.inputs.policy = { ...defaultPolicyConfig, scriptTimeoutMs: 1, maxScriptTimeoutMs: 2 }; item.inputs.runConfig.scriptTimeoutMs = 3; refix(item);
  const { supervisor, completed } = harness([item], { scriptMode: "trusted-core" }); const start = seen.length;
  try { supervisor.receive(item.delivery); await wait(() => expect(completed).toHaveLength(1)); expect(seen.slice(start)).toEqual([]); expect(completed[0]!.verdict).toBe("rejected"); expect.soft(completed[0]!.reasonCode).toBe("policy-mismatch"); }
  finally { await supervisor.close(); }
});

it("counts preparation time against the original admission deadline without starting a child afterwards", async () => {
  const item = await task(62, "/expired-in-preparation"); item.inputs.policy = { ...defaultPolicyConfig, defaultJobTimeoutMs: 50, cancelGraceMs: 5 }; refix(item);
  const { supervisor, completed, messages } = harness([item], {}, undefined, 80); const start = seen.length;
  try { supervisor.receive(item.delivery); await wait(() => expect(completed).toHaveLength(1)); expect(completed[0]!.verdict).toBe("timed-out"); expect(completed[0]!.pid).toBeUndefined(); expect(messages.some(message => message.kind === "started")).toBe(false); expect(seen.slice(start)).toEqual([]); }
  finally { await supervisor.close(); }
});

it("reports a new child heap configuration pending until the old shared generation drains", async () => {
  const item = await task(63, "/hold-config"); const { supervisor, completed, config } = harness([item]); const start = seen.length;
  try {
    supervisor.receive(item.delivery); await wait(() => expect(seen.slice(start)).toHaveLength(1)); const pid = supervisor.processState().sharedPid;
    supervisor.applyConfig({ ...config, childMaxOldSpaceMiB: 128 }, "2");
    expect(supervisor.configurationState()).toMatchObject({ configVersion: "2", appliedConfigVersion: "1", status: "pending", pendingFields: ["childMaxOldSpaceMiB"] });
    expect(supervisor.processState().sharedPid).toBe(pid); expect(completed).toEqual([]);
    release("/hold-config"); await wait(() => expect(completed).toHaveLength(1)); await wait(() => expect(supervisor.configurationState().status).toBe("applied"));
  } finally { release("/hold-config"); await supervisor.close(); }
});
