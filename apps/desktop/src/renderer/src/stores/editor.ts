import { createPinia, defineStore } from "pinia";
import type { ApiDefinition } from "@apicc/core";
import type { ApiccApi } from "../../../shared/types.js";

/**
 * 本地编辑器驻留会话（计划 C 任务 4 会话表化）：api 编辑缓冲 + 环境清单 + 已保存快照，
 * 按接口 id 表化驻留——切签/切接口零丢失零确认（计划全局不变量 2：草稿按 apiId 驻留）。
 */
export interface EditorSession {
  api: ApiDefinition | null;
  envs: Array<{ id: string; name: string }>;
  snapshot: string;
}

/** 活跃会话定位（getter/action 共用的表语义中枢，先例同 online.ts activeSessionOf）。 */
function activeSessionOf(state: { sessions: Record<string, EditorSession>; activeApiId: string | null }): EditorSession | null {
  return state.activeApiId !== null ? state.sessions[state.activeApiId] ?? null : null;
}

/**
 * 编辑器 store 工厂：接受依赖 api 参数，每次工厂调用绑定独立 Pinia 实例。
 * 计划 C 任务 4 会话表化：状态从单会话 {apiId, api, envs, snapshot} 改为
 * sessions: Record<apiId, EditorSession> + activeApiId 活跃指针；load 定位槽（无则拉取
 * 建槽，已驻留仅切指针——草稿不被服务端内容覆盖）、save/reloadEnvs 写活跃槽；对外
 * getters（apiId/api/envs/snapshot/dirty）转发活跃槽——消费者 cases/design/debug/ai
 * 与 RequestEditor 零改动（嵌套字段直接改 api 对象仍由快照比对跟踪）。
 * 历史口径（保留）：dirty 为「当前 api 与已保存快照比对」的 getter 派生——测试与组件
 * 直接改 api 字段（不经 action）也能被跟踪；load/save 后重写快照即复位。M5-B（裁定 A，
 * D2）：api 即 core 的 ApiDefinition；保存载荷经 apiSave → IPC api:save → session.saveApi
 * → fileStorage 白名单落盘。
 */
export function useEditorStore(api: ApiccApi) {
  return defineStore("editor", {
    state: () => ({
      /** 驻留编辑会话表（key = apiId）：草稿随会话驻留，切接口/切项目签不丢。 */
      sessions: {} as Record<string, EditorSession>,
      /** 活跃接口 id；null = 无活跃（编辑区空白）。 */
      activeApiId: null as string | null,
    }),
    getters: {
      apiId(state): string | null {
        return state.activeApiId;
      },
      api(state): ApiDefinition | null {
        return activeSessionOf(state)?.api ?? null;
      },
      envs(state): Array<{ id: string; name: string }> {
        return activeSessionOf(state)?.envs ?? [];
      },
      snapshot(state): string {
        return activeSessionOf(state)?.snapshot ?? "";
      },
      dirty(state): boolean {
        const session = activeSessionOf(state);
        return session !== null && session.api !== null && JSON.stringify(session.api) !== session.snapshot;
      },
    },
    actions: {
      /**
       * 载入接口进活跃槽：已驻留 → 仅切活跃指针（定位槽，不重拉——回切草稿原样驻留，
       * 不被服务端内容覆盖）；未驻留 → 拉取建槽并置活跃。
       */
      async load(apiId: string) {
        if (this.sessions[apiId]) {
          this.activeApiId = apiId;
          return;
        }
        const detail = await api.apiGet(apiId);
        this.sessions[apiId] = { api: detail.api, envs: detail.envs, snapshot: JSON.stringify(detail.api) };
        this.activeApiId = apiId;
      },
      /**
       * 环境清单重拉（M9-A1）：调试环境选择器读 editor.envs，但它只在 load（选中接口）
       * 时载入——环境管理里新建/删除环境后选择器不刷新（用户实测 bug）。由组合根在
       * 环境增删后调用，按活跃接口重拉所属项目环境清单；api 快照不动（不标脏）。
       */
      async reloadEnvs() {
        if (!this.activeApiId) return;
        const detail = await api.apiGet(this.activeApiId);
        const session = this.sessions[this.activeApiId];
        if (session) session.envs = detail.envs;
      },
      async save() {
        const session = activeSessionOf(this);
        if (!session?.api) return;
        // Electron IPC 以结构化克隆传参：Pinia/Vue 的响应式 Proxy 无法被克隆
        // （DataCloneError，Electron 冒烟实测），须先深拷贝为普通对象再过 IPC。
        // JSON 往返即可：模型字段全为 string/boolean/number/array/plain object。
        await api.apiSave(JSON.parse(JSON.stringify(session.api)) as ApiDefinition);
        session.snapshot = JSON.stringify(session.api);
      },
      /**
       * 关签驱逐（计划 C 任务 4，不变量 3：关签=项目关闭）：按调用方收集的 apiIds 驱逐
       * 该项目的编辑会话槽；活跃槽被逐则指针复位 null（编辑区空白）。projectId 形参为
       * 驱逐语义标注（apiIds 由组合根按 tree 收集，见 tabs.ts createEvictProjectSessions）。
       */
      evictProject(projectId: string, apiIds: string[]) {
        for (const apiId of apiIds) delete this.sessions[apiId];
        if (this.activeApiId !== null && apiIds.includes(this.activeApiId)) this.activeApiId = null;
      },
    },
  })(createPinia());
}
