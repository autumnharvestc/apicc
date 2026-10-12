import { createPinia, defineStore } from "pinia";
import { shallowRef } from "vue";
import type { ApiccApi, ImportApplyInput, ImportPreviewResult } from "../../../shared/types.js";
import type { GroupLocator, ProjectLocator } from "../../../shared/locations.js";

/** apply 落点（轨二双模式）：project=分组 id；module=目标项目 id。name 均可编辑（预填 title）。 */
export type ImportTarget =
  | { mode: "project"; target: GroupLocator; name: string }
  | { mode: "module"; target: ProjectLocator; name: string; sourceEnvironmentName?: string };

export interface ImportContextToken {
  generation: number;
  root: string;
  workspaceId: string | null;
  readOnly: boolean;
}

/**
 * 导入向导 store 工厂（任务 7；轨二双模式）：状态 { preview, applying }。previewFile 调
 * api.importPreview 并把返回结构入状态；apply 组入预览产出的 project 调 api.importApply
 * （project=整包落到所选分组；module=集合并入目标项目、baseUrl 进模块变量）成功后触发
 * workspace.refresh——workspace 经工厂第二参注入（组合根装配；不注入则跳过刷新，测试传
 * 新实例即天然隔离）。每次工厂调用绑定独立 Pinia 实例，与其余 store 工厂同约定。
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
        return { generation, ...currentContext() };
      },
      async previewFile(fileName: string, content: string, captured?: ImportContextToken): Promise<ImportPreviewResult> {
        const context = captured ?? this.capturePreviewContext();
        if (!contextIsCurrent(context)) throw new Error("工作区已变更，预览已取消");
        const preview: ImportPreviewResult = await api.importPreview({ fileName, content });
        if (!contextIsCurrent(context)) throw new Error("工作区已变更，预览已取消");
        this.preview = preview;
        this.previewContext = context;
        return preview;
      },
      isPreviewContextCurrent(context: ImportContextToken): boolean {
        return contextIsCurrent(context);
      },
      async apply(target: ImportTarget): Promise<void> {
        if (!this.preview || !this.previewContext) throw new Error("尚无预览结果，无法导入");
        const context = this.previewContext;
        if (!contextLocationIsCurrent(context)) throw new Error("工作区已变更，预览已取消");
        if (context.readOnly || (workspace?.readOnly ?? false)) throw new Error("工作区处于只读模式，不能导入");
        if (context.workspaceId !== null && target.target.workspaceId !== context.workspaceId) {
          throw new Error("导入目标不属于当前工作区");
        }
        const generation = ++applyingGeneration;
        this.applying = true;
        try {
          const input: ImportApplyInput = { ...target, project: this.preview.project };
          await api.importApply(input);
          if (!contextIsCurrent(context)) throw new Error("工作区已变更，导入结果未刷新");
          if (workspace) {
            await workspace.refresh();
            if (!contextIsCurrent(context)) throw new Error("工作区已变更，导入结果未刷新");
          }
        } finally {
          if (generation === applyingGeneration) this.applying = false;
        }
      },
      // 取消向导：清空预览，组件回到第一步。
      reset() {
        previewGeneration += 1;
        applyingGeneration += 1;
        this.preview = null;
        this.previewContext = null;
        this.applying = false;
      },
    },
  })(createPinia());
}
