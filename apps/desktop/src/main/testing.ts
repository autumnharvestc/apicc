import { createExecutionEvidenceCollector, createProjectSnapshot, compileWorkflowPlan, workflowPlanRequests, parseDatasetContent, prepareTestData, resolveSuitePlan, suiteCaseRequests, suiteToRunResult, SuiteRunner, validateSuiteData, validateSuiteExecution, type PluginRegistry } from "@apicc/core";
import { join } from "node:path";
import { CollectionRunner, WorkflowRunner, createEventBus, createHttpSession, testDataSelectionsForRequests, resolveExecutionEnvironment, selectEffectiveCases, type CredentialRequestSelection, type RunResult } from "@apicc/core";
import { EvidenceInvocationSchema, type EvidenceInvocation } from "../shared/testing.js";
import { DatasetExchangeInputSchema, DatasetExportInputSchema, SuiteInvocationSchema, TestingReadInputSchema, type TestingApi, type TestingAssets, type SuiteInvocation } from "../shared/testing.js";
import type { createSession } from "./session.js";
import type { DebugCredentialHost } from "./credentialHost.js";
import { createExecutionOutputBoundary, persistExecutionJson } from "./executionOutput.js";
import { validateWorkflowRunOptions } from "@apicc/core";

/** Host-only orchestration. The captured plan/data stay here for C1 evidence projection. */
export function createTestingController(session: ReturnType<typeof createSession>, registrySource: () => Promise<PluginRegistry>, credentials: DebugCredentialHost,
  storage?: { persist(path: string, result: RunResult): { value: RunResult; warning?: string }; render?: boolean }) {
  const active = new Map<string, { owner: object; input: SuiteInvocation; abort: AbortController }>();
  const evidenceRuns = new Map<string, { owner: object; input: EvidenceInvocation; abort: AbortController }>();
  const defaultOwner = {};
  const plain = <T>(value: T): T => structuredClone(value);
  function listTestingAssets(raw: Parameters<TestingApi["listTestingAssets"]>[0]): Promise<TestingAssets> {
    const input = TestingReadInputSchema.parse(raw);
    if (session.root !== input.root) throw new Error("Testing root context changed");
    const found = session.locateProject(input.project);
    if (!found || !session.revision) throw new Error("Testing project not found");
    const project = found.project;
    const cases: TestingAssets["cases"] = [];
    for (const collection of project.collections) {
      const visit = (container: typeof collection | (typeof collection.folders)[number], folderIds: string[]) => {
        for (const asset of container.apis) {
          for (const testCase of asset.cases) {
            const previous = cases.find((item) => item.locator.collectionId === collection.id && JSON.stringify(item.locator.folderIds) === JSON.stringify(folderIds) && item.locator.apiId === asset.contract.id && item.caseId === testCase.id);
            if (previous) { previous.scopes.push(testCase.scope); continue; }
            cases.push({ locator: { ...input.project, collectionId: collection.id, folderIds, apiId: asset.contract.id }, caseId: testCase.id, name: `${asset.contract.metadata.name} / ${testCase.name}`, scopes: [testCase.scope], tags: testCase.tags ?? [] });
          }
        }
        for (const folder of container.folders) visit(folder, [...folderIds, folder.id]);
      };
      visit(collection, []);
    }
    return Promise.resolve(plain({ context: { ...input, revision: session.revision }, readOnly: session.readOnly, datasets: project.datasets ?? [], suites: project.suites ?? [], cases,
      environments: project.environments.map(({ id, name }) => ({ id, name })), collections: project.collections.map(({ id, name }) => ({ id, name })), workflows: project.workflows.map(({ id, name, status }) => ({ id, name, status })) }));
  }
  function check(input: SuiteInvocation) {
    session.assertTestingContext(input.context, input.locator);
    const current = session.captureDraftWriteContext();
    return () => { session.assertDraftWriteContext(current); session.assertTestingContext(input.context, input.locator); };
  }
  async function prepare(input: SuiteInvocation) {
    const ensureCurrent = check(input);
    const project = session.locateProject(input.context.project)!.project;
    const snapshot = createProjectSnapshot(project);
    let plan = resolveSuitePlan(snapshot, input.locator.suiteId, input.overrides);
    const data = await prepareTestData(snapshot, plan.selections, { workspaceRoot: input.context.root });
    ensureCurrent();
    const preview = validateSuiteData(plan, data);
    const registry = await registrySource();
    ensureCurrent();
    plan = validateSuiteExecution(snapshot, plan, registry);
    return { snapshot, plan, data, preview, registry, ensureCurrent };
  }
  const api: TestingApi = {
    inspectEvidence,
    rerunEvidence: (input) => rerunEvidence(input),
    cancelEvidence: (input) => cancelEvidence(input),
    listTestingAssets,
    async assertionOperators() {
      return (await registrySource()).listAsserts().map(({ op, descriptor }) => plain({ op, ...(descriptor ? { descriptor } : {}) }));
    },
    async saveDataset(input) {
      // Validate the same size/type limits as imported and executed datasets, while allowing empty drafts.
      parseDatasetContent(new TextEncoder().encode(JSON.stringify(input.asset.rows)), "json");
      await session.saveDataset(input);
      return listTestingAssets({ root: input.context.root, project: input.context.project });
    },
    async saveSuite(input) { await session.saveSuite(input); return listTestingAssets({ root: input.context.root, project: input.context.project }); },
    async deleteTestingAsset(input) { await session.deleteTestingAsset(input); return listTestingAssets({ root: input.context.root, project: input.context.project }); },
    async importDataset(raw) {
      const input = DatasetExchangeInputSchema.parse(raw);
      session.assertTestingContext(input.context);
      return parseDatasetContent(new TextEncoder().encode(input.content), input.format);
    },
    async exportDataset(raw) {
      const input = DatasetExportInputSchema.parse(raw);
      session.assertTestingContext(input.context, input.locator);
      const dataset = session.locateProject(input.context.project)?.project.datasets?.find((item) => item.id === input.locator.datasetId);
      if (!dataset) throw new Error("Dataset not found");
      if (input.format === "json") return JSON.stringify(dataset.rows, null, 2);
      const cell = (value: string) => `"${value.replace(/"/g, '""')}"`;
      return [dataset.columns.map(cell).join(","), ...dataset.rows.map((row) => dataset.columns.map((name) => cell(!(name in row) ? "" : typeof row[name] === "string" ? row[name] : JSON.stringify(row[name]))).join(","))].join("\r\n");
    },
    async previewSuite(raw) { const prepared = await prepare(SuiteInvocationSchema.parse(raw)); return plain(prepared.preview); },
    runSuite: (input) => runSuite(input),
    cancelSuite: (input) => cancelSuite(input),
  };
  async function runSuite(raw: SuiteInvocation, owner = defaultOwner) {
    const input = SuiteInvocationSchema.parse(raw);
    check(input);
    if (active.has(input.invocationId)) throw new Error("Suite invocation already active");
    const abort = new AbortController();
    active.set(input.invocationId, { owner, input, abort });
    let boundary = createExecutionOutputBoundary([]);
    try {
      const { snapshot, plan, data, registry, ensureCurrent } = await prepare(input);
      if (abort.signal.aborted) throw new Error("Suite invocation cancelled");
      const prepared = await credentials.prepareRunForRequests(input.context.project, snapshot, suiteCaseRequests(snapshot, plan), { workspaceRoot: input.context.root, environmentId: plan.environmentId, signal: abort.signal });
      boundary = createExecutionOutputBoundary(prepared.markers);
      ensureCurrent();
      const evidence = createExecutionEvidenceCollector({ projectId: snapshot.project.id, definitionRevision: snapshot.definitionRevision, environmentId: plan.environmentId, dataDigest: data.digest, datasetId: plan.datasetId }, prepared.markers, { mode: input.evidenceMode });
      const result = await new SuiteRunner({ registry }).run({ ...prepared.run, preparedTestData: data }, plan, { workspaceRoot: input.context.root, signal: abort.signal,
        observeCaseExecution: (execution, identity) => evidence.observe(execution, { ...identity, workflowId: plan.entries.find((entry) => entry.id === identity.entryId)?.workflowId }) });
      ensureCurrent();
      const safe = evidence.projectRun(suiteToRunResult(result));
      const outDir = join(input.context.root, ".apicc", "runs");
      const persisted = storage ? storage.persist(join(outDir, `suite-run-${result.suiteRunId}.json`), safe) : persistExecutionJson(join(outDir, `suite-run-${result.suiteRunId}.json`), safe, boundary, () => "安全 JSON 报告保存失败");
      if (persisted.warning) { safe.reportFailure = true; safe.warnings = [...(safe.warnings ?? []), persisted.warning]; }
      else if (storage?.render !== false) for (const format of plan.reporters) if (format !== "json") {
        try { const reporter = registry.getReporter(format); if (!reporter) throw new Error("报告格式未注册"); await reporter.render(safe, outDir); }
        catch { safe.reportFailure = true; safe.warnings = [...(safe.warnings ?? []), `${format} 报告渲染失败；安全 JSON 已保留`]; }
      }
      ensureCurrent();
      return { invocationId: input.invocationId, context: input.context, result: safe };
    } catch (error) { throw boundary.error(error); }
    finally { active.delete(input.invocationId); }
  }
  async function cancelSuite(raw: SuiteInvocation, owner = defaultOwner) {
    const input = SuiteInvocationSchema.parse(raw);
    const running = active.get(input.invocationId);
    if (!running || running.owner !== owner || JSON.stringify(running.input.context) !== JSON.stringify(input.context) || running.input.locator.suiteId !== input.locator.suiteId) return false;
    running.abort.abort();
    return true;
  }
  function evidenceTarget(raw: EvidenceInvocation) {
    const input = EvidenceInvocationSchema.parse(raw);
    session.assertTestingContext(input.context);
    if (input.identity.projectId !== input.context.project.projectId) throw new Error("历史证据不属于当前项目");
    const snapshot = createProjectSnapshot(session.locateProject(input.context.project)!.project);
    const selections: CredentialRequestSelection[] = [];
    const exact = (locator: NonNullable<EvidenceInvocation["identity"]["locator"]>) => {
      const collection = snapshot.project.collections.find((item) => item.id === locator.collectionId);
      let container: typeof collection | (NonNullable<typeof collection>["folders"][number]) = collection;
      for (const id of locator.folderIds) container = container?.folders.find((item) => item.id === id);
      const asset = container?.apis.find((item) => item.contract.id === locator.apiId);
      const testCase = asset && collection ? selectEffectiveCases(asset.cases, resolveExecutionEnvironment(snapshot.project, collection.id, input.identity.environmentId).chain, locator.caseId).find((item) => item.scope === locator.scope) : undefined;
      if (asset && testCase) selections.push({ asset, testCase });
      return !!asset && !!testCase;
    };
    let available = false;
    if (input.identity.workflowId) {
      const workflow = snapshot.project.workflows.find((item) => item.id === input.identity.workflowId);
      available = !!workflow && workflow.status !== "draft";
      if (available) {
        try { validateWorkflowRunOptions(workflow!); selections.push(...workflowPlanRequests(snapshot, compileWorkflowPlan(snapshot, input.identity.workflowId, { environmentId: input.identity.environmentId }))); }
        catch { available = false; }
      }
    } else if (input.identity.locator) available = exact(input.identity.locator);
    return { input, snapshot, selections, target: { available, changed: snapshot.definitionRevision !== input.identity.definitionRevision, definitionRevision: snapshot.definitionRevision, ...(available ? {} : { reason: "当前精确资源已删除、scope 不匹配或工作流不可运行" }) } };
  }
  async function inspectEvidence(raw: EvidenceInvocation) { return plain(evidenceTarget(raw).target); }
  async function rerunEvidence(raw: EvidenceInvocation, owner = defaultOwner) {
    const { input, snapshot, selections, target } = evidenceTarget(raw);
    if (!target.available) throw new Error(target.reason);
    if (evidenceRuns.has(input.invocationId)) throw new Error("Evidence invocation already active");
    const abort = new AbortController(); evidenceRuns.set(input.invocationId, { owner, input, abort });
    const current = session.captureDraftWriteContext();
    const ensureCurrent = () => { session.assertDraftWriteContext(current); session.assertTestingContext(input.context); };
    let output = createExecutionOutputBoundary([]); const httpSession = createHttpSession();
    let evidence: ReturnType<typeof createExecutionEvidenceCollector> | undefined;
    try {
      const data = await prepareTestData(snapshot, testDataSelectionsForRequests(snapshot, selections, input.identity.environmentId).map((selection) => ({ ...selection, datasetId: input.identity.datasetId })), { workspaceRoot: input.context.root });
      ensureCurrent();
      const prepared = await credentials.prepareRunForRequests(input.context.project, snapshot, selections, { workspaceRoot: input.context.root, environmentId: input.identity.environmentId, signal: abort.signal });
      output = createExecutionOutputBoundary(prepared.markers); ensureCurrent();
      const registry = await registrySource(); ensureCurrent();
      evidence = createExecutionEvidenceCollector({ ...input.identity, definitionRevision: snapshot.definitionRevision, dataDigest: data.digest }, prepared.markers);
      const collected = evidence;
      const run = { ...prepared.run, preparedTestData: data };
      let result;
      if (input.identity.workflowId) {
        const workflow = await new WorkflowRunner({ registry }).run(run, input.identity.workflowId, { environmentId: input.identity.environmentId, workspaceRoot: input.context.root, signal: abort.signal, httpSession,
          preparedRowIndex: input.identity.suiteRow, observeCaseExecution: (execution, identity) => collected.observe(execution, { ...identity, entryId: identity.nodeId }) });
        result = evidence.projectWorkflow(workflow).report!;
      } else {
        const locator = input.identity.locator!;
        const source = data.selections.find((selection) => JSON.stringify(selection.locator) === JSON.stringify(locator))?.sourceKey;
        if (!source && (input.identity.rowIndex ?? 0) > 0) throw new Error("当前资源已没有所选数据行");
        result = evidence.projectRun(await new CollectionRunner({ registry, bus: createEventBus(), failFast: false, timeouts: { signal: abort.signal, connectTimeoutMs: 10000, totalTimeoutMs: 30000 } }).run(run, locator.collectionId,
          { workspaceRoot: input.context.root, environmentId: input.identity.environmentId, httpSession, caseSelection: locator, preparedRowIndex: source ? input.identity.rowIndex : undefined, observeCaseExecution: evidence.observe }));
      }
      if (target.changed) result.warnings = [...(result.warnings ?? []), "资源定义已变化；使用当前资源和当前凭据重跑"];
      ensureCurrent();
      const path = join(input.context.root, ".apicc", "runs", `rerun-${input.invocationId}.json`);
      const persisted = storage ? storage.persist(path, result) : persistExecutionJson(path, result, output, () => "安全 JSON 报告保存失败");
      if (persisted.warning) { persisted.value.reportFailure = true; persisted.value.warnings = [...(persisted.value.warnings ?? []), evidence.boundary().redactText(persisted.warning)]; }
      return persisted.value;
    } catch (error) {
      if (evidence) {
        if (error && typeof error === "object" && "partialResult" in error) error.partialResult = evidence.projectRun(error.partialResult as RunResult);
        throw createExecutionOutputBoundary(evidence.markers()).error(error);
      }
      throw output.error(error);
    }
    finally { await httpSession.close(); evidenceRuns.delete(input.invocationId); }
  }
  async function cancelEvidence(raw: EvidenceInvocation, owner = defaultOwner) {
    const input = EvidenceInvocationSchema.parse(raw); const active = evidenceRuns.get(input.invocationId);
    if (!active || active.owner !== owner || JSON.stringify(active.input) !== JSON.stringify(input)) return false;
    active.abort.abort(); return true;
  }
  function clearOwner(owner: object) { for (const run of [...active.values(), ...evidenceRuns.values()]) if (run.owner === owner) run.abort.abort(); }
  function abortActive() { for (const run of [...active.values(), ...evidenceRuns.values()]) run.abort.abort(); }
  return { ...api, runSuite, cancelSuite, rerunEvidence, cancelEvidence, clearOwner, abortActive };
}
