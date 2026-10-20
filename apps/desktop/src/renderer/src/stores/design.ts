import { createPinia, defineStore } from "pinia";
import { watch } from "vue";
import type { ApiccApi } from "../../../shared/types.js";
import type { DesignPreviewResult } from "../../../shared/design.js";
import type { useEditorStore } from "./editor.js";
import type { DocumentScope } from "@apicc/core";

type Editor = ReturnType<typeof useEditorStore>;
interface DesignDraft { content: string; snapshot: string; generation: number; editorGeneration: number }
export interface DesignControlDraft { value: string; error: string }

function sessionIdentity(session: NonNullable<Editor["sessions"][string]>): string {
  const locator = session.locator;
  return JSON.stringify([session.root, locator.workspaceId, locator.groupId, locator.projectId,
    locator.collectionId, locator.folderIds, locator.apiId, session.generation]);
}

function effectiveDraftVersion(
  session: NonNullable<Editor["sessions"][string]>,
  content: string,
): string {
  return JSON.stringify([sessionIdentity(session), { ...session.api, documentation: content }]);
}

function previewInputVersion(
  session: NonNullable<Editor["sessions"][string]>,
  content: string,
  controlDrafts: Record<string, DesignControlDraft>,
): string {
  return JSON.stringify([effectiveDraftVersion(session, content), controlDrafts]);
}

