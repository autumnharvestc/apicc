<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { OnlineExecutionStore } from "../../stores/onlineExecution.js";
import type { OnlineJob } from "../../../../shared/online/execution.js";
import { reportingUnits } from "@apicc/core/report/units";
import { onlineSessionErrorKey } from '../../i18n/index.js';
import ResponseViewer from "../ResponseViewer.vue";
import WfResultDrawer from "../WfResultDrawer.vue";
import CaseEvidencePanel from "../CaseEvidencePanel.vue";
const props = defineProps<{ execution: OnlineExecutionStore }>();
const { t, te, locale } = useI18n();
const selected = computed(() => { const selection = props.execution.resultSelection; return selection?.kind === 'agent' && 'job' in selection ? selection.job : props.execution.jobs.find(job => job.jobId === props.execution.selectedJobId); });
const local = computed(() => { const selection = props.execution.resultSelection; return selection?.kind === 'agent' ? null : selection?.kind === 'local' && selection.runId !== props.execution.localResult?.runId ? null : props.execution.localResult; });
const report = computed(() => { const selection = props.execution.resultSelection; return selection?.kind === 'local' || selection?.kind === 'agent' && !('job' in selection) || selected.value && selected.value.executionId !== props.execution.report?.executionId ? null : props.execution.report; });
const output = computed(() => report.value?.output ?? local.value?.output);
const units = computed(() => output.value?.kind === 'suite' || output.value?.kind === 'failure' ? reportingUnits(output.value.result) : null);
const recordedScriptTimeout = computed(() => local.value?.scriptTimeoutMs ?? selected.value?.scriptTimeoutMs);
const recordedRuntime = computed(() => selected.value?.task.runtimeCompatibilityId ?? local.value?.runtimeCompatibilityId);
function shortIdentity(value: string) { return value.length > 64 ? `${value.slice(0, 48)}…${value.slice(-8)}` : value; }
const agent = computed(() => props.execution.location.kind === "agent" ? props.execution.agents?.agents.find(agent => agent.id === (props.execution.location as { agentId: string }).agentId) : undefined);
const raw = ref(false);
const selectionKey = computed(() => JSON.stringify(props.execution.resultSelection ?? [props.execution.selectedJobId, local.value?.runId, report.value?.executionId]));
watch(selectionKey, () => { raw.value = false; });
function label(code: string | undefined) { if (!code) return t('onlineExecution.notCollected'); if (code === 'expired') return t('onlineExecution.expiredArchive'); const key = `onlineExecution.states.${code}`; const reason = `onlineExecution.reasons.${code}`; const refusal = `startRejectionLabels.${code}`; return te(key) ? t(key) : te(reason) ? t(reason) : te(refusal) ? t(refusal) : code; }
const logicalVerdict = computed(() => {
  if (report.value) return label(report.value.verdict);
  const value = output.value; if (!value) return label(undefined);
  if (value.kind === 'debug') return label(value.result.error || value.result.failureKind || value.result.run.failed > 0 ? 'failed' : 'passed');
  if (value.kind === 'workflow') return label(value.result.verdict ?? (value.result.failed > 0 ? 'failed' : 'passed'));
  return label(value.kind === 'failure' || value.result.reportFailure ? 'failed' : value.result.suite?.verdict ?? (units.value!.summary.failed > 0 ? 'failed' : 'passed'));
});
function location(event: Event) { const value = (event.target as HTMLSelectElement).value; props.execution.selectLocation(value === "local" ? { kind: "local" } : { kind: "agent", agentId: value }); }
function date(value: unknown) { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return t('onlineExecution.notCollected'); return new Intl.DateTimeFormat(locale.value, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, timeZoneName: 'longOffset' }).format(new Date(value)); }
async function action(operation: () => Promise<unknown>) { const scope = JSON.stringify(props.execution.context); try { await operation(); } catch (error) { if (scope === JSON.stringify(props.execution.context) && props.execution.visible) props.execution.error = error instanceof Error ? error.message : String(error); } }
const reason = computed(() => {
  const reportCode = props.execution.error.match(/(?:^|Error: )(invalid-core-output|report_expired)(?:['"])?$/)?.[1];
  if (reportCode) return t(reportCode === 'invalid-core-output' ? 'onlineExecution.invalidOutput' : 'onlineExecution.expiredArchive');
  const text = props.execution.error; const code = text.split(/[:\s]/, 1)[0]!; const key = code === 'online-run-in-progress' ? 'onlineExecution.runInProgress' : code === 'invalid-core-output' ? 'onlineExecution.invalidOutput' : `onlineExecution.reasons.${code}`;
  const sessionKey = onlineSessionErrorKey(text);
  return sessionKey ? t(sessionKey) : te(key) ? `${t(key)}${text.length > code.length ? ` ${text.slice(code.length + 1)}` : ''}` : text;
});
function verdict(job: OnlineJob) { return label(typeof job.summary?.verdict === 'string' ? job.summary.verdict : undefined); }
const recordedEnvironment = computed(() => { const selection = props.execution.resultSelection; if (selected.value) return selected.value.task.environmentId ?? t('onlineExecution.baseEnvironment'); if (selection?.kind === 'local') return selection.environmentId ?? t('onlineExecution.baseEnvironment'); return t('onlineExecution.notCollected'); });
</script>
<template>
  <section class="execution" data-testid="online-execution-panel">
    <div class="toolbar">
      <label>{{ t('onlineExecution.location') }}<select :value="execution.location.kind === 'local' ? 'local' : execution.location.agentId" :disabled="execution.running" data-testid="online-execution-location" @change="location"><option value="local">{{ t('onlineExecution.local') }}</option><option v-for="item in execution.agents?.agents" :key="item.id" :value="item.id" :disabled="item.availability !== 'available' || item.configuration.status !== 'applied'">{{ item.name }} · {{ label(item.availability) }}</option></select></label>
      <label>{{ t('onlineExecution.environment') }}<select v-model="execution.environmentId" :disabled="execution.running" data-testid="online-execution-environment"><option :value="undefined">{{ t('onlineExecution.baseEnvironment') }}</option><option v-for="env in execution.project?.environments" :key="env.id" :value="env.id">{{ env.name }}</option></select></label>
      <label>{{ t('onlineExecution.refresh') }}<input type="number" min="1" max="2147483647" :value="execution.statusRefreshMs" data-testid="online-refresh-ms" @change="action(async () => execution.setRefreshMs(Number(($event.target as HTMLInputElement).value)))" /> ms</label>
      <button @click="action(() => execution.refresh())">{{ t('onlineExecution.refreshNow') }}</button>
      <button :disabled="execution.running" @click="execution.newDebugSession()">{{ t('onlineExecution.newSession') }}</button>
      <button v-if="execution.activeLocalRunId" @click="action(() => execution.cancelLocal())">{{ t('onlineExecution.cancel') }}</button>
    </div>
    <p v-if="reason" role="alert" data-testid="online-execution-error">{{ reason }}</p>
    <h4>{{ t('onlineExecution.nextRunSettings') }}</h4>
    <dl class="current-summary">
      <div><dt>{{ t('onlineExecution.connection') }}</dt><dd>{{ label(execution.connection) }}</dd></div>
      <div><dt>{{ t('onlineExecution.scriptTimeout') }}</dt><dd>{{ agent?.policy.scriptTimeoutMs ?? execution.agents?.policy.scriptTimeoutMs ?? '—' }} ms</dd></div>
      <div><dt>{{ t('onlineExecution.runtime') }}</dt><dd>{{ agent?.runtime ? `Node ${agent.runtime.nodeVersion} / V8 ${agent.runtime.v8Version}` : t('onlineExecution.runtimeCheckedAtStart') }}</dd></div>
      <div v-if="agent"><dt>{{ t('onlineExecution.configuration') }}</dt><dd>{{ label(agent.configuration.status) }} · {{ agent.configuration.appliedConfigVersion }} / {{ agent.configuration.configVersion }}</dd></div>
    </dl>
    <p>{{ t('onlineExecution.scriptCapability') }}</p><p v-if="agent?.scriptGrant.scope === 'project'">{{ t('onlineExecution.projectTrustRisk') }}</p><details><summary>{{ t('onlineExecution.scripts') }}</summary><p>{{ t('onlineExecution.scriptRisk') }}</p><a v-if="execution.agents?.canManageScripts && execution.context" :href="execution.context.serverId.replace(/\/api\/v1$/, '') + '/workspaces/' + execution.context.scope.workspaceId + '/org?projectId=' + execution.context.scope.projectId + (agent ? '&agentId=' + agent.id : '') + '&section=execution'" target="_blank" rel="noopener noreferrer">{{ t('onlineExecution.approvalEntry') }}</a><p v-else>{{ t('onlineExecution.askAdmin') }}</p></details>
    <p>{{ t('onlineExecution.pluginDifference') }}</p><ul v-if="execution.localPlugins"><li v-for="plugin in execution.localPlugins.plugins" :key="plugin.key">{{ plugin.name }} · {{ plugin.version ?? '—' }} · {{ plugin.kind === 'loaded' ? t('onlineExecution.pluginLoaded') : plugin.error ?? plugin.kind }}</li></ul>
    <p class="hint">{{ t(execution.location.kind === 'local' ? 'onlineExecution.localLifetime' : 'onlineExecution.agentLifetime') }}</p>
    <div class="task-scroll">
      <table v-if="execution.jobs.length" data-testid="online-jobs">
        <thead><tr><th>{{ t('onlineExecution.task') }}</th><th>{{ t('onlineExecution.state') }}</th><th>{{ t('onlineExecution.verdict') }}</th><th>{{ t('onlineExecution.release') }}</th><th>{{ t('onlineExecution.archive') }}</th><th>{{ t('onlineExecution.actions') }}</th></tr></thead>
        <tbody><tr v-for="job in execution.jobs" :key="job.jobId">
          <td><button @click="action(() => execution.inspect(job))">{{ job.jobId }}</button> · {{ label(job.task.target.kind) }}</td>
          <td>{{ label(job.state) }}<span v-if="job.cancelState !== 'none'"> · {{ label('cancel-' + job.cancelState) }}</span></td>
          <td>{{ verdict(job) }}<p v-if="job.summary?.reasonCode">{{ label(String(job.summary.reasonCode)) }}</p></td>
          <td>{{ label(job.executionReleased ? 'released' : 'retained') }}</td><td>{{ label(job.reportState) }}</td>
          <td><button v-if="job.canCancel" :disabled="job.state === 'ended' || job.cancelState === 'requested'" @click="action(() => execution.cancel(job))">{{ t('onlineExecution.cancel') }}</button></td>
        </tr></tbody>
      </table>
      <p v-else>{{ t('onlineExecution.noTasks') }}</p>
    </div>
    <section v-if="execution.resultSelection || selected || local || report" data-testid="online-selected-run">
      <h4>{{ t('onlineExecution.recordedRun') }}</h4>
      <dl class="summary">
        <div><dt>{{ t('onlineExecution.location') }}</dt><dd>{{ selected ? t('onlineExecution.agent') + ' · ' + selected.agentId : local || execution.resultSelection?.kind === 'local' ? t('onlineExecution.local') : t('onlineExecution.notCollected') }}</dd></div>
        <div><dt>{{ t('onlineExecution.environment') }}</dt><dd>{{ recordedEnvironment }}</dd></div>
        <div><dt>{{ t('onlineExecution.snapshot') }}</dt><dd :title="selected?.task.manifestHash ?? local?.manifestHash">{{ selected?.task.snapshotId ?? local?.snapshotId ?? t('onlineExecution.notPrepared') }} · {{ (selected?.task.manifestHash ?? local?.manifestHash)?.slice(0, 12) }}</dd></div>
        <div><dt>{{ t('onlineExecution.dispatch') }}</dt><dd>{{ label(selected?.task.dispatchKind) }}</dd></div>
        <div><dt>{{ t('onlineExecution.scriptTimeout') }}</dt><dd>{{ recordedScriptTimeout ? recordedScriptTimeout + ' ms' : t('onlineExecution.notCollected') }}</dd></div>
        <div><dt>{{ t('onlineExecution.runtime') }}</dt><dd :title="recordedRuntime">{{ recordedRuntime ? shortIdentity(recordedRuntime) : t('onlineExecution.notCollected') }}</dd></div>
        <div><dt>{{ t('onlineExecution.recordedPolicy') }}</dt><dd>{{ selected?.task.policyVersion ?? t('onlineExecution.notCollected') }}</dd></div>
      </dl>
    </section>
    <section v-if="report || local" data-testid="online-execution-report">
      <p>{{ t('onlineExecution.verdict') }}: {{ logicalVerdict }} · {{ t('onlineExecution.requestFact') }}: {{ label(report?.executionFact) }}</p>
      <p v-if="report?.reasonCode" role="alert">{{ label(report.reasonCode) }}</p>
      <template v-if="output?.kind === 'failure'"><p role="alert">{{ t('onlineExecution.failureReason') }}: {{ output.error }}</p><ul v-if="output.result.warnings?.length" :aria-label="t('onlineExecution.evidenceWarnings')"><li v-for="(warning, index) in output.result.warnings" :key="index">{{ warning }}</li></ul></template>
      <p v-if="!output">{{ t('onlineExecution.incompleteReport') }}</p>
      <template v-if="output">
        <p>{{ t('onlineExecution.startedAt') }}: {{ date(output.result.startedAt) }} · {{ t('onlineExecution.finishedAt') }}: {{ date(output.result.finishedAt) }}</p>
        <ResponseViewer v-if="output.kind === 'debug'" :result="output.result" />
        <WfResultDrawer v-else-if="output.kind === 'workflow'" :open="true" :result="output.result" embedded />
        <template v-else>
          <p>{{ t('onlineExecution.logicalTotals', units!.summary) }}</p>
          <p>{{ t('onlineExecution.requestTotals', { started: output.result.requestFacts?.requestStarted ?? '—', completed: output.result.requestFacts?.requestCompleted ?? '—', exchanges: output.result.requestFacts?.httpExchanges ?? '—' }) }}</p>
          <ul><li v-for="(unit, index) in units!.invocations" :key="`invocation-${index}`">{{ unit.workflowId }} · {{ label(unit.verdict) }} <span v-if="unit.error">{{ unit.error }}</span></li>
            <li v-for="(entry, index) in units!.diagnostics" :key="`diagnostic-${index}`">{{ entry.entryId }} · {{ label(entry.status) }} <span v-if="entry.error">{{ entry.error }}</span></li></ul>
          <ul><li v-for="(row, index) in output.result.cases" :key="index">{{ row.apiName }} / {{ row.caseName }} · {{ label(row.passed ? 'passed' : 'failed') }} · {{ row.durationMs }} ms <span v-if="row.error">{{ row.error }}</span><CaseEvidencePanel v-if="row.evidence" :evidence="row.evidence" /></li></ul>
        </template>
      </template>
      <details :key="selectionKey" @toggle="raw = ($event.target as HTMLDetailsElement).open"><summary>{{ t('onlineExecution.raw') }}</summary><textarea v-if="raw" readonly :value="JSON.stringify(report ?? local, null, 2)" /></details>
    </section>
  </section>
</template>
<style scoped>
.execution{min-width:0;border-bottom:1px solid var(--border);padding:10px}.toolbar{display:flex;gap:12px;flex-wrap:wrap;align-items:center}.toolbar label{display:flex;gap:6px;align-items:center}.toolbar input{width:95px}.summary,.current-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px}.summary div,.current-summary div{min-width:0}.summary dt,.current-summary dt{color:var(--text-muted)}.summary dd,.current-summary dd{margin:2px 0;overflow-wrap:anywhere}.task-scroll{overflow:auto;max-height:230px}table{border-collapse:collapse;width:100%;white-space:nowrap}th,td{text-align:left;padding:5px 10px;border-bottom:1px solid var(--border)}.hint{color:var(--text-muted)}textarea{width:100%;height:220px}p[role=alert]{color:var(--fail,#cf1322);overflow-wrap:anywhere}
</style>
