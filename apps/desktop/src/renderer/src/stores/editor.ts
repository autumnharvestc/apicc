import { createPinia, defineStore } from "pinia";
import type { ApiDefinition } from "@apicc/core";
import type { ApiccApi } from "../../../shared/types.js";
import type { MultiProtocolApi } from "../multi-protocol.js";

/**
 * 编辑器 store 工厂：接受依赖 api 参数，每次工厂调用绑定独立 Pinia 实例。
 * 修正（相对简报实现）：dirty 改为「当前 api 与已保存快照比对」的 getter 派生——
 * 测试与组件直接改 api 字段（不经 action）也能被跟踪；load/save 后重写快照即复位。
 * 简报原实现在 state 里放 dirty 且无任何置位路径，其自身测试（直接改 url 期望 dirty）
 * 无法通过。
 * M5-B 任务 1（D2 契约 fixture）：api 状态取 MultiProtocolApi（protocol/message/
 * envelope/soapAction 本地 fixture 形状）——dirty 为 JSON 快照比对，新字段自然进
 * 缓冲与快照；保存载荷经 apiSave 出口携带新字段（本阶段旧 core strict schema 不
 * 接线，落盘往返由任务 2 同步 main 后经新 schema 校验）。
 */
export function useEditorStore(api: ApiccApi) {
  return defineStore("editor", {
    state: () => ({
      apiId: null as string | null,
      api: null as MultiProtocolApi | null,
      envs: [] as Array<{ id: string; name: string }>,
      snapshot: "",
    }),
    getters: {
      dirty: (state) => state.api !== null && JSON.stringify(state.api) !== state.snapshot,
    },
    actions: {
      async load(apiId: string) {
        const detail = await api.apiGet(apiId);
        this.apiId = apiId;
        this.api = detail.api;
        this.envs = detail.envs;
        this.snapshot = JSON.stringify(this.api);
      },
      async save() {
        if (!this.api) return;
        // Electron IPC 以结构化克隆传参：Pinia/Vue 的响应式 Proxy 无法被克隆
        // （DataCloneError，Electron 冒烟实测），须先深拷贝为普通对象再过 IPC。
        // JSON 往返即可：模型字段全为 string/boolean/number/array/plain object。
        await api.apiSave(JSON.parse(JSON.stringify(this.api)) as ApiDefinition);
        this.snapshot = JSON.stringify(this.api);
      },
    },
  })(createPinia());
}
