import { describe, expect, it } from "vitest";
import { createOnlineExecutionStore } from "../../../src/renderer/src/stores/onlineExecution.js";
import type { OnlineExecutionContext, OnlineJob, OnlineLocalResult } from "../../../src/shared/online/execution.js";
import { ContractWorkspaceSchema, StressPlanSchema } from '@apicc/core/schema';
import { workspaceFixture } from '../../../../../packages/core/tests/helpers/contractFixtures.js';
import { defaultPolicyConfig } from '@apicc/execution/contract';
import { OnlineLocalResultSchema, type OnlineExecutionInput } from '../../../src/shared/online/execution.js';
import { stressV2Report } from '../../helpers/stressV2.js';
const context: OnlineExecutionContext = { serverId: "https://control.test/api/v1", ownerId: "7", scope: { workspaceId: "11", groupId: "22", projectId: "33" } };
const workflowId = '00000000-0000-4000-8000-000000000091';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function localResult(runId: string): OnlineLocalResult { return { location: { kind: 'local' }, runId, snapshotId: '66', manifestHash: 'a'.repeat(64), runtimeCompatibilityId: 'recorded-local-runtime', scriptTimeoutMs: 3000, output: { kind: 'failure', targetKind: 'workflow', error: 'Safe preparation failure', result: { collectionId: '', collectionName: 'workflow', startedAt: '2026-10-26T16:00:00.000Z', finishedAt: '2026-10-26T16:00:00.001Z', total: 0, passed: 0, failed: 1, cases: [] } } }; }
function activateRun(store: ReturnType<typeof createOnlineExecutionStore>) { store.activate(context); store.setVisible(true); store.view = { project: null, problems: [], assets: { ...context.scope, format: 'contract-files-v1', contractProjectId: '00000000-0000-4000-8000-000000000018', version: '1', manifestHash: 'a'.repeat(64), files: [] } }; }
function job(jobId: string, executionId: string): OnlineJob { return { jobId, executionId, agentId: '5', state: 'ended', cancelState: 'none', executionReleased: true, reportState: 'archived', task: { protocolVersion: 1, jobId, executionId, scope: context.scope, submittedByUserId: '7', contractProjectId: '00000000-0000-4000-8000-000000000018', snapshotId: '66', manifestHash: 'a'.repeat(64), target: { kind: 'workflow', workflowId }, policyVersion: '0', requiredCoreBuildId: 'b'.repeat(64), scriptPlanDigest: 'c'.repeat(64), executionProfile: 'no-script', runtimeCompatibilityId: 'recorded-agent-runtime', dispatchKind: 'dedicated-task', requiredCapabilities: ['task:workflow'] } }; }
describe("online execution renderer state", () => {
  // Parsing a failed replacement must not leave the previously confirmed A authorized.
  it('revokes the previous stress consent when a replacement confirmation is invalid', async () => {
    const calls: OnlineExecutionInput[] = [];
    const store = createOnlineExecutionStore({ onlineExecution: async input => { calls.push(input); if (input.operation !== 'run') throw new Error('unexpected-operation'); return { ...localResult(input.runId), output: { kind: 'stress-failure', error: 'worker-failed', started: false, requests: { started: 0, completed: 0 } } }; } });
    activateRun(store); const project = ContractWorkspaceSchema.parse(workspaceFixture()).groups[0]!.projects[0]!;
    const plan = StressPlanSchema.parse({ formatVersion: 1, target: { kind: 'workflow', workflowId }, load: { kind: 'constant-vus', vus: 1 }, termination: { maxIterations: 1 } });
    project.stressPlans = [{ formatVersion: 1, id: 'saved', name: 'Saved', updatedAt: 0, plan }]; store.project = project; store.saved = JSON.stringify(project);
    try {
      store.confirmStressOrigins(plan, ['http://127.0.0.1:8123']);
      expect(() => store.confirmStressOrigins(plan, ['not-an-origin'])).toThrow();
      expect.soft(store.isStressConfirmed(plan)).toBe(false);
      await expect(store.run({ kind: 'stress', plan })).rejects.toThrow('stress-confirmation-required');
      expect(calls).toEqual([]);
    } finally { store.setVisible(false); }
  });
  // Each new intent consumes one consent before crossing the port; re-confirmation fixes B independently.
  it('atomically consumes stress consent before submission and requires new consent after a completed intent', async () => {
    const calls: OnlineExecutionInput[] = []; const authorizedAtPort: boolean[] = [];
    const store = createOnlineExecutionStore({ onlineExecution: async input => {
      if (input.operation !== 'run' || input.target.kind !== 'stress') throw new Error('unexpected-operation');
      calls.push(input); authorizedAtPort.push(store.isStressConfirmed(input.target.plan));
      const report = stressV2Report(); report.plan = input.target.plan; report.target = input.target.plan.target; report.projectId = store.project!.id;
      return OnlineLocalResultSchema.parse(JSON.parse(JSON.stringify({ ...localResult(input.runId), output: { kind: 'stress', result: report } })));
    } });
    activateRun(store); const project = ContractWorkspaceSchema.parse(workspaceFixture()).groups[0]!.projects[0]!;
    const plan = StressPlanSchema.parse({ formatVersion: 1, target: { kind: 'workflow', workflowId }, load: { kind: 'constant-vus', vus: 1 }, termination: { maxIterations: 1 } });
    project.stressPlans = [{ formatVersion: 1, id: 'saved', name: 'Saved', updatedAt: 0, plan }]; store.project = project; store.saved = JSON.stringify(project);
    try {
      store.confirmStressOrigins(plan, ['http://127.0.0.1:8123']); await store.run({ kind: 'stress', plan });
      expect(store.running).toBe(false); expect(store.localResult?.output.kind).toBe('stress');
      expect.soft(authorizedAtPort).toEqual([false]);
      await expect(store.run({ kind: 'stress', plan })).rejects.toThrow('stress-confirmation-required');
      expect(calls).toHaveLength(1);
      store.confirmStressOrigins(plan, ['http://127.0.0.1:9123']); await store.run({ kind: 'stress', plan });
      expect(calls).toHaveLength(2); expect(authorizedAtPort).toEqual([false, false]);
      expect(calls[0]).toMatchObject({ runConfig: { stress: { workerCount: 1, confirmedTargetOrigins: ['http://127.0.0.1:8123'] } } });
      expect(calls[1]).toMatchObject({ runConfig: { stress: { workerCount: 1, confirmedTargetOrigins: ['http://127.0.0.1:9123'] } } });
      expect(calls[1]!.operation === 'run' && calls[0]!.operation === 'run' && calls[1]!.runId !== calls[0]!.runId).toBe(true);
    } finally { store.setVisible(false); }
  });
  // A stale location confirmation would authorize a different machine's loopback.
  it('invalidates stress origin confirmation on location changes while preserving environment', () => {
    const store = createOnlineExecutionStore({ onlineExecution: async () => [] });
    store.activate(context);
    store.environmentId = "00000000-0000-4000-8000-000000000019";
    store.stressConfirmedOrigins = ['http://127.0.0.1:8123'];
    store.selectLocation({ kind: 'agent', agentId: '5' });
    expect(store.stressConfirmedOrigins).toEqual([]);
    expect(store.environmentId).toBe("00000000-0000-4000-8000-000000000019");
  });
  // Without admission here a UI-disabled agent could still be submitted by another consumer.
  it('refuses stress on an agent without task:stress capability before submission', async () => {
    const store = createOnlineExecutionStore({ onlineExecution: async () => { throw new Error('unexpected-submission'); } });
    activateRun(store);
    store.agents = { agents: [], defaultAgentId: null, canManageScripts: false, policyVersion: '0', policy: defaultPolicyConfig };
    store.selectLocation({ kind: 'agent', agentId: '5' });
    const plan = StressPlanSchema.parse({ formatVersion: 1, target: { kind: 'workflow', workflowId }, load: { kind: 'constant-vus', vus: 1 }, termination: { maxIterations: 1 } });
    await expect(store.run({ kind: 'stress', plan })).rejects.toThrow('stress-agent-unavailable');
    expect(store.running).toBe(false); store.setVisible(false);
  });
  // An unsaved target must never execute the older fixed assets or bypass a save conflict.
  it('refuses a stress target that is not the saved project plan', async () => {
    const store = createOnlineExecutionStore({ onlineExecution: async () => { throw new Error('unexpected-submission'); } });
    activateRun(store);
    const project = ContractWorkspaceSchema.parse(workspaceFixture()).groups[0]!.projects[0]!;
    const plan = StressPlanSchema.parse({ formatVersion: 1, target: { kind: 'workflow', workflowId }, load: { kind: 'constant-vus', vus: 1 }, termination: { maxIterations: 1 } });
    project.stressPlans = [{ formatVersion: 1, id: 'saved', name: 'Saved scenario', updatedAt: 0, plan }];
    store.project = project; store.saved = JSON.stringify(project);
    await expect(store.run({ kind: 'stress', plan: { ...plan, thinkTimeMs: 1 } })).rejects.toThrow('save-before-running');
    expect(store.running).toBe(false); store.setVisible(false);
  });
  // Dropping stressRun would silently select one worker and erase the user's exact origin consent.
  it('passes fixed stress worker count, origins and saved plan environment to the main port', async () => {
    let captured: unknown;
    const store = createOnlineExecutionStore({ onlineExecution: async input => { captured = input; if (input.operation !== 'run') throw new Error('unexpected-operation'); return { ...localResult(input.runId), output: { kind: 'stress-failure', error: 'worker-failed', started: false, requests: { started: 0, completed: 0 } } }; } });
    activateRun(store); const project = ContractWorkspaceSchema.parse(workspaceFixture()).groups[0]!.projects[0]!;
    const plan = StressPlanSchema.parse({ formatVersion: 1, target: { kind: 'workflow', workflowId }, environmentId: '00000000-0000-4000-8000-000000000019', maxVus: 2, load: { kind: 'constant-vus', vus: 2 }, termination: { maxIterations: 4 } });
    project.stressPlans = [{ formatVersion: 1, id: 'saved', name: 'Saved scenario', updatedAt: 0, plan }];
    store.project = project; store.saved = JSON.stringify(project); store.environmentId = plan.environmentId; store.stressWorkerCount = 2;
    store.confirmStressOrigins(plan, ['http://127.0.0.1:8123']);
    await store.run({ kind: 'stress', plan });
    expect(captured).toMatchObject({ target: { kind: 'stress', plan }, environmentId: '00000000-0000-4000-8000-000000000019', expectedVersion: '1', runConfig: { stress: { workerCount: 2, confirmedTargetOrigins: ['http://127.0.0.1:8123'] } } });
    store.setVisible(false);
  });
  // Two explicit, conflicting environments cannot be reconciled by confirming only origins.
  it('refuses two explicit conflicting stress environments even after confirming origins', async () => {
    const store = createOnlineExecutionStore({ onlineExecution: async () => { throw new Error('unexpected-submission'); } });
    activateRun(store); const project = ContractWorkspaceSchema.parse(workspaceFixture()).groups[0]!.projects[0]!;
    const plan = StressPlanSchema.parse({ formatVersion: 1, target: { kind: 'workflow', workflowId }, environmentId: '00000000-0000-4000-8000-000000000019', load: { kind: 'constant-vus', vus: 1 }, termination: { maxIterations: 1 } });
    project.environments.push({ id: '00000000-0000-4000-8000-000000000029', name: 'Another project environment', variables: {}, baseUrls: {} });
    project.stressPlans = [{ formatVersion: 1, id: 'saved', name: 'Saved scenario', updatedAt: 0, plan }]; store.project = project; store.saved = JSON.stringify(project);
    store.environmentId = '00000000-0000-4000-8000-000000000029'; store.confirmStressOrigins(plan, ['http://127.0.0.1:8123']);
    await expect(store.run({ kind: 'stress', plan })).rejects.toThrow('stress-environment-mismatch'); store.setVisible(false);
  });
  // A consent for the old asset version cannot authorize newly saved scripts or a changed worker topology.
  it.each(['version', 'workerCount'])('requires fresh stress confirmation after changing %s', async change => {
    const store = createOnlineExecutionStore({ onlineExecution: async () => { throw new Error('unexpected-submission'); } });
    activateRun(store); const project = ContractWorkspaceSchema.parse(workspaceFixture()).groups[0]!.projects[0]!;
    const plan = StressPlanSchema.parse({ formatVersion: 1, target: { kind: 'workflow', workflowId }, maxVus: 2, load: { kind: 'constant-vus', vus: 2 }, termination: { maxIterations: 4 } });
    project.stressPlans = [{ formatVersion: 1, id: 'saved', name: 'Saved scenario', updatedAt: 0, plan }];
    store.project = project; store.saved = JSON.stringify(project); store.confirmStressOrigins(plan, ['http://127.0.0.1:8123']);
    if (change === 'version') store.view!.assets.version = '2'; else store.stressWorkerCount = 2;
    await expect(store.run({ kind: 'stress', plan })).rejects.toThrow('stress-confirmation-required');
    store.setVisible(false);
  });
  it('settles its local run after hiding and restores its result on returning to the same context', async () => {
    const pending = deferred<unknown>(); let runId = '';
    const store = createOnlineExecutionStore({ onlineExecution: async input => { if (input.operation !== 'run') throw new Error('Unexpected operation'); runId = input.runId; return pending.promise; } });
    activateRun(store); const completion = store.run({ kind: 'workflow', workflowId });
    store.setVisible(false); pending.resolve(localResult(runId)); await completion; store.setVisible(true);
    expect(store.running).toBe(false); expect(store.activeLocalRunId).toBe(''); expect(store.localResult?.runId).toBe(runId);
    store.setVisible(false);
  });
  it('switches result ownership from an old agent report to the new local run', async () => {
    const pending = deferred<unknown>(); let runId = '';
    const store = createOnlineExecutionStore({ onlineExecution: async input => { if (input.operation !== 'run') throw new Error('Unexpected operation'); runId = input.runId; return pending.promise; } });
    activateRun(store); store.report = { executionId: '100', verdict: 'passed' }; store.selectedJobId = '99';
    const completion = store.run({ kind: 'workflow', workflowId });
    const reportAtStart = store.report; pending.resolve(localResult(runId)); await completion;
    expect(reportAtStart).toBeNull(); expect(store.report).toBeNull(); expect(store.selectedJobId).toBe(''); expect(store.localResult?.runId).toBe(runId);
    store.setVisible(false);
  });
  it('keeps the selected agent report when two inspections return in reverse order', async () => {
    const a = deferred<unknown>(), b = deferred<unknown>();
    const store = createOnlineExecutionStore({ onlineExecution: async input => { if (input.operation !== 'report') throw new Error('Unexpected operation'); return input.runId === '99' ? a.promise : b.promise; } });
    activateRun(store); const first = job('99', '100'), second = job('101', '102'); store.jobs = [first, second];
    const inspectA = store.inspect(first); const inspectB = store.inspect(second);
    b.resolve({ executionId: '102', verdict: 'failed' }); await inspectB; a.resolve({ executionId: '100', verdict: 'passed' }); await inspectA;
    expect(store.selectedJobId).toBe('101'); expect(store.report?.executionId).toBe('102'); expect(store.report?.verdict).toBe('failed');
    store.setVisible(false);
  });
  it("keeps the chosen environment when selecting an agent", () => {
    const store = createOnlineExecutionStore({ onlineExecution: async () => [] });
    store.activate(context); store.environmentId = "00000000-0000-4000-8000-000000000019";
    store.selectLocation({ kind: "agent", agentId: "5" });
    expect(store.location).toEqual({ kind: "agent", agentId: "5" });
    expect(store.environmentId).toBe("00000000-0000-4000-8000-000000000019");
  });
  it("discards a late list response after changing project, server or page visibility", async () => {
    for (const change of ["project", "server", "page"] as const) {
      let release!: (value: unknown) => void;
      const store = createOnlineExecutionStore({ onlineExecution: () => new Promise(resolve => { release = resolve; }) });
      store.activate(context); store.setVisible(true);
      const request = store.refresh();
      if (change === "page") store.setVisible(false);
      else store.activate(change === "project" ? { ...context, scope: { ...context.scope, projectId: "44" } } : { ...context, serverId: "https://other.test/api/v1" });
      release([{ jobId: "old-project-job" }]); await request;
      expect(store.jobs).toEqual([]);
    }
  });
  it("rejects a refresh interval that would overflow a host timer", () => {
    const store = createOnlineExecutionStore({ onlineExecution: async () => [] });
    expect(() => store.setRefreshMs(2147483648)).toThrow();
    expect(store.statusRefreshMs).toBe(2000);
  });
});
