<script setup lang="ts">
import { computed } from "vue";
import { Button as AButton, Modal as AModal } from "ant-design-vue";
import { useI18n } from "vue-i18n";
import { redactAiText, safeAiValue } from "@apicc/core/ai/contract-view";
import { sameProjectSaveValue } from "@apicc/core/collaboration/project-save";
import type { OnlineExecutionStore } from "../../stores/onlineExecution.js";

const props = defineProps<{ execution: Pick<OnlineExecutionStore, "hasProjectUpdates" | "updatePreview" | "openUpdatePreview"
  | "closeUpdatePreview" | "applyUpdatePreview" | "saveFeedback" | "verifyAssetSave" | "dismissSaveFeedback" | "projectReadIssue"> }>();
const { t, te } = useI18n();
const feedback = computed(() => props.execution.saveFeedback);
const conflict = computed(() => feedback.value?.conflict);
const details = computed(() => feedback.value?.details);
const safeTextFields = new Set(["name", "description", "method", "protocol", "path", "baseUrl", "documentation"]);
const parameterFields = new Set(["pathParams", "query", "headers", "cookies"]);
const valueColumns = ["baseline", "submitted", "current"] as const;
type Parameter = { id: string; name: string; value: string; enabled: boolean };

function isParameter(value: unknown): value is Parameter {
  return !!value && typeof value === "object" && "id" in value && typeof value.id === "string"
    && "name" in value && typeof value.name === "string" && "value" in value && typeof value.value === "string"
    && "enabled" in value && typeof value.enabled === "boolean";
}

const changedParameters = computed(() => {
  if (!conflict.value?.field || !parameterFields.has(conflict.value.field) || !details.value) return null;
  const versions = valueColumns.map(column => {
    const value = details.value?.[column];
    return new Map((Array.isArray(value) ? value.filter(isParameter) : []).map(row => [row.id, row]));
  });
  const ids = [...new Set(versions.flatMap(rows => [...rows.keys()]))];
  const changed = ids.filter(id => !versions.slice(1).every(rows => sameProjectSaveValue(versions[0]?.get(id), rows.get(id))));
  return versions.map(rows => changed.flatMap(id => {
    const row = rows.get(id);
    return row ? [{ ...row, name: redactAiText(row.name), value: conflict.value?.field === "cookies" ? "[REDACTED]" : String(safeAiValue(row.value, row.name)) }] : [];
  }));
});

const conflictField = computed(() => {
  const field = conflict.value?.field;
  const fieldKey = `onlineProjectUpdate.field.${field}`;
  return t(field && te(fieldKey) ? fieldKey : `onlineProjectUpdate.area.${conflict.value?.area ?? "api"}`);
});

function describeValue(value: unknown) {
  if (value === undefined || value === null) return t("onlineProjectUpdate.noValue");
  if (value === "") return t("onlineProjectUpdate.emptyValue");
  if (Array.isArray(value)) return t("onlineProjectUpdate.itemCount", { count: value.length });
  if (conflict.value?.field && safeTextFields.has(conflict.value.field) && typeof value === "string") return redactAiText(value);
  return t("onlineProjectUpdate.editorValue");
}
</script>

