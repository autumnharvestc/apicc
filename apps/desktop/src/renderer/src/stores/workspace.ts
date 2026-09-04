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
      /** 关闭工作区（不与 main 交互）：M3-B 任务 3 裁定 E 模式互斥——打开在线工作区前
       *  先关本地目录工作区会话（渲染层上下文复位；main 侧由 ws:open/ws:create 链清理）。 */
      reset() {
        this.opened = false;
        this.name = "";
        this.root = "";
        this.tree = null;
        this.problems = [];
      },
    },
  })(createPinia());
}
