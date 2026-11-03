import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { vi } from "vitest";
import { createDefaultRegistry, fileStorage, encodeContractProjectFiles, type Workspace, type ContractProject } from "@apicc/core";
import { prepareExecution, invokeExecution, createExecutionRegistry, type PreparedExecution, type InvocationOutput } from "@apicc/execution/host";
import { defaultPolicyConfig, defaultAgentConfig, runtimeCompatibilityIdForRuntime } from "@apicc/execution/contract";
import { readBuildIdentity } from "@apicc/execution/buildIdentity";
import { createMcpSource } from "../src/mcp/source.js";
import { loginMcpProfile } from "../src/mcp/profiles.js";
import type { McpPrepareInput, McpLocalExecutionHost } from "../src/mcp/execution.js";
import { executionCapabilityFor } from "../src/mcp/executionCapabilities.js";
import { onlineFixture, oid } from "./mcp-online.fixture.js";
import { FullOnlineJobSchema } from '@apicc/execution/client';

export const signal = () => new AbortController().signal;
export async function outcome<T>(action: () => Promise<T>) {
  try { return { value: await action(), error: null }; }
  catch (error) { return { value: undefined, error: error instanceof Error ? error.message : String(error) }; }
}
export function observeActualPreparation(source: Parameters<typeof executionCapabilityFor>[0]) {
  const capability = executionCapabilityFor(source);
  if (capability.kind !== "online") throw new Error("online test fixture required");
  const observed = vi.spyOn(capability.member, "prepare");
  return { member: capability.member, prepared: async () => await observed.mock.results[0]!.value };
}