<template>
  <div v-if="execution.hasProjectUpdates || feedback || execution.projectReadIssue" class="project-updates">
    <div v-if="execution.projectReadIssue === 'online-project-content-unavailable'" class="update-line" role="status" data-testid="online-update-unreadable">
      {{ t('onlineProjectUpdate.contentUnavailable') }}
    </div>
    <div v-if="execution.hasProjectUpdates" class="update-line" role="status" data-testid="online-project-updates">
      <span>{{ t("onlineProjectUpdate.available") }}</span>
      <a-button size="small" type="link" data-testid="online-update-review" @click="execution.openUpdatePreview()">{{ t("onlineProjectUpdate.review") }}</a-button>
    </div>
    <div v-if="feedback" class="update-line" :role="feedback.status === 'conflict' || feedback.status === 'rejected' ? 'alert' : 'status'" data-testid="online-asset-save-feedback">
      <span>{{ t(`onlineProjectUpdate.save.${feedback.disposition ?? feedback.status}`, { name: feedback.target }) }}</span>
      <span v-if="conflict">{{ t(`onlineProjectUpdate.conflict.${conflict.reason}`, { field: conflictField }) }}</span>
      <span v-else-if="feedback.reason">{{ t(`onlineProjectUpdate.rejected.${feedback.reason}`) }}</span>
      <a-button v-if="feedback.status === 'unknown'" size="small" data-testid="online-verify-save" @click="execution.verifyAssetSave()">{{ t("onlineProjectUpdate.verify") }}</a-button>
      <a-button v-else-if="feedback.status !== 'saving'" size="small" type="text" @click="execution.dismissSaveFeedback()">{{ t("onlineProjectUpdate.dismiss") }}</a-button>
      <details v-if="conflict?.reason === 'same-field' && details" class="save-details">
        <summary>{{ t("onlineProjectUpdate.compare") }}</summary>
        <dl>
          <div v-for="(column, index) in valueColumns" :key="column">
            <dt>{{ t(`onlineProjectUpdate.${column}`) }}</dt>
            <dd v-if="changedParameters?.[index]?.length">
              <ul class="parameter-list">
                <li v-for="row in changedParameters[index]" :key="row.id">
                  <strong>{{ row.name }}</strong> · {{ row.enabled ? '' : t('onlineProjectUpdate.disabled') }}{{ row.value || t('onlineProjectUpdate.emptyValue') }}
                </li>
              </ul>
            </dd>
            <dd v-else>{{ changedParameters ? t('onlineProjectUpdate.noValue') : describeValue(details[column]) }}</dd>
          </div>
        </dl>
      </details>
    </div>
  </div>
  <a-modal v-if="execution.updatePreview" open :title="t('onlineProjectUpdate.title')"
    data-testid="online-update-preview" @cancel="execution.closeUpdatePreview()">
    <template #footer>
      <a-button @click="execution.closeUpdatePreview()">{{ t('onlineProjectUpdate.later') }}</a-button>
      <a-button type="primary" data-testid="online-update-apply" @click="execution.applyUpdatePreview()">{{ t('onlineProjectUpdate.apply') }}</a-button>
    </template>
    <ul class="update-list" :aria-label="t('onlineProjectUpdate.title')">
      <li v-for="change in execution.updatePreview.changes" :key="change.id">
        <span class="change-kind" :class="change.kind">{{ t(`onlineProjectUpdate.kind.${change.kind}`) }}</span>
        <span>
          <strong>{{ change.name }}</strong>
          <small>{{ t(`onlineProjectUpdate.asset.${change.asset}`) }}<template v-if="change.location"> · {{ change.location }}</template></small>
        </span>
      </li>
    </ul>
  </a-modal>
</template>

<style scoped>
.project-updates { flex-shrink: 0; background: var(--subtle); color: var(--text); border-bottom: 1px solid var(--border); }
.update-line { display: flex; align-items: center; gap: 4px 10px; flex-wrap: wrap; padding: 6px 12px; overflow-wrap: anywhere; }
.update-line + .update-line { border-top: 1px solid var(--border); }
.save-details { width: 100%; }
.save-details summary { cursor: pointer; }
.save-details dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(140px, 100%), 1fr)); gap: 8px 16px; margin: 8px 0 0; }
.save-details dt { color: var(--muted); }
.save-details dd { margin: 0; max-height: 8em; overflow: auto; white-space: pre-wrap; }
.parameter-list { list-style: none; padding: 0; margin: 0; }
.update-list { list-style: none; padding: 0; margin: 0; max-height: min(50vh, 360px); overflow: auto; }
.update-list li { display: grid; grid-template-columns: max-content minmax(0, 1fr); align-items: start; gap: 12px; border-bottom: 1px solid var(--border); padding: 8px 0; overflow-wrap: anywhere; }
.update-list li:last-child { border-bottom: 0; }
.update-list small { display: block; color: var(--muted); }
.change-kind { background: var(--subtle); border-radius: 4px; padding: 1px 6px; }
</style>
