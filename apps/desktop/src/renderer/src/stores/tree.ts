import { createPinia, defineStore } from "pinia";
import type { ApiccApi, NodeCreateInput, NodeCreatedDTO } from "../../../shared/types.js";
import type { NodeLocator } from "../../../shared/locations.js";
import { localTreeNodeKey, type LocalTreeIdentity, type LocalTreeNodeDTO } from "../../../shared/tree-dto.js";
import { useWorkspaceStore } from "./workspace.js";

type ConfirmFn = (message: string) => Promise<boolean>;
type SelectedLocalNode = LocalTreeIdentity & { id: string; key: string };

function nodeId(node: NodeLocator): string {
  switch (node.kind) {
    case "api": return node.locator.apiId;
    case "project": return node.locator.projectId;
    case "group": return node.locator.groupId;
    case "collection": return node.locator.collectionId;
    case "folder": return node.locator.folderIds.at(-1)!;
    case "environment": return node.locator.environmentId;
    case "model": return node.locator.modelId;
    case "component": return node.locator.componentId;
    case "workflow": return node.locator.workflowId;
  }
}

function copyLocator(node: LocalTreeNodeDTO | NodeCreatedDTO): LocalTreeIdentity["locator"] {
  switch (node.kind) {
    case "root": return { workspaceId: node.locator.workspaceId };
    case "group": return { workspaceId: node.locator.workspaceId, groupId: node.locator.groupId };
    case "project": return { workspaceId: node.locator.workspaceId, groupId: node.locator.groupId, projectId: node.locator.projectId };
    case "collection": return {
      workspaceId: node.locator.workspaceId,
      groupId: node.locator.groupId,
      projectId: node.locator.projectId,
      collectionId: node.locator.collectionId,
    };
    case "folder": return {
      workspaceId: node.locator.workspaceId,
      groupId: node.locator.groupId,
      projectId: node.locator.projectId,
      collectionId: node.locator.collectionId,
      folderIds: [...node.locator.folderIds],
    };
    case "api": return {
      workspaceId: node.locator.workspaceId,
      groupId: node.locator.groupId,
      projectId: node.locator.projectId,
      collectionId: node.locator.collectionId,
      folderIds: [...node.locator.folderIds],
      apiId: node.locator.apiId,
    };
    case "workflow": return {
      workspaceId: node.locator.workspaceId,
      groupId: node.locator.groupId,
      projectId: node.locator.projectId,
      workflowId: node.locator.workflowId,
    };
  }
}

function selectionOf(node: LocalTreeNodeDTO | NodeCreatedDTO): SelectedLocalNode {
  return { source: "local", kind: node.kind, id: node.id, key: node.key, locator: copyLocator(node) } as SelectedLocalNode;
}

/** Complete local locators are retained for every selection and mutation. */
export function useTreeStore(api: ApiccApi, workspace: ReturnType<typeof useWorkspaceStore>) {
  return defineStore("tree", {
    state: () => ({ selected: null as SelectedLocalNode | null }),
    actions: {
      select(node: LocalTreeNodeDTO): void {
        this.selected = selectionOf(node);
      },

      async createNode(input: NodeCreateInput): Promise<NodeCreatedDTO> {
        this.assertWritable();
        const created = await api.nodeCreate(input);
        await workspace.refresh();
        this.selected = selectionOf(created);
        return created;
      },

      async renameNode(node: NodeLocator, name: string): Promise<void> {
        this.assertWritable();
        await api.nodeRename(node, name);
        await workspace.refresh();
      },

      async deleteNode(node: NodeLocator, confirm: ConfirmFn): Promise<boolean> {
        this.assertWritable();
        if (!(await confirm(`delete:${nodeId(node)}`))) return false;
        await api.nodeDelete(node);
        if (this.selected && node.kind !== "model" && node.kind !== "component" && node.kind !== "environment") {
          const deletedKey = localTreeNodeKey({ source: "local", kind: node.kind, locator: node.locator } as LocalTreeIdentity);
          if (this.selected.key === deletedKey) this.selected = null;
        }
        await workspace.refresh();
        return true;
      },

      assertWritable(): void {
        if (!workspace.opened) throw new Error("尚未打开本地工作区");
        if (workspace.readOnly) throw new Error("工作区处于只读模式，不能修改树");
      },
    },
  })(createPinia());
}
