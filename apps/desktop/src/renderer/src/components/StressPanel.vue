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
import { createStressFormDefaults, type createStressStore } from "../stores/stress.js";
import StressReportView from "./StressReportView.vue";

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
  apiId: string;
  cases: Array<{ id: string; name: string }>;
  envs: Array<{ id: string; name: string }>;
  reportError: (e: unknown) => void;

  /** 环境选中共享源（M10）：传入则环境下拉读写调试 store 的项目记忆。 */
  debug?: { selectedEnvName: string | null; selectEnv(name: string | null): void };
  policy?: StressTargetPolicy;
  savePolicy?: (policy: StressTargetPolicy) => Promise<void>;
}>();
const { t } = useI18n();

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
  try {
    await props.stress.start(props.apiId);
  } catch (e) {
    props.reportError(e);
  }
}

async function onStop() {
  try {
    await props.stress.stop();
  } catch (e) {
    props.reportError(e);
  }
}
async function savePolicy() {
  if (!props.savePolicy) return;
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
  <section class="stress-panel" data-testid="stress-panel">
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
        <label class="field"><span class="field-label">{{ t("stress.trustedOrigins") }}</span><textarea class="text-control" :value="(policyDraft.trustedOrigins ?? []).join('\n')" @change="(e) => { policyDraft.trustedOrigins = (e.target as HTMLTextAreaElement).value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean); savePolicy(); }" /></label>
        <label class="field"><span class="field-label">{{ t("stress.deniedOrigins") }}</span><textarea class="text-control" :value="(policyDraft.deniedOrigins ?? []).join('\n')" @change="(e) => { policyDraft.deniedOrigins = (e.target as HTMLTextAreaElement).value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean); savePolicy(); }" /></label>
        <label class="field"><span class="field-label">{{ t("stress.maxConcurrency") }}</span><a-input-number :value="policyDraft.maxConcurrency" :min="1" class="control" @update:value="(v) => { policyDraft.maxConcurrency = (v as number | null) ?? undefined; savePolicy(); }" /></label>
        <label class="field"><span class="field-label">{{ t("stress.maxRps") }}</span><a-input-number :value="policyDraft.maxRps" :min="0.001" class="control" @update:value="(v) => { policyDraft.maxRps = (v as number | null) ?? undefined; savePolicy(); }" /></label>
      </details>
      <div v-if="stress.pendingTargetOrigin" class="target-confirmation" data-testid="stress-target-confirmation">
        <p>{{ t("stress.targetConfirmation", { origin: stress.pendingTargetOrigin }) }}</p>
        <p class="risk">{{ t("stress.targetConfirmationRisk") }}</p>
        <a-button data-testid="stress-confirm-once" @click="stress.confirmTarget(apiId, false)">{{ t("stress.confirmOnce") }}</a-button>
        <a-button type="primary" data-testid="stress-trust-project" @click="stress.confirmTarget(apiId, true)">{{ t("stress.trustProject") }}</a-button>
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
