<script setup lang="ts">
import { computed } from "vue";
import { Button as AButton, Modal as AModal } from "ant-design-vue";
import { useI18n } from "vue-i18n";
import type { LocalWorkspaceFailureReason, WorkspaceObservationResult } from "../../../shared/workspace-refresh.js";

const props = defineProps<{
  observation: WorkspaceObservationResult | null;
  preview: WorkspaceObservationResult | null;
  issue: LocalWorkspaceFailureReason | null;
  applyIssue: LocalWorkspaceFailureReason | null;
  applying: boolean;
  previewStale: boolean;
}>();
const emit = defineEmits<{ review: []; apply: []; close: [] }>();
const { t } = useI18n();
const notice = computed(() => {
  const changes = props.observation?.changes ?? [];
  const projects = changes.filter(change => change.project);
  if (changes.length === 1 && projects.length === 1) {
    const { name, groupName } = projects[0]!;
    return groupName ? t("diskUpdate.singleGroupedProject", { name, group: groupName }) : t("diskUpdate.singleProject", { name });
  }
  if (projects.length && projects.length === changes.length) return t("diskUpdate.multipleProjects", { count: projects.length });
  return t("diskUpdate.workspace");
});
</script>

<template>
  <div v-if="observation" class="disk-update" role="status" data-testid="workspace-disk-update">
    <span>{{ notice }}</span>
    <a-button type="link" size="small" data-testid="workspace-disk-update-review" @click="emit('review')">{{ t('onlineProjectUpdate.review') }}</a-button>
  </div>
  <div v-if="issue" class="disk-update" role="status" data-testid="workspace-disk-observation-issue">
    {{ t(`diskRefresh.error.${issue}`) }}
  </div>
  <a-modal v-if="preview" open :title="t('diskUpdate.title')" :mask-closable="!applying" :closable="!applying" :keyboard="!applying"
    @cancel="emit('close')">
    <p v-if="previewStale" role="status" data-testid="workspace-disk-update-stale">{{ t('diskUpdate.previewStale') }}</p>
    <p v-if="applyIssue" role="alert">{{ t(`diskRefresh.error.${applyIssue}`) }}</p>
    <p v-if="!preview.changes.length">{{ t('diskUpdate.noChanges') }}</p>
    <div class="disk-change-list" data-testid="workspace-disk-update-preview">
      <section v-for="change in preview.changes" :key="change.project ? JSON.stringify(change.project) : 'workspace'">
        <h3><span>{{ t(`onlineProjectUpdate.kind.${change.kind}`) }}</span> {{ change.name }}<small v-if="change.groupName"> · {{ change.groupName }}</small></h3>
        <ul v-if="change.changes.length">
          <li v-for="asset in change.changes" :key="asset.id">
            <span>{{ t(`onlineProjectUpdate.kind.${asset.kind}`) }}</span>
            <small>{{ t(`onlineProjectUpdate.asset.${asset.asset}`) }}</small>
            <strong>{{ asset.name }}</strong><small v-if="asset.location">{{ asset.location }}</small>
          </li>
        </ul>
      </section>
    </div>
    <template #footer>
      <a-button :disabled="applying" @click="emit('close')">{{ t('onlineProjectUpdate.later') }}</a-button>
      <a-button type="primary" :loading="applying" :disabled="!preview.changes.length" data-testid="workspace-disk-update-apply" @click="emit('apply')">
        {{ t('diskUpdate.apply') }}
      </a-button>
    </template>
  </a-modal>
</template>

<style scoped>
.disk-update { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; flex-shrink: 0; padding: 4px 12px; background: var(--subtle); color: var(--text); border-bottom: 1px solid var(--border); overflow-wrap: anywhere; }
.disk-change-list { max-height: min(50vh, 360px); overflow: auto; }
.disk-change-list section { padding: 8px 0; border-bottom: 1px solid var(--border); }
.disk-change-list section:last-child { border-bottom: 0; }
.disk-change-list h3 { margin: 0; overflow-wrap: anywhere; }
.disk-change-list ul { list-style: none; padding: 0; margin: 4px 0 0; }
.disk-change-list li { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px; overflow-wrap: anywhere; padding: 4px 0; }
.disk-change-list h3 span, .disk-change-list small { color: var(--muted); }
</style>
