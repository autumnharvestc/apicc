<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Alert as AAlert, Drawer as ADrawer, Table as ATable, Tag as ATag } from "ant-design-vue";
import type { CaseOutcome, EvidenceIdentity, NodeResult, NodeState, WorkflowRunResult, WorkflowTraceEvent } from "@apicc/core";
import type { ProjectLocator } from "../../../shared/locations.js";
import { reportingUnits } from "@apicc/core/report/units";
import { workflowToRunResult } from "@apicc/core/workflow/adapter";
import { stateTagColor } from "../wf/wfCanvas.js";
import CaseEvidencePanel from "./CaseEvidencePanel.vue";

/**
 * 运行结果抽屉（M2-B 任务 7，纯展示组件）：props 只收 open/result（WorkflowRunResult），
 * 关闭经 emit("close") 上抛（开关状态由 WfDesigner 持有：运行完成自动打开、顶栏
 * 「结果」按钮重开）。内容 = warnings a-alert 置顶列表 + 节点 a-table（label / 状态
 * Tag（stateTagColor，复用 colorForState 语义）/ 耗时（outcome?.durationMs）/ 错误）。
 * 组件内零 store/工厂调用；耗时无 outcome（noop/skipped）与无 error 以「—」占位。
 */
const props = withDefaults(defineProps<{ open: boolean; result: WorkflowRunResult | null; projectLocator?: ProjectLocator | null; embedded?: boolean }>(), { embedded: false });
const emit = defineEmits<{ close: []; locate: [identity: EvidenceIdentity] }>();
const { t, te } = useI18n();
function label(code: string | undefined) { if (!code) return '—'; const key = `executionLabels.${code}`; return te(key) ? t(key) : code; }

const columns = computed(() => [
  { key: "label", title: t("wf.colNode"), dataIndex: "label" },
  { key: "row", title: t("run.row"), dataIndex: "row" },
  { key: "state", title: t("wf.colState"), dataIndex: "state" },
  { key: "duration", title: t("wf.colDuration"), dataIndex: "duration" },
  { key: "error", title: t("wf.colError"), dataIndex: "error" },
  { key: "locate", title: t("wf.control.locate") },
]);
const isV2 = computed(() => props.result?.reportingMode === 'workflow-invocation-v2');
const facts = computed(() => props.result ? workflowToRunResult(props.result) : null);
function formatPath(path: WorkflowRunResult['invocationPath']) { return path?.map(segment => [segment.workflowId, segment.branchId,
  segment.iteration === undefined ? undefined : t('wf.control.iteration', { n: segment.iteration + 1 }), segment.handler].filter(Boolean).join(' · ')).join(' → '); }
const summary = computed(() => formatPath(props.result?.invocationPath));
function locate(node: NodeResult, outcome?: CaseOutcome) {
  const result = props.result;
  if (!result || !props.projectLocator) return;
  const collected = outcome?.evidence?.identity;
  emit('locate', { projectId: props.projectLocator.projectId, definitionRevision: collected?.definitionRevision ?? '',
    invocationId: outcome?.invocationId ?? node.invocationId ?? result.invocationId,
    parentInvocationId: outcome?.parentInvocationId ?? node.parentInvocationId ?? result.parentInvocationId,
    invocationPath: outcome?.invocationPath ?? node.invocationPath ?? result.invocationPath,
    nodeVisitId: outcome?.nodeVisitId ?? node.nodeVisitId, attempt: outcome?.attempt ?? node.attempt,
    workflowId: result.workflowId, nodeId: node.nodeId, locator: outcome?.locator ?? collected?.locator,
    rowIndex: outcome?.row, ...collected });
}
function locateTrace(event: WorkflowTraceEvent) {
  const workflowId = event.invocationPath?.at(-1)?.workflowId ?? props.result?.workflowId;
  if (!props.projectLocator || !workflowId || !event.nodeId) return;
  emit('locate', { projectId: props.projectLocator.projectId, definitionRevision: '', workflowId,
    invocationId: event.invocationId, parentInvocationId: event.parentInvocationId, invocationPath: event.invocationPath,
    nodeId: event.nodeId, nodeVisitId: event.nodeVisitId, attempt: event.attempt });
}

interface ResultRow {
  node: NodeResult;
  outcome?: CaseOutcome;
  state: NodeState;
  key: string;
}

