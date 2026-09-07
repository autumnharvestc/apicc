<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Alert as AAlert, Button as AButton, Input as AInput, Select as ASelect, Steps as ASteps, Tag as ATag, Tree as ATree } from "ant-design-vue";
import type { useImportWizardStore } from "../stores/importW.js";
import type { PluginsStore } from "../stores/plugins.js";

/**
 * 导入向导（antd a-steps 三步；轨二双模式）：① 选择文件——渲染层 input[type=file] 读文本，
 * 读出 content + fileName 进 preview；② 预览确认——a-tree 渲染项目结构 + 警告 a-alert +
 * 落点表单（按 mode 区分）；③ 完成——apply 落库 + workspace 刷新 + 成功态。
 * - mode="project"（主页入口）：「目标分组」下拉（按 id，默认分组默认选中）+「项目名」
 *   输入（预填文件 title 可改）——整项目落库（含 imported 环境）。
 * - mode="module"（接口模块头部入口）：无落点选择，仅「模块名」输入（预填 title 可改）——
 *   产物集合并入目标项目，baseUrl 写模块变量、不造环境。
 * 同名放开（轨二）：重名不拒绝，重复导入并存。
 * store 经 props 注入（组合根一次装配）；取消/完成向组合根发 close 事件。apply 拒绝时
 * 经 reportError 上报并留在第二步可重试；无法识别的格式经组件内错误提示留在第一步。
 * 导入格式清单（M7-B）：来自 plugins:list 出口的 importers，向导内零硬编码格式名。
 */
const props = defineProps<{
  importW: ReturnType<typeof useImportWizardStore>;
  plugins: PluginsStore;
  reportError: (e: unknown) => void;
  /** 落点模式：project=导入为项目（选分组）；module=并入指定项目（默认当前项目）。 */
  mode: "project" | "module";
  /** project 模式：可选分组清单（id+名），默认选中 defaultGroupId。 */
  groups?: Array<{ id: string; label: string }>;
  defaultGroupId?: string | null;
  /** module 模式：目标项目 id（默认当前项目上下文）。 */
  targetProjectId?: string | null;
}>();
const emit = defineEmits<{ (e: "close"): void }>();
const { t } = useI18n();

const current = ref(0);
const targetName = ref("");
const groupId = ref<string | undefined>(undefined);
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

const groupOptions = computed(() => (props.groups ?? []).map((g) => ({ label: g.label, value: g.id })));

async function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ""; // 复位以允许重复选择同一文件
  if (!file) return;
  try {
    const content = await file.text();
    await props.importW.previewFile(file.name, content);
    // 预填可编辑名称：project=项目名 / module=模块名（均取文件 title）
    targetName.value = props.importW.preview?.project.name ?? "";
    groupId.value = props.defaultGroupId ?? props.groups?.[0]?.id ?? undefined;
    stepError.value = "";
    current.value = 1;
  } catch (e) {
    stepError.value = e instanceof Error ? e.message : String(e);
  }
}

async function applyImport() {
  const p = props.importW.preview?.project;
  if (!p) return;
  if (props.mode === "project" && !groupId.value) {
    stepError.value = t("home.targetGroup");
    return;
  }
  try {
    if (props.mode === "module") {
      if (!props.targetProjectId) {
        stepError.value = t("home.noWorkspaceSide");
        return;
      }
      await props.importW.apply({ mode: "module", projectId: props.targetProjectId, name: targetName.value.trim() });
    } else {
      await props.importW.apply({ mode: "project", groupId: groupId.value!, name: targetName.value.trim() });
    }
    current.value = 2;
  } catch (e) {
    props.reportError(e); // 留在第二步（预览/名称可改后重试）
  }
}

function closeWizard() {
  props.importW.reset();
  targetName.value = "";
  groupId.value = undefined;
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
    <!-- 第二步：预览确认（表单按模式区分） -->
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
      <label v-if="mode === 'project'" class="group-row">
        <span>{{ t("home.targetGroup") }}</span>
        <a-select
          v-model:value="groupId"
          class="group-select"
          :options="groupOptions"
          data-testid="import-group-select"
        />
      </label>
      <label class="group-row">
        <span>{{ mode === "project" ? t("home.projectName") : t("home.moduleName") }}</span>
        <a-input
          v-model:value="targetName"
          :placeholder="mode === 'project' ? t('home.projectName') : t('home.moduleName')"
          data-testid="import-name-input"
        />
      </label>
      <div class="actions">
        <a-button data-testid="import-prev" @click="current = 0">{{ t("import.prev") }}</a-button>
        <a-button data-testid="import-cancel" @click="closeWizard">{{ t("common.cancel") }}</a-button>
        <a-button
          type="primary"
          :disabled="importW.applying || (mode === 'project' && !groupId)"
          data-testid="import-apply"
          @click="applyImport"
        >
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
.group-row input,
.group-select {
  flex: 1;
}
.actions {
  display: flex;
  gap: 8px;
}
</style>
