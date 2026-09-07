/**
 * 模块侧栏记忆（M11）：各模块 API 栏的展开/选中/过滤状态按模块独立持久。
 * localStorage 持久化（应用本地，不进工作区文件/Git）；重启保留，恢复时与现存
 * 节点求交由消费方负责。App 组合根一次性创建，经 props 下发。
 */
import { createPinia, defineStore } from "pinia";
import { watch } from "vue";

const STORAGE_KEY = "apicc.moduleMemory";

type ModuleMemory = {
  apiTree: { filter: string; expanded: string[]; lastApiId: string | null };
  test: { pane: "api-cases" | "scenario"; apiId: string | null };
};

function load(): ModuleMemory {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ModuleMemory>;
      return {
        apiTree: { filter: "", expanded: [], lastApiId: null, ...parsed.apiTree },
        test: { pane: "api-cases", apiId: null, ...parsed.test },
      };
    }
  } catch {
    // 损坏即重置（等价无记录）
  }
  return { apiTree: { filter: "", expanded: [], lastApiId: null }, test: { pane: "api-cases", apiId: null } };
}

export function useModuleMemoryStore() {
  return defineStore("moduleMemory", {
    state: (): ModuleMemory => load(),
    actions: {
      touch(): void {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.$state));
      },
    },
  })(createPinia());
}
