import { createPinia, defineStore } from "pinia";
import type { ApiccApi, DebugInput, DebugOutput } from "../../../shared/types.js";
import type { useEditorStore } from "./editor.js";

type Editor = ReturnType<typeof useEditorStore>;
type SendFn = (input: DebugInput) => Promise<DebugOutput>;

/**
 * 调试 store 工厂：接受依赖 api 参数，每次工厂调用绑定独立 Pinia 实例。
 * send 前自动保存脏编辑（发送即保存），sendFn 默认走 api.debugSend、测试可注入替身；
 * 失败时错误信息可见，sending 无论成败都在 finally 复位。
 */
export function useDebugStore(api: ApiccApi) {
  return defineStore("debug", {
    state: () => ({ sending: false, result: null as DebugOutput | null, error: null as string | null }),
    actions: {
      async send(editor: Editor, sendFn: SendFn = (input) => api.debugSend(input), envName?: string) {
        if (!editor.api || !editor.api.cases[0]) return;
        this.sending = true;
        this.error = null;
        try {
          if (editor.dirty) await editor.save();
          this.result = await sendFn({ apiId: editor.api.id, caseId: editor.api.cases[0].id, envName });
        } catch (e) {
          this.error = e instanceof Error ? e.message : String(e);
        } finally {
          this.sending = false;
        }
      },
    },
  })(createPinia());
}
