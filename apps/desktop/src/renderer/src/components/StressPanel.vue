<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  Button as AButton,
  InputNumber as AInputNumber,
  Radio as ARadio,
  RadioGroup as ARadioGroup,
  Select as ASelect,
} from "ant-design-vue";
import type { StressTargetPolicy } from "@apicc/core";
import { StressPlanSchema } from "@apicc/core/schema";
import type { ApiLocator, ProjectLocator } from "../../../shared/locations.js";
import { createStressFormDefaults, type createStressStore } from "../stores/stress.js";
import StressReportView from "./StressReportView.vue";
import StressLoadEditor from "./StressLoadEditor.vue";

/**
 * 压测面板（M2-D3 任务 2，裁定 B）：表单（用例/环境 a-select、并发 a-input-number、
 * 终止条件 a-radio-group + 迭代数/秒数输入）+ 开始/停止按钮 + 报告展示（StressReportView）。
 * **组件内零工厂调用**：stress store 实例经 props 注入（任务 3 App 装配；组件测试同款）；
 * cases/envs 按「props 直接传列表」契约下发（对照既有面板 props 数据下发风格，组合根从
 * editor store 取值，不在组件内重复发 apiGet）。选择悬空防御与既有面板同款：接口切换后
 * 失效 caseId 回退首个用例、失效环境名复位「无环境」。运行/停止链路拒绝经 reportError
 * 转报组合根错误通道；store.error（debug 错误语义：老报告保留）同步在面板内可见。
 * file 字段（裁定 D）仅作落盘路径一行小字提示，file 省略（落盘降级）时不显示。
 * 任务 3 裁定 C 顺修：① a-input-number 清空产生 null → update 通道按表单默认值归一
 * （并发 1 / 迭代 10 / 秒 10，默认值以 createStressFormDefaults 为单一来源），start 载荷
 * 不再携带 null；② cases 为空时显示「无用例」空态提示（开始按钮本就因无 caseId 禁用）。
 */
const props = defineProps<{
  stress: ReturnType<typeof createStressStore>;
  apiLocator?: ApiLocator | null;
  projectLocator?: ProjectLocator | null;
  workflows?: Array<{ id: string; name: string }>;
  cases: Array<{ id: string; name: string }>;
  envs: Array<{ id: string; name: string }>;
  reportError: (e: unknown) => void;

  /** 环境选中共享源（M10）：传入则环境下拉读写调试 store 的项目记忆。 */
  debug?: { selectedEnvName: string | null; selectEnv(name: string | null): void };
  policy?: StressTargetPolicy;
  savePolicy?: (policy: StressTargetPolicy) => Promise<void>;
  readOnly?: boolean;
}>();
const { t } = useI18n();
const pane = ref<'configuration' | 'report'>('configuration');
const filter = ref('');
const valid = ref(false);
const workbench = computed(() => !!props.projectLocator && !!props.stress.planOwner);
const history = computed(() => props.stress.history.filter(row => `${row.file} ${row.startedAt}`.toLowerCase().includes(filter.value.toLowerCase())));
const comparisonRows = computed(() => Object.entries(props.stress.comparison?.metrics ?? {}).map(([key,value]) => ({ key, ...value })));
const value = (n: number | null) => n === null ? t('stress.workbench.notComputable') : String(Math.round(n * 10000) / 10000);
async function perform(action: () => Promise<unknown>) { try { await action(); } catch (e) { props.reportError(e); } }
function newPlan() {
  if (!props.stress.plan || props.stress.running) return;
  props.stress.plan = StressPlanSchema.parse({ formatVersion: 1, target: JSON.parse(JSON.stringify(props.stress.plan.target)), load: { kind: 'constant-vus', vus: 1 }, termination: { maxIterations: 10 } });
  props.stress.savedPlanId = null; props.stress.planName = ''; props.stress.denyPlanTarget(); pane.value = 'configuration';
}
watch(() => props.stress.planOwner, owner => { if (owner) void perform(() => props.stress.loadStressHistory()); }, { immediate: true });
watch(() => props.stress.planReport, report => { if (report) { pane.value = 'report'; void perform(() => props.stress.loadStressHistory()); } });

