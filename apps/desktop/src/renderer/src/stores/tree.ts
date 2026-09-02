import { createPinia, defineStore } from "pinia";
import type { ApiccApi, NodeCreateInput } from "../../../shared/types.js";
import type { TreeNodeDTO } from "../../../shared/tree-dto.js";
import { useWorkspaceStore } from "./workspace.js";

type ConfirmFn = (message: string) => Promise<boolean>;

/**
 * 树 store 工厂：接受依赖 api 与工作区 store 参数，节点变更后刷新工作区树；
 * 删除必须经确认回调放行。每次工厂调用绑定独立 Pinia 实例。
 */
export function useTreeStore(api: ApiccApi, workspace: ReturnType<typeof useWorkspaceStore>) {
  return defineStore("tree", {
    state: () => ({ selected: null as { kind: TreeNodeDTO["kind"]; id: string } | null }),
    actions: {
      select(kind: TreeNodeDTO["kind"], id: string) {
        this.selected = { kind, id };
      },
      async createNode(input: NodeCreateInput) {
        const node = (await api.nodeCreate(input)) as unknown as { id: string };
        await workspace.refresh();
        this.select(input.kind, node.id);
        return node;
      },
      async renameNode(kind: Parameters<ApiccApi["nodeRename"]>[0], id: string, name: string) {
        await api.nodeRename(kind, id, name);
        await workspace.refresh();
      },
      async deleteNode(kind: Parameters<ApiccApi["nodeDelete"]>[0], id: string, confirm: ConfirmFn) {
        if (!(await confirm(`delete:${id}`))) return;
        await api.nodeDelete(kind, id);
        if (this.selected?.id === id) this.selected = null;
        await workspace.refresh();
      },
    },
  })(createPinia());
}
