<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { EvidenceIdentity, SafeExecutionEvidence } from "@apicc/core";
import type { EvidenceTarget } from "../../../shared/testing.js";
const props = defineProps<{ evidence?: SafeExecutionEvidence; disabled?: boolean; inspect?: (identity: EvidenceIdentity) => Promise<EvidenceTarget>; rerun?: (identity: EvidenceIdentity) => Promise<unknown> }>();
const emit = defineEmits<{ (event: "locate", identity: EvidenceIdentity): void }>();
const { t, te } = useI18n();
function label(code: string) { const key = `executionLabels.${code}`; return te(key) ? t(key) : code; }
const target = ref<EvidenceTarget | null>(null); const error = ref(""); const busy = ref(false); let epoch = 0;
watch(() => [props.evidence, props.inspect] as const, async () => { const token = ++epoch; target.value = null; error.value = ""; if (!props.evidence || !props.inspect) return;
  try { const value = await props.inspect(props.evidence.identity); if (token === epoch) target.value = value; } catch (failure) { if (token === epoch) error.value = failure instanceof Error ? failure.message : String(failure); }
}, { immediate: true });
async function rerun() { if (!props.evidence || !props.rerun || !target.value?.available) return; busy.value = true; try { await props.rerun(props.evidence.identity); } catch (failure) { error.value = failure instanceof Error ? failure.message : String(failure); } finally { busy.value = false; } }
async function copy() { try { await navigator.clipboard.writeText(JSON.stringify(props.evidence ?? { state: "not-collected", reason: "旧记录未采集" }, null, 2)); } catch { error.value = t('caseEvidence.copyFailed'); } }
</script>
<template>
  <section class="evidence" data-testid="case-evidence">
    <p v-if="!evidence || evidence.state === 'not-collected'">{{ t(evidence ? 'caseEvidence.notCollected' : 'caseEvidence.legacyNotCollected') }}</p>
    <template v-if="evidence">
      <p>{{ evidence.identity.locator?.apiId }} / {{ evidence.identity.locator?.caseId }} · {{ t('caseEvidence.scope') }}={{ evidence.identity.locator?.scope }} · {{ t('caseEvidence.entry') }}={{ evidence.identity.entryId }} · {{ t('run.row') }}={{ evidence.identity.rowIndex === undefined ? '—' : evidence.identity.rowIndex + 1 }} · {{ t('caseEvidence.node') }}={{ evidence.identity.nodeId }}</p>
      <p>{{ t('caseEvidence.definitionRevision') }}={{ evidence.identity.definitionRevision }}</p>
      <p v-if="target?.changed" data-testid="evidence-revision-changed">{{ t('caseEvidence.changed') }}</p>
      <p v-if="target && !target.available">{{ target.reason }}</p>
      <p v-if="evidence.state === 'omitted' || evidence.truncated">{{ t('caseEvidence.truncated') }}</p>
      <details v-if="evidence.request"><summary>{{ t('caseEvidence.request') }} · {{ evidence.request.protocol }} {{ evidence.request.method }}</summary><pre>{{ evidence.request.url.text }}
{{ evidence.request.headers.text }}
{{ evidence.request.body.text }}{{ evidence.request.body.omitted ? ` [${t('caseEvidence.unavailable')}]` : '' }}</pre></details>
      <details v-if="evidence.response"><summary>{{ t('caseEvidence.response') }} · {{ evidence.response.status }}</summary><pre>{{ evidence.response.headers.text }}
{{ evidence.response.body.text }}{{ evidence.response.body.omitted ? ` [${t('caseEvidence.unavailable')}]` : '' }}</pre></details><p v-else>{{ t('caseEvidence.responseUnavailable') }}</p>
      <div v-for="(assertion,index) in evidence.assertions" :key="index" data-testid="assertion-evidence"><strong>{{ assertion.id.text }} · {{ assertion.op.text }} · {{ assertion.code.text }}</strong><pre>{{ t('caseEvidence.selector') }}: {{ assertion.selector.text }}
{{ t('caseEvidence.actual') }}: {{ assertion.actual?.text ?? t('caseEvidence.unavailable') }}
{{ t('caseEvidence.expected') }}: {{ assertion.expected?.text ?? t('caseEvidence.unavailable') }}
{{ t('caseEvidence.differencePath') }}: {{ assertion.differencePath?.text }}
{{ t('caseEvidence.schemaPath') }}: {{ assertion.schemaPath?.text }}
{{ assertion.message.text }}</pre></div>
      <div v-for="(extraction,index) in evidence.extractions" :key="index" data-testid="extraction-evidence">{{ t('caseEvidence.extraction') }} {{ extraction.name.text }} · {{ label(extraction.status) }} · {{ extraction.code.text }} · {{ t(extraction.published ? 'caseEvidence.published' : 'caseEvidence.unpublished') }}<pre>{{ extraction.selector.text }}
{{ extraction.value?.text ?? t('caseEvidence.unavailable') }}
{{ extraction.message.text }}</pre></div>
      <p>{{ t('caseEvidence.scripts') }}：{{ t(evidence.scriptDiagnostics === 'not-collected' ? 'caseEvidence.scriptNotCollected' : 'caseEvidence.scriptAssertionsOnly') }}</p>
      <p v-if="evidence.timings">{{ t('caseEvidence.timings', { request: evidence.timings.requestMs, script: evidence.timings.scriptMs, iteration: evidence.timings.iterationMs }) }}</p>
      <button v-if="inspect" :disabled="disabled || busy || !target?.available" data-testid="evidence-locate" @click="emit('locate', evidence.identity)">{{ t('caseEvidence.locate') }}</button>
      <button v-if="rerun" :disabled="disabled || busy || !target?.available" data-testid="evidence-rerun" @click="rerun">{{ t(evidence.identity.workflowId ? 'caseEvidence.rerunWorkflow' : 'caseEvidence.rerunCase') }}</button>
    </template>
    <button data-testid="evidence-copy" @click="copy">{{ t('caseEvidence.copy') }}</button><p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>.evidence{padding:8px;border:1px solid var(--border);overflow:auto;max-height:70vh;font-size:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere}p{margin:4px 0}button{margin:4px}</style>
