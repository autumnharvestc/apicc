import type { DeepReadonly, ProjectSnapshot } from "../assets/snapshot.js";
import type { ApiAsset } from "../contract/model.js";
import type { ContractFolder } from "../contract/workspace.js";
import type { TestCase } from "../domain/common.js";
import { resolveExecutionEnvironment, selectEffectiveCases } from "../domain/executionSelection.js";
import type { CaseExecutionLocator } from "../runner/caseExecutor.js";
import { validateWorkflowStructure } from "../workflow/validate.js";
import { SuiteAssetSchema } from "./model.js";
import type { PreparedCaseSelection, PreparedTestData } from "./dataModel.js";

export interface SuiteRunOverrides {
  environmentId?: string;
  datasetId?: string;
  failFast?: boolean;
  allowDraft?: boolean;
  reporters?: readonly ("html" | "json" | "junit")[];
}
export interface ResolvedSuiteCase { readonly locator: CaseExecutionLocator; readonly nodeId?: string }
export interface ResolvedSuiteEntry {
  readonly id: string;
  readonly kind: "case" | "workflow";
  readonly workflowId?: string;
  readonly cases: readonly ResolvedSuiteCase[];
}
export interface ResolvedSuitePlan {
  readonly projectId: string;
  readonly definitionRevision: string;
  readonly suiteId: string;
  readonly suiteName: string;
  readonly environmentId?: string;
  readonly datasetId?: string;
  readonly failFast: boolean;
  readonly allowDraft: boolean;
  readonly reporters: readonly ("html" | "json" | "junit")[];
  readonly entries: readonly ResolvedSuiteEntry[];
  readonly selections: readonly PreparedCaseSelection[];
}
export interface SuitePreview {
  readonly plan: ResolvedSuitePlan;
  readonly outerRows: number;
  readonly plannedExecutions: number;
  readonly entries: readonly { readonly id: string; readonly rows: readonly number[]; readonly plannedExecutions: number }[];
  readonly sources: readonly { readonly label: string; readonly digest?: string; readonly rowCount: number; readonly legacyEmptyFallback: boolean }[];
}
export function freezeSuiteValue<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freezeSuiteValue); Object.freeze(value); }
  return value;
}
export const suiteCaseKey = (locator: CaseExecutionLocator): string => JSON.stringify([locator.collectionId, [...locator.folderIds], locator.apiId, locator.caseId, locator.scope]);
function fail(message: string): never { throw new Error(`套件配置错误: ${message}`); }
function locations(snapshot: ProjectSnapshot) {
  const result: Array<{ asset: DeepReadonly<ApiAsset>; collectionId: string; folderIds: readonly string[] }> = [];
  for (const collection of snapshot.project.collections) {
    const visit = (container: { readonly apis: readonly DeepReadonly<ApiAsset>[]; readonly folders: readonly DeepReadonly<ContractFolder>[] }, folderIds: readonly string[]) => {
      for (const asset of container.apis) result.push({ asset, collectionId: collection.id, folderIds });
      for (const folder of container.folders) visit(folder, [...folderIds, folder.id]);
    };
    visit(collection, []);
  }
  return result;
}

