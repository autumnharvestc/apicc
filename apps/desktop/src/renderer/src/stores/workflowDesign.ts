import { createPinia, defineStore } from "pinia";
import type { Workflow, WorkflowRunResult, WorkflowStatus } from "@apicc/core";
import type { ApiccApi } from "../../../shared/types.js";
import type { WorkflowLocator } from "../../../shared/locations.js";
import type { LocalWorkspaceContext } from "./localIdentity.js";

function copyLocator(locator: WorkflowLocator): WorkflowLocator {
  return { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId, workflowId: locator.workflowId };
}

function sameLocator(left: WorkflowLocator | null, right: WorkflowLocator): boolean {
  return !!left && left.workspaceId === right.workspaceId && left.groupId === right.groupId
    && left.projectId === right.projectId && left.workflowId === right.workflowId;
}

export function useWorkflowDesignStore(api: ApiccApi, getContext: () => LocalWorkspaceContext = () => ({ root: "", readOnly: false })) {
  return defineStore("workflowDesign", {
    state: () => ({
      root: null as string | null,
      locator: null as WorkflowLocator | null,
      workflow: null as Workflow | null,
      snapshot: "",
      saving: false,
      validationErrors: [] as string[],
      warnings: [] as string[],
      runResult: null as WorkflowRunResult | null,
      running: false,
      loadEpoch: 0,
    }),
    getters: {
      workflowId(): string | null { return this.locator?.workflowId ?? null; },
      dirty: (state) => state.workflow !== null && JSON.stringify(state.workflow) !== state.snapshot,
    },
    actions: {
      assertWritable() {
        if (getContext().readOnly) throw new Error("工作区处于只读模式，不能修改工作流");
      },
      assertCurrentRoot(this: { root: string | null }, root: string | null = this.root) {
        if (!root || getContext().root !== root) throw new Error("工作区上下文已变化，不能操作旧工作流");
      },
      async load(root: string, locator: WorkflowLocator) {
        if (getContext().root !== root) return;
        const fixed = copyLocator(locator);
        const epoch = ++this.loadEpoch;
        const detail = await api.wfGet(fixed);
        if (epoch !== this.loadEpoch || getContext().root !== root) return;
        this.root = root;
        this.locator = fixed;
        this.workflow = JSON.parse(JSON.stringify(detail.workflow)) as Workflow;
        this.snapshot = JSON.stringify(this.workflow);
        this.validationErrors = [];
        this.warnings = [];
        this.runResult = null;
        this.saving = false;
        this.running = false;
      },
      update(workflow: Workflow) {
        this.assertWritable();
        this.assertCurrentRoot();
        this.workflow = workflow;
      },
      unload() {
        this.loadEpoch += 1;
        this.root = null;
        this.locator = null;
        this.workflow = null;
        this.snapshot = "";
        this.saving = false;
        this.validationErrors = [];
        this.warnings = [];
        this.runResult = null;
        this.running = false;
      },
      async save() {
        if (!this.workflow || !this.locator) return;
        this.assertWritable();
        this.assertCurrentRoot();
        const epoch = this.loadEpoch;
        const root = this.root;
        const locator = copyLocator(this.locator);
        const submitted = JSON.parse(JSON.stringify(this.workflow)) as Workflow;
        this.saving = true;
        try {
          const stored = await api.wfSave(locator, submitted);
          if (epoch !== this.loadEpoch || getContext().root !== root || !sameLocator(this.locator, locator)) return;
          this.workflow = stored;
          this.snapshot = JSON.stringify(stored);
          this.runResult = null;
        } finally {
          if (epoch === this.loadEpoch) this.saving = false;
        }
      },
      async setStatus(next: WorkflowStatus) {
        if (!this.locator) return;
        this.assertWritable();
        this.assertCurrentRoot();
        const epoch = this.loadEpoch;
        const root = this.root;
        const locator = copyLocator(this.locator);
        const result = await api.wfSetStatus(locator, next);
        if (epoch !== this.loadEpoch || getContext().root !== root || !sameLocator(this.locator, locator)) return;
        if (result.workflow.status !== next) {
          this.validationErrors = result.errors;
          this.warnings = result.warnings;
          return;
        }
        // Some successful transitions (draft → published) still return enablement findings.
        // They are not a failed transition; only surface findings when the requested transition
        // was rejected and the workflow remains at its previous status.
        this.validationErrors = [];
        this.warnings = result.warnings;
        this.workflow = { ...result.workflow };
        this.snapshot = JSON.stringify(this.workflow);
      },
      dismissValidation() {
        this.validationErrors = [];
      },
      async run(envName?: string) {
        if (this.running || !this.workflow || !this.locator) return;
        this.assertCurrentRoot();
        if (this.workflow.status === "draft") {
          this.validationErrors = ["工作流为草稿，请先发布启用"];
          return;
        }
        const epoch = this.loadEpoch;
        const root = this.root;
        const locator = copyLocator(this.locator);
        this.running = true;
        try {
          const result = await api.wfRun({ locator, envName });
          if (epoch === this.loadEpoch && getContext().root === root && sameLocator(this.locator, locator)) this.runResult = result;
        } finally {
          if (epoch === this.loadEpoch) this.running = false;
        }
      },
    },
  })(createPinia());
}