/** By default material-free; optional saved-definition changes still use actual fileStorage/Core. */
export async function localCaseExecutionFixture(options: { responseBody?: string; responseGate?: (requestIndex: number) => Promise<void>; beforeRegistryClose?: () => Promise<void>; configureProject?: (project: ContractProject, materials: { driverPath: string }) => void; tls?: { cert: Buffer; key: Buffer } } = {}) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "apicc-mcp-local-case-"));
  const privateRoot = mkdtempSync(join(tmpdir(), "apicc-mcp-local-private-"));
  const materialRoot = mkdtempSync(join(tmpdir(), "apicc-mcp-local-material-"));
  const driverPath = join(materialRoot, "rows.csv");
  let release!: () => void;
  const responseGate = new Promise<void>(resolve => { release = resolve; });
  const requests: Array<{ method: string; url: string }> = [];
  const authorizations: Array<string | undefined> = [];
  const requestBodies: Buffer[] = [];
  let earlyConnectionCloses = 0;
  const closedBeforeReply: string[] = [];
  const handleRequest = (request: IncomingMessage, response: ServerResponse) => {
    const requestIndex = requests.length;
    requests.push({ method: request.method!, url: request.url! });
    authorizations.push(request.headers.authorization);
    const body: Buffer[] = [];
    request.on("data", chunk => body.push(Buffer.from(chunk)));
    request.once("end", () => requestBodies.push(Buffer.concat(body)));
    response.once("close", () => { if (!response.writableEnded) { earlyConnectionCloses++; closedBeforeReply.push(request.url!); } });
    void responseGate.then(async () => { await options.responseGate?.(requestIndex); response.setHeader("content-type", "application/json"); response.end(options.responseBody ?? '{"ok":true}'); });
  };
  const server = options.tls ? createHttpsServer(options.tls, handleRequest) : createServer(handleRequest);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `${options.tls ? "https" : "http"}://127.0.0.1:${(server.address() as { port: number }).port}`;
  const project: ContractProject = { id: oid(3), name: "local-case-project", variables: {}, globals: { query: [], headers: [], cookies: [], body: [] }, collections: [{ id: oid(4), name: "saved-cases", variables: {}, preOperations: [], postOperations: [], folders: [], apis: [{ contract: { formatVersion: 1, id: oid(5), metadata: { name: "saved-local-case", description: "", tags: [], version: "1", status: "published" }, request: { protocol: "http", method: "GET", baseUrl, path: "/saved-case", pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" }, body: { kind: "none" } }, responses: [{ kind: "inline", id: oid(7), status: "200", description: "success", headers: {}, content: {} }] }, documentation: "", cases: [{ id: oid(6), name: "saved-case", scope: "base", parameters: {}, preOperations: [], postOperations: [], assertions: [] }] }] }], models: [], components: [], workflows: [], environments: [], stressPolicy: {} };
  options.configureProject?.(project, { driverPath });
  const workspace: Workspace = { formatVersion: 1, id: oid(1), name: "local-case-workspace", variables: {}, groups: [{ id: oid(2), name: "group", projects: [project] }] };
  const initial = await fileStorage.load(workspaceRoot);
  await fileStorage.save(workspaceRoot, workspace, { expectedRevision: initial.revision, deletions: [] });
  const source = await createMcpSource({ workspace: workspaceRoot, registry: createDefaultRegistry() });
  const locator = { workspaceId: oid(1), groupId: oid(2), projectId: oid(3), collectionId: oid(4), folderIds: [], apiId: oid(5) };
  const input: McpPrepareInput = { projectId: oid(3), location: { kind: "local" }, target: { kind: "debug", invocation: { mode: "case", locator, case: { ...locator, caseId: oid(6), scope: "base" } } } };
  const preparations: PreparedExecution[] = [];
  const invocations: Array<{ prepared: PreparedExecution; runId: string; signal: AbortSignal; output: Promise<InvocationOutput>; settled: boolean }> = [];
  const localHost: McpLocalExecutionHost = {
    prepare(snapshot, target, environmentId) {
      const prepared = prepareExecution({ snapshot, target, environmentId, profile: "no-script" });
      preparations.push(prepared);
      return prepared;
    },
    start(prepared, runId, runSignal) {
      const output = invokeExecution(prepared, { workspaceRoot, credentialBindings: { versions: {}, resolve() { throw new Error("Unexpected credential in the material-free local case"); } } }, { signal: runSignal,
        ...(options.beforeRegistryClose ? { registryFactory: async (settings: Parameters<typeof createExecutionRegistry>[0]) => {
          const registry = createExecutionRegistry(settings);
          const close = registry.close;
          registry.close = async () => { try { await options.beforeRegistryClose!(); } finally { await close(); } };
          return registry;
        } } : {}),
      });
      const invocation = { prepared, runId, signal: runSignal, output, settled: false };
      void output.then(() => { invocation.settled = true; }, () => { invocation.settled = true; });
      invocations.push(invocation);
      return output;
    },
  };
  return { source, input, privateRoot, workspaceRoot, materialPath: driverPath, localHost, preparations, invocations, requests, authorizations, requestBodies, release, baseUrl, closedBeforeReply, earlyConnectionCloses: () => earlyConnectionCloses,
    writeDriver(content: string) { writeFileSync(driverPath, content); },
    async changeDefinition() {
      const state = await fileStorage.load(workspaceRoot);
      const changed = structuredClone(workspace);
      changed.groups[0]!.projects[0]!.collections[0]!.apis[0]!.contract.request.path = "/changed-after-prepare";
      await fileStorage.save(workspaceRoot, changed, { expectedRevision: state.revision, deletions: [] });
    },
    async close() {
      release();
      await Promise.allSettled(invocations.map(invocation => invocation.output));
      await source.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      for (const root of [workspaceRoot, privateRoot, materialRoot]) rmSync(root, { recursive: true, force: true });
    },
  };
}

/** One actual online source/member; two saved local cases share this owned loopback target. */
export async function onlineLocalCaseExecutionFixture() {
  const target = await localCaseExecutionFixture();
  const f = await executionFixture("online", { configureProject(project) {
    const asset = project.collections[0]!.apis[0]!;
    asset.contract.request.baseUrl = target.baseUrl; asset.contract.request.path = "/saved-case";
    asset.contract.request.auth = { kind: "none" };
    if (asset.contract.request.protocol === "http") asset.contract.request.body = { kind: "none" };
    const other = structuredClone(asset);
    other.contract.id = oid(8); other.contract.request.path = "/other-owned-case"; other.cases[0]!.id = oid(9);
    project.collections[0]!.apis.push(other);
  } });
  if (f.input.target.kind !== "debug") throw new Error("saved debug fixture required");
  const locator = { ...f.input.target.invocation.locator, apiId: oid(8) };
  const input: McpPrepareInput = { ...f.input, location: { kind: "local" } };
  const otherInput: McpPrepareInput = { ...input, target: { kind: "debug", invocation: { mode: "case", locator, case: { ...locator, caseId: oid(9), scope: "base" } } } };
  return { ...f, input, otherInput, agentInput: f.input, target,
    async close() { target.release(); await f.close(); await target.close(); },
  };
}

export async function executionFixture(kind: "local" | "online" = "online", options: { configureProject?: (project: ContractProject) => void; beforeSubmit?: () => Promise<void>; beforeSnapshot?: () => Promise<void>; rejectPrepare?: { status: number; code: string }; loseSubmitResponse?: boolean; rejectSubmit?: { status: number; code: string } } = {}) {
  const f = await onlineFixture();
  if (options.configureProject) {
    options.configureProject(f.project);
    f.assets.files = [...encodeContractProjectFiles(f.project).files].map(([path, content]) => ({ path, content, version: "1", hash: createHash("sha256").update(content).digest("hex"), size: Buffer.byteLength(content) }));
  }
  const privateRoot = mkdtempSync(join(tmpdir(), "apicc-mcp-execution-private-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "apicc-mcp-execution-workspace-"));
  const identity = await readBuildIdentity();
  const scope = { workspaceId: "1", groupId: "2", projectId: "3" };
  f.assets.manifestHash = createHash("sha256").update([...f.assets.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(file => `${file.path}\0${file.version}\0${file.hash}\0${file.size}\n`).join("")).digest("hex");
  const configuration = { configVersion: "0", appliedConfigVersion: "0", pendingFields: [], restartRequiredFields: [], status: "applied" };
  const accepted = new Map<string, { submission: unknown; job: unknown }>();
  let intentVisible = true;
  let minimumViews = false;
  const memberJob = (value: unknown) => {
    if (!minimumViews) return value;
    const job = FullOnlineJobSchema.parse(value);
    return { jobId:job.jobId, executionId:job.executionId, agentId:job.agentId, state:job.state, cancelState:job.cancelState, executionReleased:job.executionReleased, canCancel:true, view:'active-status', scope:job.task.scope };
  };
  const counts = { submissions: 0, verifications: 0, business: 0 };
  const controlRequests: Array<{ url: string; method: string; authorization: string | null }> = [];
  const cancellations: Array<{ url: string; method: string; body: unknown }> = [];
  const materialSignals: AbortSignal[] = [];
  let profileReads = 0;
  const keyringEntry = f.deps.mcpKeyringEntry!;
  f.deps.mcpKeyringEntry = (service, account) => {
    const entry = keyringEntry(service, account);
    return { ...entry, async getPassword() { profileReads++; return entry.getPassword(); } };
  };
  const fallback = f.deps.mcpFetch!;
  f.deps.mcpFetch = async (url, init) => {
    const address = String(url);
    controlRequests.push({ url: address, method: init?.method ?? "GET", authorization: new Headers(init?.headers).get("authorization") });
    if (address.startsWith("https://business.example")) { counts.business++; return Response.json({ ok: true }); }
    if (address.endsWith("/execution-agents")) return Response.json({ defaultAgentId: "5", canManageScripts: false, policy: defaultPolicyConfig, policyVersion: "0", agents: [{ id: "5", name: "Fixed agent", acceptingJobs: true, availability: "available", lastSeenAt: "2026-10-30T00:00:00Z", policy: defaultPolicyConfig, policyVersion: "0", scriptsAllowed: false, scriptGrant: { scope: "script-version", version: "0", scripts: [] }, configuration,
      stressConfiguration: { agent: { maxConcurrentStressJobs: defaultAgentConfig.maxConcurrentStressJobs, maxStressProcesses: defaultAgentConfig.maxStressProcesses, maxStressVus: defaultAgentConfig.maxStressVus, maxStressRequestConcurrency: defaultAgentConfig.maxStressRequestConcurrency, maxStressRps: defaultAgentConfig.maxStressRps, maxStressMetricMemoryBytes: defaultAgentConfig.maxStressMetricMemoryBytes }, sources: { "agent.maxStressRequestConcurrency": "default", "agent.maxStressRps": "default", "policy.maxStressRequestConcurrency": "default", "policy.maxStressRps": "default" } },
      runtime: { protocolVersion: 1, sessionId: "fixture-host", coreBuildId: identity.coreBuildId, scriptApiId: identity.scriptApiId, capabilities: identity.capabilities, nodeVersion: process.versions.node, v8Version: process.versions.v8, runtimeCompatibilityId: runtimeCompatibilityIdForRuntime(process.versions.node, process.versions.v8, identity.scriptApiId), configuration } }] });
    if (address.endsWith("/execution-snapshots")) { await options.beforeSnapshot?.(); if (options.rejectPrepare) return Response.json({ code: options.rejectPrepare.code, message: "SYNTHETIC_PREPARE_PRIVATE_RESPONSE" }, { status: options.rejectPrepare.status }); return Response.json({ snapshotId: "66", createdByUserId: "7", assets: f.assets }); }
    if (address.endsWith("/local-materials")) { if (init?.signal) materialSignals.push(init.signal); return Response.json({ snapshotId: "66", scope, credentials: [], attachments: [] }); }
    if (address.includes("/jobs/by-intent?")) {
      const prior = intentVisible ? accepted.get(new URL(address).searchParams.get("intentId")!) : undefined;
      return prior ? Response.json(memberJob(prior.job)) : Response.json({ code: "job_not_found" }, { status: 404 });
    }
    if (address.endsWith("/jobs/by-intent/verify")) {
      counts.verifications++;
      const body = JSON.parse(String(init?.body));
      const prior = accepted.get(body.intentId);
      return prior && isDeepStrictEqual(body, prior.submission) ? Response.json(memberJob(prior.job)) : Response.json({ code: "intent_conflict" }, { status: 409 });
    }
    if (address.includes("/projects/3/jobs?")) {
      const query = new URL(address).searchParams, before = query.get("beforeJobId"), limit = Number(query.get("limit"));
      const jobs = [...accepted.values()].map(entry => entry.job as { jobId: string }).sort((a, b) => Number(b.jobId) - Number(a.jobId));
      return Response.json(jobs.filter(job => !before || Number(job.jobId) < Number(before)).slice(0, limit));
    }
    const jobPath = address.match(/\/jobs\/([0-9]+)(\/cancel)?$/);
    if (jobPath) {
      const prior = [...accepted.values()].find(entry => (entry.job as { jobId: string }).jobId === jobPath[1]);
      if (!prior) return Response.json({ code: "job_not_found" }, { status: 404 });
      if (jobPath[2] && init?.method === "POST") {
        cancellations.push({ url: address, method: init.method, body: JSON.parse(String(init.body)) });
        prior.job = { ...(prior.job as Record<string, unknown>), cancelState: "requested" };
      }
      return Response.json(prior.job);
    }
    if (address.endsWith("/jobs") && init?.method === "POST") {
      await options.beforeSubmit?.();
      counts.submissions++;
      const body = JSON.parse(String(init.body));
      if (options.rejectSubmit) return Response.json({ code: options.rejectSubmit.code, message: "SYNTHETIC_PRIVATE_SERVER_ERROR_BODY" }, { status: options.rejectSubmit.status });
      if (accepted.has(body.intentId)) return Response.json({ code: "unexpected_resubmit" }, { status: 409 });
      const { scriptRequirements: _requirements, ...preparation } = body.preparation;
      const jobId = String(98 + counts.submissions), executionId = String(99 + counts.submissions);
      const job = { jobId, executionId, agentId: "5", state: "queued", cancelState: "none", executionReleased: false, reportState: "none", task: { protocolVersion: 1, jobId, executionId, scope, submittedByUserId: "7", contractProjectId: f.project.id, snapshotId: body.snapshotId, target: body.target, ...(body.environmentId ? { environmentId: body.environmentId } : {}), policyVersion: "0", ...preparation } };
      accepted.set(body.intentId, { submission: body, job });
      if (options.loseSubmitResponse) throw new Error("synthetic-submit-response-lost");
      return Response.json(memberJob(job));
    }
    return fallback(url, init);
  };
  if (kind === "local") {
    const workspace: Workspace = { formatVersion: 1, id: oid(1), name: "workspace", variables: {}, groups: [{ id: oid(2), name: "group", projects: [f.project] }] };
    const initial = await fileStorage.load(workspaceRoot);
    await fileStorage.save(workspaceRoot, workspace, { expectedRevision: initial.revision, deletions: [] });
  }
  const source = await createMcpSource(kind === "online" ? { onlineProfile: "online-member", ...f.deps } : { workspace: workspaceRoot, registry: createDefaultRegistry() });
  const locator = { workspaceId: kind === "online" ? "1" : oid(1), groupId: kind === "online" ? "2" : oid(2), projectId: f.project.id, collectionId: oid(4), folderIds: [], apiId: oid(5) };
  const input: McpPrepareInput = { projectId: kind === "online" ? "3" : f.project.id, location: { kind: "agent", agentId: "5" }, target: { kind: "debug", invocation: { mode: "case", locator, case: { ...locator, caseId: oid(6), scope: "base" } } } };
  return { source, input, counts, controlRequests, cancellations, materialSignals, assets: f.assets, profileReads: () => profileReads, privateRoot,
    meStatus: f.meStatus,
    relogin: () => loginMcpProfile({ id: "online-member", server: "https://service.example", username: "member", password: "ONLINE_SYNTHETIC_PASSWORD", scopes: [scope] }, f.deps),
    reopen: () => createMcpSource({ onlineProfile: "online-member", ...f.deps }),
    setMinimumViews(value: boolean) { minimumViews = value; }, setIntentVisible(value: boolean) { intentVisible = value; }, async close() {
    await source.close();
    for (const root of [f.home, privateRoot, workspaceRoot]) rmSync(root, { recursive: true, force: true });
  } };
}
