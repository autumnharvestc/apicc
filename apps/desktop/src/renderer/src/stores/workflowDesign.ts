import { createPinia, defineStore } from "pinia";
import type { Workflow, WorkflowRunResult, WorkflowStatus } from "@apicc/core";
import type { ApiccApi } from "../../../shared/types.js";

/**
 * 工作流设计器 store 工厂（M2-B 任务 2）：接受依赖 api 参数，每次工厂调用绑定独立
 * Pinia 实例。语义与 editor 先例同款：
 * - dirty 是「当前缓冲与已保存快照比对」的 getter 派生——画布编辑动作（组件经 wfCanvas
 *   纯函数产出新缓冲，任务 3/4）只调 update(workflow) 整体替换缓冲，置 dirty 语义经快照
 *   比对自动生效，store 不设显式标志位；
 * - save() 先深拷贝剥离响应式再过 IPC（Electron 结构化克隆不接受 Proxy，editor 冒烟
 *   实测 DataCloneError），用 wf:save 返回的落盘工作流刷新缓冲并重置快照；失败上抛调用方；
 * - setStatus(next) 失败（启用校验未过）把 errors 存入 validationErrors 且缓冲不动，
 *   成功刷新缓冲 + 快照（status 变更若不重置快照会误报 dirty）并清 validationErrors；
 * - run(envName?) 有 running 门控；draft 时直接把「工作流为草稿，请先发布启用」存入
 *   validationErrors 而不发 IPC——api 层对 draft 也会抛同文案错误，双保险。
 */
export function useWorkflowDesignStore(api: ApiccApi) {
  return defineStore("workflowDesign", {
    state: () => ({
      workflowId: null as string | null,
      workflow: null as Workflow | null,
      snapshot: "",
      saving: false,
      validationErrors: [] as string[],
      warnings: [] as string[],
      runResult: null as WorkflowRunResult | null,
      running: false,
    }),
    getters: {
      dirty: (state) => state.workflow !== null && JSON.stringify(state.workflow) !== state.snapshot,
    },
    actions: {
      async load(workflowId: string) {
        const detail = await api.wfGet(workflowId);
        this.workflowId = workflowId;
        this.workflow = detail.workflow;
        this.snapshot = JSON.stringify(this.workflow);
        // 切换工作流即重置设计器会话态：上文的运行结果与校验/告警不再属于当前流
        this.validationErrors = [];
        this.warnings = [];
        this.runResult = null;
      },
      /** 画布/属性面板编辑入口：整体替换编辑缓冲，dirty 经快照比对自动派生。 */
      update(workflow: Workflow) {
        this.workflow = workflow;
      },
      /**
       * 卸载编辑会话（审查修复：离开设计器/切换项目时调用）：回到未选工作流空态，
       * 缓冲、快照与运行/校验等会话态一并清空。同步动作，无在途守卫需求（与 load
       * 的异步切流守卫互不干扰）。
       */
      unload() {
        this.workflowId = null;
        this.workflow = null;
        this.snapshot = "";
        this.saving = false;
        this.validationErrors = [];
        this.warnings = [];
        this.runResult = null;
        this.running = false;
      },
      async save() {
        if (!this.workflow) return;
        // 在途切流守卫：await 期间 load(另一工作流) 可能完成，旧流的落盘返回值不得
        // 回写（否则 workflowId 是 B、缓冲内容是 A，dirty=false 掩盖错位，后续编辑
        // 经 wfSave 按 input.id 落到 A 流，跨流数据错写）。
        const targetId = this.workflowId;
        this.saving = true;
        try {
          // JSON 往返剥离响应式（模型字段全为 string/boolean/number/array/plain object，
          // 与 editor.save 同款注释依据）。
          const stored = await api.wfSave(JSON.parse(JSON.stringify(this.workflow)) as Workflow);
          if (this.workflowId !== targetId) return;
          this.workflow = stored;
          this.snapshot = JSON.stringify(this.workflow);
          // 审查 Minor 采纳：保存成功即清空旧运行结果——编辑+保存后画布着色来自
          // 旧 runResult，与新落盘内容不符；清空后「结果」钮随之禁用（未运行语义）。
          this.runResult = null;
        } finally {
          this.saving = false;
        }
      },
      async setStatus(next: WorkflowStatus) {
        if (!this.workflowId) return;
        const targetId = this.workflowId; // 在途切流守卫，同 save
        const result = await api.wfSetStatus(this.workflowId, next);
        if (this.workflowId !== targetId) return;
        if (result.errors.length > 0) {
          // 启用校验未过：错误可见、缓冲内容不动（api 返回状态不变的原工作流）
          this.validationErrors = result.errors;
          this.warnings = result.warnings;
          return;
        }
        // 浅拷贝换新引用再写入：api 层原地迁移 status 后回传同一对象，同引用赋值不触发
        // 响应式（审查修复：设计器状态 Tag/侧树色点依赖 status 变化的 watcher 将失明；
        // 与 save() 用 wfSave 新对象刷新缓冲的模式对齐）。
        this.workflow = { ...result.workflow };
        this.snapshot = JSON.stringify(this.workflow);
        this.validationErrors = [];
        this.warnings = result.warnings;
      },
      dismissValidation() {
        this.validationErrors = [];
      },
      async run(envName?: string) {
        if (this.running || !this.workflow || !this.workflowId) return;
        if (this.workflow.status === "draft") {
          this.validationErrors = ["工作流为草稿，请先发布启用"];
          return;
        }
        const targetId = this.workflowId; // 在途切流守卫，同 save（旧流运行结果不回填）
        this.running = true;
        try {
          const result = await api.wfRun({ workflowId: this.workflowId, envName });
          if (this.workflowId !== targetId) return;
          this.runResult = result;
        } finally {
          this.running = false;
        }
      },
    },
  })(createPinia());
}