/** Resolve identity, scope and order only. No file, credential or protocol access. */
export function resolveSuitePlan(snapshot: ProjectSnapshot, suiteId: string, overrides: SuiteRunOverrides = {}): ResolvedSuitePlan {
  const matches = (snapshot.project.suites ?? []).filter((suite) => suite.id === suiteId);
  if (matches.length !== 1) fail("套件不存在或引用有歧义");
  const suite = SuiteAssetSchema.parse(matches[0]);
  const environmentId = overrides.environmentId ?? suite.environmentId;
  const datasetId = overrides.datasetId ?? suite.datasetId;
  const allowDraft = overrides.allowDraft ?? false;
  if (environmentId !== undefined && snapshot.project.environments.filter((env) => env.id === environmentId).length !== 1) fail("环境不存在或引用有歧义");
  if (datasetId !== undefined && (snapshot.project.datasets ?? []).filter((asset) => asset.id === datasetId).length !== 1) fail("数据集不存在或引用有歧义");
  const all = locations(snapshot);
  const effective = (location: typeof all[number], caseId?: string) => {
    const selected = selectEffectiveCases(location.asset.cases, resolveExecutionEnvironment(snapshot.project, location.collectionId, environmentId).chain, caseId);
    for (const tc of selected) if (location.asset.cases.filter((other) => other.id === tc.id && other.scope === tc.scope).length !== 1) fail("用例 scope 引用有歧义");
    return selected;
  };
  const resolved = (location: typeof all[number], tc: DeepReadonly<TestCase>, nodeId?: string): ResolvedSuiteCase => {
    if (datasetId !== undefined && tc.dataDriver !== undefined) fail("外层数据集与子用例 dataDriver 冲突");
    return { locator: { collectionId: location.collectionId, folderIds: [...location.folderIds], apiId: location.asset.contract.id, caseId: tc.id, scope: tc.scope }, ...(nodeId === undefined ? {} : { nodeId }) };
  };
  const entries: ResolvedSuiteEntry[] = [];
  if (suite.selection.kind === "explicit") {
    for (const entry of suite.selection.entries) {
      if (entry.kind === "case") {
        const candidates = all.filter((loc) => loc.collectionId === entry.collectionId && loc.asset.contract.id === entry.apiId && JSON.stringify(loc.folderIds) === JSON.stringify(entry.folderIds));
        if (candidates.length !== 1) fail("用例物理路径不存在或有歧义");
        const location = candidates[0]!; const cases = effective(location, entry.caseId);
        if (cases.length !== 1) fail("逻辑用例不存在或不适用于当前环境");
        entries.push({ id: entry.id, kind: "case", cases: [resolved(location, cases[0]!)] });
      } else {
        const workflows = snapshot.project.workflows.filter((wf) => wf.id === entry.workflowId);
        if (workflows.length !== 1) fail("工作流不存在或有歧义");
        const workflow = workflows[0]!;
        if (workflow.status === "draft" && !allowDraft) fail("draft 工作流需要本次 allowDraft");
        if (workflow.nodes.length === 0) fail("工作流没有节点");
        const errors = validateWorkflowStructure(workflow).filter((item) => item.level === "error");
        if (errors.length) fail(errors.map((e) => e.message).join("; "));
        const cases = workflow.nodes.filter((node) => node.kind === "request").map((node) => {
          const candidates = all.filter((loc) => loc.asset.contract.id === node.apiId);
          if (candidates.length !== 1) fail("工作流接口不存在或有歧义");
          const location = candidates[0]!; const selected = effective(location, node.caseId);
          if (!node.caseId || selected.length !== 1) fail("工作流用例不存在或不适用于当前环境");
          return resolved(location, selected[0]!, node.id);
        });
        entries.push({ id: entry.id, kind: "workflow", workflowId: workflow.id, cases });
      }
    }
  } else {
    const { collectionIds, caseTags } = suite.selection;
    if (collectionIds?.some((id) => snapshot.project.collections.filter((c) => c.id === id).length !== 1)) fail("筛选模块不存在或有歧义");
    const seen = new Set<string>();
    for (const location of all) {
      if (collectionIds?.length && !collectionIds.includes(location.collectionId)) continue;
      for (const tc of effective(location)) {
        if (caseTags?.length && !caseTags.some((tag) => tc.tags?.includes(tag))) continue;
        const selected = resolved(location, tc); const key = suiteCaseKey(selected.locator);
        if (seen.has(key)) continue;
        seen.add(key); entries.push({ id: key, kind: "case", cases: [selected] });
      }
    }
  }
  if (!entries.length) fail("选择集为空");
  const selections = new Map<string, PreparedCaseSelection>();
  for (const entry of entries) for (const selected of entry.cases) selections.set(suiteCaseKey(selected.locator), { locator: selected.locator, ...(datasetId === undefined ? {} : { datasetId }) });
  // Noop-only workflows cannot drive an outer source without an actual selected case.
  if (datasetId !== undefined && !selections.size) fail("外层数据集需要请求用例");
  return freezeSuiteValue({ projectId: snapshot.project.id, definitionRevision: snapshot.definitionRevision, suiteId, suiteName: suite.name,
    ...(environmentId === undefined ? {} : { environmentId }), ...(datasetId === undefined ? {} : { datasetId }),
    failFast: overrides.failFast ?? suite.failFast, allowDraft, reporters: SuiteAssetSchema.shape.reporters.parse(overrides.reporters ?? suite.reporters), entries, selections: [...selections.values()] });
}