/** Documentation editor drafts are keyed by the active editor's complete session identity. */
export function useDesignStore(api: ApiccApi, editor: Editor) {
  const store = defineStore("design", {
    state: () => ({
      content: "",
      snapshot: "",
      activeKey: null as string | null,
      drafts: {} as Record<string, DesignDraft>,
      generation: 0,
      sessionIdentity: null as string | null,
      controlDrafts: {} as Record<string, Record<string, DesignControlDraft>>,
      previewStatus: "idle" as "idle" | "loading" | "ready" | "invalid" | "conflict",
      previewResult: null as DesignPreviewResult | null,
      previewError: "",
      previewGeneration: 0,
    }),
    getters: {
      dirty(): boolean { return this.content !== this.snapshot || Object.keys(this.activeControlDrafts).length > 0; },
      contentVersion(): string {
        const key = editor.activeKey;
        const session = key ? editor.sessions[key] : undefined;
        return session ? previewInputVersion(session, this.content, this.activeControlDrafts) : "";
      },
      committedContentVersion(): string {
        const key = editor.activeKey;
        const session = key ? editor.sessions[key] : undefined;
        return session ? effectiveDraftVersion(session, this.content) : "";
      },
      activeControlDrafts(): Record<string, DesignControlDraft> {
        return this.sessionIdentity ? this.controlDrafts[this.sessionIdentity] ?? {} : {};
      },
      hasInvalidControls(): boolean {
        return Object.values(this.activeControlDrafts).some((draft) => !!draft.error);
      },
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
          this.sessionIdentity = null;
          this.content = "";
          this.snapshot = "";
          this.invalidatePreview();
          return;
        }
        const session = editor.sessions[key];
        if (!session) {
          this.activeKey = null;
          this.sessionIdentity = null;
          this.content = "";
          this.snapshot = "";
          this.invalidatePreview();
          return;
        }
        const nextIdentity = sessionIdentity(session);
        if (this.sessionIdentity !== nextIdentity) {
          this.sessionIdentity = nextIdentity;
          this.invalidatePreview();
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

      setControlDraft(path: string, value: string, error: string | null): void {
        const identity = this.sessionIdentity;
        if (!identity || !path) return;
        const drafts = { ...(this.controlDrafts[identity] ?? {}) };
        if (error === null && value === "") delete drafts[path];
        else drafts[path] = { value, error: error ?? "" };
        this.controlDrafts[identity] = drafts;
      },

      clearControlDrafts(prefix: string): void {
        const identity = this.sessionIdentity;
        const existing = identity ? this.controlDrafts[identity] : undefined;
        if (!identity || !existing || !prefix) return;
        const next = { ...existing };
        for (const path of Object.keys(next)) {
          if (path === prefix || path.startsWith(`${prefix}.`)) delete next[path];
        }
        this.controlDrafts[identity] = next;
      },

      moveControlDrafts(fromPrefix: string, toPrefix: string): void {
        const identity = this.sessionIdentity;
        const existing = identity ? this.controlDrafts[identity] : undefined;
        if (!identity || !existing || !fromPrefix || !toPrefix || fromPrefix === toPrefix) return;
        const moved = Object.entries(existing).filter(([path]) => path === fromPrefix || path.startsWith(`${fromPrefix}.`));
        if (moved.length === 0) return;
        const next = { ...existing };
        for (const [path] of moved) delete next[path];
        for (const [path, draft] of moved) next[`${toPrefix}${path.slice(fromPrefix.length)}`] = draft;
        this.controlDrafts[identity] = next;
      },

      hasControlDrafts(session: NonNullable<Editor["sessions"][string]>): boolean {
        return Object.keys(this.controlDrafts[sessionIdentity(session)] ?? {}).length > 0;
      },

      evictControlDrafts(session: NonNullable<Editor["sessions"][string]>): void {
        delete this.controlDrafts[sessionIdentity(session)];
      },

      invalidatePreview(): void {
        this.previewGeneration += 1;
        this.previewStatus = "idle";
        this.previewResult = null;
        this.previewError = "";
      },

      async preview(): Promise<void> {
        const key = editor.activeKey;
        const session = key ? editor.sessions[key] : undefined;
        const identity = session ? sessionIdentity(session) : null;
        if (!key || !session || !identity || this.sessionIdentity !== identity) return;
        const requestGeneration = ++this.previewGeneration;
        const requestContentVersion = this.contentVersion;
        this.previewStatus = "loading";
        this.previewResult = null;
        this.previewError = "";
        if (Object.values(this.controlDrafts[identity] ?? {}).some((draft) => !!draft.error)) {
          this.previewStatus = "invalid";
          this.previewError = "请先修正无效的 JSON 输入";
          return;
        }
        const current = () => editor.activeKey === key
          && editor.sessions[key]?.generation === session.generation
          && this.sessionIdentity === identity
          && this.contentVersion === requestContentVersion
          && this.previewGeneration === requestGeneration;
        const previewState = this as unknown as {
          previewResult: DesignPreviewResult | null;
          previewStatus: "idle" | "loading" | "ready" | "invalid" | "conflict";
          previewError: string;
        };
        try {
          const result = await api.designPreview({
            sourceRoot: session.root,
            locator: { ...session.locator, folderIds: [...session.locator.folderIds] },
            sourceProjectRevision: session.sourceProjectRevision,
            assetDraft: { ...JSON.parse(JSON.stringify(session.api)) as Record<string, unknown>, documentation: this.content },
          });
          if (!current()) return;
          previewState.previewResult = result;
          previewState.previewStatus = result.status;
        } catch (error) {
          if (!current()) return;
          previewState.previewResult = null;
          previewState.previewStatus = "invalid";
          previewState.previewError = error instanceof Error ? error.message : String(error);
        }
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
        const controlDraftIdentity = sessionIdentity(session);
        const submittedControlDrafts = { ...(this.controlDrafts[controlDraftIdentity] ?? {}) };
        const submittedContent = this.content;
        const submittedSnapshot = submittedContent;
        const activeAsset = editor.api;
        if (!activeAsset) return;
        activeAsset.documentation = submittedContent;
        await editor.save();
        const originalDraft = this.drafts[key];
        if (editor.sessions[key]?.generation === editorGeneration) {
          if (originalDraft?.generation === generation && originalDraft.editorGeneration === editorGeneration) {
            originalDraft.snapshot = submittedSnapshot;
            this.snapshot = this.activeKey === key ? submittedSnapshot : this.snapshot;
          }
          const currentControlDrafts = this.controlDrafts[controlDraftIdentity];
          if (currentControlDrafts) {
            const remaining = { ...currentControlDrafts };
            for (const [path, submitted] of Object.entries(submittedControlDrafts)) {
              const current = remaining[path];
              if (submitted.error === "" && current?.value === submitted.value && current.error === submitted.error) {
                delete remaining[path];
              }
            }
            if (Object.keys(remaining).length > 0) this.controlDrafts[controlDraftIdentity] = remaining;
            else delete this.controlDrafts[controlDraftIdentity];
          }
        }
      },

      async exportDocument(
        format: "markdown" | "html" | "openapi-3.0" | "openapi-3.1",
        scope: DocumentScope,
        options?: { encoding?: "json" | "yaml"; infoVersion?: string },
      ): Promise<string> {
        const key = editor.activeKey;
        const session = key ? editor.sessions[key] : undefined;
        const locator = editor.locator;
        if (!locator || !session) return "";
        return api.designExport({
          sourceRoot: session.root,
          locator: { ...locator, folderIds: [...locator.folderIds] },
          format,
          ...options,
          scope,
        });
      },
    },
  })(createPinia());

  editor.registerFullAssetSaveGuard((session) => {
    const identity = sessionIdentity(session);
    const invalid = Object.values(store.controlDrafts[identity] ?? {}).some((draft) => !!draft.error);
    if (invalid) throw new Error("存在无效的 JSON 输入，请修正后再保存");
  });

  // Invalidate synchronously on every visit boundary (including A→B→A), not just when
  // a view watcher eventually calls load().
  watch(() => {
    const key = editor.activeKey;
    const session = key ? editor.sessions[key] : undefined;
    return session ? sessionIdentity(session) : null;
  }, (identity) => {
    if (store.sessionIdentity !== identity) {
      store.sessionIdentity = identity;
      store.invalidatePreview();
    }
  }, { flush: "sync", immediate: true });

  watch(() => store.contentVersion, (version, previous) => {
    if (previous !== undefined && version !== previous) store.invalidatePreview();
  }, { flush: "sync" });

  return store;
}
