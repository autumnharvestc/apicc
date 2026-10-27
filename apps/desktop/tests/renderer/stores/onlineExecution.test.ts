import { describe, expect, it } from "vitest";
import { createOnlineExecutionStore } from "../../../src/renderer/src/stores/onlineExecution.js";
import type { OnlineExecutionContext, OnlineJob, OnlineLocalResult } from "../../../src/shared/online/execution.js";
const context: OnlineExecutionContext = { serverId: "https://control.test/api/v1", ownerId: "7", scope: { workspaceId: "11", groupId: "22", projectId: "33" } };
const workflowId = '00000000-0000-4000-8000-000000000091';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function localResult(runId: string): OnlineLocalResult { return { location: { kind: 'local' }, runId, snapshotId: '66', manifestHash: 'a'.repeat(64), runtimeCompatibilityId: 'recorded-local-runtime', scriptTimeoutMs: 3000, output: { kind: 'failure', targetKind: 'workflow', error: 'Safe preparation failure', result: { collectionId: '', collectionName: 'workflow', startedAt: '2026-10-26T16:00:00.000Z', finishedAt: '2026-10-26T16:00:00.001Z', total: 0, passed: 0, failed: 1, cases: [] } } }; }
function activateRun(store: ReturnType<typeof createOnlineExecutionStore>) { store.activate(context); store.setVisible(true); store.view = { project: null, problems: [], assets: { ...context.scope, format: 'contract-files-v1', contractProjectId: '00000000-0000-4000-8000-000000000018', version: '1', manifestHash: 'a'.repeat(64), files: [] } }; }
function job(jobId: string, executionId: string): OnlineJob { return { jobId, executionId, agentId: '5', state: 'ended', cancelState: 'none', executionReleased: true, reportState: 'archived', task: { protocolVersion: 1, jobId, executionId, scope: context.scope, submittedByUserId: '7', contractProjectId: '00000000-0000-4000-8000-000000000018', snapshotId: '66', manifestHash: 'a'.repeat(64), target: { kind: 'workflow', workflowId }, policyVersion: '0', requiredCoreBuildId: 'b'.repeat(64), scriptPlanDigest: 'c'.repeat(64), executionProfile: 'no-script', runtimeCompatibilityId: 'recorded-agent-runtime', dispatchKind: 'dedicated-task', requiredCapabilities: ['task:workflow'] } }; }
describe("online execution renderer state", () => {
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
