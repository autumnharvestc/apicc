import { createPinia, defineStore } from "pinia";
import { shallowRef } from "vue";
import type { ApiccApi, ImportApplyResult, ImportPlanInput, ImportPlanResult, ImportPreviewResult } from "../../../shared/types.js";
import type { CollectionLocator, GroupLocator, ProjectLocator } from "../../../shared/locations.js";

/** apply 落点（轨二双模式）：project=分组 id；module=目标项目 id。name 均可编辑（预填 title）。 */
export type ImportTarget =
  | { mode: "project"; target: GroupLocator; name: string }
  | { mode: "module"; target: ProjectLocator; name: string; sourceEnvironmentOptionToken?: string }
  | { mode: "merge"; target: CollectionLocator; sourceCollectionIds: string[]; decisions: ImportPlanInput extends infer _ ? Record<string, { action: "skip" | "rename" | "overwrite" | "cancel"; targetApiId?: string; name?: string }> : never };

export interface ImportContextToken {
  generation: number;
  root: string;
  workspaceId: string | null;
  readOnly: boolean;
}

/**
 * Parsed candidates remain in the main process. The renderer retains only opaque preview/plan
 * tokens and public summaries; a committed write is never repeated because a later refresh failed.
 */
export function useImportWizardStore(api: ApiccApi, workspace?: {
  refresh(): Promise<void>;
  root: string;
  readOnly: boolean;
  tree: { locator: { workspaceId: string } } | null;
}) {
  let previewGeneration = 0;
  let applyingGeneration = 0;
  const currentContext = (): Omit<ImportContextToken, "generation"> => ({
    root: workspace?.root ?? "",
    workspaceId: workspace?.tree?.locator.workspaceId ?? null,
    readOnly: workspace?.readOnly ?? false,
  });
  const contextIsCurrent = (token: ImportContextToken): boolean => {
    const current = currentContext();
    return token.generation === previewGeneration
      && token.root === current.root
      && token.workspaceId === current.workspaceId
      && token.readOnly === current.readOnly;
  };
  const contextLocationIsCurrent = (token: ImportContextToken): boolean => {
    const current = currentContext();
    return token.generation === previewGeneration
      && token.root === current.root
      && token.workspaceId === current.workspaceId;
  };
  return defineStore("importW", {
    state: () => ({
      // 预览产物在一次解析后作为整体替换；浅持有避免 Pinia 深度解包递归契约图。
      preview: shallowRef<ImportPreviewResult | null>(null),
      previewContext: null as ImportContextToken | null,
      plan: shallowRef<ImportPlanResult | null>(null),
      applyResult: null as ImportApplyResult | null,
      planTargetKey: "",
      refreshError: "",
      applying: false,
    }),
    getters: {
      previewIsCurrent(): boolean {
        return this.previewContext !== null && contextIsCurrent(this.previewContext);
      },
    },
    actions: {
      capturePreviewContext(): ImportContextToken {
        const generation = ++previewGeneration;
        this.preview = null;
        this.previewContext = null;
        this.plan = null;
        this.applyResult = null;
        this.planTargetKey = "";
        this.refreshError = "";
        return { generation, ...currentContext() };
      },
      async previewFile(fileName: string, content: string, captured?: ImportContextToken): Promise<ImportPreviewResult> {
        const context = captured ?? this.capturePreviewContext();
        if (!contextIsCurrent(context)) throw new Error("工作区已变更，预览已取消");
        const preview: ImportPreviewResult = await api.importPreview({ fileName, content });
        if (!contextIsCurrent(context)) throw new Error("工作区已变更，预览已取消");
        this.preview = preview;
        this.previewContext = context;
        this.plan = null;
        this.applyResult = null;
        this.planTargetKey = "";
        return preview;
      },
      isPreviewContextCurrent(context: ImportContextToken): boolean {
        return contextIsCurrent(context);
      },
      async makePlan(target: ImportTarget): Promise<ImportPlanResult> {
        if (!this.preview || !this.previewContext) throw new Error("尚无预览结果，无法生成计划");
        const context = this.previewContext;
        if (!contextLocationIsCurrent(context)) throw new Error("工作区已变更，预览已取消");
        if (context.readOnly || (workspace?.readOnly ?? false)) throw new Error("工作区处于只读模式，不能导入");
        const plan = await api.importPlan({ ...target, previewToken: this.preview.token } as ImportPlanInput);
        if (!contextLocationIsCurrent(context)) throw new Error("工作区已变更，导入计划已取消");
        this.plan = plan;
        this.planTargetKey = JSON.stringify(target);
        return plan;
      },
      async apply(target: ImportTarget, allowLossy = false): Promise<ImportApplyResult> {
        if (!this.preview || !this.previewContext) throw new Error("尚无预览结果，无法导入");
        if (this.applyResult) throw new Error("该导入已提交；请刷新或撤销，不要重复应用。");
        const context = this.previewContext;
        if (!contextLocationIsCurrent(context)) throw new Error("工作区已变更，预览已取消");
        if (context.readOnly || (workspace?.readOnly ?? false)) throw new Error("工作区处于只读模式，不能导入");
        if (context.workspaceId !== null && target.target.workspaceId !== context.workspaceId) {
          throw new Error("导入目标不属于当前工作区");
        }
        const generation = ++applyingGeneration;
        this.applying = true;
        try {
          let plan = this.plan;
          if (!plan || this.planTargetKey !== JSON.stringify(target)) plan = await this.makePlan(target);
          if (!contextIsCurrent(context)) throw new Error("工作区已变更，导入计划已取消");
          if (plan.diagnostics.some((item) => item.severity === "error")) throw new Error("导入计划包含结构或引用错误，不能应用。");
          if (plan.diagnostics.some((item) => item.lossy) && !allowLossy) throw new Error("导入包含语义损失，需要显式确认。");
          const result = await api.importApply({ planToken: plan.token, allowLossy });
          if (generation !== applyingGeneration || !contextIsCurrent(context)) {
            throw new Error("工作区已变更，导入已在原上下文处理；当前向导不会重试或刷新其他工作区。");
          }
          this.applyResult = result;
          if (result.committed && workspace) {
            try {
              await workspace.refresh();
              this.refreshError = "";
            } catch (error) {
              this.refreshError = error instanceof Error ? error.message : String(error);
            }
          }
          return result;
        } finally {
          if (generation === applyingGeneration) this.applying = false;
        }
      },
      async refreshAfterCommit(): Promise<void> {
        if (!this.applyResult?.committed || !workspace) return;
        try {
          await workspace.refresh();
          this.refreshError = "";
        } catch (error) {
          this.refreshError = error instanceof Error ? error.message : String(error);
          throw error;
        }
      },
      async undo(): Promise<void> {
        if (!this.applyResult?.undoToken) throw new Error("没有可用的本次会话撤销句柄。");
        await api.importUndo({ undoToken: this.applyResult.undoToken });
        this.applyResult = { committed: false, summary: this.applyResult.summary };
        if (workspace) await workspace.refresh();
      },
      // 取消向导：清空预览，组件回到第一步。
      reset() {
        previewGeneration += 1;
        applyingGeneration += 1;
        this.preview = null;
        this.previewContext = null;
        this.plan = null;
        this.applyResult = null;
        this.planTargetKey = "";
        this.refreshError = "";
        this.applying = false;
      },
    },
  })(createPinia());
}
