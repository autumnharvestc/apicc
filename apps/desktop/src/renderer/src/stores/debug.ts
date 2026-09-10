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
 * 计划 C 任务 4：result 按 apiId 表化驻留——results: Record<apiId, DebugOutput>，send
 * 写发送时接口的槽；result getter 按活跃接口读（注入 editor 依赖时跟随 editor.activeApiId，
 * 未注入回落最近发送槽——旧装配面兼容）。切项目（setProject）不清其他接口结果。
 */
export function useDebugStore(api: ApiccApi, editor?: Editor) {
  return defineStore("debug", {
    state: () => ({
      sending: false,
      /** 调试结果驻留表（key = apiId）：切接口/切项目签零丢失（计划全局不变量 2）。 */
      results: {} as Record<string, DebugOutput>,
      /** 最近发送的接口 id：未注入 editor 依赖时 result getter 的回落键（兼容面）。 */
      lastResultApiId: null as string | null,
      error: null as string | null,
      // 环境选中态项目记忆（M10）：envByProject[projectId] = 该项目上次选的环境名；
      // activeProjectId 由组合根随项目切换写入。调试与压测共享同一状态源。
      activeProjectId: null as string | null,
      envByProject: {} as Record<string, string | null>,
      selectedEnvName: null as string | null,
      selectedCaseId: null as string | null,
    }),
    getters: {
      /**
       * 活跃接口的调试结果（驻留表按活跃 apiId 取槽；无则 null）。
       * 注入 editor 依赖 → 跟随 editor 活跃接口（组合根装配：useDebugStore(api, editor)）。
       */
      result(state): DebugOutput | null {
        const apiId = editor ? editor.activeApiId : state.lastResultApiId;
        return apiId !== null ? state.results[apiId] ?? null : null;
      },
      /** 当前项目的环境选中（项目未激活或该项目从未选择过 = null/「无环境」）。 */
      projectEnvName(state): string | null {
        return state.activeProjectId ? state.envByProject[state.activeProjectId] ?? null : null;
      },
    },
    actions: {
      /** 项目切换（M10）：activeProjectId 换挡；selectedEnvName 同步为该项目记忆值。
       *  结果驻留表不清（任务 4：切项目不清其他项目结果，驻留键是接口而非项目）。 */
      setProject(projectId: string | null) {
        this.activeProjectId = projectId;
        this.selectedEnvName = projectId ? this.envByProject[projectId] ?? null : null;
      },
      selectEnv(name: string | null) {
        this.selectedEnvName = name;
        if (this.activeProjectId) this.envByProject[this.activeProjectId] = name;
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
        const apiId = editor.apiId;
        this.sending = true;
        this.error = null;
        try {
          if (editor.dirty) await editor.save();
          // 载荷用已捕获的 apiId（任务 4 审查移交的一行修）：await save() 期间若编辑器
          // 切换槽位，editor.api.id 已是新槽——按它发请求会把结果存错槽
          const output = await sendFn({ apiId: apiId!, caseId, envName });
          this.results[apiId!] = output; // 驻留到发送时接口的槽（apiId 已由上方 editor.api 守卫非空）
          this.lastResultApiId = apiId;
        } catch (e) {
          this.error = e instanceof Error ? e.message : String(e);
        } finally {
          this.sending = false;
        }
      },
    },
  })(createPinia());
}
