import { createPinia, defineStore } from "pinia";
import type { ApiccApi, ImportApplyInput, ImportPreviewResult } from "../../../shared/types.js";

/** apply 落点（轨二双模式）：project=分组 id；module=目标项目 id。name 均可编辑（预填 title）。 */
export type ImportTarget = { mode: "project"; groupId: string; name: string } | { mode: "module"; projectId: string; name: string };

/**
 * 导入向导 store 工厂（任务 7；轨二双模式）：状态 { preview, applying }。previewFile 调
 * api.importPreview 并把返回结构入状态；apply 组入预览产出的 project 调 api.importApply
 * （project=整包落到所选分组；module=集合并入目标项目、baseUrl 进模块变量）成功后触发
 * workspace.refresh——workspace 经工厂第二参注入（组合根装配；不注入则跳过刷新，测试传
 * 新实例即天然隔离）。每次工厂调用绑定独立 Pinia 实例，与其余 store 工厂同约定。
 */
export function useImportWizardStore(api: ApiccApi, workspace?: { refresh(): Promise<void> }) {
  return defineStore("importW", {
    state: () => ({
      preview: null as ImportPreviewResult | null,
      applying: false,
    }),
    actions: {
      async previewFile(fileName: string, content: string): Promise<ImportPreviewResult> {
        this.preview = await api.importPreview({ fileName, content });
        return this.preview;
      },
      async apply(target: ImportTarget): Promise<void> {
        if (!this.preview) throw new Error("尚无预览结果，无法导入");
        this.applying = true;
        try {
          const input: ImportApplyInput = { ...target, project: this.preview.project };
          await api.importApply(input);
          if (workspace) await workspace.refresh();
        } finally {
          this.applying = false;
        }
      },
      // 取消向导：清空预览，组件回到第一步。
      reset() {
        this.preview = null;
      },
    },
  })(createPinia());
}
