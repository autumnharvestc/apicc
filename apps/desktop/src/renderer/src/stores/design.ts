import { createPinia, defineStore } from "pinia";
import type { ApiccApi } from "../../../shared/types.js";
import type { useEditorStore } from "./editor.js";

type Editor = ReturnType<typeof useEditorStore>;

/**
 * 详细设计 store 工厂（任务 8）：状态 { content, dirty }。content 是组件内编辑缓冲：
 * load() 从 editor.api.design 水合（简报 load(api) 的 api 即 editor.api——store 已注入
 * editor，故免传参）；setContent(text) 置 dirty；save() 写回 editor.api.design 并委托
 * editor.save()（apiSave 持久化 + 复位 dirty 快照）；exportMarkdown() 调
 * api.designExport(apiId)（主进程 renderDesignMarkdown + showSaveDialog）返回保存路径
 * （用户取消对话框时为主进程回传的空串）。每次工厂调用绑定独立 Pinia 实例。
 */
export function useDesignStore(api: ApiccApi, editor: Editor) {
  return defineStore("design", {
    state: () => ({ content: "", dirty: false }),
    actions: {
      load() {
        this.content = editor.api?.design ?? "";
        this.dirty = false;
      },
      setContent(text: string) {
        this.content = text;
        this.dirty = true;
      },
      async save() {
        if (!editor.api) return;
        editor.api.design = this.content;
        await editor.save();
        this.dirty = false;
      },
      async exportMarkdown(): Promise<string> {
        if (!editor.apiId) return "";
        return api.designExport(editor.apiId);
      },
    },
  })(createPinia());
}
