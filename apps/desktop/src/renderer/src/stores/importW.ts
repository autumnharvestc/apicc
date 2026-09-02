import { createPinia, defineStore } from "pinia";
import type { ApiccApi, ImportPreviewResult } from "../../../shared/types.js";

/**
 * 导入向导 store 工厂（任务 7）：状态 { preview, applying }。previewFile 调
 * api.importPreview 并把返回结构入状态；apply 调 api.importApply（主进程侧缺分组
 * 建组、同分组重名拒绝）成功后触发 workspace.refresh——workspace 经工厂第二参注入
 * （组合根装配；不注入则跳过刷新，测试传新实例即天然隔离）。每次工厂调用绑定独立
 * Pinia 实例，与其余 store 工厂同约定。
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
      async apply(groupName: string): Promise<void> {
        if (!this.preview) throw new Error("尚无预览结果，无法导入");
        this.applying = true;
        try {
          await api.importApply({ groupName, project: this.preview.project });
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