/** Actual prepared row counts only. This DTO deliberately excludes rows and host paths. */
export function validateSuiteData(plan: ResolvedSuitePlan, data: PreparedTestData): SuitePreview {
  if (data.projectId !== plan.projectId || data.definitionRevision !== plan.definitionRevision) fail("数据快照不匹配");
  if (data.selections.length !== plan.selections.length) fail("数据选择不匹配");
  const sources = new Map(data.sources.map((source) => [source.key, source]));
  const counts = new Map<string, number>();
  plan.selections.forEach((selection, index) => {
    const actual = data.selections[index]; const key = suiteCaseKey(selection.locator);
    if (!actual || actual.key !== key || suiteCaseKey(actual.locator) !== key || actual.datasetId !== selection.datasetId) fail("数据选择顺序或来源不匹配");
    const source = actual.sourceKey === undefined ? undefined : sources.get(actual.sourceKey);
    if (actual.sourceKey !== undefined && !source) fail("数据源缺失");
    if (source?.diagnostics.some((d) => d.code !== "legacy-empty-fallback" && d.code !== "DATA_LEGACY_EMPTY_FALLBACK")) fail(source.diagnostics.map((d) => d.message).join("; "));
    if (source && !source.rows.length && !source.legacyEmptyFallback) fail("所选数据集为空");
    counts.set(key, source?.rows.length || 1);
  });
  const outerRows = plan.datasetId === undefined ? 1 : counts.values().next().value ?? 1;
  const entries = plan.entries.map((entry) => {
    const rows = entry.cases.map((selected) => counts.get(suiteCaseKey(selected.locator)) ?? 1);
    return { id: entry.id, rows, plannedExecutions: rows.reduce((sum, count) => sum + count, 0) };
  });
  const plannedExecutions = entries.reduce((sum, entry) => sum + entry.plannedExecutions, 0);
  if (plannedExecutions > 50000) fail("预计 executeCase 超过 50000 次");
  return freezeSuiteValue({ plan, outerRows, plannedExecutions, entries, sources: data.sources.map((source) => ({ label: source.label, ...(source.digest === undefined ? {} : { digest: source.digest }), rowCount: source.rows.length, legacyEmptyFallback: source.legacyEmptyFallback })) });
}

/** Snapshot-reference requests used by assertion and credential preparation. */
export function suiteCaseRequests(snapshot: ProjectSnapshot, plan: ResolvedSuitePlan): Array<{ asset: DeepReadonly<ApiAsset>; testCase: DeepReadonly<TestCase> }> {
  const all = locations(snapshot);
  return plan.selections.map(({ locator }) => {
    const location = all.find((candidate) => candidate.collectionId === locator.collectionId && candidate.asset.contract.id === locator.apiId && JSON.stringify(candidate.folderIds) === JSON.stringify(locator.folderIds));
    const testCase = location?.asset.cases.find((tc) => tc.id === locator.caseId && tc.scope === locator.scope);
    if (!location || !testCase) fail("计划用例不属于当前快照");
    return { asset: location.asset, testCase };
  });
}
