<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { EvidenceIdentity, SafeExecutionEvidence } from "@apicc/core";
import type { EvidenceTarget } from "../../../shared/testing.js";
const props = defineProps<{ evidence?: SafeExecutionEvidence; disabled?: boolean; inspect?: (identity: EvidenceIdentity) => Promise<EvidenceTarget>; rerun?: (identity: EvidenceIdentity) => Promise<unknown> }>();
const emit = defineEmits<{ (event: "locate", identity: EvidenceIdentity): void }>();
const { t, te } = useI18n();
function label(code: string, group = 'executionLabels') { const key = `${group}.${code}`; return te(key) ? t(key) : code; }
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
      <dl class="identity-grid">
        <div><dt>{{ t('run.api') }}</dt><dd>{{ evidence.identity.locator?.apiId ?? '—' }}</dd></div>
        <div><dt>{{ t('run.case') }}</dt><dd>{{ evidence.identity.locator?.caseId ?? '—' }}</dd></div>
        <div><dt>{{ t('caseEvidence.scope') }}</dt><dd>{{ evidence.identity.locator?.scope ? label(evidence.identity.locator.scope, 'reportPresentation.scopes') : '—' }}</dd></div>
        <div><dt>{{ t('caseEvidence.entry') }}</dt><dd>{{ evidence.identity.entryId ?? '—' }}</dd></div>
        <div data-testid="evidence-row"><dt>{{ t('run.row') }}</dt><dd>{{ evidence.identity.rowIndex === undefined ? '—' : evidence.identity.rowIndex + 1 }}</dd></div>
        <div><dt>{{ t('caseEvidence.node') }}</dt><dd>{{ evidence.identity.nodeId ?? '—' }}</dd></div>
      </dl>
      <details class="fingerprint" data-testid="evidence-fingerprint"><summary>{{ t('reportPresentation.fingerprint') }} · {{ evidence.identity.definitionRevision ? `${evidence.identity.definitionRevision.slice(0, 12)}${evidence.identity.definitionRevision.length > 12 ? '…' : ''}` : '—' }}</summary><p class="business-text">{{ evidence.identity.definitionRevision || '—' }}</p></details>
      <p v-if="target?.changed" data-testid="evidence-revision-changed">{{ t('caseEvidence.changed') }}</p>
      <p v-if="target && !target.available">{{ target.reason }}</p>
      <p v-if="evidence.state === 'omitted' || evidence.truncated">{{ t('caseEvidence.truncated') }}</p>
      <details v-if="evidence.request"><summary>{{ t('caseEvidence.request') }} · {{ evidence.request.protocol }} {{ evidence.request.method }}</summary><pre>{{ evidence.request.url.text }}
{{ evidence.request.headers.text }}
{{ evidence.request.body.text }}{{ evidence.request.body.omitted ? ` [${t('caseEvidence.unavailable')}]` : '' }}</pre></details>
      <details v-if="evidence.response"><summary>{{ t('caseEvidence.response') }} · {{ evidence.response.status }}</summary><pre>{{ evidence.response.headers.text }}
{{ evidence.response.body.text }}{{ evidence.response.body.omitted ? ` [${t('caseEvidence.unavailable')}]` : '' }}</pre></details><p v-else>{{ t('caseEvidence.responseUnavailable') }}</p>
      <article v-for="(assertion,index) in evidence.assertions" :key="index" class="proof-card" data-testid="assertion-evidence">
        <header><strong :class="{ failure: !assertion.pass }">{{ t(assertion.pass ? 'response.passed' : 'response.failed') }}</strong><span>{{ assertion.id.text }}</span><code>{{ assertion.op.text }} · {{ assertion.code.text }}</code></header>
        <p class="business-text">{{ assertion.message.text }}</p>
        <dl class="proof-fields">
          <div><dt>{{ t('caseEvidence.selector') }}</dt><dd>{{ assertion.selector.text }}</dd></div>
          <div><dt>{{ t('caseEvidence.differencePath') }}</dt><dd>{{ assertion.differencePath?.text ?? '—' }}</dd></div>
          <div><dt>{{ t('caseEvidence.schemaPath') }}</dt><dd>{{ assertion.schemaPath?.text ?? '—' }}</dd></div>
        </dl>
        <div class="value-pair"><div><h4>{{ t('caseEvidence.actual') }}</h4><pre>{{ assertion.actual?.text ?? t('caseEvidence.unavailable') }}</pre></div><div><h4>{{ t('caseEvidence.expected') }}</h4><pre>{{ assertion.expected?.text ?? t('caseEvidence.unavailable') }}</pre></div></div>
      </article>
      <article v-for="(extraction,index) in evidence.extractions" :key="index" class="proof-card" data-testid="extraction-evidence">
        <header><strong>{{ t('caseEvidence.extraction') }} · {{ extraction.name.text }}</strong><span>{{ label(extraction.status) }}</span><span>{{ t(extraction.published ? 'caseEvidence.published' : 'caseEvidence.unpublished') }}</span></header>
        <p class="business-text">{{ extraction.message.text }}</p>
        <dl class="proof-fields"><div><dt>{{ t('caseEvidence.selector') }}</dt><dd>{{ extraction.selector.text }}</dd></div><div><dt>{{ t('reportPresentation.diagnosticCode') }}</dt><dd>{{ extraction.code.text }}</dd></div></dl>
        <h4>{{ t('reportPresentation.extractedValue') }}</h4><pre>{{ extraction.value?.text ?? t('caseEvidence.unavailable') }}</pre>
      </article>
      <p>{{ t('caseEvidence.scripts') }}：{{ t(evidence.scriptDiagnostics === 'not-collected' ? 'caseEvidence.scriptNotCollected' : 'caseEvidence.scriptAssertionsOnly') }}</p>
      <p v-if="evidence.timings">{{ t('caseEvidence.timings', { request: evidence.timings.requestMs, script: evidence.timings.scriptMs, iteration: evidence.timings.iterationMs }) }}</p>
      <button v-if="inspect" :disabled="disabled || busy || !target?.available" data-testid="evidence-locate" @click="emit('locate', evidence.identity)">{{ t('caseEvidence.locate') }}</button>
      <button v-if="rerun" :disabled="disabled || busy || !target?.available" data-testid="evidence-rerun" @click="rerun">{{ t(evidence.identity.workflowId ? 'caseEvidence.rerunWorkflow' : 'caseEvidence.rerunCase') }}</button>
    </template>
    <button data-testid="evidence-copy" @click="copy">{{ t('caseEvidence.copy') }}</button><p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.evidence { padding: 14px; border: 1px solid var(--border); border-radius: 8px; overflow: auto; max-height: 70vh; font-size: 12px; color: var(--text); background: var(--bg); }
