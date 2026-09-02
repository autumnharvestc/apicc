import { createPinia, defineStore } from "pinia";
import type { ApiDefinition } from "@apicc/core";
import type { ApiccApi } from "../../../shared/types.js";

/**
 * 编辑器 store 工厂：接受依赖 api 参数，每次工厂调用绑定独立 Pinia 实例。
 * 修正（相对简报实现）：dirty 改为「当前 api 与已保存快照比对」的 getter 派生——
 * 测试与组件直接改 api 字段（不经 action）也能被跟踪；load/save 后重写快照即复位。
 * 简报原实现在 state 里放 dirty 且无任何置位路径，其自身测试（直接改 url 期望 dirty）
 * 无法通过。
 */
export function useEditorStore(api: ApiccApi) {
  return defineStore("editor", {
    state: () => ({
      apiId: null as string | null,
      api: null as ApiDefinition | null,
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
        await api.apiSave(this.api);
        this.snapshot = JSON.stringify(this.api);
      },
    },
  })(createPinia());
}
