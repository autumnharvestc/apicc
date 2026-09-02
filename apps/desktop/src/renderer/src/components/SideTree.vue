<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import type { TreeNodeDTO } from "../../shared/tree-dto.js";
import type { useWorkspaceStore } from "../stores/workspace.js";
import type { useTreeStore } from "../stores/tree.js";
import EmptyState from "./EmptyState.vue";
import ConfirmDialog from "./ConfirmDialog.vue";

/**
 * 左侧树：递归结构按 DTO 固定深度展开（分组→项目→集合→[文件夹→]接口）。
 * store 经 props 注入（组合根一次装配；组件内部禁止重复调用 store 工厂）。
 * 选中接口 emit select(kind,id)；创建/重命名复用 ConfirmDialog 输入，删除先经确认。
 */
const props = defineProps<{
  workspace: ReturnType<typeof useWorkspaceStore>;
  tree: ReturnType<typeof useTreeStore>;
}>();
const emit = defineEmits<{ select: [kind: TreeNodeDTO["kind"], id: string] }>();
const { t } = useI18n();

// 折叠集合：默认全部折叠（分组/项目/集合/文件夹）；展开节点时递归展开其后代容器，
// 一次点击即可从分组直达接口。
const expanded = ref(new Set<string>());

function descendantContainerIds(node: TreeNodeDTO): string[] {
  const ids: string[] = [];
  for (const child of node.children ?? []) {
    if (child.kind !== "api") ids.push(child.id);
    ids.push(...descendantContainerIds(child));
  }
  return ids;
}

function toggle(node: TreeNodeDTO) {
  const next = new Set(expanded.value);
  if (next.has(node.id)) {
    next.delete(node.id);
  } else {
    next.add(node.id);
    for (const id of descendantContainerIds(node)) next.add(id);
  }
  expanded.value = next;
}

function isOpen(node: TreeNodeDTO): boolean {
  return expanded.value.has(node.id);
}

function selectApi(node: TreeNodeDTO) {
  props.tree.select(node.kind, node.id);
  emit("select", node.kind, node.id);
}

// —— 对话框（创建/重命名/删除共用一个 ConfirmDialog 实例） ——
interface DialogState {
  open: boolean;
  title: string;
  placeholder?: string;
  initialValue?: string;
  run: (value: string | null) => void;
}
const dialog = ref<DialogState>({ open: false, title: "", run: () => {} });

function openDialog(state: Omit<DialogState, "open">) {
  dialog.value = { open: true, ...state };
}

function closeDialog() {
  dialog.value = { ...dialog.value, open: false };
}

async function onDialogConfirm(value: string | null) {
  const run = dialog.value.run;
  closeDialog();
  await run(value);
}

type CreateKind = "group" | "project" | "collection" | "folder" | "api";

/** 根层新建分组：空工作区没有可悬停的节点，这是分组创建的唯一入口。 */
function startCreateGroup() {
  openDialog({
    title: t("tree.newGroup"),
    placeholder: t("tree.namePlaceholder"),
    run: async (value) => {
      if (!value) return;
      // nodeCreate 返回统一瘦 DTO（kind 必在，宽审查 I2），选中直接用返回值。
      const node = await props.tree.createNode({ kind: "group", parentId: null, name: value });
      emit("select", node.kind, node.id);
    },
  });
}

function startCreate(parent: TreeNodeDTO, kind: CreateKind) {
  const titleKey = { group: "tree.newGroup", project: "tree.newProject", collection: "tree.newCollection", folder: "tree.newFolder", api: "tree.newApi" }[kind];
  openDialog({
    title: t(titleKey),
    placeholder: t("tree.namePlaceholder"),
    run: async (value) => {
      if (!value) return;
      // nodeCreate 返回统一瘦 DTO（kind 必在，宽审查 I2）：选中用返回值的 kind，
      // App 据此对 "api" 加载编辑器。
      const node = await props.tree.createNode({ kind, parentId: parent.id, name: value });
      emit("select", node.kind, node.id);
    },
  });
}

function startRename(node: TreeNodeDTO) {
  openDialog({
    title: t("tree.rename"),
    placeholder: t("tree.namePlaceholder"),
    initialValue: node.label,
    run: async (value) => {
      if (!value) return;
      await props.tree.renameNode(node.kind, node.id, value);
    },
  });
}

function startDelete(node: TreeNodeDTO) {
  openDialog({
    title: t("tree.deleteConfirm", { name: node.label }),
    run: async () => {
      // 已在对话框确认：放行回调恒真。
      await props.tree.deleteNode(node.kind, node.id, async () => true);
    },
  });
}
</script>

