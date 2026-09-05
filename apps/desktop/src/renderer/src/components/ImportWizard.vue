<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Alert as AAlert, Button as AButton, Input as AInput, Steps as ASteps, Tag as ATag, Tree as ATree } from "ant-design-vue";
import type { useImportWizardStore } from "../stores/importW.js";
import type { PluginsStore } from "../stores/plugins.js";

/**
 * 导入向导（antd a-steps 三步，任务 7）：① 选择文件——渲染层 input[type=file] 读文本
 * （Electron 渲染层可读用户所选文件，不新增文件选择 IPC），读出 content + fileName 进
 * preview；② 预览确认——a-tree 渲染项目结构（项目 → 集合 → 接口）+ 警告 a-alert +
 * 目标分组名（不存在则由主进程创建）；③ 完成——apply 落库 + workspace 刷新 + 成功态。
 * store 经 props 注入（组合根一次装配，组件内零工厂调用）；取消/完成向组合根发
 * close 事件（向导挂载与视图切换装配留收官任务）。apply 拒绝时经 reportError 上报并
 * 留在第二步可重试；无法识别的格式经组件内错误提示留在第一步。
 * 导入格式清单（M7-B 任务 1，规格 §2 D5）：改造走 plugins store 动态枚举——清单来自
 * IPC plugins:list 出口的 importers（内置 registry + 插件贡献），向导内零硬编码格式名
 * （既有硬编码口径见报告：import:preview 探测清单保持 core registry 注入不动）。
 */
const props = defineProps<{
  importW: ReturnType<typeof useImportWizardStore>;
  plugins: PluginsStore;
  reportError: (e: unknown) => void;
}>();
const emit = defineEmits<{ (e: "close"): void }>();
const { t } = useI18n();

const current = ref(0);
const groupName = ref("");
const stepError = ref("");

const steps = computed(() => [
  { title: t("import.stepFile") },
  { title: t("import.stepPreview") },
  { title: t("import.stepDone") },
]);

// 预览树：项目 → 集合（标注接口数）→ 接口（方法 + 名称；文件夹内接口平铺）。
const treeData = computed(() => {
  const p = props.importW.preview?.project;
  if (!p) return [];
  return [{
    title: `${p.name}（${t("import.project")}）`,
    key: `project:${p.id}`,
    children: p.collections.map((c) => ({
      title: `${c.name}（${c.apis.length + c.folders.reduce((n, f) => n + f.apis.length, 0)} ${t("import.apiCount")}）`,
      key: `collection:${c.id}`,
      children: [
        ...c.apis.map((a) => ({ title: `${a.method} ${a.name}`, key: `api:${a.id}` })),
        ...c.folders.flatMap((f) => f.apis.map((a) => ({ title: `${a.method} ${a.name}`, key: `folder-api:${a.id}` }))),
      ],
    })),
  }];
});

const warnings = computed(() => props.importW.preview?.warnings ?? []);

async function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ""; // 复位以允许重复选择同一文件
  if (!file) return;
  try {
    const content = await file.text();
    await props.importW.previewFile(file.name, content);
    stepError.value = "";
    current.value = 1;
  } catch (e) {
    stepError.value = e instanceof Error ? e.message : String(e);
  }
}

async function applyImport() {
  if (!groupName.value.trim()) return;
  try {
    await props.importW.apply(groupName.value.trim());
    current.value = 2;
  } catch (e) {
    props.reportError(e); // 留在第二步（预览/分组名可改后重试）
  }
}

function closeWizard() {
  props.importW.reset();
  groupName.value = "";
  stepError.value = "";
  current.value = 0;
  emit("close");
}
</script>

<template>
  <section class="import-wizard" data-testid="import-wizard">
    <a-steps :items="steps" :current="current" size="small" data-testid="import-steps" />
    <!-- 第一步：选择文件 -->
    <div v-if="current === 0" class="step-body">
      <!-- 动态枚举的导入格式（M7-B 任务 1，D5）：内置 + 插件贡献，随 plugins:list 出口 -->
      <div class="formats" data-testid="import-formats">
        <span class="formats-label">{{ t("import.formats") }}</span>
        <a-tag v-for="name in plugins.importers" :key="name" data-testid="import-format">{{ name }}</a-tag>
        <span v-if="plugins.importers.length === 0" class="formats-empty">—</span>
      </div>
      <input
        ref="fileInput"
        type="file"
        class="hidden-input"
        data-testid="import-file-input"
        @change="onFileChange"
      />
      <a-button type="primary" data-testid="import-file-button" @click="($refs.fileInput as HTMLInputElement).click()">
        {{ t("import.pickFile") }}
      </a-button>
      <a-button data-testid="import-cancel" @click="closeWizard">{{ t("common.cancel") }}</a-button>
      <a-alert
        v-if="stepError"
        type="error"
        :message="t('import.error')"
        :description="stepError"
        show-icon
        data-testid="import-error"
      />
    </div>
    <!-- 第二步：预览确认 -->
    <div v-else-if="current === 1" class="step-body">
      <a-alert
        v-for="w in warnings"
        :key="w"
        type="warning"
        :message="t('import.warnings')"
        :description="w"
        show-icon
        data-testid="import-warnings"
      />
      <a-tree :tree-data="treeData" block-node default-expand-all data-testid="import-preview-tree" />
      <label class="group-row">
        <span>{{ t("import.groupName") }}</span>
        <a-input
          v-model:value="groupName"
          :placeholder="t('import.groupPlaceholder')"
          data-testid="import-group-input"
        />
      </label>
      <div class="actions">
        <a-button data-testid="import-prev" @click="current = 0">{{ t("import.prev") }}</a-button>
        <a-button data-testid="import-cancel" @click="closeWizard">{{ t("common.cancel") }}</a-button>
        <a-button type="primary" :disabled="!groupName.trim() || importW.applying" data-testid="import-apply" @click="applyImport">
          {{ t("import.apply") }}
        </a-button>
      </div>
    </div>
    <!-- 第三步：完成 -->
    <div v-else class="step-body">
      <div data-testid="import-done">
        <a-alert
          type="success"
          :message="t('import.doneTitle')"
          :description="t('import.doneText', { name: importW.preview?.project.name ?? '' })"
          show-icon
        />
      </div>
      <a-button type="primary" data-testid="import-finish" @click="closeWizard">{{ t("import.finish") }}</a-button>
    </div>
  </section>
</template>

<style scoped>
.import-wizard {
  padding: 8px 10px;
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.step-body {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}
.hidden-input {
  display: none;
}
/* 动态枚举的导入格式清单（M7-B 任务 1）：文件选择上方轻量 tag 行 */
.formats {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.formats-label {
  color: var(--text-muted);
  font-size: 12px;
  margin-inline-end: 2px;
}
.formats-empty {
  color: var(--text-muted);
}
.group-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}
.group-row .ant-input,
.group-row input {
  flex: 1;
}
.actions {
  display: flex;
  gap: 8px;
}
</style>
