<script setup lang="ts">
// 组合根（装配约定）：store 工厂每调用一次即新建独立 Pinia 实例、得到互不相通的
// 状态副本——因此全部 store 只能在此一次性创建，再经 props 向下传递；
// SideTree/RequestEditor/TopBar 等组件内部禁止重复调用工厂。
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { apicc } from "./api";
import type { TreeNodeDTO } from "../../shared/tree-dto.js";
import TopBar from "./components/TopBar.vue";
import SideTree from "./components/SideTree.vue";
import RequestEditor from "./components/RequestEditor.vue";
import ResponseViewer from "./components/ResponseViewer.vue";
import { useWorkspaceStore } from "./stores/workspace.js";
import { useTreeStore } from "./stores/tree.js";
import { useEditorStore } from "./stores/editor.js";
import { useDebugStore } from "./stores/debug.js";

const { t } = useI18n();
const workspace = useWorkspaceStore(apicc);
const tree = useTreeStore(apicc, workspace);
const editor = useEditorStore(apicc);
const debug = useDebugStore(apicc);

// —— 最小错误反馈通道（宽审查 I1）——
// SideTree/TopBar 链路的 Promise 拒绝统一转报到这里，集中展示、可手动关闭，
// 不再作为未处理的 rejection 被静默吞没。
const errorMessage = ref("");

function reportError(e: unknown) {
  errorMessage.value = e instanceof Error ? e.message : String(e);
}

function dismissError() {
  errorMessage.value = "";
}

/** 侧树选中回调：接口节点加载进编辑器，其余节点仅记录选中态。 */
async function onSelect(kind: TreeNodeDTO["kind"], id: string) {
  tree.select(kind, id);
  if (kind === "api") await editor.load(id);
}
</script>

<template>
  <div class="app" data-testid="app-root">
    <TopBar :workspace="workspace" :api="apicc" :report-error="reportError" />
    <div v-if="errorMessage" class="app-error" data-testid="app-error">
      <span class="app-error-text">{{ t("app.error") }}: {{ errorMessage }}</span>
      <button data-testid="app-error-close" @click="dismissError">{{ t("common.close") }}</button>
    </div>
    <div class="main">
      <SideTree class="side-col" :workspace="workspace" :tree="tree" :report-error="reportError" @select="onSelect" />
      <div class="right-col" data-testid="main-split">
        <div class="editor-pane" data-testid="editor-pane">
          <RequestEditor :editor="editor" :debug="debug" />
        </div>
        <div class="viewer-pane" data-testid="viewer-pane">
          <ResponseViewer :result="debug.result" :sending="debug.sending" :error="debug.error" />
        </div>
      </div>
    </div>
  </div>
</template>

<style>
html, body, #app { height: 100%; margin: 0; }
.app { display: flex; flex-direction: column; height: 100%; background: var(--bg); color: var(--text); }
.app-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
  color: var(--fail);
  font-size: 12px;
}
.app-error-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.app-error button {
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
  font-size: 11px;
}
.main { display: flex; flex: 1; min-height: 0; }
.side-col {
  width: 240px; /* 左树固定宽 */
  flex: none;
  border-right: 1px solid var(--border);
}
.right-col { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.editor-pane { flex: 1; min-height: 0; overflow: auto; }
.viewer-pane { flex: none; max-height: 45%; overflow: auto; border-top: 1px solid var(--border); }
</style>
