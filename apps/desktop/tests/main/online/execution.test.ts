import { describe, expect, it, vi } from "vitest";
const secretNamespaces = vi.hoisted(() => new Map<string, Map<string, string>>());
vi.mock('@apicc/core', async original => {
  const core = await original<typeof import('@apicc/core')>();
  return { ...core, createSystemSecretStore: (options: { privateRoot: string }) => {
    const values = secretNamespaces.get(options.privateRoot) ?? new Map<string, string>(); secretNamespaces.set(options.privateRoot, values);
    return { async put(scope: object, ref: { id: string }, value: string) { values.set(`${JSON.stringify(scope)}:${ref.id}`, value); }, async resolve(scope: object, ref: { id: string }) { return values.get(`${JSON.stringify(scope)}:${ref.id}`) ?? ''; }, async version() { return '1'; }, async remove(scope: object, ref: { id: string }) { values.delete(`${JSON.stringify(scope)}:${ref.id}`); }, async status() { return 'available'; } };
  } };
});
import { createOnlineExecutionHost } from "../../../src/main/online/execution.js";
import { createOnlineSession } from "../../../src/main/online/session.js";
import { createOnlineClient } from "../../../src/main/online/client.js";
import type { OnlineExecutionContext, OnlineExecutionInput } from "../../../src/shared/online/execution.js";
import { ContractWorkspaceSchema, encodeContractProjectFiles } from "@apicc/core";
import { workspaceFixture } from "../../../../../packages/core/tests/helpers/contractFixtures.js";
import { projectAssetsManifestHash } from "@apicc/execution/host";
import { createHash, randomUUID } from "node:crypto";
import { defaultAgentConfig, defaultPolicyConfig, runtimeCompatibilityIdForRuntime } from "@apicc/execution/contract";
import { readBuildIdentity } from "@apicc/execution/buildIdentity";
import type { ContractProject } from "@apicc/core";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginsRuntime } from "../../../src/main/plugins/runtime.js";
import { OnlineLocalResultSchema } from "../../../src/shared/online/execution.js";
import { createIpcDeps } from "../../../src/main/ipc.js";
import { createSession } from "../../../src/main/session.js";
import { createOnlineExecutionStore } from "../../../src/renderer/src/stores/onlineExecution.js";
import { createOnlineProjectAdapter } from "../../../src/renderer/src/stores/onlineProjectAdapter.js";
import type { ApiccApi } from "../../../src/shared/types.js";
import { stressV2Report } from '../../helpers/stressV2.js';
import { StressPlanSchema } from '@apicc/core/schema';
import { execFileSync } from 'node:child_process';

