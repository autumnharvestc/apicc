import { createPinia, defineStore } from "pinia";
import type { Workflow } from "@apicc/core";
import type { ApiccApi, WorkflowSummary } from "../../../shared/types.js";

type ConfirmFn = (message: string) => Promise<boolean>;

/**
 * 工作流列表 store 工厂（M2-B 任务 2）：项目级工作流列表 + 新建 + 删除确认回调模式
 * （先例同 tree store：删除必须经确认回调放行）。接受依赖 api 参数，每次工厂调用绑定
 * 独立 Pinia 实例。create/remove 成功后重拉列表（items 与 api 内存态保持一致）。
 */
export function useWfListStore(api: ApiccApi) {
  return defineStore("wfList", {
    state: () => ({
      items: [] as WorkflowSummary[],
      projectId: null as string | null,
    }),
    actions: {
      async load(projectId: string) {
        this.projectId = projectId;
        this.items = await api.wfList(projectId);
      },
      /** 新建工作流（挂在当前 load 的项目下），返回新工作流并刷新列表。 */
      async create(name: string): Promise<Workflow> {
        if (!this.projectId) throw new Error("尚未选择项目");
        const workflow = await api.wfCreate({ projectId: this.projectId, name });
        await this.load(this.projectId);
        return workflow;
      },
      async remove(id: string, confirm: ConfirmFn) {
        if (!this.projectId) return;
        if (!(await confirm(`delete:${id}`))) return;
        await api.wfDelete(id);
        await this.load(this.projectId);
      },
    },
  })(createPinia());
}
