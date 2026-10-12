import { createPinia, defineStore } from "pinia";
import type { Workflow } from "@apicc/core";
import type { ApiccApi, WorkflowSummary } from "../../../shared/types.js";
import type { ProjectLocator, WorkflowLocator } from "../../../shared/locations.js";
import type { LocalWorkspaceContext } from "./localIdentity.js";

type ConfirmFn = (message: string) => Promise<boolean>;

function copyProject(locator: ProjectLocator): ProjectLocator {
  return { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId };
}

function copyWorkflow(locator: WorkflowLocator): WorkflowLocator {
  return { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId, workflowId: locator.workflowId };
}

function sameProject(left: ProjectLocator | null, right: ProjectLocator): boolean {
  return !!left && left.workspaceId === right.workspaceId && left.groupId === right.groupId && left.projectId === right.projectId;
}

export function useWfListStore(api: ApiccApi, getContext: () => LocalWorkspaceContext = () => ({ root: "", readOnly: false })) {
  return defineStore("wfList", {
    state: () => ({ items: [] as WorkflowSummary[], root: null as string | null, projectLocator: null as ProjectLocator | null, loadEpoch: 0 }),
    actions: {
      assertWritable() {
        if (getContext().readOnly) throw new Error("工作区处于只读模式，不能修改工作流");
      },
      async load(root: string, locator: ProjectLocator) {
        if (getContext().root !== root) return;
        const fixed = copyProject(locator);
        const epoch = ++this.loadEpoch;
        this.root = root;
        this.projectLocator = fixed;
        this.items = [];
        const items = await api.wfList(fixed);
        if (epoch !== this.loadEpoch || getContext().root !== root || !sameProject(this.projectLocator, fixed)) return;
        this.items = items;
      },
      async create(name: string, projectLocator: ProjectLocator): Promise<Workflow> {
        this.assertWritable();
        const root = getContext().root;
        if (!root) throw new Error("尚未选择本地工作区");
        const locator = copyProject(projectLocator);
        if (this.root !== root || !this.projectLocator) throw new Error("工作流列表上下文已变化");
        const workflow = await api.wfCreate({ locator, name });
        if (root === getContext().root && this.root === root && sameProject(this.projectLocator, locator)) await this.load(root, locator);
        return workflow;
      },
      async remove(locator: WorkflowLocator, confirm: ConfirmFn) {
        this.assertWritable();
        const root = getContext().root;
        const fixed = copyWorkflow(locator);
        const project: ProjectLocator = { workspaceId: fixed.workspaceId, groupId: fixed.groupId, projectId: fixed.projectId };
        if (!root || this.root !== root || !sameProject(this.projectLocator, project)) return;
        if (!(await confirm(`delete:${fixed.workflowId}`)) || root !== getContext().root) return;
        await api.wfDelete(fixed);
        if (root === getContext().root && this.root === root && sameProject(this.projectLocator, project)) await this.load(root, project);
      },
    },
  })(createPinia());
}
