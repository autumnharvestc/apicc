import { createPinia, defineStore } from "pinia";
import type { ApiccApi, DebugInput, DebugOutput } from "../../../shared/types.js";
import type { useEditorStore } from "./editor.js";

type Editor = ReturnType<typeof useEditorStore>;
type SendFn = (input: DebugInput) => Promise<DebugOutput>;

/**
 * 调试 store 工厂：接受依赖 api 参数，每次工厂调用绑定独立 Pinia 实例。
 * send 前自动保存脏编辑（发送即保存），sendFn 默认走 api.debugSend、测试可注入替身；
 * 失败时错误信息可见，sending 无论成败都在 finally 复位。
 * 选择状态（任务 1）：selectedEnvName/selectedCaseId 由调试视图的选择器写入；
 * send 取值——显式传入的 envName 参数优先（既有调用点不受影响），其次 selectedEnvName
 * （须在 editor.envs 中存在，否则回退 undefined）；用例取 selectedCaseId（须在当前
 * 接口 cases 中存在，否则回退 cases[0].id），无用例维持静默 return。
 */
export function useDebugStore(api: ApiccApi) {
  return defineStore("debug", {
    state: () => ({
      sending: false,
      result: null as DebugOutput | null,
      error: null as string | null,
      selectedEnvName: null as string | null,
      selectedCaseId: null as string | null,
    }),
    actions: {
      selectEnv(name: string | null) {
        this.selectedEnvName = name;
      },
      selectCase(id: string | null) {
        this.selectedCaseId = id;
      },
      /** 指定用例运行（M9-D 测试模块）：选中该用例后走既有 send 管线（结果上屏共享）。 */
      async runCase(editor: Editor, caseId: string) {
        this.selectedCaseId = caseId;
        await this.send(editor);
      },
      async send(editor: Editor, sendFn: SendFn = (input) => api.debugSend(input), explicitEnvName?: string) {
        const cases = editor.api?.cases ?? [];
        const caseId =
          this.selectedCaseId && cases.some((c) => c.id === this.selectedCaseId) ? this.selectedCaseId! : cases[0]?.id;
        const envName =
          explicitEnvName ??
          (this.selectedEnvName && (editor.envs ?? []).some((e) => e.name === this.selectedEnvName)
            ? this.selectedEnvName
            : undefined);
        if (!editor.api || !caseId) return;
        this.sending = true;
        this.error = null;
        try {
          if (editor.dirty) await editor.save();
          this.result = await sendFn({ apiId: editor.api.id, caseId, envName });
        } catch (e) {
          this.error = e instanceof Error ? e.message : String(e);
        } finally {
          this.sending = false;
        }
      },
    },
  })(createPinia());
}
