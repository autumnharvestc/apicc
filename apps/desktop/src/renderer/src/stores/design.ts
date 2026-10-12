import { createPinia, defineStore } from "pinia";
import type { ApiccApi } from "../../../shared/types.js";
import type { useEditorStore } from "./editor.js";

type Editor = ReturnType<typeof useEditorStore>;
interface DesignDraft { content: string; snapshot: string; generation: number; editorGeneration: number }

/** Documentation editor drafts are keyed by the active editor's complete session identity. */
export function useDesignStore(api: ApiccApi, editor: Editor) {
  return defineStore("design", {
    state: () => ({
      content: "",
      snapshot: "",
      activeKey: null as string | null,
      drafts: {} as Record<string, DesignDraft>,
      generation: 0,
    }),
    getters: {
      dirty(): boolean { return this.content !== this.snapshot; },
    },
    actions: {
      load(): void {
        const key = editor.activeKey;
        const asset = editor.api;
        const previousKey = this.activeKey;
        const previousDraft = previousKey ? this.drafts[previousKey] : undefined;
        const previousSession = previousKey ? editor.sessions[previousKey] : undefined;
        if (previousKey && (!previousSession || previousDraft?.editorGeneration !== previousSession.generation)) {
          delete this.drafts[previousKey];
        }
        if (!key || !asset) {
          this.activeKey = null;
          this.content = "";
          this.snapshot = "";
          return;
        }
        const session = editor.sessions[key];
        if (!session) {
          this.activeKey = null;
          this.content = "";
          this.snapshot = "";
          return;
        }
        this.activeKey = key;
        let draft: DesignDraft | undefined = this.drafts[key];
        if (draft && draft.editorGeneration !== session.generation) {
          delete this.drafts[key];
          draft = undefined;
        }
        if (draft) {
          this.content = draft.content;
          this.snapshot = draft.snapshot;
          return;
        }
        const content = asset.documentation;
        const created = { content, snapshot: content, generation: ++this.generation, editorGeneration: session.generation };
        this.drafts[key] = created;
        this.content = content;
        this.snapshot = content;
      },

      setContent(text: string): void {
        const key = this.activeKey;
        if (!key) throw new Error("未加载接口设计文档");
        this.content = text;
        const draft = this.drafts[key];
        if (draft) draft.content = text;
      },

      async save(): Promise<void> {
        const key = this.activeKey;
        const locator = editor.locator;
        const session = key ? editor.sessions[key] : undefined;
        const draft = key ? this.drafts[key] : undefined;
        if (!key || !locator || !session || !draft) return;
        if (editor.activeKey !== key) throw new Error("接口已切换，请先重新加载设计文档");
        if (editor.readOnly) throw new Error("工作区处于只读模式，不能保存设计文档");
        const generation = draft.generation;
        const editorGeneration = session.generation;
        const submittedContent = this.content;
        const submittedSnapshot = submittedContent;
        const activeAsset = editor.api;
        if (!activeAsset) return;
        activeAsset.documentation = submittedContent;
        await editor.save();
        const originalDraft = this.drafts[key];
        if (editor.sessions[key]?.generation === editorGeneration
          && originalDraft?.generation === generation
          && originalDraft.editorGeneration === editorGeneration) {
          originalDraft.snapshot = submittedSnapshot;
          this.snapshot = this.activeKey === key ? submittedSnapshot : this.snapshot;
        }
      },

      async exportMarkdown(): Promise<string> {
        const locator = editor.locator;
        if (!locator) return "";
        return api.designExport(locator);
      },
    },
  })(createPinia());
}