/** 展开节点的全部实际数据行；旧报告无 outcomes 时回退 outcome。 */
const rows = computed<ResultRow[]>(() => props.result?.nodeResults.flatMap((node) => {
  const outcomes = node.outcomes?.length ? node.outcomes : node.outcome ? [node.outcome] : [];
  const identity = JSON.stringify([node.invocationId, node.invocationPath, node.nodeVisitId, node.nodeId]);
  if (outcomes.length === 0) return [{ node, state: node.state, key: `${identity}:0` }];
  const expanded: ResultRow[] = outcomes.map((outcome, index) => ({
    node, outcome, state: outcome.skipped ? "skipped" as const : outcome.passed ? "passed" as const : "failed" as const,
    key: `${identity}:${JSON.stringify([outcome.invocationId, outcome.nodeVisitId, outcome.attempt, outcome.locator, outcome.row, index])}`,
  }));
  // 条件/路由失败不能改写已经通过的 HTTP 数据行；追加独立节点诊断行。
  if (!isV2.value && reportingUnits(workflowToRunResult(props.result!)).diagnostics.some((entry) => entry.entryId === node.nodeId)) {
    expanded.push({
      node,
      state: "failed", key: `${identity}:diagnostic`,
    });
  }
  return expanded;
}) ?? []);

function rowKey(record: ResultRow): string {
  return record.key;
}

function formatMs(ms: number): string {
  return `${Math.round(ms)}ms`;
}
</script>

