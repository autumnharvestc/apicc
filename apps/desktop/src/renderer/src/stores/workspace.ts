import { createPinia, defineStore } from "pinia";
import type { LoadProblem } from "@apicc/core";
import type { ApiccApi, OpenResult } from "../../../shared/types.js";
import type { TreeNodeDTO } from "../../../shared/tree-dto.js";

/**
 * 工作区 store 工厂：接受依赖 api 参数（测试传新实例即天然隔离）。
 * 每次工厂调用绑定独立 Pinia 实例，得到互不共享状态的工作区 store。
 */
export function useWorkspaceStore(api: ApiccApi) {
  return defineStore("workspace", {
    state: () => ({ opened: false, name: "", root: "", tree: null as TreeNodeDTO | null, problems: [] as LoadProblem[] }),
    actions: {
      async open(rootPath: string) {
        const r = await api.wsOpen(rootPath);
        this.apply(r);
        await this.refresh();
      },
      async create(rootPath: string, name: string) {
        const r = await api.wsCreate(rootPath, name);
        this.apply(r);
        await this.refresh();
      },
      async refresh() {
        this.tree = await api.treeGet();
      },
      apply(r: OpenResult) {
        this.opened = true;
        this.name = r.workspace.name;
        this.root = r.root;
        this.problems = r.problems;
      },
    },
  })(createPinia());
}