// 数字输入清空归一的默认值（与 form 初始默认同一来源，裁定 C①）
const FORM_DEFAULTS = createStressFormDefaults();
const policyDraft = ref<StressTargetPolicy>({ trustedOrigins: [], deniedOrigins: [] });
watch(() => props.policy, (policy) => {
  policyDraft.value = {
    trustedOrigins: [...(policy?.trustedOrigins ?? [])],
    deniedOrigins: [...(policy?.deniedOrigins ?? [])],
    ...(policy?.maxConcurrency !== undefined ? { maxConcurrency: policy.maxConcurrency } : {}),
    ...(policy?.maxRps !== undefined ? { maxRps: policy.maxRps } : {}),
  };
}, { immediate: true, deep: true });

// —— 选项派生 ——
const caseOptions = computed(() => props.cases.map((c) => ({ label: c.name, value: c.id })));
const envOptions = computed(() => [
  { label: t("stress.envNone"), value: "" },
  ...props.envs.map((e) => ({ label: e.name, value: e.name })),
]);

// 悬空回退：form.caseId 不在当前用例列表时回退首个（CasePanel selected 同款语义），
// 环境列表变化后失效环境名复位「无环境」（RunView 切项目重置环境同款）。
watch(
  () => props.cases,
  (cases) => {
    if (!cases.some((c) => c.id === props.stress.form.caseId)) {
      props.stress.form.caseId = cases[0]?.id ?? null;
    }
  },
  { immediate: true },
);
watch(
  () => props.envs,
  (envs) => {
    if (props.stress.form.envName && !envs.some((e) => e.name === props.stress.form.envName)) {
      props.stress.form.envName = null;
    }
  },
  { immediate: true },
);

// —— 开始 / 停止（store 持有 running/report/file/error 状态；拒绝转报组合根通道） ——
async function onStart() {
  if (!props.apiLocator) return;
  try {
    await props.stress.start(props.apiLocator);
  } catch (e) {
    props.reportError(e);
  }
}

async function onStop() {
  if (!props.apiLocator) return;
  try {
    await props.stress.stop(props.apiLocator);
  } catch (e) {
    props.reportError(e);
  }
}
async function savePolicy() {
  if (props.readOnly || !props.savePolicy) return;
  await props.savePolicy({
    ...policyDraft.value,
    trustedOrigins: [...new Set(policyDraft.value.trustedOrigins ?? [])].filter((origin) => !(policyDraft.value.deniedOrigins ?? []).includes(origin)),
    deniedOrigins: [...new Set(policyDraft.value.deniedOrigins ?? [])],
  });
}
function setThreshold(key: keyof typeof props.stress.form.thresholds, value: number | null) {
  if (value === null || value === undefined) delete props.stress.form.thresholds[key];
  else props.stress.form.thresholds[key] = value;
}
</script>

