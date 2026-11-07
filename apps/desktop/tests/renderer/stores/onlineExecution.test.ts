import { describe, expect, it } from "vitest";
import { createOnlineExecutionStore } from "../../../src/renderer/src/stores/onlineExecution.js";
import { ONLINE_EXECUTION_CACHE_SETTINGS_KEY } from '../../../src/renderer/src/stores/onlineExecutionCachePreferences.js';
import type { OnlineExecutionContext, OnlineJob, OnlineLocalResult, FullOnlineJob } from "../../../src/shared/online/execution.js";
import { ApiRequestSchema, DebugInvocationSchema, ContractWorkspaceSchema, StressPlanSchema } from '@apicc/core/schema';
import { workspaceFixture } from '../../../../../packages/core/tests/helpers/contractFixtures.js';
import { defaultPolicyConfig } from '@apicc/execution/contract';
import { OnlineLocalResultSchema, type OnlineExecutionInput } from '../../../src/shared/online/execution.js';
import { stressV2Report } from '../../helpers/stressV2.js';
const context: OnlineExecutionContext = { serverId: "https://control.test/api/v1", ownerId: "7", scope: { workspaceId: "11", groupId: "22", projectId: "33" } };
const workflowId = '00000000-0000-4000-8000-000000000091';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function localResult(runId: string): OnlineLocalResult { return { location: { kind: 'local' }, runId, snapshotId: '66', manifestHash: 'a'.repeat(64), runtimeCompatibilityId: 'recorded-local-runtime', scriptTimeoutMs: 3000, output: { kind: 'failure', targetKind: 'workflow', error: 'Safe preparation failure', result: { collectionId: '', collectionName: 'workflow', startedAt: '2026-10-26T16:00:00.000Z', finishedAt: '2026-10-26T16:00:00.001Z', total: 0, passed: 0, failed: 1, cases: [] } } }; }
function activateRun(store: ReturnType<typeof createOnlineExecutionStore>) { store.activate(context); store.setVisible(true); store.view = { project: null, problems: [], assets: { ...context.scope, format: 'contract-files-v1', contractProjectId: '00000000-0000-4000-8000-000000000018', version: '1', manifestHash: 'a'.repeat(64), files: [] } }; }
function job(jobId: string, executionId: string): FullOnlineJob { return { jobId, executionId, agentId: '5', state: 'ended', cancelState: 'none', executionReleased: true, reportState: 'archived', task: { protocolVersion: 1, jobId, executionId, scope: context.scope, submittedByUserId: '7', contractProjectId: '00000000-0000-4000-8000-000000000018', snapshotId: '66', manifestHash: 'a'.repeat(64), target: { kind: 'workflow', workflowId }, policyVersion: '0', requiredCoreBuildId: 'b'.repeat(64), scriptPlanDigest: 'c'.repeat(64), executionProfile: 'no-script', runtimeCompatibilityId: 'recorded-agent-runtime', dispatchKind: 'dedicated-task', requiredCapabilities: ['task:workflow'] } }; }
describe("F8 inactive execution cache", () => {
  const at = (id: number): OnlineExecutionContext => ({ ...context, scope: { ...context.scope, projectId: String(id) } });
  function activateAt(store: ReturnType<typeof createOnlineExecutionStore>, selected: OnlineExecutionContext) {
    store.activate(selected); store.setVisible(true);
    store.view = { project: null, problems: [], assets: { ...selected.scope, format: 'contract-files-v1', contractProjectId: '00000000-0000-4000-8000-000000000018', version: '1', manifestHash: 'a'.repeat(64), files: [] } };
  }
  it("F8 evicts the oldest safe context after the default twenty inactive contexts", () => {
    const store = createOnlineExecutionStore({ onlineExecution: async () => { throw new Error('No requests expected'); } });
    for (let id = 1; id <= 22; id++) { store.activate(at(id)); store.selectLocation({ kind: 'agent', agentId: '5' }); }
    store.activate(at(1));
    expect(store.location).toEqual({ kind: 'local' });
    store.activate(at(21));
    expect(store.location).toEqual({ kind: 'agent', agentId: '5' });
  });
  it("F8 expires idle selections before revisiting them using the monotonic clock", () => {
    let now = 0;
    const store = createOnlineExecutionStore({ onlineExecution: async () => [] }, { now: () => now });
    store.activate(at(1)); store.selectLocation({ kind: 'agent', agentId: '5' }); store.environmentId = '00000000-0000-4000-8000-000000000019';
    store.activate(at(2)); now = 31 * 60_000;
    store.activate(at(1));
    expect(store.location).toEqual({ kind: 'local' }); expect(store.environmentId).toBeUndefined();
  });
  it("F8 releases a safe inactive result above the configured serialized payload budget", async () => {
    const store = createOnlineExecutionStore({ onlineExecution: async input => {
      if (input.operation !== 'run') throw new Error('Unexpected operation');
      const result = localResult(input.runId); if (result.output.kind === 'failure') result.output.result.warnings = ['x'.repeat(1_100_000)];
      return result;
    } }, { preferences: { maxInactiveContexts: 20, inactiveTtlMinutes: 30, maxInactivePayloadMiB: 1 }, storage: null });
    try {
      activateAt(store, at(1)); await store.run({ kind: 'workflow', workflowId });
      expect(store.localResult).not.toBeNull(); store.activate(at(2)); store.activate(at(1));
      expect(store.localResult).toBeNull(); expect(store.resultSelection).toBeNull();
    } finally { store.setVisible(false); }
  });
  it("F8 protects a local RPC across switches and permits eviction only after real settlement", async () => {
    const response = deferred<unknown>(); let runId = '';
    const store = createOnlineExecutionStore({ onlineExecution: async input => { if (input.operation !== 'run') throw new Error('Unexpected operation'); runId = input.runId; return response.promise; } },
      { preferences: { maxInactiveContexts: 0, inactiveTtlMinutes: 30, maxInactivePayloadMiB: 1 }, storage: null });
    activateAt(store, at(1)); const running = store.run({ kind: 'workflow', workflowId });
    store.activate(at(2)); store.activate(at(1)); expect(store.running).toBe(true); expect(store.activeLocalRunId).toBe(runId);
    store.activate(at(2)); response.resolve(localResult(runId)); await running; store.activate(at(1));
    expect(store.running).toBe(false); expect(store.localResult).toBeNull(); store.setVisible(false);
  });
  it("F8 keeps every known unarchived job protected even when a later run replaces the latest result", async () => {
    const active = { ...job('101', '201'), state: 'running' as const, executionReleased: false, reportState: 'none' as const };
    active.task.scope = at(1).scope;
    const archived = job('102', '202'); archived.task.scope = at(1).scope;
    let calls = 0;
    const store = createOnlineExecutionStore({ onlineExecution: async input => {
      if (input.operation === 'list') return [archived];
      if (input.operation !== 'run') throw new Error('Unexpected operation'); return ++calls === 1 ? active : archived;
    } },
      { preferences: { maxInactiveContexts: 0, inactiveTtlMinutes: 30, maxInactivePayloadMiB: 1 }, storage: null });
    try {
      activateAt(store, at(1)); store.selectLocation({ kind: 'agent', agentId: '5' });
      await store.run({ kind: 'workflow', workflowId }); await store.run({ kind: 'workflow', workflowId });
      await store.refresh();
      store.activate(at(2)); store.activate(at(1)); expect(store.selectedJobId).toBe('102');
      expect(store.location).toEqual({ kind: 'agent', agentId: '5' }); expect(calls).toBe(2);
      expect(store.cacheUsage.protectedContexts).toBe(0);
      store.activate(at(2)); expect(store.cacheUsage.protectedContexts).toBe(1); expect(store.cacheUsage.overLimit).toBe(true);
      store.activate(at(1));
      await store.inspect({ ...active, state: 'ended', executionReleased: true, reportState: 'expired' });
      store.activate(at(2)); store.activate(at(1)); expect(store.resultSelection).toBeNull(); expect(calls).toBe(2);
    } finally { store.setVisible(false); }
  });
  it("F8 retains an uncertain submitted RPC instead of treating its rejection as physical release", async () => {
    let calls = 0;
    const store = createOnlineExecutionStore({ onlineExecution: async () => { calls++; throw new Error('connection-lost-after-submit'); } },
      { preferences: { maxInactiveContexts: 0, inactiveTtlMinutes: 30, maxInactivePayloadMiB: 1 }, storage: null });
    try {
      activateAt(store, at(1)); store.selectLocation({ kind: 'agent', agentId: '5' });
      await expect(store.run({ kind: 'workflow', workflowId })).rejects.toThrow('connection-lost-after-submit');
      store.activate(at(2)); store.activate(at(1)); expect(store.error).toBe('connection-lost-after-submit');
      expect(store.location).toEqual({ kind: 'agent', agentId: '5' }); expect(calls).toBe(1);
    } finally { store.setVisible(false); }
  });
  it("F8 retains only the target kind after submission instead of an extra copy of debug request contents", async () => {
    const request = ApiRequestSchema.parse({ protocol: 'http', method: 'POST', baseUrl: 'https://synthetic.test', path: '/debug', pathParams: [], cookies: [], headers: [], query: [], auth: { kind: 'none' }, body: { kind: 'json', content: JSON.stringify({ synthetic: 'x'.repeat(20_000) }) } });
    const invocation = DebugInvocationSchema.parse({ mode: 'request', locator: { workspaceId: 'ws', groupId: 'group', projectId: 'project', collectionId: 'collection', folderIds: [], apiId: 'api' }, request, parameters: {}, fields: [] });
    let sentBytes = 0;
    const store = createOnlineExecutionStore({ onlineExecution: async input => {
      if (input.operation !== 'run') throw new Error('Unexpected operation'); sentBytes = JSON.stringify(input.target).length;
      const result = localResult(input.runId); if (result.output.kind === 'failure') result.output.targetKind = 'debug'; return result;
    } }, { storage: null });
    try {
      activateAt(store, at(1)); await store.run({ kind: 'debug', invocation }); expect(sentBytes).toBeGreaterThan(20_000);
      store.activate(at(2)); expect(store.cacheUsage.inactivePayloadBytes).toBeLessThan(5_000);
      store.activate(at(1)); expect(store.localResult).not.toBeNull();
    } finally { store.setVisible(false); }
  });
  it("F8 refreshes retained job identities absent from the latest page before releasing protection", async () => {
    const active = { ...job('101', '201'), state: 'running' as const, executionReleased: false, reportState: 'none' as const };
    active.task.scope = at(1).scope;
    const recent = job('102', '202'); recent.task.scope = at(1).scope;
    const queried: string[] = []; let runs = 0;
    const store = createOnlineExecutionStore({ onlineExecution: async input => {
      if (input.operation === 'run') return ++runs === 1 ? active : recent;
      if (input.operation === 'list') return [recent];
      if (input.operation === 'status') { queried.push(input.runId); return { ...active, state: 'ended', executionReleased: true, reportState: 'archived' }; }
      throw new Error('Unexpected operation');
    } }, { preferences: { maxInactiveContexts: 0, inactiveTtlMinutes: 30, maxInactivePayloadMiB: 1 }, storage: null });
    try {
      activateAt(store, at(1)); store.selectLocation({ kind: 'agent', agentId: '5' });
      await store.run({ kind: 'workflow', workflowId }); await store.run({ kind: 'workflow', workflowId }); await store.refresh();
      expect(store.jobs.map(item => item.jobId)).toEqual(['102']);
      await store.refreshActive(); expect(queried).toEqual(['101']);
      store.activate(at(2)); store.activate(at(1)); expect(store.resultSelection).toBeNull(); expect(runs).toBe(2);
    } finally { store.setVisible(false); }
  });
  it.each([2, 21])("F8 a failed status read does not starve later known refs across bounded pages (%s jobs)", async count => {
    const active = Array.from({ length: count }, (_value, index) => {
      const row = { ...job(String(101 + index), String(201 + index)), state: 'running' as const, executionReleased: false, reportState: 'none' as const };
      row.task.scope = at(1).scope; return row;
    });
    let submitted = 0; let recoverFirst = false; const queried: string[] = [];
    const store = createOnlineExecutionStore({ onlineExecution: async input => {
      if (input.operation === 'run') return active[submitted++]!;
      if (input.operation === 'status') {
        queried.push(input.runId); if (input.runId === '101' && !recoverFirst) throw new Error('history-read-forbidden');
        const previous = active.find(row => row.jobId === input.runId)!;
        return { ...previous, state: 'ended', executionReleased: true, reportState: 'archived' };
      }
      throw new Error('Unexpected operation');
    } }, { preferences: { maxInactiveContexts: 0, inactiveTtlMinutes: 30, maxInactivePayloadMiB: 1 }, storage: null });
    try {
      activateAt(store, at(1)); store.selectLocation({ kind: 'agent', agentId: '5' });
      for (const _row of active) await store.run({ kind: 'workflow', workflowId });
      await store.refreshActive(); expect(queried).toHaveLength(Math.min(20, count));
      if (count > 20) await store.refreshActive();
      expect(queried).toContain(String(100 + count)); expect(store.error).toBe('history-read-forbidden');
      store.activate(at(2)); expect(store.cacheUsage.protectedContexts).toBe(1);
      store.activate(at(1)); recoverFirst = true; queried.length = 0; await store.refreshActive(); expect(queried).toEqual(['101']);
      store.activate(at(2)); store.activate(at(1)); expect(store.resultSelection).toBeNull();
    } finally { store.setVisible(false); }
  });
  it("F8 keeps cache identities separate for servers, users, workspaces, groups and projects", () => {
    const store = createOnlineExecutionStore({ onlineExecution: async () => [] }, { storage: null });
    const variants = [context, { ...context, serverId: 'https://other.test/api/v1' }, { ...context, ownerId: '8' },
      { ...context, scope: { ...context.scope, workspaceId: '12' } }, { ...context, scope: { ...context.scope, groupId: '23' } }, at(34)];
    for (const [index, selected] of variants.entries()) { store.activate(selected); store.selectLocation({ kind: 'agent', agentId: String(50 + index) }); }
    for (const [index, selected] of variants.entries()) { store.activate(selected); expect(store.location).toEqual({ kind: 'agent', agentId: String(50 + index) }); }
    store.activate(context);
    store.activate({ scope: { projectId: '33', groupId: '22', workspaceId: '11' }, ownerId: '7', serverId: context.serverId });
    expect(store.location).toEqual({ kind: 'agent', agentId: '50' });
  });
  it("F8 persists only validated local preferences and applies limits after a successful save", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const store = createOnlineExecutionStore({ onlineExecution: async () => [] }, { storage });
    store.activate(at(1)); store.selectLocation({ kind: 'agent', agentId: '5' }); store.activate(at(2));
    const preferences = { maxInactiveContexts: 0, inactiveTtlMinutes: 1, maxInactivePayloadMiB: 1 };
    expect(() => store.setCachePreferences({ ...preferences, maxInactiveContexts: -1 })).toThrow('online-cache-settings-invalid');
    expect(values.size).toBe(0); expect(store.cacheUsage.inactiveContexts).toBe(1);
    store.setCachePreferences(preferences);
    expect(store.cacheUsage.inactiveContexts).toBe(0); expect(JSON.parse(values.get(ONLINE_EXECUTION_CACHE_SETTINGS_KEY)!)).toEqual(preferences);
    const reopened = createOnlineExecutionStore({ onlineExecution: async () => [] }, { storage });
    expect(reopened.cachePreferences).toEqual(preferences);
    expect(reopened.cachePreferenceDiagnostic).toBeNull();
    storage.setItem = () => { throw new Error('local storage unavailable'); };
    expect(() => store.setCachePreferences({ ...preferences, maxInactiveContexts: 10 })).toThrow('online-cache-settings-save-failed');
    expect(store.cachePreferences).toEqual(preferences);
    values.set(ONLINE_EXECUTION_CACHE_SETTINGS_KEY, '{invalid');
    const damaged = createOnlineExecutionStore({ onlineExecution: async () => [] }, { storage });
    expect(damaged.cachePreferences.maxInactiveContexts).toBe(20); expect(damaged.cachePreferenceDiagnostic).toBe('online-cache-settings-corrupt');
  });
});
describe("online execution renderer state", () => {
  it.each(['refresh','cancel'])('F7f minimum %s replaces selected full job and never requests historical report',async operation=>{
    const calls:OnlineExecutionInput[]=[];
    const minimum={jobId:'99',executionId:'100',agentId:'5',state:operation==='cancel'?'ended':'running',cancelState:operation==='cancel'?'confirmed':'none',executionReleased:operation==='cancel',canCancel:operation!=='cancel',view:'active-status',scope:context.scope};
    const previous={...job('99','100'),state:'running' as const,reportState:'none' as const};
    const store=createOnlineExecutionStore({onlineExecution:async input=>{calls.push(input);return input.operation==='run'?previous:minimum;}});
    activateRun(store);store.selectLocation({kind:'agent',agentId:'5'});await store.run({kind:'workflow',workflowId});
    expect(store.jobs[0]).toEqual(previous);store.report={executionId:'100',verdict:'passed'};
    try{
      const error=await (operation==='refresh'?store.refreshActive():store.cancel(previous)).then(()=>null,cause=>cause);
      expect.soft(error).toBeNull();
      expect.soft(store.jobs[0]).toEqual(minimum);
      expect.soft(store.resultSelection).toEqual({kind:'agent',job:minimum});
      expect.soft(store.connection).not.toBe('disconnected');
      expect.soft(store.report).toBeNull();
      store.setVisible(false);store.setVisible(true);
      expect.soft(store.jobs[0]).toEqual(minimum);expect.soft(store.resultSelection).toEqual({kind:'agent',job:minimum});expect.soft(store.report).toBeNull();
      expect(calls.some(call=>call.operation==='report')).toBe(false);
    }finally{store.setVisible(false);}
  });
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
