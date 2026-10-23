<script setup lang="ts">
import { useI18n } from "vue-i18n";
import type { PluginsStore } from "../stores/plugins.js";
import type { PluginLoadEntry } from "../../../shared/plugins/contract.js";
import EmptyState from "./EmptyState.vue";
defineProps<{ plugins: PluginsStore }>();
const { t, te } = useI18n();
const categories = ["protocols", "auths", "asserts", "scripts", "reporters", "importers"] as const;
const groups = (p: PluginLoadEntry) => categories.filter(k => p.contributions?.[k].length).map(k => ({ key: k, names: p.contributions![k] }));
const stageLabel = (stage: string) => te(`plugins.stages.${stage}`) ? t(`plugins.stages.${stage}`) : stage;
const reasonLabel = (p: PluginLoadEntry) => p.code && te(`plugins.reasons.${p.code}`) ? t(`plugins.reasons.${p.code}`) : p.error;
const configRules: Record<string, string> = {
  "Config must be a plain object": "object",
  "Config field is not declared": "undeclared",
  "Required config field is missing": "required",
  "Config value must match the declared type and choices": "type",
};
const reasonDetail = (p: PluginLoadEntry): string => {
  const message = p.error?.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (/^[{\[]/.test(message)) return "";
  if (p.code !== "invalid_config") return message;
  // The loader joins stable SDK rules as path: reason; preserve author field names.
  return message.split("; ").map(part => {
    const separator = part.lastIndexOf(": ");
    const path = separator < 0 ? "" : part.slice(0, separator + 2);
    const rule = separator < 0 ? part : part.slice(separator + 2);
    return configRules[rule] ? path + t(`plugins.configRules.${configRules[rule]}`) : part;
  }).join("; ");
};
</script>

<template>
  <section class="plugins-view" data-testid="plugins-view">
    <div class="head"><strong>{{ t('plugins.title') }}</strong><button data-testid="plugins-refresh" :disabled="plugins.loading" @click="plugins.refresh()">{{ t('plugins.refresh') }}</button></div>
    <p class="muted">{{ t('plugins.refreshHint') }}</p>
    <p v-if="plugins.hostVersion">{{ t('plugins.hostVersion') }}: {{ plugins.hostVersion }} · {{ t('plugins.apiVersion') }} 1</p>
    <p v-if="!plugins.enabled" role="status">{{ t('plugins.globallyDisabled') }}</p>
    <p v-if="plugins.error" role="alert" data-testid="plugins-error-alert">{{ plugins.error }}</p>
    <div v-else-if="plugins.entries.length === 0" data-testid="plugins-empty"><EmptyState :text="t('plugins.empty')" /><p>{{ t('plugins.emptyGuide') }}</p></div>
    <div v-else class="table-scroll">
      <table data-testid="plugins-table">
        <thead><tr><th>{{ t('plugins.colName') }}</th><th>{{ t('plugins.status') }}</th><th>{{ t('plugins.colVersion') }}</th><th>{{ t('plugins.colContrib') }}</th><th>{{ t('plugins.colError') }}</th></tr></thead>
        <tbody><tr v-for="(p, index) in plugins.entries" :key="p.key ?? `${p.kind}:${p.source ?? p.name}:${index}`" data-testid="plugins-row" :data-failed="p.kind === 'failed' ? 'true' : undefined">
          <td><strong>{{ p.name }}</strong><div v-if="p.pluginId">{{ p.pluginId }}</div><details v-if="p.source"><summary>{{ t('plugins.source') }}</summary><span>{{ p.source }}</span></details></td>
          <td><span data-testid="plugins-kind" :data-kind="p.kind">{{ t(p.kind === 'loaded' ? 'plugins.kindLoaded' : p.kind === 'disabled' ? 'plugins.kindDisabled' : 'plugins.kindFailed') }}</span></td>
          <td>{{ p.version ?? '—' }}<div v-if="p.apiVersion">API {{ p.apiVersion }}</div><div v-if="p.requiredHost">{{ t('plugins.requiredHost') }}: {{ p.requiredHost }}</div></td>
          <td><div v-for="g in groups(p)" :key="g.key" data-testid="plugins-contrib-tag">{{ t(`plugins.contrib.${g.key}`) }} ×{{ g.names.length }}: {{ g.names.join(', ') }}</div><span v-if="!groups(p).length">—</span></td>
          <td><template v-if="p.error"><div class="error-text" data-testid="plugins-error"><div>{{ reasonLabel(p) }}</div><div v-if="reasonDetail(p) && reasonDetail(p) !== reasonLabel(p)" class="reason-detail">{{ reasonDetail(p) }}</div></div><div v-if="p.code">{{ t('plugins.reasonCode') }}: {{ p.code }}</div><div v-if="p.stage">{{ t('plugins.stage') }}: {{ stageLabel(p.stage) }}</div><div v-if="p.actual !== undefined">{{ t('plugins.actual') }}: {{ p.actual }}</div><div v-if="p.required !== undefined">{{ t('plugins.required') }}: {{ p.required }}</div><p>{{ t('plugins.repairAction') }}</p><details v-if="reasonLabel(p) !== p.error"><summary>{{ t('plugins.originalError') }}</summary><span>{{ p.error }}</span></details></template><span v-else>—</span></td>
        </tr></tbody>
      </table>
    </div>
    <section v-if="plugins.bindings.length"><h3>{{ t('plugins.bindings') }}</h3><ul><li v-for="b in plugins.bindings" :key="b.key">{{ t(`plugins.contrib.${b.kind}`) }} · {{ b.target }} → {{ b.contributionId }} · {{ t(b.active ? 'plugins.bindingActive' : 'plugins.bindingUnavailable') }}</li></ul></section>
    <details v-if="plugins.entries.length" class="raw"><summary>{{ t('plugins.rawSummary') }}</summary><pre>{{ JSON.stringify({ plugins: plugins.entries, bindings: plugins.bindings }, null, 2) }}</pre></details>
  </section>
</template>

<style scoped>
.plugins-view { padding: 10px; min-width: 0; display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
.head { display: flex; justify-content: space-between; align-items: center; }
p { margin: 4px 0; } .muted { color: var(--text-secondary, #666); }
.table-scroll { overflow: auto; max-width: 100%; } table { width: 100%; border-collapse: collapse; table-layout: fixed; min-width: 760px; }
th, td { padding: 8px; border-bottom: 1px solid var(--border-color, #ddd); text-align: left; vertical-align: top; overflow-wrap: anywhere; }
th { white-space: nowrap; } th:nth-child(2) { width: 70px; } th:nth-child(3) { width: 160px; }
tr[data-failed=true] { background: rgba(255, 77, 79, .06); } .error-text { color: var(--color-error, #b42318); }
.reason-detail { max-height: 160px; overflow: auto; }
li { overflow-wrap: anywhere; } details span { display: block; max-height: 160px; overflow: auto; } summary { cursor: pointer; }
.raw pre { max-height: 260px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
