import { createPinia, defineStore } from "pinia";
import { shallowRef } from "vue";
import type { JsonValue, Workflow, WorkflowRunResult, WorkflowStatus } from "@apicc/core";
import type { ApiccApi, WorkspaceRefreshResult } from "../../../shared/types.js";
import type { WorkflowLocator } from "../../../shared/locations.js";
import type { LocalWorkspaceContext } from "./localIdentity.js";
import { currentDiskRead, diskProject, jsonCopy, sameDiskValue, type DiskDraftConflict } from "./diskDrafts.js";
import { localTestingDependencies } from "../../../shared/workspace-testing-dependencies.js";

const RUN_HISTORY_LIMIT = 2;

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
      workflow: shallowRef<Workflow | null>(null),
      snapshot: "",
      saving: false,
      validationErrors: [] as string[],
      warnings: [] as string[],
      runResult: null as WorkflowRunResult | null,
      running: false,
      stopping: false,
      activeRun: null as { locator: WorkflowLocator; root: string; invocationId: string; epoch: number } | null,
      runHistory: [] as Array<{ locator: WorkflowLocator; root: string; invocationId: string; result: WorkflowRunResult }>,
      loadEpoch: 0,
      diskEpoch: 0,
      diskConflict: null as DiskDraftConflict | null,
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
        const detail = await currentDiskRead(() => api.wfGet(fixed), () => this.diskEpoch,
          () => epoch === this.loadEpoch && getContext().root === root);
        if (!detail || epoch !== this.loadEpoch || getContext().root !== root) return;
        this.root = root;
        this.locator = fixed;
        this.workflow = JSON.parse(JSON.stringify(detail.workflow)) as Workflow;
        this.snapshot = JSON.stringify(this.workflow);
        this.diskConflict = null;
        this.validationErrors = [];
        this.warnings = [];
        this.runResult = null;
        this.saving = false;
        // The captured run survives editor navigation until its real promise settles.
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
        this.diskConflict = null;
        this.saving = false;
        this.validationErrors = [];
        this.warnings = [];
        this.runResult = null;
      },
      async save() {
        if (!this.workflow || !this.locator) return;
        this.assertWritable();
        this.assertCurrentRoot();
        if (this.diskConflict) throw new Error("disk-draft-blocked");
        const epoch = this.loadEpoch;
        const diskEpoch = this.diskEpoch;
        const root = this.root;
        const locator = copyLocator(this.locator);
        const submitted = JSON.parse(JSON.stringify(this.workflow)) as Workflow;
        this.saving = true;
        try {
          const stored = await api.wfSave(locator, submitted);
          if (epoch !== this.loadEpoch || diskEpoch !== this.diskEpoch || getContext().root !== root || !sameLocator(this.locator, locator)) return;
          if (sameDiskValue(this.workflow, submitted)) this.workflow = stored;
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
        if (this.diskConflict) throw new Error("disk-draft-blocked");
        const epoch = this.loadEpoch;
        const diskEpoch = this.diskEpoch;
        const root = this.root;
        const locator = copyLocator(this.locator);
        const result = await api.wfSetStatus(locator, next);
        if (epoch !== this.loadEpoch || diskEpoch !== this.diskEpoch || getContext().root !== root || !sameLocator(this.locator, locator)) return;
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
        this.workflow = this.dirty && this.workflow ? { ...this.workflow, status: result.workflow.status } : { ...result.workflow };
        this.snapshot = JSON.stringify(result.workflow);
      },
      reconcileDiskRefresh(receipt: WorkspaceRefreshResult): void {
        if (getContext().root !== receipt.root) return;
        this.diskEpoch += 1;
        if (this.root !== receipt.root || !this.locator || !this.workflow) return;
        const root = this.root, locator = copyLocator(this.locator);
        const before = diskProject(receipt.previousWorkspace, locator), after = diskProject(receipt.workspace, locator);
        const next = after?.workflows.find((item) => item.id === locator.workflowId);
        const local = this.workflow;
        const epoch = this.diskEpoch;
        const restore = () => {
          if (this.root !== root || getContext().root !== root || !sameLocator(this.locator, locator) || this.diskEpoch !== epoch) return;
          this.workflow = next ? jsonCopy(next) : null;
          this.snapshot = next ? JSON.stringify(next) : "";
          this.diskConflict = null;
          this.validationErrors = [];
          this.warnings = [];
        };
        if (this.dirty && (this.diskConflict || !next || !sameDiskValue(JSON.parse(this.snapshot), next)
          || !sameDiskValue(localTestingDependencies(receipt.previousWorkspace, before, locator, local),
            localTestingDependencies(receipt.workspace, after, locator, local)))) {
          this.diskConflict = { reason: next ? "changed" : "deleted", name: local.name, restore };
        } else {
          if (!next) {
            restore();
            return;
          }
          if (!this.dirty) restore();
        }
      },
      dismissValidation() {
        this.validationErrors = [];
      },
      async cancel() {
        const active = this.activeRun;
        if (!active || !this.running || this.stopping) return;
        this.stopping = true;
        try {
          const accepted = await api.wfCancel({ locator: copyLocator(active.locator), root: active.root, invocationId: active.invocationId });
          if (!accepted) throw new Error("未接受该运行的停止请求");
          // Acceptance is not completion. Only wfRun settling releases the session.
        } catch (error) {
          if (this.activeRun?.invocationId === active.invocationId) this.stopping = false;
          throw error;
        }
      },
      async run(envName?: string, inputs?: Readonly<Record<string, JsonValue>>, saved?: { root: string; locator: WorkflowLocator; workflow: Workflow; revision: string }) {
        const workflow = saved?.workflow ?? this.workflow;
        const target = saved?.locator ?? this.locator;
        const root = saved?.root ?? this.root;
        if (this.running || !workflow || !target || !root) return;
        this.assertCurrentRoot(root);
        if (root === this.root && sameLocator(this.locator, target) && (this.dirty || this.saving)) {
          this.validationErrors = ["工作流有未保存修改，请先保存"];
          return;
        }
        if (workflow.status === "draft") {
          this.validationErrors = ["工作流为草稿，请先发布启用"];
          return;
        }
        const epoch = this.loadEpoch;
        const locator = copyLocator(target);
        const invocationId = crypto.randomUUID();
        this.activeRun = { locator, root, invocationId, epoch };
        this.running = true;
        this.stopping = false;
        try {
          const result = await api.wfRun({ locator, envName, invocationId, root, ...(saved ? { previewRevision: saved.revision } : {}), ...(inputs ? { inputs: JSON.parse(JSON.stringify(inputs)) } : {}) });
          this.runHistory.push({ locator, root, invocationId, result });
          if (this.runHistory.length > RUN_HISTORY_LIMIT) this.runHistory.splice(0, this.runHistory.length - RUN_HISTORY_LIMIT);
          if (epoch === this.loadEpoch && getContext().root === root && sameLocator(this.locator, locator)) this.runResult = result;
          return result;
        } finally {
          if (this.activeRun?.invocationId === invocationId) {
            this.running = false;
            this.stopping = false;
            this.activeRun = null;
          }
        }
      },
    },
  })(createPinia());
}