<template>
  <component
    :is="embedded ? 'section' : ADrawer"
    :open="open"
    :title="t('wf.resultTitle')"
    :width="'min(840px, 95vw)'"
    :data-testid="embedded ? `wf-invocation-${result?.invocationId}` : 'wf-result-drawer'"
    @close="emit('close')"
  >
    <template v-if="result">
      <div v-if="isV2 || embedded" class="wf-invocation">
        <p data-testid="wf-logical-verdict">{{ t('wf.control.logicalVerdict') }}: <strong>{{ label(result.verdict) }}</strong> · {{ t('wf.control.rawRows') }}: {{ facts?.total ?? 0 }} · {{ t('wf.control.rawFailed') }}: {{ facts?.failed ?? 0 }}</p>
        <p>{{ t('wf.control.mode') }}: {{ label(result.reportingMode ?? 'v1') }} · {{ result.workflowName }}</p>
        <p class="wf-identity">{{ t('wf.control.invocation') }}: {{ result.invocationId }} · {{ summary }}</p>
        <p v-if="result.requestFacts">{{ t('wf.control.requestFacts', { started: result.requestFacts.requestStarted, completed: result.requestFacts.requestCompleted, http: result.requestFacts.httpExchanges }) }}</p>
        <p class="wf-identity">{{ t('wf.control.currentAssetHint') }}</p>
        <details v-for="node in result.nodeResults" :key="JSON.stringify([node.invocationId, node.nodeVisitId, node.nodeId])" open class="wf-call-node">
          <summary>{{ node.label || node.nodeId }} · {{ label(node.state) }} · {{ t('wf.control.visit') }} {{ node.nodeVisitId ?? '—' }}</summary>
          <p v-if="node.primaryError">{{ t('wf.control.primary') }}: {{ node.primaryError.code }} · {{ node.primaryError.message }}</p>
          <p v-if="node.recoveredError" data-testid="wf-recovered">{{ t('wf.control.recovered') }}: {{ node.recoveredError.code }} · {{ node.recoveredError.message }}</p>
          <p v-for="(error, index) in node.secondaryErrors" :key="index">{{ t('wf.control.secondary') }}: {{ error.code }} · {{ error.message }}</p>
          <p v-for="attempt in node.attempts" :key="attempt.attempt">{{ t('wf.control.attempt', { n: attempt.attempt }) }} · {{ label(attempt.state) }} · {{ attempt.error?.message }}</p>
          <p v-for="branch in node.branches" :key="branch.invocationId">{{ branch.branchId }} · {{ label(branch.state) }} · {{ t(branch.winner ? 'wf.control.winner' : 'wf.control.loser') }} · {{ label(branch.cause) }} <span v-if="branch.cleanupFailed">{{ t('wf.control.cleanupFailed') }}</span></p>
          <p v-for="(event, index) in node.policyEvents" :key="index">{{ label(event.type) }}<template v-if="'cause' in event"> · {{ label(event.cause) }}</template></p>
          <details v-for="child in node.childInvocations" :key="child.invocationId" open><summary>{{ t('wf.control.invocation') }} · {{ child.workflowName }} · {{ label(child.verdict) }}</summary><WfResultDrawer embedded :open="true" :result="child" :project-locator="projectLocator" @locate="emit('locate', $event)" /></details>
          <details v-for="child in node.policyInvocations" :key="`${child.role}:${child.result.invocationId}`" open><summary>{{ t(`wf.control.${child.role}`) }} · {{ label(child.result.verdict) }}</summary><WfResultDrawer embedded :open="true" :result="child.result" :project-locator="projectLocator" @locate="emit('locate', $event)" /></details>
        </details>
      </div>
      <!-- warnings 置顶（结构性告警如悬空边——不阻断运行但必须可见，core runner 折进 warnings） -->
      <a-alert
        v-if="result.warnings.length > 0"
        class="wf-result-warnings"
        type="warning"
        show-icon
        data-testid="wf-result-warnings"
      >
        <template #message>
          <span>{{ t("wf.warnings") }}</span>
          <ul class="wf-result-warning-list">
            <li v-for="(w, i) in result.warnings" :key="i" data-testid="wf-result-warning-item">{{ w }}</li>
          </ul>
        </template>
      </a-alert>
      <a-table
        :data-source="rows"
        :columns="columns"
        :row-key="rowKey"
        :pagination="false"
        size="small"
        data-testid="wf-result-table"
        :custom-row="(): Record<string, any> => ({ 'data-testid': 'wf-result-node' })"
      >
        <template #expandedRowRender="{ record }"><CaseEvidencePanel :evidence="record.outcome?.evidence" /></template>
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'label'">
            <span v-if="record.key.endsWith(':diagnostic')">{{ t('executionLabels.entry-diagnostic') }} · </span>
            {{ record.outcome?.caseName || record.node.label || record.node.nodeId }}
          </template>
          <template v-else-if="column.key === 'state'">
            <a-tag :color="stateTagColor(record.state)" data-testid="wf-result-state">
              {{ t(`wf.nodeState.${record.state}`) }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'row'">{{ record.outcome?.row === undefined ? '—' : record.outcome.row + 1 }}<span v-if="record.outcome?.attempt"> · {{ t('wf.control.attempt', { n: record.outcome.attempt }) }}</span></template>
          <template v-else-if="column.key === 'locate'"><button type="button" data-testid="wf-locate-row" :disabled="!projectLocator" @click="locate(record.node, record.outcome)">{{ t('wf.control.locate') }}</button></template>
          <template v-else-if="column.key === 'duration'">
            {{ record.outcome ? formatMs(record.outcome.durationMs) : "—" }}
          </template>
          <template v-else-if="column.key === 'error'">
            <span class="wf-result-error">
              <template v-if="record.outcome">
                <template v-if="record.outcome.skipReason">{{ label(record.outcome.skipReason) }}</template>
                <template v-if="record.outcome.failureKind">{{ label(record.outcome.failureKind) }}</template>
                <template v-if="record.outcome.error">{{ record.outcome.error }}</template>
                <template v-if="!record.outcome.skipReason && !record.outcome.failureKind && !record.outcome.error">—</template>
              </template>
              <template v-else>
                <template v-if="record.node.failureKind">{{ label(record.node.failureKind) }}</template>
                <template v-if="record.node.error">{{ record.node.error }}</template>
                <template v-if="!record.node.failureKind && !record.node.error">{{ label(record.node.skipReason) }}</template>
              </template>
            </span>
          </template>
        </template>
      </a-table>
      <details v-if="result.trace" class="wf-trace"><summary>{{ t('wf.control.trace') }} · {{ result.trace.totalEvents }}</summary>
        <p v-if="result.trace.truncated">{{ t('wf.control.truncated', { shown: result.trace.events.length, total: result.trace.totalEvents }) }}</p>
        <ol><li v-for="(event, index) in result.trace.events" :key="index"><button type="button" :disabled="!event.nodeId || !projectLocator" @click="locateTrace(event)">{{ label(event.type) }}</button> · {{ label(event.state) }} · {{ label(event.cause) }} · {{ event.code }} · {{ event.message }}<span v-if="event.iteration !== undefined"> · {{ t('wf.control.iteration', { n: event.iteration + 1 }) }}</span><span v-if="event.attempt !== undefined"> · {{ t('wf.control.attempt', { n: event.attempt }) }}</span><small class="wf-identity">{{ event.invocationId }} · {{ event.nodeVisitId }} · {{ formatPath(event.invocationPath) }}<template v-if="event.childInvocation"> → {{ event.childInvocation.invocationId }}</template></small></li></ol>
      </details>
    </template>
  </component>
</template>

<style scoped>
/* 长文本防溢出（2B T7③）：warnings 告警整体 break-all（word-break 可继承，覆盖
 * message/列表全部子文本，li 上的显式规则保留兜底）；错误列单元格单独断行。 */
.wf-result-warnings { margin-bottom: 12px; word-break: break-all; }
.wf-result-warning-list { margin: 4px 0 0; padding-left: 18px; }
.wf-result-warning-list li { word-break: break-all; }
.wf-result-error { word-break: break-all; }
.wf-invocation, .wf-call-node, .wf-trace { overflow-wrap: anywhere; min-width: 0; }
.wf-identity { display: block; font-size: 11px; color: var(--text-muted); overflow-wrap: anywhere; }
.wf-call-node { margin: 8px 0; padding-left: 8px; border-left: 2px solid var(--border); }
.wf-trace { max-height: 45vh; overflow: auto; }
</style>
