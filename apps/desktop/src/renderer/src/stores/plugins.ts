import { createPinia, defineStore } from "pinia";
import type { PluginLoadEntry } from "../../../shared/plugins/contract.js";
import type { ApiccApi } from "../../../shared/types.js";

/**
 * 插件 store 工厂（M7-B 任务 1，规格 §2 D3/D5）：依赖注入（api，测试传新实例即天然
 * 隔离）；每次工厂调用绑定独立 Pinia 实例；组件内零工厂调用，实例由 App 组合根一次性
 * 创建后经 props 下传（PluginsView / ImportWizard）。
 *
 * 状态契约：
 * - init（App 挂载即拉取，void 之）：plugins:list 出口入状态——entries（loaded/failed
 *   混合清单，插件视图只读展示）+ importers（registry 导入器枚举，导入向导选择面动态
 *   枚举数据源）；全程不抛，失败仅 error 上屏、状态保持空。
 * - refresh（插件视图刷新钮/诊断链路）：以最新清单覆盖状态；失败 error 上屏、既有清单
 *   保留（刷新不破坏已显示数据）。
 * - loading：init/refresh 进行中；loaded：init 是否已成功过（组合根/消费方判重拉依据）。
 */
export function createPluginsStore(deps: { api: ApiccApi }) {
  const api = deps.api;
  return defineStore("plugins", {
    state: () => ({
      entries: [] as PluginLoadEntry[],
      importers: [] as string[],
      loading: false,
      loaded: false,
      /** 拉取失败的可读错误（init/refresh 共用通道；成功拉取即清空）。 */
      error: null as string | null,
    }),
    actions: {
      /** 启动装配（App 组合根 onMounted 调用，void 之）：首次拉取清单，全程不抛。 */
      async init(): Promise<void> {
        if (this.loaded) return;
        await this.refresh();
        // loaded 仅在成功拉取后置位：失败后再次 refresh 仍会重试（见 refresh 内清位逻辑）。
        if (!this.error) this.loaded = true;
      },

      /** 重拉清单并覆盖状态；失败 error 上屏、既有 entries/importers 保留、不向调用方抛。 */
      async refresh(): Promise<void> {
        this.loading = true;
        this.error = null;
        try {
          const result = await api.pluginsList();
          this.entries = result.plugins;
          this.importers = result.importers;
        } catch (e) {
          this.error = e instanceof Error ? e.message : String(e);
        } finally {
          this.loading = false;
        }
      },
    },
  })(createPinia());
}

export type PluginsStore = ReturnType<typeof createPluginsStore>;
