<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Modal as AModal } from "ant-design-vue";
import type { OnlineExecutionStore } from "../../stores/onlineExecution.js";
import { onlineExecutionLocationIssue } from "../../onlineExecutionLocation.js";

const props = defineProps<{ execution: OnlineExecutionStore; open: boolean }>();
const emit = defineEmits<{ close: [] }>();
const { t, te } = useI18n();
const agent = computed(() => {
  const location = props.execution.location;
  return location.kind === "agent" ? props.execution.agents?.agents.find(item => item.id === location.agentId) : undefined;
});
const issue = computed(() => onlineExecutionLocationIssue(props.execution));
const timeout = computed(() => agent.value?.policy.scriptTimeoutMs ?? props.execution.agents?.policy.scriptTimeoutMs);
const approvalUrl = computed(() => {
  const context = props.execution.context;
  if (!props.execution.agents?.canManageScripts || !context) return null;
  const endpoint = context.serverId.replace(/\/api\/v1$/, "");
  const query = new URLSearchParams({ projectId: context.scope.projectId, section: "execution" });
  if (agent.value) query.set("agentId", agent.value.id);
  return `${endpoint}/workspaces/${encodeURIComponent(context.scope.workspaceId)}/org?${query}`;
});
function status(value: string) { const key = `onlineExecution.states.${value}`; return te(key) ? t(key) : value; }
</script>

<template>
  <a-modal :open="open" :title="t('projectWorkbench.executionDetails')" :footer="null" @cancel="emit('close')">
    <section class="execution-details" data-testid="project-execution-details">
      <p v-if="issue" role="status">{{ te(issue) ? t(issue) : issue.split('.').at(-1) }}</p>
      <dl>
        <dt>{{ t('onlineExecution.connection') }}</dt><dd>{{ status(execution.connection) }}</dd>
        <dt>{{ t('onlineExecution.scriptTimeout') }}</dt><dd>{{ timeout === undefined ? t('onlineExecution.notCollected') : `${timeout} ms` }}</dd>
        <dt>{{ t('onlineExecution.runtime') }}</dt><dd>{{ agent?.runtime ? `Node ${agent.runtime.nodeVersion} / V8 ${agent.runtime.v8Version}` : execution.location.kind === 'local' ? t('onlineExecution.runtimeCheckedAtStart') : t('onlineExecution.notCollected') }}</dd>
        <template v-if="agent">
          <dt>{{ t('onlineExecution.configuration') }}</dt>
          <dd>{{ status(agent.configuration.status) }} · {{ agent.configuration.appliedConfigVersion }} / {{ agent.configuration.configVersion }}</dd>
        </template>
      </dl>
      <p v-if="agent && (!agent.scriptsAllowed || agent.scriptGrant.version === '0')">{{ t('projectWorkbench.noScriptApproval') }}</p>
      <p v-if="agent?.scriptGrant.scope === 'project'">{{ t('onlineExecution.projectTrustRisk') }}</p>
      <details v-if="agent" data-testid="agent-script-approval">
        <summary>{{ t('onlineExecution.scripts') }}</summary>
        <p>{{ t('onlineExecution.scriptRisk') }}</p>
        <a v-if="approvalUrl" :href="approvalUrl" target="_blank" rel="noopener noreferrer">{{ t('onlineExecution.approvalEntry') }}</a>
        <p v-else>{{ t('onlineExecution.askAdmin') }}</p>
      </details>
      <ul v-if="execution.location.kind === 'local' && execution.localPlugins">
        <li v-for="plugin in execution.localPlugins.plugins" :key="plugin.key">{{ plugin.name }} · {{ plugin.version ?? '—' }} · {{ plugin.kind === 'loaded' ? t('onlineExecution.pluginLoaded') : plugin.error ?? status(plugin.kind) }}</li>
      </ul>
    </section>
  </a-modal>
</template>

<style scoped>
.execution-details { max-height: 65vh; overflow: auto; overflow-wrap: anywhere; }
.execution-details dl { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); gap: 6px 12px; }
.execution-details dd { margin: 0; }
.execution-details dt { color: var(--text-muted); }
.execution-details details { margin-bottom: 12px; }
</style>
