import { createPinia, defineStore } from "pinia";
import type { ApiDefinition } from "@apicc/core";
import type { ApiccApi } from "../../../shared/types.js";

/**
 * 编辑器 store 工厂：接受依赖 api 参数，每次工厂调用绑定独立 Pinia 实例。
 * 修正（相对简报实现）：dirty 改为「当前 api 与已保存快照比对」的 getter 派生——
 * 测试与组件直接改 api 字段（不经 action）也能被跟踪；load/save 后重写快照即复位。
 * 简报原实现在 state 里放 dirty 且无任何置位路径，其自身测试（直接改 url 期望 dirty）
 * 无法通过。
 * M5-B 任务 2（裁定 A，D2 保存链路接线）：api 即 core 的 ApiDefinition（protocol/
 * message/envelope/soapAction 已由 core schema 正式承载）——任务 1 的本地契约 fixture
 * 类型（multi-protocol.ts）收敛删除，消除双类型源。dirty 为 JSON 快照比对，新字段自然
 * 进缓冲与快照；保存载荷经 apiSave → IPC api:save → session.saveApi → fileStorage
 * 白名单落盘，reopen 过新 schema strict 校验（集成见 tests/main/multi-protocol-save.test.ts）。
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
      /**
       * 环境清单重拉（M9-A1）：调试环境选择器读 editor.envs，但它只在 load（选中接口）
       * 时载入——环境管理里新建/删除环境后选择器不刷新（用户实测 bug）。由组合根在
       * 环境增删后调用，按当前接口重拉所属项目环境清单；api 快照不动（不标脏）。
       */
      async reloadEnvs() {
        if (!this.apiId) return;
        const detail = await api.apiGet(this.apiId);
        this.envs = detail.envs;
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
