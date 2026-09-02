<script setup lang="ts">
// 组合根（装配约定）：store 工厂每调用一次即新建独立 Pinia 实例、得到互不相通的
// 状态副本——因此全部 store 只能在此一次性创建，再经 props 向下传递；
// SideTree/RequestEditor/TopBar 等组件内部禁止重复调用工厂。
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

const workspace = useWorkspaceStore(apicc);
const tree = useTreeStore(apicc, workspace);
const editor = useEditorStore(apicc);
const debug = useDebugStore(apicc);

/** 侧树选中回调：接口节点加载进编辑器，其余节点仅记录选中态。 */
async function onSelect(kind: TreeNodeDTO["kind"], id: string) {
  tree.select(kind, id);
  if (kind === "api") await editor.load(id);
}
</script>

<template>
  <div class="app" data-testid="app-root">
    <TopBar :workspace="workspace" :api="apicc" />
    <div class="main">
      <SideTree class="side-col" :workspace="workspace" :tree="tree" @select="onSelect" />
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