<template>
  <aside class="side" data-testid="side-tree">
    <EmptyState v-if="!workspace.opened || !workspace.tree" :text="t('tree.empty')" />
    <template v-else>
      <div class="root-row">
        <span class="root-label">{{ workspace.tree.label }}</span>
        <button class="act" data-testid="new-group" @click="startCreateGroup">{{ t("tree.newGroup") }}</button>
      </div>
      <ul class="tree">
        <li v-for="group in workspace.tree.children" :key="group.id">
          <div class="node">
            <button class="toggle" data-testid="tree-group-toggle" @click="toggle(group)">{{ isOpen(group) ? "▾" : "▸" }}</button>
            <span class="label">{{ group.label }}</span>
            <span class="actions">
              <button class="act" data-testid="new-project" @click="startCreate(group, 'project')">{{ t("tree.newProject") }}</button>
              <button class="act" data-testid="node-rename" @click="startRename(group)">{{ t("tree.rename") }}</button>
              <button class="act danger" data-testid="node-delete" @click="startDelete(group)">{{ t("tree.delete") }}</button>
            </span>
          </div>
          <ul v-if="isOpen(group)">
            <li v-for="project in group.children" :key="project.id">
              <div class="node">
                <button class="toggle" data-testid="tree-group-toggle" @click="toggle(project)">{{ isOpen(project) ? "▾" : "▸" }}</button>
                <span class="label">{{ project.label }}</span>
                <span class="actions">
                  <button class="act" data-testid="new-collection" @click="startCreate(project, 'collection')">{{ t("tree.newCollection") }}</button>
                  <button class="act" data-testid="node-rename" @click="startRename(project)">{{ t("tree.rename") }}</button>
                  <button class="act danger" data-testid="node-delete" @click="startDelete(project)">{{ t("tree.delete") }}</button>
                </span>
              </div>
              <ul v-if="isOpen(project)">
                <li v-for="collection in project.children" :key="collection.id">
                  <div class="node">
                    <button class="toggle" data-testid="tree-group-toggle" @click="toggle(collection)">{{ isOpen(collection) ? "▾" : "▸" }}</button>
                    <span class="label">{{ collection.label }}</span>
                    <span class="actions">
                      <button class="act" data-testid="new-api" @click="startCreate(collection, 'api')">{{ t("tree.newApi") }}</button>
                      <button class="act" data-testid="new-folder" @click="startCreate(collection, 'folder')">{{ t("tree.newFolder") }}</button>
                      <button class="act" data-testid="node-rename" @click="startRename(collection)">{{ t("tree.rename") }}</button>
                      <button class="act danger" data-testid="node-delete" @click="startDelete(collection)">{{ t("tree.delete") }}</button>
                    </span>
                  </div>
                  <ul v-if="isOpen(collection)">
                    <li v-for="api in collection.children?.filter((c) => c.kind === 'api')" :key="api.id">
                      <div class="node leaf" data-testid="tree-api-row">
                        <button class="api-btn" data-testid="tree-api" :data-node-id="api.id" @click="selectApi(api)">
                          <span class="method">{{ api.method }}</span>{{ api.label }}
                        </button>
                        <span class="actions">
                          <button class="act" data-testid="node-rename" @click="startRename(api)">{{ t("tree.rename") }}</button>
                          <button class="act danger" data-testid="node-delete" @click="startDelete(api)">{{ t("tree.delete") }}</button>
                        </span>
                      </div>
                    </li>
                    <li v-for="folder in collection.children?.filter((c) => c.kind === 'folder')" :key="folder.id">
                      <div class="node">
                        <button class="toggle" data-testid="tree-group-toggle" @click="toggle(folder)">{{ isOpen(folder) ? "▾" : "▸" }}</button>
                        <span class="label">{{ folder.label }}</span>
                        <span class="actions">
                          <button class="act" data-testid="new-api" @click="startCreate(folder, 'api')">{{ t("tree.newApi") }}</button>
                          <button class="act" data-testid="node-rename" @click="startRename(folder)">{{ t("tree.rename") }}</button>
                          <button class="act danger" data-testid="node-delete" @click="startDelete(folder)">{{ t("tree.delete") }}</button>
                        </span>
                      </div>
                      <ul v-if="isOpen(folder)">
                        <li v-for="api in folder.children" :key="api.id">
                          <div class="node leaf" data-testid="tree-api-row">
                            <button class="api-btn" data-testid="tree-api" :data-node-id="api.id" @click="selectApi(api)">
                              <span class="method">{{ api.method }}</span>{{ api.label }}
                            </button>
                            <span class="actions">
                              <button class="act" data-testid="node-rename" @click="startRename(api)">{{ t("tree.rename") }}</button>
                              <button class="act danger" data-testid="node-delete" @click="startDelete(api)">{{ t("tree.delete") }}</button>
                            </span>
                          </div>
                        </li>
                      </ul>
                    </li>
                  </ul>
                </li>
              </ul>
            </li>
          </ul>
        </li>
      </ul>
    </template>
    <ConfirmDialog
      :open="dialog.open"
      :title="dialog.title"
      :input-placeholder="dialog.placeholder"
      :initial-value="dialog.initialValue"
      @confirm="onDialogConfirm"
      @cancel="closeDialog"
    />
  </aside>
</template>

<style scoped>
.side {
  height: 100%;
  overflow: auto;
  font-size: 13px;
}
.root-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
}
.root-label {
  font-weight: 600;
  color: var(--text-muted);
}
.tree, .tree ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.tree ul { padding-left: 14px; }
.node {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border-radius: 4px;
}
.node:hover { background: var(--panel); }
.toggle {
  border: none;
  background: none;
  color: var(--text-muted);
  cursor: pointer;
  width: 16px;
  padding: 0;
}
.label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.actions {
  margin-left: auto;
  display: none;
  gap: 2px;
}
.node:hover .actions { display: inline-flex; }
.act, .api-btn {
  border: none;
  background: none;
  color: var(--text);
  cursor: pointer;
  font-size: 11px;
  padding: 1px 4px;
  border-radius: 3px;
}
.act.danger { color: var(--fail); }
.act:hover { background: var(--border); }
.api-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  padding: 2px 4px;
  min-width: 0;
  text-align: left;
}
.api-btn:hover { background: var(--border); }
.method {
  font-size: 10px;
  font-weight: 600;
  color: var(--accent);
}
</style>