// OS observation stays in the test harness; no product-only testing API or private argv output.
function ownedNodeDescendants() {
  if (process.platform !== 'win32') {
    const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,comm='], { encoding: 'utf8' }).trim().split('\n').map(line => { const [pid, parent, name] = line.trim().split(/\s+/); return { pid: Number(pid), parent: Number(parent), name }; });
    const owned = new Set([process.pid]); let changed = true;
    while (changed) { changed = false; for (const row of rows) if (owned.has(row.parent) && !owned.has(row.pid) && (row.name === 'node' || row.name === 'electron' || row.name === 'apicc')) { owned.add(row.pid); changed = true; } }
    return [...owned].filter(pid => pid !== process.pid);
  }
  const rows = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true })) as Array<{ ProcessId: number; ParentProcessId: number; Name: string }>;
  const owned = new Set([process.pid]); let changed = true;
  while (changed) { changed = false; for (const row of rows) if (owned.has(row.ParentProcessId) && !owned.has(row.ProcessId) && row.Name.toLowerCase() === 'node.exe') { owned.add(row.ProcessId); changed = true; } }
  return [...owned].filter(pid => pid !== process.pid);
}
function processCommandLine(pid: number) {
  if (process.platform !== 'win32') return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`], { encoding: 'utf8', windowsHide: true });
}

const context: OnlineExecutionContext = { serverId: "https://control.test/api/v1", ownerId: "7", scope: { workspaceId: "11", groupId: "22", projectId: "33" } };
function stressConfigurationFixture() {
  const { maxConcurrentStressJobs, maxStressProcesses, maxStressVus, maxStressRequestConcurrency, maxStressRps, maxStressMetricMemoryBytes } = defaultAgentConfig;
  return { agent: { maxConcurrentStressJobs, maxStressProcesses, maxStressVus, maxStressRequestConcurrency, maxStressRps, maxStressMetricMemoryBytes }, sources: { 'agent.maxStressRequestConcurrency': 'default', 'agent.maxStressRps': 'default', 'policy.maxStressRequestConcurrency': 'default', 'policy.maxStressRps': 'default' } };
}
function assetsFixture(configure?: (project: ContractProject) => void) {
  const project = ContractWorkspaceSchema.parse(workspaceFixture()).groups[0]!.projects[0]!;
  project.collections[0]!.preOperations = []; project.collections[0]!.apis[0]!.cases[0]!.preOperations = [];
  project.workflows = [{ id: "00000000-0000-4000-8000-000000000091", name: "No target requests", status: "enabled", nodes: [{ id: "only", kind: "noop" }], edges: [] }];
  configure?.(project);
  const files = [...encodeContractProjectFiles(project).files].map(([path, content]) => ({ path, content, version: "1", hash: createHash("sha256").update(content).digest("hex"), size: Buffer.byteLength(content) }));
  return { project, assets: { ...context.scope, format: "contract-files-v1" as const, contractProjectId: project.id, version: "1", manifestHash: projectAssetsManifestHash(files), files } };
}
async function fixture(extra?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined) {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url); requests.push({ url: path, method: init?.method ?? "GET", body: init?.body && JSON.parse(String(init.body)) });
    if (path.endsWith("/auth/login")) return Response.json({ token: "member-token", expiresAt: "2027-01-01T00:00:00Z", user: { id: "7", username: "member", displayName: "Member", role: "USER", disabled: false } });
    const custom = await extra?.(path, init); if (custom) return custom;
    if (path.endsWith("/jobs/99")) return Response.json({ jobId: "99", executionId: "100", agentId: "5", state: "ended", cancelState: "none", executionReleased: true, reportState: "pending", task: { protocolVersion: 1, jobId: "99", executionId: "100", scope: context.scope, submittedByUserId: "7", contractProjectId: "00000000-0000-4000-8000-000000000018", snapshotId: "66", manifestHash: "a".repeat(64), target: { kind: "workflow", workflowId: "00000000-0000-4000-8000-000000000091" }, policyVersion: "0", requiredCoreBuildId: "b".repeat(64), scriptPlanDigest: "c".repeat(64), executionProfile: "no-script", runtimeCompatibilityId: "persisted-controlled-runtime", dispatchKind: "dedicated-task", requiredCapabilities: ["task:workflow"] } });
    return Response.json({ code: "unexpected_test_request", message: path }, { status: 400 });
  };
  const session = createOnlineSession({ createClient: (baseUrl, hooks) => createOnlineClient({ baseUrl, fetch: fetcher, onUnauthorized: hooks.onUnauthorized }), tokenStore: { save() {}, load() { return null; }, clear() {} } });
  await session.login({ baseUrl: "https://control.test", username: "member", password: "password" });
  session.openWorkspace({ workspaceId: "11", name: "Workspace", myRole: "EDITOR" });
  return { session, requests, fetcher, host: createOnlineExecutionHost({ session, fetch: fetcher }) };
}
describe("online execution main boundary", () => {
  // Added after implementation: a disclosed sequence exception, not historical RED evidence.
  it('bounds local worker count by the real project policy before allocating children', async () => {
    const plan = StressPlanSchema.parse({ formatVersion: 1, target: { kind: 'workflow', workflowId: '00000000-0000-4000-8000-000000000091' }, load: { kind: 'constant-vus', vus: 2 }, maxVus: 2, termination: { maxIterations: 2 } });
    const f = await fixture(url => url.endsWith('/execution-agents') ? Response.json({ agents: [], defaultAgentId: null, canManageScripts: false, policyVersion: '0', policy: { ...defaultPolicyConfig, maxStressWorkers: 1 } }) : undefined);
    try {
      await expect(f.host.handle({ context, operation: 'run', runId: randomUUID(), location: { kind: 'local' }, target: { kind: 'stress', plan }, expectedVersion: '1', runConfig: { stress: { workerCount: 2, confirmedTargetOrigins: [] } }, materials: { projectId: '33', credentials: [], attachments: [] }, localOnlyRefIds: [] })).rejects.toThrow('stress-worker-policy-exceeded');
      expect(f.requests.some(request => request.url.endsWith('/execution-snapshots'))).toBe(false); expect(ownedNodeDescendants()).toEqual([]);
    } finally { await f.host.close(); }
  });
  it.each(['none', 'outer', 'plan', 'same'] as const)('accepts the fixed stress environment when supplied by %s', async source => {
    const report = stressV2Report(); report.projectId = '00000000-0000-4000-8000-000000000018';
    const environmentId = '00000000-0000-4000-8000-000000000019', plan = structuredClone(report.plan);
    if (source !== 'none') { report.environmentId = environmentId; report.plan.environmentId = environmentId; }
    if (source === 'plan' || source === 'same') plan.environmentId = environmentId;
    const f = await fixture(url => {
      if (url.endsWith('/jobs/99')) return Response.json({ jobId: '99', executionId: '100', agentId: '5', state: 'ended', cancelState: 'none', executionReleased: true, reportState: 'archived', reportKind: 'stress', task: { protocolVersion: 1, jobId: '99', executionId: '100', scope: context.scope, submittedByUserId: '7', contractProjectId: '00000000-0000-4000-8000-000000000018', snapshotId: '66', manifestHash: 'a'.repeat(64), target: { kind: 'stress', plan }, ...(source === 'outer' || source === 'same' ? { environmentId } : {}), policyVersion: '0', requiredCoreBuildId: 'b'.repeat(64), scriptPlanDigest: 'c'.repeat(64), executionProfile: 'no-script', runtimeCompatibilityId: 'persisted-controlled-runtime', dispatchKind: 'dedicated-task', requiredCapabilities: ['protocol:http', 'task:stress', 'stress:local-workers-v1'] } });
      if (url.endsWith('/jobs/99/report')) return Response.json({ executionId: '100', verdict: 'passed', output: { kind: 'stress', result: report } });
      return undefined;
    });
    try { await expect(f.host.handle({ context, operation: 'report', runId: '99', location: { kind: 'agent', agentId: '5' } })).resolves.toMatchObject({ executionId: '100', output: { kind: 'stress', result: { projectId: report.projectId, environmentId: source === 'none' ? null : environmentId } } }); }
    finally { await f.host.close(); }
  });
  // This exercises the private wire's actual Core rebinding, rather than passing function objects over IPC.
  it('rebinds fixed CSV data, authorized credentials and network in two real workers with private evidence', async () => {
    const secret = 't6-authorized-private-marker'; const paths: string[] = [], authorized: boolean[] = [];
    const target = createServer((request, response) => { paths.push(request.url!); authorized.push(request.headers.authorization === `Bearer ${secret}`); response.statusCode = 500; response.end(secret); });
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve)); const address = target.address(); if (!address || typeof address === 'string') throw new Error('owned target missing');
    const origin = `http://127.0.0.1:${address.port}`, csv = Buffer.from('value\nalpha\nbeta\n'), hash = createHash('sha256').update(csv).digest('hex');
    const { project, assets } = assetsFixture(project => {
      const collection = project.collections[0]!, asset = collection.apis[0]!;
      asset.contract.request.baseUrl = origin; asset.contract.request.path = '/{{value}}'; asset.contract.request.auth = { kind: 'bearer', token: { id: 'service-token', policy: 'test-auto' } }; if (asset.contract.request.protocol === 'http') asset.contract.request.body = { kind: 'none' };
      asset.cases[0]!.dataDriver = { sourcePath: 'rows.csv', format: 'csv' };
      project.stressPolicy = { ...project.stressPolicy, trustedOrigins: [origin] };
      project.stressPlans = [{ formatVersion: 1, id: 'fixed-materials', name: 'Fixed materials', updatedAt: 0, plan: StressPlanSchema.parse({ formatVersion: 1, target: { kind: 'case', collectionId: collection.id, apiId: asset.contract.id, caseId: asset.cases[0]!.id }, load: { kind: 'constant-vus', vus: 2 }, maxVus: 2, gracefulStopMs: 500, termination: { maxIterations: 4 } }) }];
    });
    const attachment = { refId: 'rows', version: '1', hash, size: csv.length, kind: 'file', contentBase64: csv.toString('base64') };
    const f = await fixture((url, init) => {
      if (url.endsWith('/execution-agents')) return Response.json({ agents: [], defaultAgentId: null, canManageScripts: false, policyVersion: '0', policy: defaultPolicyConfig });
      if (url.endsWith('/execution-snapshots')) return Response.json({ snapshotId: '66', createdByUserId: '7', assets });
      if (url.endsWith('/local-materials')) { const selection = JSON.parse(String(init?.body)); return Response.json({ snapshotId: '66', scope: context.scope, credentials: selection.credentials.map((ref: { refId: string }) => ({ refId: ref.refId, version: '1', value: secret })), attachments: [attachment] }); }
      return undefined;
    });
    try {
      const result = OnlineLocalResultSchema.parse(await f.host.handle({ context, operation: 'run', runId: randomUUID(), location: { kind: 'local' }, target: { kind: 'stress', plan: project.stressPlans![0]!.plan }, expectedVersion: '1', runConfig: { jobTimeoutMs: 15000, stress: { workerCount: 2, confirmedTargetOrigins: [origin] } }, materials: { projectId: '33', credentials: [], attachments: [{ refId: 'rows', version: '1', hash }], attachmentPaths: { 'rows.csv': { refId: 'rows', version: '1', hash } } }, localOnlyRefIds: [], network: { revision: '1', configuration: { formatVersion: 1, profiles: [], environmentSelections: [], projectSelection: { kind: 'direct' } }, selection: { kind: 'direct' } } }));
      expect(result.output.kind).toBe('stress'); expect(paths).toHaveLength(4); expect(new Set(paths)).toEqual(new Set(['/alpha', '/beta'])); expect(authorized.every(Boolean)).toBe(true);
      // Final I2: a real owned coordinator plus two leaves must reach the safe local summary after exit.
      expect.soft((result.localStress as unknown as Record<string,unknown>).processObservation).toEqual({completeness:'complete',started:3,exited:3,peak:3});
      expect(ownedNodeDescendants()).toEqual([]);
      expect(JSON.stringify(result).includes(secret)).toBe(false);
      if (result.output.kind === 'stress') { expect(result.output.result.requests.failed).toBe(4); expect(result.output.result.failureEvidence!.length).toBeGreaterThan(0); expect(result.output.result.distributed?.workers).toBe(2); }
    } finally { await f.host.close(); target.closeAllConnections(); await new Promise<void>(resolve => target.close(() => resolve())); }
  });
  // Same executionId and valid V2 shapes are insufficient when the fixed contract project/plan differs.
  it.each(['project', 'target', 'plan', 'environment'] as const)('rejects a stress report with a different fixed %s', async change => {
    const report = stressV2Report(); report.projectId = '00000000-0000-4000-8000-000000000018';
    report.target = { kind: 'workflow', workflowId: '00000000-0000-4000-8000-000000000091' }; report.plan.target = { ...report.target };
    const plan = structuredClone(report.plan), environmentId = '00000000-0000-4000-8000-000000000019';
    if (change === 'project') report.projectId = '00000000-0000-4000-8000-000000000028';
    if (change === 'target') { report.target = { kind: 'workflow', workflowId: '00000000-0000-4000-8000-000000000092' }; report.plan.target = { ...report.target }; }
    if (change === 'plan') report.plan.thinkTimeMs = 1;
    if (change === 'environment') { plan.environmentId = environmentId; report.environmentId = '00000000-0000-4000-8000-000000000029'; report.plan.environmentId = report.environmentId; }
    const f = await fixture(url => {
      if (url.endsWith('/jobs/99')) return Response.json({ jobId: '99', executionId: '100', agentId: '5', state: 'ended', cancelState: 'none', executionReleased: true, reportState: 'archived', reportKind: 'stress', task: { protocolVersion: 1, jobId: '99', executionId: '100', scope: context.scope, submittedByUserId: '7', contractProjectId: '00000000-0000-4000-8000-000000000018', snapshotId: '66', manifestHash: 'a'.repeat(64), target: { kind: 'stress', plan }, ...(change === 'environment' ? { environmentId } : {}), policyVersion: '0', requiredCoreBuildId: 'b'.repeat(64), scriptPlanDigest: 'c'.repeat(64), executionProfile: 'no-script', runtimeCompatibilityId: 'persisted-controlled-runtime', dispatchKind: 'dedicated-task', requiredCapabilities: ['protocol:http', 'task:stress', 'stress:local-workers-v1'] } });
      if (url.endsWith('/jobs/99/report')) return Response.json({ executionId: '100', verdict: 'passed', output: { kind: 'stress', result: report } });
      return undefined;
    });
    try { const error = await f.host.handle({ context, operation: 'report', runId: '99', location: { kind: 'agent', agentId: '5' } }).then(() => null, cause => cause as Error); expect(error?.message).toBe('fixed-input-mismatch'); }
    finally { await f.host.close(); }
  });
  // Every owned native channel must settle before materials/resource ownership is released.
  it.each(['cancel', 'close', 'coordinator-exit', 'worker-exit'] as const)('waits for all real local descendants after %s without replaying HTTP', async mode => {
    let requests = 0, entered!: () => void; const active = new Promise<void>(resolve => { entered = resolve; });
    const target = createServer(() => { requests++; if (requests === 2) entered(); });
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve)); const address = target.address(); if (!address || typeof address === 'string') throw new Error('owned target missing');
    const origin = `http://127.0.0.1:${address.port}`, runId = randomUUID();
    const { project, assets } = assetsFixture(project => {
      const collection = project.collections[0]!, asset = collection.apis[0]!;
      asset.contract.request.baseUrl = origin; asset.contract.request.path = '/'; asset.contract.request.auth = { kind: 'none' }; if (asset.contract.request.protocol === 'http') asset.contract.request.body = { kind: 'none' };
      project.stressPolicy = { ...project.stressPolicy, trustedOrigins: [origin] };
      project.stressPlans = [{ formatVersion: 1, id: 'owned-lifetime', name: 'Held local requests', updatedAt: 0, plan: StressPlanSchema.parse({ formatVersion: 1, target: { kind: 'case', collectionId: collection.id, apiId: asset.contract.id, caseId: asset.cases[0]!.id }, load: { kind: 'constant-vus', vus: 2 }, maxVus: 2, gracefulStopMs: 500, termination: { maxIterations: 4 } }) }];
    });
    const f = await fixture(url => url.endsWith('/execution-agents') ? Response.json({ agents: [], defaultAgentId: null, canManageScripts: false, policyVersion: '0', policy: defaultPolicyConfig }) : url.endsWith('/execution-snapshots') ? Response.json({ snapshotId: '66', createdByUserId: '7', assets }) : url.endsWith('/local-materials') ? Response.json({ snapshotId: '66', scope: context.scope, credentials: [], attachments: [] }) : undefined);
    const running = f.host.handle({ context, operation: 'run', runId, location: { kind: 'local' }, target: { kind: 'stress', plan: project.stressPlans![0]!.plan }, expectedVersion: '1', runConfig: { jobTimeoutMs: 15000, stress: { workerCount: 2, confirmedTargetOrigins: [origin] } }, materials: { projectId: '33', credentials: [], attachments: [] }, localOnlyRefIds: [] });
    const outcome = running.then(result => ({ result }), error => ({ error }));
    try {
      await active; const pids = ownedNodeDescendants(); expect(pids).toHaveLength(3);
      if (mode === 'cancel') await f.host.handle({ context, operation: 'cancel', location: { kind: 'local' }, runId });
      else if (mode === 'close') await f.host.close();
      else {
        const role = mode === 'coordinator-exit' ? 'coordinator' : 'worker';
        const selected = pids.find(pid => { const command = processCommandLine(pid); return command.includes(runId) && new RegExp(`stressChild\\.js"?\\s+${role}\\b`).test(command); });
        expect(selected).toBeDefined(); process.kill(selected!);
      }
      const settled = await outcome;
      if ('result' in settled) { const parsed = OnlineLocalResultSchema.parse(settled.result); expect(parsed.output.kind === 'stress-failure' || parsed.output.kind === 'stress' && parsed.output.result.verdict.status !== 'passed').toBe(true); }
      else expect(settled.error).toBeInstanceOf(Error);
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      expect(requests).toBe(2);
      console.log(JSON.stringify({ mode, requests, pids, allExited: true }));
    } finally { await f.host.close(); await outcome; target.closeAllConnections(); await new Promise<void>(resolve => target.close(() => resolve())); }
  });
  // A valid stress report attached to an ordinary task is still the wrong execution evidence.
  it.each(['stress', 'stress-failure'])('rejects a %s output attached to a workflow task identity', async kind => {
    const output = kind === 'stress' ? { kind, result: stressV2Report() } : { kind, error: 'worker-failed', started: true, requests: { started: 1, completed: 0 } };
    const f = await fixture(url => url.endsWith('/jobs/99/report') ? Response.json({ executionId: '100', verdict: 'failed', output }) : undefined);
    try { await expect(f.host.handle({ context, operation: 'report', runId: '99', location: { kind: 'agent', agentId: '5' } })).rejects.toThrow('fixed-input-mismatch'); }
    finally { await f.host.close(); }
  });
  // Only Core's compiled load is checked against local policy; no agent reservation is fabricated.
  it.each(['maxStressVus', 'maxStressRequestConcurrency', 'maxStressRps'] as const)('rejects local compiled load exceeding %s before HTTP', async field => {
    let requests = 0; const target = createServer((_request, response) => { requests++; response.end('ok'); });
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve)); const address = target.address(); if (!address || typeof address === 'string') throw new Error('owned target missing');
    const origin = `http://127.0.0.1:${address.port}`;
    const { project, assets } = assetsFixture(project => {
      const collection = project.collections[0]!, asset = collection.apis[0]!;
      asset.contract.request.baseUrl = origin; asset.contract.request.path = '/'; asset.contract.request.auth = { kind: 'none' }; if (asset.contract.request.protocol === 'http') asset.contract.request.body = { kind: 'none' };
      project.stressPolicy = { ...project.stressPolicy, trustedOrigins: [origin] };
      project.stressPlans = [{ formatVersion: 1, id: 'local-policy', name: 'Local bounded run', updatedAt: 0, plan: StressPlanSchema.parse({ formatVersion: 1, target: { kind: 'case', collectionId: collection.id, apiId: asset.contract.id, caseId: asset.cases[0]!.id }, load: { kind: 'constant-vus', vus: 2 }, maxVus: 2, maxRps: field === 'maxStressRps' ? 2 : undefined, gracefulStopMs: 500, termination: { maxIterations: 2 } }) }];
    });
    const f = await fixture(url => url.endsWith('/execution-agents') ? Response.json({ agents: [], defaultAgentId: null, canManageScripts: false, policyVersion: '0', policy: { ...defaultPolicyConfig, [field]: 1 } }) : url.endsWith('/execution-snapshots') ? Response.json({ snapshotId: '66', createdByUserId: '7', assets }) : url.endsWith('/local-materials') ? Response.json({ snapshotId: '66', scope: context.scope, credentials: [], attachments: [] }) : undefined);
    try {
      const error = await f.host.handle({ context, operation: 'run', runId: '00000000-0000-4000-8000-000000000133', location: { kind: 'local' }, target: { kind: 'stress', plan: project.stressPlans![0]!.plan }, expectedVersion: '1', runConfig: { jobTimeoutMs: 30000, stress: { workerCount: 1, confirmedTargetOrigins: [origin] } }, materials: { projectId: '33', credentials: [], attachments: [] }, localOnlyRefIds: [] }).then(() => null, cause => cause as Error);
      console.log(JSON.stringify({ field, requests, refused: !!error }));
      expect.soft(requests).toBe(0); expect(error?.message).toBe('stress-local-budget-exceeded');
    } finally { await f.host.close(); await new Promise<void>(resolve => target.close(() => resolve())); }
  });
  // Legitimate typed metadata and queue reasons from the service cannot make a real stress task unreadable.
  it('reads complete typed stress metadata and the capacity wait reason from job status', async () => {
    const report = stressV2Report(); const reservation = { jobs: 1, processes: 3, vus: 2, requestConcurrency: 2, maxRps: 1000, metricMemoryBytes: 201326592 };
    const metadata = { location: { kind: 'agent', agentId: '5' }, executor: { id: '5', name: 'Stress agent' }, workerCount: 2, processes: 3, resources: { requested: reservation, effective: reservation }, runtime: { coreBuildId: 'b'.repeat(64), scriptApiId: 'c'.repeat(64), nodeVersion: '22.19.0', v8Version: '12.4.254.21-node.29', runtimeCompatibilityId: 'recorded-agent-runtime' }, status: { preparation: 'ready', execution: 'pending', upload: 'pending' }, contentionHints: [] };
    const status = { jobId: '99', executionId: '100', agentId: '5', state: 'preparing', cancelState: 'none', executionReleased: false, reportState: 'none', stressMetadata: metadata, capacityWaitReason: 'stress.processes', task: { protocolVersion: 1, jobId: '99', executionId: '100', scope: context.scope, submittedByUserId: '7', contractProjectId: '00000000-0000-4000-8000-000000000018', snapshotId: '66', manifestHash: 'a'.repeat(64), target: { kind: 'stress', plan: report.plan }, policyVersion: '0', requiredCoreBuildId: 'b'.repeat(64), scriptPlanDigest: 'c'.repeat(64), executionProfile: 'no-script', runtimeCompatibilityId: 'recorded-agent-runtime', dispatchKind: 'dedicated-task', requiredCapabilities: ['protocol:http', 'task:stress', 'stress:local-workers-v1'] } };
    const f = await fixture(url => url.endsWith('/jobs/99') ? Response.json(status) : undefined);
    try { await expect(f.host.handle({ context, operation: 'status', runId: '99', location: { kind: 'agent', agentId: '5' } })).resolves.toEqual(status); }
    finally { await f.host.close(); }
  });
  // Admission bounds cannot substitute for compiled load or omit the fixed stress declaration.
  it('submits the selected agent stress inputs with the authoritative compiled binding and exact worker confirmation', async () => {
    const { project, assets } = assetsFixture(project => { project.stressPlans = [{ formatVersion: 1, id: 'saved-agent', name: 'Agent scenario', updatedAt: 0, plan: StressPlanSchema.parse({ formatVersion: 1, target: { kind: 'workflow', workflowId: project.workflows[0]!.id }, load: { kind: 'constant-vus', vus: 2 }, maxVus: 2, gracefulStopMs: 0, termination: { maxIterations: 4 } }) }]; });
    const identity = await readBuildIdentity(); const runtimeCompatibilityId = runtimeCompatibilityIdForRuntime(process.versions.node, process.versions.v8, identity.scriptApiId);
    const configuration = { configVersion: '0', appliedConfigVersion: '0', pendingFields: [], restartRequiredFields: [], status: 'applied' };
    const { maxConcurrentStressJobs, maxStressProcesses, maxStressVus, maxStressRequestConcurrency, maxStressRps, maxStressMetricMemoryBytes } = defaultAgentConfig;
    const stressConfiguration = { agent: { maxConcurrentStressJobs, maxStressProcesses, maxStressVus, maxStressRequestConcurrency, maxStressRps, maxStressMetricMemoryBytes }, sources: { 'agent.maxStressRequestConcurrency': 'default', 'agent.maxStressRps': 'default', 'policy.maxStressRequestConcurrency': 'default', 'policy.maxStressRps': 'default' } };
    const f = await fixture((url, init) => {
      if (url.endsWith('/execution-agents')) return Response.json({ defaultAgentId: '5', canManageScripts: false, policy: defaultPolicyConfig, policyVersion: '0', agents: [{ id: '5', name: 'Stress agent', acceptingJobs: true, availability: 'available', lastSeenAt: '2026-10-26T12:00:00Z', policy: defaultPolicyConfig, policyVersion: '0', scriptsAllowed: false, scriptGrant: { scope: 'script-version', version: '0', scripts: [] }, stressConfiguration, configuration, runtime: { protocolVersion: 1, sessionId: 'actual-agent-host', ...identity, sourceFiles: undefined, algorithm: undefined, nodeVersion: process.versions.node, v8Version: process.versions.v8, runtimeCompatibilityId, configuration } }] });
      if (url.endsWith('/execution-snapshots')) return Response.json({ snapshotId: '66', createdByUserId: '7', assets });
      if (url.endsWith('/local-materials')) return Response.json({ snapshotId: '66', scope: context.scope, credentials: [], attachments: [] });
      if (url.endsWith('/jobs') && init?.method === 'POST') { const body = JSON.parse(String(init.body)); const { stressBinding: _binding, scriptRequirements: _requirements, ...preparation } = body.preparation; return Response.json({ jobId: '99', executionId: '100', agentId: '5', state: 'queued', cancelState: 'none', executionReleased: false, reportState: 'none', task: { protocolVersion: 1, jobId: '99', executionId: '100', scope: context.scope, submittedByUserId: '7', contractProjectId: project.id, snapshotId: '66', manifestHash: assets.manifestHash, target: body.target, policyVersion: '0', ...preparation } }); }
      return undefined;
    });
    try {
      await expect(f.host.handle({ context, operation: 'run', runId: '00000000-0000-4000-8000-000000000122', location: { kind: 'agent', agentId: '5' }, target: { kind: 'stress', plan: project.stressPlans![0]!.plan }, expectedVersion: '1', runConfig: { stress: { workerCount: 2, confirmedTargetOrigins: ['http://127.0.0.1:8123'] } }, materials: { projectId: '33', credentials: [], attachments: [] }, localOnlyRefIds: [] })).resolves.toMatchObject({ agentId: '5', jobId: '99' });
      expect(f.requests.find(row => row.url.endsWith('/jobs') && row.method === 'POST')?.body).toMatchObject({ runConfig: { stress: { workerCount: 2, confirmedTargetOrigins: ['http://127.0.0.1:8123'] } }, preparation: { dispatchKind: 'dedicated-task', stressBinding: { stage: 'compiled-limits', reservation: { jobs: 1, processes: 3, vus: 2, requestConcurrency: 2, maxRps: 1000, metricMemoryBytes: 201326592 } } } });
    } finally { await f.host.close(); }
  });
  // Ignoring stressRun or executing in main silently loses topology and process ownership.
  it.each([1, 2])('uses an exclusive real local stress process tree for workerCount=%i and waits for every exit', async workerCount => {
    let observedPids: number[] = []; let requests = 0;
    const target = createServer((_request, response) => { requests++; if (requests === 1) observedPids = ownedNodeDescendants(); response.end('ok'); });
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
    const address = target.address(); if (!address || typeof address === 'string') throw new Error('owned target missing');
    const origin = `http://127.0.0.1:${address.port}`;
    const { project, assets } = assetsFixture(project => {
      const collection = project.collections[0]!; const asset = collection.apis[0]!;
      asset.contract.request.baseUrl = origin; asset.contract.request.path = '/'; asset.contract.request.auth = { kind: 'none' }; if (asset.contract.request.protocol === 'http') asset.contract.request.body = { kind: 'none' };
      project.stressPolicy = { ...project.stressPolicy, trustedOrigins: [origin] };
      project.stressPlans = [{ formatVersion: 1, id: 'saved-local', name: 'Four local requests', updatedAt: 0, plan: StressPlanSchema.parse({ formatVersion: 1, target: { kind: 'case', collectionId: collection.id, apiId: asset.contract.id, caseId: asset.cases[0]!.id }, load: { kind: 'constant-vus', vus: 2 }, maxVus: 2, gracefulStopMs: 500, termination: { maxIterations: 4 } }) }];
    });
    const f = await fixture(url => url.endsWith('/execution-agents') ? Response.json({ agents: [], defaultAgentId: null, canManageScripts: false, policyVersion: '0', policy: defaultPolicyConfig }) : url.endsWith('/execution-snapshots') ? Response.json({ snapshotId: '66', createdByUserId: '7', assets }) : url.endsWith('/local-materials') ? Response.json({ snapshotId: '66', scope: context.scope, credentials: [], attachments: [] }) : undefined);
    try {
      const result = OnlineLocalResultSchema.parse(await f.host.handle({ context, operation: 'run', runId: `00000000-0000-4000-8000-00000000010${workerCount}`, location: { kind: 'local' }, target: { kind: 'stress', plan: project.stressPlans![0]!.plan }, expectedVersion: '1', runConfig: { jobTimeoutMs: 30000, stress: { workerCount, confirmedTargetOrigins: [origin] } }, materials: { projectId: '33', credentials: [], attachments: [] }, localOnlyRefIds: [] }));
      expect(result.output.kind).toBe('stress');
      expect(requests).toBe(4);
      expect(observedPids).toHaveLength(workerCount === 1 ? 1 : 3);
      for (const pid of observedPids) expect(() => process.kill(pid, 0)).toThrow();
      expect(f.requests.some(row => row.url.endsWith('/jobs') && row.method === 'POST')).toBe(false);
      console.log(JSON.stringify({ workerCount, requests, observedPids, allExited: observedPids.every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } }) }));
      const identity = await readBuildIdentity();
      expect((result as unknown as Record<string, unknown>).localStress).toMatchObject({ workerCount, processBudget: workerCount === 1 ? 1 : 3, runtime: { coreBuildId: identity.coreBuildId, scriptApiId: identity.scriptApiId, nodeVersion: process.versions.node, v8Version: process.versions.v8, runtimeCompatibilityId: runtimeCompatibilityIdForRuntime(process.versions.node, process.versions.v8, identity.scriptApiId) } });
      if (result.output.kind === 'stress') expect(result.output.result.load.effectiveMaxRps).toBeNull();
    } finally { await f.host.close(); await new Promise<void>(resolve => target.close(() => resolve())); }
  });
  // Stress failure deliberately has no result; dropping that branch hides known execution facts.
  it.each([
    { output: { kind: 'stress-failure', error: 'worker-failed', started: true, requests: { started: 2, completed: 1 } }, reportKind: 'stress-failure' },
    { output: { kind: 'stress', result: stressV2Report() }, reportKind: 'stress' },
    { reasonCode: 'result-capacity-exceeded', executionFact: 'started', reportKind: 'stress-fault' },
  ])('accepts fixed-identity stress report without inventing absent Core output ($reportKind)', async body => {
    const { reportKind, ...envelope } = body;
    if (envelope.output?.kind === 'stress') envelope.output.result!.projectId = '00000000-0000-4000-8000-000000000018';
    const report = stressV2Report();
    const f = await fixture(url => {
      if (url.endsWith('/jobs/99')) return Response.json({ jobId: '99', executionId: '100', agentId: '5', state: 'ended', cancelState: 'none', executionReleased: true, reportState: 'archived', reportKind, task: { protocolVersion: 1, jobId: '99', executionId: '100', scope: context.scope, submittedByUserId: '7', contractProjectId: '00000000-0000-4000-8000-000000000018', snapshotId: '66', manifestHash: 'a'.repeat(64), target: { kind: 'stress', plan: report.plan }, policyVersion: '0', requiredCoreBuildId: 'b'.repeat(64), scriptPlanDigest: 'c'.repeat(64), executionProfile: 'no-script', runtimeCompatibilityId: 'persisted-controlled-runtime', dispatchKind: 'dedicated-task', requiredCapabilities: ['protocol:http', 'task:stress', 'stress:local-workers-v1'] } });
      if (url.endsWith('/jobs/99/report')) return Response.json({ executionId: '100', verdict: 'failed', ...envelope });
      return undefined;
    });
    try { await expect(f.host.handle({ context, operation: 'report', runId: '99', location: { kind: 'agent', agentId: '5' } })).resolves.toEqual({ executionId: '100', verdict: 'failed', ...envelope }); }
    finally { await f.host.close(); }
  });
  it("rejects malformed remote Core reports with a stable error before the IPC boundary", async () => {
    const f = await fixture(url => url.endsWith('/jobs/99/report') ? Response.json({ executionId: '100', verdict: 'failed', output: { kind: 'suite', result: { collectionId: 'suite', collectionName: 'Invalid remote report', startedAt: '2026-10-26T16:00:00.000Z', finishedAt: '2026-10-26T16:00:00.001Z', total: 1, passed: 0, failed: 1, cases: [null] } } }) : undefined);
    try {
      const error = await f.host.handle({ context, operation: 'report', runId: '99', location: { kind: 'agent', agentId: '5' } }).then(() => null, error => error as Error);
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toBe('invalid-core-output');
    } finally { await f.host.close(); }
  });
  it("keeps active debug sessions alive across the idle horizon and starts idle expiry after the final release", async () => {
    let releaseTarget!: () => void; let entered!: () => void; let requests = 0; let materialReads = 0; let now = 0;
    const enteredTarget = new Promise<void>(resolve => { entered = resolve; });
    const target = createServer((_request, response) => {
      requests++;
      if (requests === 1) { releaseTarget = () => response.end('first completed'); entered(); }
      else response.end('another completed');
    });
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
    const address = target.address(); if (!address || typeof address === 'string') throw new Error('owned target missing');
    const { project, assets } = assetsFixture(project => { const request = project.collections[0]!.apis[0]!.contract.request; request.baseUrl = `http://127.0.0.1:${address.port}`; request.path = '/'; if (request.protocol === 'http') request.body = { kind: 'none' }; });
    const f = await fixture(url => {
      if (url.endsWith('/execution-agents')) return Response.json({ agents: [], defaultAgentId: null, canManageScripts: false, policyVersion: '0', policy: defaultPolicyConfig });
      if (url.endsWith('/execution-snapshots')) return Response.json({ snapshotId: '66', createdByUserId: '7', assets });
      if (url.endsWith('/local-materials')) { materialReads++; return Response.json({ snapshotId: '66', scope: context.scope, credentials: [], attachments: [] }); }
      return undefined;
    });
    const asset = project.collections[0]!.apis[0]!;
    const input = (n: number, debugSessionId?: string): OnlineExecutionInput => ({ context, operation: 'run', runId: `00000000-0000-4000-8000-${String(800 + n).padStart(12, '0')}`, location: { kind: 'local' }, expectedVersion: '1', target: { kind: 'debug', invocation: { mode: 'request', locator: { workspaceId: '11', groupId: '22', projectId: project.id, collectionId: project.collections[0]!.id, folderIds: [], apiId: asset.contract.id }, request: asset.contract.request, parameters: {}, fields: [] } }, runConfig: { jobTimeoutMs: defaultPolicyConfig.maxJobTimeoutMs }, materials: { projectId: '33', credentials: [], attachments: [] }, localOnlyRefIds: [], ...(debugSessionId ? { debugSessionId } : {}) });
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    let first: Promise<unknown> | undefined; let second: Promise<unknown> | undefined;
    try {
      first = f.host.handle(input(1)); await enteredTarget;
      now = defaultAgentConfig.debugSessionIdleMs + 1;
      second = f.host.handle(input(2));
      await vi.waitFor(() => { expect(materialReads).toBe(2); });
      releaseTarget();
      const a = OnlineLocalResultSchema.parse(await first); const b = OnlineLocalResultSchema.parse(await second);
      expect.soft(a.output).toMatchObject({ kind: 'debug', result: { run: { failed: 0 } } });
      now += defaultAgentConfig.debugSessionIdleMs - 1;
      await expect.soft(f.host.handle(input(3, a.debugSessionId))).resolves.toMatchObject({ debugSessionId: a.debugSessionId });
      now += defaultAgentConfig.debugSessionIdleMs + 1;
      await f.host.handle(input(4));
      await expect.soft(f.host.handle(input(5, b.debugSessionId))).rejects.toThrow('debug-session-expired');
    } finally { releaseTarget?.(); await Promise.allSettled([first, second]); clock.mockRestore(); await f.host.close(); target.closeAllConnections(); await new Promise<void>(resolve => target.close(() => resolve())); }
  });
  // Break caught: enabled online dataset controls falling through to the local-root proxy.
  it("imports and exports dataset content through the scoped online editor and real host", async () => {
    const datasetId = '00000000-0000-4000-8000-000000000081';
    const { project, assets } = assetsFixture(project => { project.datasets = [{ formatVersion: 1, id: datasetId, name: 'Quotes and types', columns: ['name', 'count'], rows: [{ name: 'a"b', count: 2 }, { name: '', count: null }] }]; });
    const f = await fixture(url => url.endsWith('/assets') ? Response.json(assets) : undefined);
    const api = { onlineExecution: (input: OnlineExecutionInput) => f.host.handle(input), assertionOperators: async () => [] } as unknown as ApiccApi;
    const execution = createOnlineExecutionStore(api); execution.activate(context); execution.project = project; execution.view = { assets, project, problems: [] };
    const adapter = createOnlineProjectAdapter(execution, api, () => false, () => true);
    const editorContext = { root: adapter.editorRoot(), project: adapter.locator(), revision: '1' };
    try {
      await expect(adapter.bridge.importDataset({ context: editorContext, format: 'csv', content: 'name,count\r\nAlice,2' })).resolves.toEqual({ columns: ['name', 'count'], rows: [{ name: 'Alice', count: '2' }] });
      await expect(adapter.bridge.exportDataset({ context: editorContext, locator: { ...adapter.locator(), datasetId }, format: 'csv' })).resolves.toBe('"name","count"\r\n"a""b","2"\r\n"","null"');
      await expect(adapter.bridge.exportDataset({ context: editorContext, locator: { ...adapter.locator(), datasetId }, format: 'json' })).resolves.toBe('[\n  {\n    "name": "a\\"b",\n    "count": 2\n  },\n  {\n    "name": "",\n    "count": null\n  }\n]');
      expect(f.requests.filter(item => item.url.endsWith('/assets')).every(item => item.method === 'GET')).toBe(true);
    } finally { adapter.stop(); await f.host.close(); }
  });
  // Break caught: restarting the parent budget after slow admission permits a target request.
  it("counts admission time against the local parent deadline before any target request", async () => {
    let targetRequests = 0; let now = 0;
    const server = createServer((_request, response) => { targetRequests++; response.setHeader('content-type', 'text/plain'); response.end('must not start'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture listener not ready');
    const { project, assets } = assetsFixture(project => { const request = project.collections[0]!.apis[0]!.contract.request; request.baseUrl = `http://127.0.0.1:${address.port}`; request.path = '/'; if (request.protocol === 'http') request.body = { kind: 'none' }; });
    const f = await fixture(url => {
      if (url.endsWith('/execution-agents')) { now = 1001; return Response.json({ agents: [], defaultAgentId: null, canManageScripts: false, policyVersion: '0', policy: { ...defaultPolicyConfig, defaultJobTimeoutMs: 1000, cancelGraceMs: 10 } }); }
      if (url.endsWith('/execution-snapshots')) return Response.json({ snapshotId: '66', createdByUserId: '7', assets });
      if (url.endsWith('/local-materials')) return Response.json({ snapshotId: '66', scope: context.scope, credentials: [], attachments: [] });
      return undefined;
    });
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const asset = project.collections[0]!.apis[0]!;
    try {
      await expect(f.host.handle({ context, operation: 'run', runId: '00000000-0000-4000-8000-000000000071', location: { kind: 'local' }, expectedVersion: '1', target: { kind: 'debug', invocation: { mode: 'request', locator: { workspaceId: '11', groupId: '22', projectId: project.id, collectionId: project.collections[0]!.id, folderIds: [], apiId: asset.contract.id }, request: asset.contract.request, parameters: {}, fields: [] } }, runConfig: { jobTimeoutMs: 1000 }, materials: { projectId: '33', credentials: [], attachments: [] }, localOnlyRefIds: [] })).rejects.toThrow('job-timeout');
      expect(targetRequests).toBe(0);
    } finally { clock.mockRestore(); await f.host.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  // Break caught: preparation has no registered owner, so neither cancellation nor close aborts it.
  it("cancels and closes local runs while their admission request is still pending", async () => {
    const { assets } = assetsFixture();
    for (const action of ['cancel', 'close'] as const) {
      let release!: () => void; let entered!: () => void; let aborted = false;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const f = await fixture((url, init) => {
        if (url.endsWith('/execution-agents')) return new Promise<Response>((resolve, reject) => {
          release = () => resolve(Response.json({ agents: [], defaultAgentId: null, policy: defaultPolicyConfig, policyVersion: '0', canManageScripts: false }));
          init?.signal?.addEventListener('abort', () => { aborted = true; reject(init.signal!.reason); }, { once: true }); entered();
        });
        if (url.endsWith('/execution-snapshots')) return Response.json({ snapshotId: '66', createdByUserId: '7', assets });
        if (url.endsWith('/local-materials')) return Response.json({ snapshotId: '66', scope: context.scope, credentials: [], attachments: [] });
        return undefined;
      });
      const runId = '00000000-0000-4000-8000-000000000072';
      const run = f.host.handle({ context, operation: 'run', runId, location: { kind: 'local' }, expectedVersion: '1', target: { kind: 'workflow', workflowId: '00000000-0000-4000-8000-000000000091' }, runConfig: {}, materials: { projectId: '33', credentials: [], attachments: [] }, localOnlyRefIds: [] }).then(() => 'resolved', error => String(error.message));
      await started;
      try {
        if (action === 'cancel') await expect(f.host.handle({ context, operation: 'cancel', location: { kind: 'local' }, runId })).resolves.toMatchObject({ executionId: runId, verdict: 'cancelled', executionFact: 'not-started' });
        else await f.host.close();
        expect(aborted).toBe(true);
        expect(f.requests.some(item => item.url.endsWith('/execution-snapshots'))).toBe(false);
      } finally { release(); await run; await f.host.close(); }
    }
  });
  // No target requests: one deferred admission plus 101 identical denied material preparations.
  it("retains identifiable failed local runs in bounded history without evicting an active admission", async () => {
    const { assets } = assetsFixture(); let policyReads = 0; let release!: () => void; let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const policy = () => Response.json({ agents: [], defaultAgentId: null, policy: defaultPolicyConfig, policyVersion: '0', canManageScripts: false });
    const f = await fixture((url, init) => {
      if (url.endsWith('/execution-agents')) {
        if (policyReads++ === 0) return new Promise<Response>((resolve, reject) => { release = () => resolve(policy()); init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }); entered(); });
        return policy();
      }
      if (url.endsWith('/execution-snapshots')) return Response.json({ snapshotId: '66', createdByUserId: '7', assets });
      if (url.endsWith('/local-materials')) return Response.json({ code: 'material-denied' }, { status: 403 });
      return undefined;
    });
    const runInput = (runId: string): OnlineExecutionInput => ({ context, operation: 'run', runId, location: { kind: 'local' }, expectedVersion: '1', target: { kind: 'workflow', workflowId: '00000000-0000-4000-8000-000000000091' }, runConfig: {}, materials: { projectId: '33', credentials: [], attachments: [] }, localOnlyRefIds: [] });
    const activeId = '00000000-0000-4000-8000-000000000073';
    const active = f.host.handle(runInput(activeId)).catch(() => undefined); await started;
    const ids = Array.from({ length: 101 }, (_, index) => `00000000-0000-4000-8000-${String(1000 + index).padStart(12, '0')}`);
    try {
      for (const runId of ids) await expect(f.host.handle(runInput(runId))).rejects.toThrow();
      await expect(f.host.handle({ context, operation: 'status', location: { kind: 'local' }, runId: ids[0]! })).rejects.toThrow('local-run-unavailable');
      await expect(f.host.handle({ context, operation: 'status', location: { kind: 'local' }, runId: ids.at(-1)! })).resolves.toMatchObject({ executionId: ids.at(-1), verdict: 'failed', executionFact: 'not-started' });
      await expect(f.host.handle({ context, operation: 'cancel', location: { kind: 'local' }, runId: activeId })).resolves.toMatchObject({ verdict: 'cancelled', executionFact: 'not-started' });
    } finally { release(); await active; await f.host.close(); }
  });
  it("keeps online personal credentials in the configured isolated provider root through real IPC composition", async () => {
    const privateRoot = join(tmpdir(), 'apicc-t9-isolated-provider');
    secretNamespaces.clear();
    const f = await fixture(url => url.endsWith('/assets') ? Response.json(assetsFixture().assets) : url.endsWith('/tree') ? Response.json({ workspaceId: '11', rootVersion: 1, files: [], projects: [{ id: '33', groupId: '22', name: 'Project', myRole: 'EDITOR' }] }) : url.endsWith('/groups') ? Response.json([]) : undefined);
    const deps = createIpcDeps({ session: createSession(), pickDirectory: async () => '', saveFile: async () => '', online: { createClient: (baseUrl, hooks) => createOnlineClient({ baseUrl, fetch: f.fetcher, onUnauthorized: hooks.onUnauthorized }), tokenStore: { save() {}, load() { return null; }, clear() {} }, fetch: f.fetcher }, credentials: { credentialPrivateRoot: privateRoot, networkPrivateRoot: join(privateRoot, 'network'), oauthPrivateRoot: join(privateRoot, 'oauth') } });
    await deps.handle('online:login', {}, { baseUrl: 'https://control.test', username: 'member', password: 'password' });
    await deps.handle('online:workspace:open', {}, { workspaceId: '11', name: 'Workspace', myRole: 'EDITOR' });
    await deps.handle('online:execution', {}, { context, operation: 'credential', action: 'put', storage: 'local', contractProjectId: '00000000-0000-4000-8000-000000000018', ref: { id: 'personal-token', policy: 'test-auto' }, value: 'isolated-fixture-value' });
    expect([...(secretNamespaces.get(privateRoot)?.values() ?? [])]).toEqual(['isolated-fixture-value']);
  });
  it("rebuilds registered local plugin contributions on a fresh execution registry", async () => {
    const directory = mkdtempSync(join(tmpdir(), 'apicc-t9-plugin-'));
    const server = createServer((request, response) => { response.setHeader('content-type', 'text/plain'); response.end(request.headers['x-online-plugin'] ?? 'builtin-only'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture listener not ready');
    const manifest = { manifestVersion: 1, id: 'example.online', name: 'online-fixture', version: '1.0.0', apiVersion: 1, engines: { apicc: '>=0.1.0 <0.2.0' }, entry: './index.js', capabilities: ['protocol'], contributions: [{ kind: 'protocol', id: 'example.online/protocol.http' }] };
    mkdirSync(join(directory, 'plugin')); mkdirSync(join(directory, '.apicc'));
    writeFileSync(join(directory, 'plugin', 'package.json'), JSON.stringify({ name: manifest.name, version: manifest.version, type: 'module' }));
    writeFileSync(join(directory, 'plugin', 'apicc-plugin.json'), JSON.stringify(manifest));
    writeFileSync(join(directory, 'plugin', 'index.js'), `export default { manifest: ${JSON.stringify(manifest)}, setup(ctx) { ctx.register({ kind: 'protocol', id: 'example.online/protocol.http', supports: ['http'], execute(request, context) { return context.transport.execute({ ...request, headers: { ...request.headers, 'X-Online-Plugin': 'registered-online-plugin' } }); } }); } };`);
    writeFileSync(join(directory, '.apicc', 'plugins.json'), JSON.stringify({ plugins: [join(directory, 'plugin')], bindings: { protocols: { http: 'example.online/protocol.http' } } }));
    const { project, assets } = assetsFixture(project => { const request = project.collections[0]!.apis[0]!.contract.request; request.baseUrl = `http://127.0.0.1:${address.port}`; request.path = '/'; if (request.protocol === 'http') request.body = { kind: 'none' }; });
    const f = await fixture(url => url.endsWith('/execution-agents') ? Response.json({ defaultAgentId: null, agents: [], canManageScripts: false, policy: defaultPolicyConfig, policyVersion: '0' }) : url.endsWith('/execution-snapshots') ? Response.json({ snapshotId: '66', createdByUserId: '7', assets }) : url.endsWith('/local-materials') ? Response.json({ snapshotId: '66', scope: context.scope, credentials: [], attachments: [] }) : undefined);
    const plugins = createPluginsRuntime({ homeDir: directory });
    const summary = await plugins.summary();
    expect(summary.plugins.map(plugin => plugin.kind), JSON.stringify(summary)).toEqual(['loaded']);
    const host = createOnlineExecutionHost({ session: f.session, fetch: f.fetcher, plugins });
    try {
      const asset = project.collections[0]!.apis[0]!;
      const result = await host.handle({ context, operation: 'run', runId: '00000000-0000-4000-8000-000000000097', location: { kind: 'local' }, expectedVersion: '1', target: { kind: 'debug', invocation: { mode: 'request', locator: { workspaceId: '11', groupId: '22', projectId: project.id, collectionId: project.collections[0]!.id, folderIds: [], apiId: asset.contract.id }, request: asset.contract.request, parameters: {}, fields: [] } }, runConfig: {}, materials: { projectId: '33', credentials: [], attachments: [] }, localOnlyRefIds: [] });
      const output = OnlineLocalResultSchema.parse(result).output;
      expect(output.kind).toBe('debug');
      if (output.kind !== 'debug') throw new Error('debug output expected');
      expect(output.result.exchanges[0]?.response?.body).toMatchObject({ text: 'registered-online-plugin' });
    } finally { await host.close(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
  });
  it("publishes a valid local project only into a newly created server entity, preserving the old project", async () => {
    const { project, assets } = assetsFixture();
    const f = await fixture((url, init) => {
      if (url.endsWith('/projects/33/assets')) return Response.json(assets);
      if (url.endsWith('/projects') && init?.method === 'POST') return Response.json({ id: '44', groupId: '22', name: 'Published', createdAt: '2026-10-26T12:00:00Z' });
      if (url.endsWith('/projects/44/assets')) return Response.json(init?.method === 'PUT' ? { ...assets, projectId: '44' } : { ...assets, projectId: '44', format: null, contractProjectId: null, version: '0', files: [] });
      return undefined;
    });
    await expect(f.host.handle({ context, operation: 'publishNew', name: 'Published', project })).resolves.toMatchObject({ scope: { projectId: '44' }, view: { project: { id: project.id } } });
    expect(f.requests.filter(row => row.method === 'PUT').map(row => row.url)).toEqual(['https://control.test/api/v1/workspaces/11/projects/44/assets']);
  });
  it("derives required credential versions from real Core preparation and uses the selected agent's registered runtime", async () => {
    const { project, assets } = assetsFixture(project => { project.collections[0]!.apis[0]!.contract.request.auth = { kind: 'bearer', token: { id: 'service-token', policy: 'test-auto' } }; });
    const identity = await readBuildIdentity(); const runtimeCompatibilityId = runtimeCompatibilityIdForRuntime(process.versions.node, process.versions.v8, identity.scriptApiId);
    const configuration = { configVersion: '0', appliedConfigVersion: '0', pendingFields: [], restartRequiredFields: [], status: 'applied' };
    const f = await fixture((url, init) => {
      if (url.endsWith('/execution-agents')) return Response.json({ defaultAgentId: '5', canManageScripts: false, policy: defaultPolicyConfig, policyVersion: '0', agents: [{ id: '5', name: 'Actual agent', acceptingJobs: true, availability: 'available', lastSeenAt: '2026-10-26T12:00:00Z', policy: defaultPolicyConfig, policyVersion: '0', scriptsAllowed: false, scriptGrant: { scope: 'script-version', version: '0', scripts: [] }, stressConfiguration: stressConfigurationFixture(), configuration, runtime: { protocolVersion: 1, sessionId: 'actual-agent-host', ...identity, sourceFiles: undefined, algorithm: undefined, nodeVersion: process.versions.node, v8Version: process.versions.v8, runtimeCompatibilityId, configuration } }] });
      if (url.endsWith('/execution-snapshots')) return Response.json({ snapshotId: '66', createdByUserId: '7', assets });
      if (url.endsWith('/local-materials')) { const selection = JSON.parse(String(init?.body)); return Response.json({ snapshotId: '66', scope: context.scope, credentials: selection.credentials.map((ref: { refId: string }) => ({ ...ref, version: '1', value: 'scoped-project-secret' })), attachments: [] }); }
      if (url.endsWith('/jobs') && init?.method === 'POST') { const body = JSON.parse(String(init.body)); return Response.json({ jobId: '99', executionId: '100', agentId: '5', state: 'queued', cancelState: 'none', executionReleased: false, reportState: 'none', task: { protocolVersion: 1, jobId: '99', executionId: '100', scope: context.scope, submittedByUserId: '7', contractProjectId: project.id, snapshotId: '66', manifestHash: assets.manifestHash, target: body.target, policyVersion: '0', ...body.preparation, scriptRequirements: undefined } }); }
      return undefined;
    });
    const asset = project.collections[0]!.apis[0]!;
    await f.host.handle({ context, operation: 'run', runId: '00000000-0000-4000-8000-000000000098', location: { kind: 'agent', agentId: '5' }, expectedVersion: '1', target: { kind: 'debug', invocation: { mode: 'request', locator: { workspaceId: '11', groupId: '22', projectId: project.id, collectionId: project.collections[0]!.id, folderIds: [], apiId: asset.contract.id }, request: asset.contract.request, parameters: {}, fields: [] } }, runConfig: {}, materials: { projectId: '33', credentials: [], attachments: [] }, localOnlyRefIds: [] });
    expect(f.requests.find(row => row.url.endsWith('/jobs'))?.body).toMatchObject({ materials: { credentials: [{ refId: 'service-token', version: '1' }] }, preparation: { runtimeCompatibilityId } });
  });
  it("writes a project credential only through the explicitly scoped material action and returns no secret value", async () => {
    const values = new Map<string, string>();
    const f = await fixture((url, init) => {
      if (url.endsWith("/assets")) return Response.json(assetsFixture().assets);
      if (url.endsWith("/credentials")) return Response.json([]);
      if (url.endsWith("/credentials/service-token") && init?.method === "PUT") { values.set("service-token", JSON.parse(String(init.body)).value); return Response.json({ refId: "service-token", version: "1", status: "available" }); }
      return undefined;
    });
    const result = await f.host.handle({ context, operation: "credential", action: "put", ref: { id: "service-token", policy: "test-auto" }, storage: "project", contractProjectId: "00000000-0000-4000-8000-000000000018", value: "project-only-value" });
    expect(result).toEqual({ ok: true }); expect(values.get("service-token")).toBe("project-only-value");
    expect(JSON.stringify(result)).not.toContain("project-only-value");
  });
  it("binds execution to the authenticated owner and rejects renderer impersonation", async () => {
    const f = await fixture();
    await expect(f.host.handle({ operation: "assets", context: { ...context, ownerId: "8" } })).rejects.toThrow("online-session-changed");
    expect(f.requests.filter(row => row.url.includes("/assets"))).toEqual([]);
  });
  it("rejects local-only credentials before snapshot/submission instead of uploading or switching location", async () => {
    const f = await fixture();
    const request = { context, operation: "run", runId: "00000000-0000-4000-8000-000000000099", location: { kind: "agent", agentId: "5" }, target: { kind: "workflow", workflowId: "wf" }, expectedVersion: "1", runConfig: {}, materials: { projectId: "33", credentials: [], attachments: [] }, localOnlyRefIds: ["personal-token"] } satisfies OnlineExecutionInput;
    await expect(f.host.handle(request)).rejects.toThrow("local-material-required");
    expect(f.requests).toHaveLength(1);
  });
  it("queries persisted agent jobs after a fresh host without resubmitting a target", async () => {
    const f = await fixture();
    const reopened = createOnlineExecutionHost({ session: f.session, fetch: f.fetcher });
    await expect(reopened.handle({ context, operation: "status", location: { kind: "agent", agentId: "5" }, runId: "99" })).resolves.toMatchObject({ jobId: "99", state: "ended", reportState: "pending" });
    expect(f.requests.map(row => row.method)).toEqual(["POST", "GET"]);
  });
  it("keeps legacy project bytes read-only instead of overwriting them with executable files", async () => {
    const { assets, project } = assetsFixture();
    const f = await fixture((url) => url.endsWith("/assets") ? Response.json({ ...assets, format: null, contractProjectId: null }) : undefined);
    await expect(f.host.handle({ context, operation: "publish", project })).rejects.toThrow("publish-requires-empty-project");
    expect(f.requests.filter(row => row.method === "PUT")).toEqual([]);
  });
  it("saves a complete project with the atomic expected-version delta and preserves conflict", async () => {
    const { assets } = assetsFixture();
    const f = await fixture((url, init) => url.endsWith("/assets") ? init?.method === "PUT" ? Response.json({ code: "version_conflict", message: "changed" }, { status: 409 }) : Response.json(assets) : undefined);
    await expect(f.host.handle({ context, operation: "save", delta: { format: "contract-files-v1", contractProjectId: assets.contractProjectId, expectedVersion: "1", changes: [{ path: "project.yaml", content: "changed" }], deletes: [] } })).rejects.toThrow("version_conflict");
    expect(f.requests.at(-1)).toMatchObject({ method: "PUT", body: { expectedVersion: "1" } });
  });
  it("prepares the authoritative fixed snapshot and executes a local workflow through the real host without submitting a backend job", async () => {
    const { assets } = assetsFixture();
    const f = await fixture((url) => {
      if (url.endsWith("/execution-snapshots")) return Response.json({ snapshotId: "66", createdByUserId: "7", assets });
      if (url.endsWith("/local-materials")) return Response.json({ snapshotId: "66", scope: context.scope, credentials: [], attachments: [] });
      if (url.endsWith("/execution-agents")) return Response.json({ agents: [], defaultAgentId: null, policy: defaultPolicyConfig, policyVersion: "0", canManageScripts: false });
      return undefined;
    });
    const result = await f.host.handle({ context, operation: "run", runId: "00000000-0000-4000-8000-000000000099", location: { kind: "local" }, target: { kind: "workflow", workflowId: "00000000-0000-4000-8000-000000000091" }, expectedVersion: "1", runConfig: {}, materials: { projectId: "33", credentials: [], attachments: [] }, localOnlyRefIds: [] });
    expect(result).toMatchObject({ location: { kind: "local" }, snapshotId: "66", output: { kind: "workflow" } });
    expect(result).not.toHaveProperty('localStress');expect(result).not.toHaveProperty('processObservation');
    expect(f.requests.some(row => row.url.endsWith("/jobs"))).toBe(false);
  });
});
