<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Alert as AAlert, Button as AButton, Modal as AModal, Typography as ATypography } from "ant-design-vue";
import type { ApiccApi } from "../../../shared/types.js";
import type { MigrationFileAction } from "../../../shared/online/types.js";
import type { createOnlineStore } from "../stores/online.js";

const ATypographyParagraph = ATypography.Paragraph;

/**
 * 在线工作区迁移向导（M3-B 任务 3，简报裁定 D）：
 * - 拉取到本地：wsPickDirectory 选目录 → store.migratePull（hash 比对跳过同内容 → 分批
 *   ≤200 取内容/落盘 → 新拉/更新/跳过计数 + 明细）。
 * - 推送到在线：选本地目录 → store.migratePush（新文件 baseVersion=0、变更带服务端 version
 *   走 batch、同 hash 跳过——从不盲目覆盖；冲突默认跳过并列出）→ 推送后树自动刷新。
 * - 进度按批次回传（store.migrationProgress），迁移中单活动（按钮禁用 + 防二次启动）。
 * store/api 经 props 注入（组合根一次装配；组件内零工厂调用）。
 */
const props = defineProps<{
  online: ReturnType<typeof createOnlineStore>;
  api: ApiccApi;
  reportError: (e: unknown) => void;
}>();
const { t } = useI18n();

const result = computed(() => props.online.migrationResult);

/** 结果计数行文案（拉/推各一条）。 */
const resultText = computed(() => {
  const r = result.value;
  if (!r) return "";
  return r.direction === "pull"
    ? t("online.pullResult", { pulled: r.pulled, updated: r.updated, skipped: r.skipped, failed: r.failed })
    : t("online.pushResult", { pushed: r.pushed, conflicts: r.conflicts, skipped: r.skipped, failed: r.failed });
});

function actionText(action: MigrationFileAction): string {
  return t(`online.action.${action}`);
}

async function runMigrate(direction: "pull" | "push") {
  let dir: string;
  try {
    dir = await props.api.wsPickDirectory();
  } catch (e) {
    props.reportError(e);
    return;
  }
  if (!dir) return; // 用户取消目录选择
  try {
    if (direction === "pull") await props.online.migratePull(dir);
    else await props.online.migratePush(dir);
  } catch (e) {
    props.reportError(e);
  }
}
</script>

<template>
  <a-modal
    v-if="online.migrateDialogOpen"
    :open="online.migrateDialogOpen"
    :title="t('online.migrateTitle')"
    :width="520"
    data-testid="online-migrate-dialog"
    :footer="null"
    @cancel="online.migrateDialogOpen = false"
  >
    <div class="migrate-body" data-testid="migrate-body">
      <!-- 拉取到本地 -->
      <section class="section">
        <div class="section-title">{{ t("online.migratePullTitle") }}</div>
        <a-typography-paragraph class="desc">{{ t("online.migratePullDesc") }}</a-typography-paragraph>
        <a-button
          type="primary"
          data-testid="migrate-pull-btn"
          :disabled="online.migrating"
          @click="runMigrate('pull')"
        >
          {{ t("online.migratePick") }}
        </a-button>
      </section>

      <!-- 推送到在线 -->
      <section class="section">
        <div class="section-title">{{ t("online.migratePushTitle") }}</div>
        <a-typography-paragraph class="desc">{{ t("online.migratePushDesc") }}</a-typography-paragraph>
        <a-button
          data-testid="migrate-push-btn"
          :disabled="online.migrating"
          @click="runMigrate('push')"
        >
          {{ t("online.migratePick") }}
        </a-button>
      </section>

      <!-- 进度（按批次）与结果清单 -->
      <div v-if="online.migrating" class="progress" data-testid="migrate-progress">
        {{ t("online.migrating") }} {{ online.migrationProgress }}
      </div>
      <template v-if="result">
        <a-alert
          type="success"
          show-icon
          :message="resultText"
          data-testid="migrate-result"
        />
        <div class="detail">
          <div class="detail-title">{{ t("online.resultDetail") }}</div>
          <ul class="detail-list" data-testid="migrate-result-list">
            <li v-for="(entry, index) in result.details" :key="`${entry.path}:${index}`">
              <span class="detail-path">{{ entry.path }}</span>
              <span class="detail-action">{{ actionText(entry.action) }}</span>
              <!-- 退化/冲突注记：孤儿退化按实体路径落盘、同名项目冲突后行者计 failed 时标注 -->
              <span v-if="entry.note" class="detail-note">{{ entry.note }}</span>
            </li>
          </ul>
        </div>
        <div class="hint" data-testid="migrate-done-hint">{{ t("online.migrateDoneHint") }}</div>
      </template>
    </div>
  </a-modal>
</template>

<style scoped>
.migrate-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.section-title {
  font-weight: 600;
  font-size: 13px;
}
.desc {
  margin: 0;
  color: var(--text-muted, #666);
  font-size: 12px;
  line-height: 1.6;
}
.progress {
  font-size: 12px;
  color: var(--accent, #1677ff);
}
.detail-title {
  font-size: 12px;
  color: var(--text-muted, #666);
  margin: 4px 0;
}
.detail-list {
  margin: 0;
  padding-left: 16px;
  max-height: 200px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.8;
}
.detail-path {
  margin-right: 8px;
}
.detail-action {
  color: var(--text-muted, #666);
}
.detail-note {
  display: block;
  color: var(--text-muted, #999);
  font-size: 11px;
}
.hint {
  font-size: 12px;
  color: var(--text-muted, #666);
}
</style>