dl,p,h4 { margin: 0; } .identity-grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(min(100%,180px),1fr)); gap: 10px 16px; padding-bottom: 12px; }
dt { color: var(--text-muted); font-size: 12px; } dd { margin: 4px 0 0; overflow-wrap: anywhere; white-space: pre-wrap; }
details { margin: 8px 0; border: 1px solid var(--border); border-radius: 6px; } summary { padding: 8px 10px; cursor: pointer; background: var(--subtle); }
details > p,details > pre { margin: 8px 10px; } .fingerprint > p { font-family: ui-monospace,Consolas,monospace; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 260px; overflow: auto; padding: 10px; background: var(--subtle); border-radius: 6px; font-size: 12px; margin: 6px 0; }
.proof-card { border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin: 10px 0; }.proof-card header { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: baseline; margin-bottom: 8px; overflow-wrap: anywhere; }
.proof-card header code { color: var(--text-muted); }.failure,[role="alert"] { color: var(--fail); }.business-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.proof-fields { display: flex; flex-wrap: wrap; gap: 10px 24px; margin: 10px 0; }.proof-fields > div { min-width: 0; flex: 1 1 160px; }.value-pair { display: grid; grid-template-columns: repeat(auto-fit,minmax(min(100%,220px),1fr)); gap: 12px; }.value-pair > div { min-width: 0; } h4 { font-size: 12px; font-weight: 600; }
.evidence > p { margin: 8px 0; overflow-wrap: anywhere; }button { margin: 8px 8px 0 0; padding: 5px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); font: inherit; cursor: pointer; }button:hover:not(:disabled) { background: var(--hover); border-color: var(--accent); }button:disabled { opacity: .5; cursor: not-allowed; }
</style>
