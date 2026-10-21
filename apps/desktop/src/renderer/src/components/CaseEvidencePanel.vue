<script setup lang="ts">
import { ref, watch } from "vue";
import type { EvidenceIdentity, SafeExecutionEvidence } from "@apicc/core";
import type { EvidenceTarget } from "../../../shared/testing.js";
const props = defineProps<{ evidence?: SafeExecutionEvidence; disabled?: boolean; inspect?: (identity: EvidenceIdentity) => Promise<EvidenceTarget>; rerun?: (identity: EvidenceIdentity) => Promise<unknown> }>();
const emit = defineEmits<{ (event: "locate", identity: EvidenceIdentity): void }>();
const target = ref<EvidenceTarget | null>(null); const error = ref(""); const busy = ref(false); let epoch = 0;
watch(() => [props.evidence, props.inspect] as const, async () => { const token = ++epoch; target.value = null; error.value = ""; if (!props.evidence || !props.inspect) return;
  try { const value = await props.inspect(props.evidence.identity); if (token === epoch) target.value = value; } catch (failure) { if (token === epoch) error.value = failure instanceof Error ? failure.message : String(failure); }
}, { immediate: true });
async function rerun() { if (!props.evidence || !props.rerun || !target.value?.available) return; busy.value = true; try { await props.rerun(props.evidence.identity); } catch (failure) { error.value = failure instanceof Error ? failure.message : String(failure); } finally { busy.value = false; } }
async function copy() { try { await navigator.clipboard.writeText(JSON.stringify(props.evidence ?? { state: "not-collected", reason: "旧记录未采集" }, null, 2)); } catch { error.value = "复制失败"; } }
</script>
<template>
  <section class="evidence" data-testid="case-evidence">
    <p v-if="!evidence || evidence.state === 'not-collected'">{{ evidence ? '此记录未采集正文（none / failures 策略）' : '旧记录未采集' }}</p>
    <template v-if="evidence">
      <p>{{ evidence.identity.locator?.apiId }} / {{ evidence.identity.locator?.caseId }} · scope={{ evidence.identity.locator?.scope }} · entry={{ evidence.identity.entryId }} · row={{ evidence.identity.rowIndex === undefined ? '—' : evidence.identity.rowIndex + 1 }} · node={{ evidence.identity.nodeId }}</p>
      <p>definitionRevision={{ evidence.identity.definitionRevision }}</p>
      <p v-if="target?.changed" data-testid="evidence-revision-changed">资源定义已变化；定位和重跑使用当前资源与当前凭据</p>
      <p v-if="target && !target.available">{{ target.reason }}</p>
      <p v-if="evidence.state === 'omitted' || evidence.truncated">证据已截断或预算耗尽 omitted/truncated；执行结论未改变</p>
      <details v-if="evidence.request"><summary>安全请求 · {{ evidence.request.protocol }} {{ evidence.request.method }}</summary><pre>{{ evidence.request.url.text }}
{{ evidence.request.headers.text }}
{{ evidence.request.body.text }}{{ evidence.request.body.omitted ? ' [unavailable/omitted]' : '' }}</pre></details>
      <details v-if="evidence.response"><summary>安全响应 · {{ evidence.response.status }}</summary><pre>{{ evidence.response.headers.text }}
{{ evidence.response.body.text }}{{ evidence.response.body.omitted ? ' [unavailable/omitted]' : '' }}</pre></details><p v-else>响应正文不可用 unavailable</p>
      <div v-for="(assertion,index) in evidence.assertions" :key="index" data-testid="assertion-evidence"><strong>{{ assertion.id.text }} · {{ assertion.op.text }} · {{ assertion.code.text }}</strong><pre>selector: {{ assertion.selector.text }}
actual: {{ assertion.actual?.text ?? 'unavailable' }}
expected: {{ assertion.expected?.text ?? 'unavailable' }}
differencePath: {{ assertion.differencePath?.text }}
schemaPath: {{ assertion.schemaPath?.text }}
{{ assertion.message.text }}</pre></div>
      <div v-for="(extraction,index) in evidence.extractions" :key="index" data-testid="extraction-evidence">提取阶段 {{ extraction.name.text }} · {{ extraction.status }} · {{ extraction.code.text }} · {{ extraction.published ? 'published' : 'unpublished' }}<pre>{{ extraction.selector.text }}
{{ extraction.value?.text ?? 'unavailable' }}
{{ extraction.message.text }}</pre></div>
      <p>脚本诊断：{{ evidence.scriptDiagnostics === 'not-collected' ? '未采集' : '仅已有断言消息；完整控制台未采集' }}</p>
      <p v-if="evidence.timings">request {{ evidence.timings.requestMs }}ms · script {{ evidence.timings.scriptMs }}ms · iteration {{ evidence.timings.iterationMs }}ms</p>
      <button v-if="inspect" :disabled="disabled || busy || !target?.available" data-testid="evidence-locate" @click="emit('locate', evidence.identity)">定位当前资源</button>
      <button v-if="rerun" :disabled="disabled || busy || !target?.available" data-testid="evidence-rerun" @click="rerun">{{ evidence.identity.workflowId ? '重跑整个工作流条目' : '重跑当前精确用例行' }}</button>
    </template>
    <button data-testid="evidence-copy" @click="copy">复制安全证据</button><p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>.evidence{padding:8px;border:1px solid var(--border);overflow:auto;max-height:70vh;font-size:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere}p{margin:4px 0}button{margin:4px}</style>