<template>
  <section v-if="workbench && stress.plan" class="stress-workbench" data-testid="stress-workbench">
    <header class="workbench-head"><h3>{{ t('stress.workbench.title') }}</h3><span class="target-name" :title="stress.plan.target.kind === 'workflow' ? stress.plan.target.workflowId : stress.plan.target.caseId">{{ stress.plan.target.kind }} · {{ stress.plan.target.kind === 'workflow' ? stress.plan.target.workflowId : stress.plan.target.caseId }}</span><span data-testid="stress-plan-state">{{ t(`stress.workbench.state.${stress.planState}`) }}</span></header>
    <div class="workbench-body">
      <aside class="workbench-nav">
        <div class="nav-title">{{ t('stress.workbench.plans') }}<button class="icon-action" :title="t('stress.workbench.new')" :aria-label="t('stress.workbench.new')" :disabled="stress.running" @click="newPlan">＋</button></div>
        <div v-for="saved in stress.plans" :key="saved.id" class="nav-row" :class="{selected:saved.id === stress.savedPlanId}"><button class="name-action" :title="saved.name" :disabled="stress.running" @click="perform(async () => { await stress.openPlan(saved.id); pane = 'configuration'; })">{{ saved.name }}</button><button class="icon-action" :title="t('stress.workbench.remove')" :aria-label="t('stress.workbench.remove')" :disabled="readOnly || stress.running" @click="perform(() => stress.removePlan(saved.id))">×</button></div>
        <div class="nav-title">{{ t('stress.workbench.results') }}<button class="icon-action" :title="t('stress.workbench.refresh')" :aria-label="t('stress.workbench.refresh')" @click="perform(() => stress.loadStressHistory())">↻</button></div>
        <p class="history-note">{{ t('stress.workbench.provenHistory') }}</p>
        <input v-model="filter" class="history-filter" :placeholder="t('stress.workbench.filter')" data-testid="stress-history-filter" />
        <button v-for="row in history" :key="row.file" class="history-action" :class="{selected:row.file === stress.planFile}" :title="row.file" @click="perform(async () => { await stress.openStressReport(row.file); pane = 'report'; })"><span>{{ row.file }}</span><small>{{ row.startedAt }} · {{ row.verdict ?? 'legacy' }} · RPS {{ row.rps ?? '—' }}</small></button>
      </aside>
      <div class="workbench-main">
        <nav class="pane-tabs"><button :class="{selected:pane === 'configuration'}" @click="pane = 'configuration'">{{ t('stress.workbench.configuration') }}</button><button :class="{selected:pane === 'report'}" @click="pane = 'report'">{{ t('stress.workbench.report') }}</button></nav>
        <div class="workbench-scroll">
          <div v-if="pane === 'configuration'" class="plan-config">
            <label>{{ t('stress.workbench.name') }}<input v-model="stress.planName" :disabled="stress.running" maxlength="200" data-testid="stress-plan-name" /></label>
            <button :disabled="readOnly || stress.running || !valid || !stress.planName.trim()" data-testid="stress-plan-save" @click="perform(() => stress.savePlan())">{{ t('stress.workbench.save') }}</button>
            <StressLoadEditor :plan="stress.plan" :disabled="stress.running" :workflows="workflows ?? []" :envs="envs" @valid="valid = $event" />
          </div>
          <template v-else>
            <div class="baseline-tools"><label>{{ t('stress.workbench.baseline') }}<select :value="stress.baselineFile ?? ''" data-testid="stress-baseline" @change="perform(() => stress.selectBaseline(($event.target as HTMLSelectElement).value || null))"><option value="">{{ t('stress.workbench.noBaseline') }}</option><option v-for="row in stress.history" :key="row.file" :value="row.file">{{ row.file }}</option></select></label><button :disabled="!stress.baselineFile" data-testid="stress-baseline-clear" @click="perform(() => stress.selectBaseline(null))">{{ t('stress.workbench.clearBaseline') }}</button></div>
            <div class="export-tools"><button :disabled="!stress.planFile" @click="perform(() => stress.exportReport('html'))">{{ t('stress.workbench.exportHtml') }}</button><button :disabled="!stress.planFile" @click="perform(() => stress.exportReport('json'))">{{ t('stress.workbench.exportJson') }}</button></div>
            <p v-if="stress.comparisonError" class="error" data-testid="stress-comparison-error">{{ stress.comparisonError }}</p>
            <section v-if="stress.comparison" data-testid="stress-comparison"><h4>{{ t('stress.workbench.comparison') }}</h4><p v-if="!stress.comparison.directlyComparable">{{ t('stress.workbench.notComparable') }}</p><p>{{ stress.comparison.mismatches.join(', ') }} {{ stress.comparison.notices.join(', ') }}</p><div class="comparison-scroll"><table><thead><tr><th>{{ t('stress.metricName') }}</th><th>{{ t('stress.workbench.baseline') }}</th><th>{{ t('stress.workbench.report') }}</th><th>Δ</th><th>Δ %</th></tr></thead><tbody><tr v-for="row in comparisonRows" :key="row.key"><td>{{ row.key }}</td><td>{{ value(row.base) }}</td><td>{{ value(row.candidate) }}</td><td>{{ value(row.absolute) }}</td><td>{{ row.relative === null ? t('stress.workbench.notComputable') : `${value(row.relative * 100)}%` }}</td></tr></tbody></table></div></section>
            <StressReportView :report="stress.planReport" /><p v-if="!stress.planReport">{{ t('stress.workbench.noReport') }}</p><p v-if="stress.planFile" class="file-line" :title="stress.planFile">{{ stress.planFile }}</p>
          </template>
        </div>
        <footer class="run-controls"><div class="actions"><button :disabled="stress.running || !valid" data-testid="stress-plan-start" @click="perform(() => stress.startPlan())">{{ t('stress.start') }}</button><button :disabled="!stress.running || stress.planState === 'stopping'" data-testid="stress-plan-stop" @click="perform(() => stress.stopPlan())">{{ t('stress.stop') }}</button><span>{{ t(`stress.workbench.state.${stress.planState}`) }}</span></div>
          <p v-if="stress.running">{{ t('stress.workbench.progressOnly') }}</p><p v-if="stress.progress" data-testid="stress-plan-progress">{{ stress.progress.phase ?? 'preparing' }} / {{ stress.progress.stageId ?? '—' }} · VU {{ stress.progress.activeVus }} · {{ t('stress.workbench.iterations') }} {{ stress.progress.startedIterations }}/{{ stress.progress.completedIterations }} · dropped {{ stress.progress.droppedIterations }}</p>
          <div v-if="stress.planPendingOrigin" class="target-confirmation"><p>{{ t('stress.targetConfirmation',{origin:stress.planPendingOrigin}) }}</p><p>{{ t('stress.targetConfirmationRisk') }}</p><button :disabled="stress.confirmationInFlight" @click="perform(() => stress.confirmPlanTarget(false))">{{ t('stress.confirmOnce') }}</button><button :disabled="readOnly || stress.confirmationInFlight" @click="perform(() => stress.confirmPlanTarget(true))">{{ t('stress.trustProject') }}</button><button @click="stress.denyPlanTarget()">{{ t('stress.denyTarget') }}</button></div><p v-if="stress.error" class="error">{{ stress.error }}</p>
        </footer>
      </div>
    </div>
  </section>
  <section v-else class="stress-panel" data-testid="stress-panel">
    <h3 class="title">{{ t("stress.title") }}</h3>
    <div class="form" data-testid="stress-form">
      <div v-if="cases.length === 0" class="no-cases" data-testid="stress-no-cases">{{ t("stress.noCases") }}</div>
      <label class="field">
        <span class="field-label">{{ t("stress.case") }}</span>
        <a-select
          class="control"
          :value="stress.form.caseId ?? undefined"
          :options="caseOptions"
          :placeholder="t('stress.casePlaceholder')"
          data-testid="stress-case-select"
          @update:value="(v) => (stress.form.caseId = v as string)"
        />
      </label>
      <label class="field">
        <span class="field-label">{{ t("stress.env") }}</span>
        <a-select
          class="control"
          :value="(debug ? debug.selectedEnvName : stress.form.envName) ?? ''"
          :options="envOptions"
          :placeholder="t('stress.env')"
          data-testid="stress-env-select"
          @update:value="(v) => ((v as string) ? (debug ? debug.selectEnv(v as string) : (stress.form.envName = v as string)) : (debug ? debug.selectEnv(null) : (stress.form.envName = null)))"
        />
      </label>
      <label class="field">
        <span class="field-label">{{ t("stress.concurrency") }}</span>
        <a-input-number
          :value="stress.form.concurrency"
          :min="1"
          class="control"
          data-testid="stress-concurrency"
          @update:value="(v) => (stress.form.concurrency = (v as number | null) ?? FORM_DEFAULTS.concurrency)"
        />
      </label>
      <div class="field">
        <span class="field-label">{{ t("stress.mode") }}</span>
        <a-radio-group
          class="control"
          :value="stress.form.mode"
          data-testid="stress-mode"
          @update:value="(v) => (stress.form.mode = v as 'iterations' | 'duration')"
        >
          <a-radio value="iterations" data-testid="stress-mode-iterations">{{ t("stress.modeIterations") }}</a-radio>
          <a-radio value="duration" data-testid="stress-mode-duration">{{ t("stress.modeDuration") }}</a-radio>
        </a-radio-group>
      </div>
      <label v-if="stress.form.mode === 'iterations'" class="field">
        <span class="field-label">{{ t("stress.iterations") }}</span>
        <a-input-number
          :value="stress.form.iterations"
          :min="1"
          class="control"
          data-testid="stress-iterations"
          @update:value="(v) => (stress.form.iterations = (v as number | null) ?? FORM_DEFAULTS.iterations)"
        />
      </label>
      <label v-else class="field">
        <span class="field-label">{{ t("stress.duration") }}</span>
        <a-input-number
          :value="stress.form.durationSeconds"
          :min="1"
          class="control"
          data-testid="stress-duration"
          @update:value="(v) => (stress.form.durationSeconds = (v as number | null) ?? FORM_DEFAULTS.durationSeconds)"
        />
      </label>
      <details class="advanced" data-testid="stress-thresholds">
        <summary>{{ t("stress.criteria") }}</summary>
        <label class="field"><span class="field-label">{{ t("stress.maxErrorRate") }}</span><a-input-number :value="stress.form.thresholds.maxErrorRate" :min="0" :max="1" :step="0.01" class="control" @update:value="(v) => setThreshold('maxErrorRate', v as number | null)" /></label>
        <label class="field"><span class="field-label">{{ t("stress.maxAssertionFailureRate") }}</span><a-input-number :value="stress.form.thresholds.maxAssertionFailureRate" :min="0" :max="1" :step="0.01" class="control" @update:value="(v) => setThreshold('maxAssertionFailureRate', v as number | null)" /></label>
        <label class="field"><span class="field-label">{{ t("stress.maxP95Ms") }}</span><a-input-number :value="stress.form.thresholds.maxP95Ms" :min="0.001" class="control" @update:value="(v) => setThreshold('maxP95Ms', v as number | null)" /></label>
        <label class="field"><span class="field-label">{{ t("stress.minRps") }}</span><a-input-number :value="stress.form.thresholds.minRps" :min="0.001" class="control" @update:value="(v) => setThreshold('minRps', v as number | null)" /></label>
        <label class="field"><span class="field-label">{{ t("stress.connectionMode") }}</span><a-radio-group :value="stress.form.connectionMode" @update:value="(v) => (stress.form.connectionMode = v as 'pooled' | 'fresh')"><a-radio value="pooled">{{ t("stress.pooled") }}</a-radio><a-radio value="fresh">{{ t("stress.fresh") }}</a-radio></a-radio-group></label>
      </details>
      <details class="advanced" data-testid="stress-policy">
        <summary>{{ t("stress.targetPolicy") }}</summary>
        <p class="risk">{{ t("stress.targetPolicyRisk") }}</p>
        <label class="field"><span class="field-label">{{ t("stress.trustedOrigins") }}</span><textarea class="text-control" :disabled="readOnly" :value="(policyDraft.trustedOrigins ?? []).join('\n')" @change="(e) => { if (!readOnly) { policyDraft.trustedOrigins = (e.target as HTMLTextAreaElement).value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean); savePolicy(); } }" /></label>
        <label class="field"><span class="field-label">{{ t("stress.deniedOrigins") }}</span><textarea class="text-control" :disabled="readOnly" :value="(policyDraft.deniedOrigins ?? []).join('\n')" @change="(e) => { if (!readOnly) { policyDraft.deniedOrigins = (e.target as HTMLTextAreaElement).value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean); savePolicy(); } }" /></label>
        <label class="field"><span class="field-label">{{ t("stress.maxConcurrency") }}</span><a-input-number :value="policyDraft.maxConcurrency" :disabled="readOnly" :min="1" class="control" @update:value="(v) => { if (!readOnly) { policyDraft.maxConcurrency = (v as number | null) ?? undefined; savePolicy(); } }" /></label>
        <label class="field"><span class="field-label">{{ t("stress.maxRps") }}</span><a-input-number :value="policyDraft.maxRps" :disabled="readOnly" :min="0.001" class="control" @update:value="(v) => { if (!readOnly) { policyDraft.maxRps = (v as number | null) ?? undefined; savePolicy(); } }" /></label>
      </details>
      <div v-if="stress.pendingTargetOrigin" class="target-confirmation" data-testid="stress-target-confirmation">
        <p>{{ t("stress.targetConfirmation", { origin: stress.pendingTargetOrigin }) }}</p>
        <p class="risk">{{ t("stress.targetConfirmationRisk") }}</p>
        <a-button data-testid="stress-confirm-once" @click="apiLocator && stress.confirmTarget(apiLocator, false)">{{ t("stress.confirmOnce") }}</a-button>
        <a-button type="primary" data-testid="stress-trust-project" :disabled="readOnly" @click="apiLocator && stress.confirmTarget(apiLocator, true)">{{ t("stress.trustProject") }}</a-button>
        <a-button @click="stress.denyTarget()">{{ t("stress.denyTarget") }}</a-button>
      </div>
      <div class="actions">
        <a-button
          type="primary"
          :loading="stress.running"
          :disabled="stress.running || !stress.form.caseId"
          data-testid="stress-start"
          @click="onStart"
        >
          {{ t("stress.start") }}
        </a-button>
        <a-button danger :disabled="!stress.running" data-testid="stress-stop" @click="onStop">
          {{ t("stress.stop") }}
        </a-button>
        <span v-if="stress.running" class="running" data-testid="stress-running">{{ t("stress.running") }}</span>
      </div>
      <div v-if="stress.error" class="error" data-testid="stress-error">{{ stress.error }}</div>
    </div>
    <StressReportView :report="stress.report" />
    <div v-if="stress.file" class="file-line" data-testid="stress-file">{{ t("stress.savedTo", { file: stress.file }) }}</div>
  </section>
</template>

<style scoped>
.stress-workbench { display:flex;flex-direction:column;flex:1;min-height:0;min-width:0;overflow:hidden!important;font-size:13px; } .workbench-head { display:flex;align-items:center;gap:12px;padding:8px 12px;flex:none;border-bottom:1px solid var(--border,#ddd); } .workbench-head h3 { margin:0;font-size:14px;white-space:nowrap; } .target-name { flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; } .workbench-body { display:flex;flex:1;min-height:0;overflow:hidden; } .workbench-nav { width:220px;max-width:30%;flex:none;overflow:auto;padding:8px;border-right:1px solid var(--border,#ddd); } .nav-title { display:flex;align-items:center;justify-content:space-between;font-weight:600;margin:6px 0; } .nav-row { display:flex;min-width:0;align-items:center;height:32px; } .name-action { flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;min-width:0; } .icon-action { width:26px;height:26px;flex:none;opacity:0; } .nav-row:hover .icon-action,.icon-action:focus,.nav-title .icon-action { opacity:1; } .history-action { display:flex;flex-direction:column;width:100%;text-align:left;min-width:0;padding:7px 4px; } .history-action span,.history-action small { display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; } .history-action small { font-size:10px;color:var(--text-muted,#666); } .history-filter { width:100%;box-sizing:border-box; } .workbench-main { display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;overflow:hidden; } .pane-tabs { display:flex;gap:8px;flex:none;padding:6px 12px;border-bottom:1px solid var(--border,#ddd); } .workbench-scroll { flex:1;min-height:0;overflow:auto;padding:12px; } .plan-config { max-width:650px;display:flex;flex-direction:column;gap:10px; } .plan-config>label,.baseline-tools label { display:flex;gap:8px;align-items:center;min-width:0; } .plan-config>label input { flex:1;min-width:0; } .run-controls { flex:none;max-height:35%;overflow:auto;border-top:1px solid var(--border,#ddd);padding:8px 12px; } .run-controls p { margin:5px 0;font-size:12px; } .baseline-tools,.export-tools { display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px; } .baseline-tools select { max-width:270px;min-width:100px; } button { color:inherit;background:var(--bg-panel,#fff);border:1px solid var(--border,#ddd);border-radius:4px;min-height:26px;cursor:pointer; } button:disabled { cursor:default;opacity:.5; } input,select { color:inherit;background:var(--bg-panel,#fff);border:1px solid var(--border,#ddd);border-radius:4px;padding:4px 6px; } .selected { background:var(--bg-selected,#e6f4ff);color:var(--primary,#1677ff); } .comparison-scroll { overflow:auto; } table { width:100%;border-collapse:collapse; } td,th { padding:5px;text-align:left;border-bottom:1px solid var(--border,#ddd);white-space:nowrap; }
.stress-panel {
  padding: 8px 10px;
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 520px;
}
.field {
  display: flex;
  align-items: center;
  gap: 8px;
}
.field-label {
  min-width: 72px;
  color: var(--text-muted, #666);
}
.control {
  flex: 1;
}
.actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.running {
  color: var(--text-muted, #666);
}
.no-cases {
  color: var(--text-muted, #666);
}
.error {
  color: var(--fail, #cf1322);
}
.advanced {
  border-top: 1px solid var(--border, #ddd);
  padding-top: 6px;
}
.advanced summary { cursor: pointer; color: var(--text-muted, #666); }
.risk { color: var(--warning, #ad6800); margin: 4px 0; }
.target-confirmation { border: 1px solid var(--warning, #d48806); padding: 8px; }
.text-control { flex: 1; min-height: 42px; }
.file-line {
  color: var(--text-muted, #666);
  font-size: 12px;
  word-break: break-all;
}
</style>
