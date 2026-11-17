import { createPinia, defineStore } from "pinia";
import { ref } from "vue";
import type { ContractWorkspace, LoadProblem, StressTargetPolicy } from "@apicc/core";
import type { ApiLocator, ProjectLocator } from "../../../shared/locations.js";
import type { ApiccApi, OpenResult, WorkspaceRefreshResult } from "../../../shared/types.js";
import { LocalWorkspaceError, localWorkspaceError, type LocalWorkspaceFailureReason, type WorkspaceObservationResult } from "../../../shared/workspace-refresh.js";
import type { LocalGroupTreeNodeDTO, LocalProjectTreeNodeDTO, LocalRootTreeNodeDTO, LocalTreeNodeDTO } from "../../../shared/tree-dto.js";

function normalizeOrigin(value: string): string {
  const parsed = new URL(value);
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) throw new Error(`无效 HTTP(S) origin: ${value}`);
  const authority = value.slice(value.indexOf("://") + 3);
  if (!/^[^/?#\s]+\/?$/.test(authority) || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error(`无效 HTTP(S) origin: ${value}`);
  return parsed.origin;
}

function normalizePolicy(policy: StressTargetPolicy): StressTargetPolicy {
  const trustedOrigins = [...new Set((policy.trustedOrigins ?? []).map(normalizeOrigin))];
  const deniedOrigins = [...new Set((policy.deniedOrigins ?? []).map(normalizeOrigin))];
  const denied = new Set(deniedOrigins);
  if (policy.maxConcurrency !== undefined && (!Number.isInteger(policy.maxConcurrency) || policy.maxConcurrency <= 0)) throw new Error("maxConcurrency 必须为正整数");
  if (policy.maxRps !== undefined && (!Number.isFinite(policy.maxRps) || policy.maxRps <= 0)) throw new Error("maxRps 必须为正数");
  return {
    trustedOrigins: trustedOrigins.filter((origin) => !denied.has(origin)),
    deniedOrigins,
    ...(policy.maxConcurrency === undefined ? {} : { maxConcurrency: policy.maxConcurrency }),
    ...(policy.maxRps === undefined ? {} : { maxRps: policy.maxRps }),
  };
}

function sameApiLocator(left: ApiLocator, right: ApiLocator): boolean {
  return left.workspaceId === right.workspaceId
    && left.groupId === right.groupId
    && left.projectId === right.projectId
    && left.collectionId === right.collectionId
    && left.apiId === right.apiId
    && left.folderIds.length === right.folderIds.length
    && left.folderIds.every((id, index) => id === right.folderIds[index]);
}

interface WorkspaceState {
  opened: boolean;
  name: string;
  root: string;
  workspace: ContractWorkspace | null;
  tree: LocalRootTreeNodeDTO | null;
  problems: LoadProblem[];
  readOnly: boolean;
  revision: string;
}

function applyOpenResult(state: WorkspaceState, result: OpenResult): void {
  state.opened = true;
  state.name = result.workspace.name;
  state.workspace = result.workspace;
  state.tree = result.tree;
  state.root = result.root;
  state.problems = result.problems;
  state.readOnly = result.readOnly;
  state.revision = result.revision;
}

/** Local workspace view and its exact, revisioned renderer context. */
export function useWorkspaceStore(api: ApiccApi) {
  let contextEpoch = 0;
  let operationQueue: Promise<void> = Promise.resolve();
  const pendingOpenCount = ref(0);
  const diskRefreshPending = ref(false);
  let diskRefreshTask: Promise<WorkspaceRefreshResult | undefined> | null = null;
  let observationEpoch = 0;
  let observingDisk: { epoch: number; task: Promise<WorkspaceObservationResult | undefined> } | undefined;

  const enqueueContextOperation = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = operationQueue.then(operation, operation);
    operationQueue = next.then(() => undefined, () => undefined);
    return next;
  };
  const readTree = async (): Promise<LocalRootTreeNodeDTO> => {
    const tree = await api.treeGet();
    if (tree.source !== "local" || tree.kind !== "root") throw new Error("workspace tree must be a local root node");
    return tree;
  };

  return defineStore("workspace", {
    state: () => ({
      opened: false,
      name: "",
      root: "",
      workspace: null as ContractWorkspace | null,
      tree: null as LocalRootTreeNodeDTO | null,
      problems: [] as LoadProblem[],
      readOnly: false,
      revision: "",
      diskObservation: null as WorkspaceObservationResult | null,
      diskObservationIssue: null as LocalWorkspaceFailureReason | null,
    }),
    actions: {
      resolveRoot(rootPath: string): Promise<string> {
        return api.wsResolveRoot(rootPath);
      },

      open(rootPath: string, isCurrent: () => boolean = () => true, project?: ProjectLocator): Promise<string | void> {
        const epoch = ++contextEpoch;
        pendingOpenCount.value += 1;
        return enqueueContextOperation(async () => {
          try {
            if (epoch !== contextEpoch || !isCurrent()) return;
            const result = await api.wsOpen(rootPath, project);
            if (result.disposition === "reused" && this.opened && this.root === result.root && this.tree) return result.root;
            // The main process has already switched. Apply the completed receipt
            // before the next renderer open, even if its navigation intent changed.
            this.apply(result);
            return result.root;
          } finally {
            pendingOpenCount.value -= 1;
          }
        });
      },

      create(rootPath: string, name: string): Promise<void> {
        const epoch = ++contextEpoch;
        pendingOpenCount.value += 1;
        return enqueueContextOperation(async () => {
          try {
            if (epoch !== contextEpoch) return;
            const result = await api.wsCreate(rootPath, name);
            this.apply(result);
          } finally {
            pendingOpenCount.value -= 1;
          }
        });
      },

      refresh(): Promise<void> {
        const epoch = contextEpoch;
        return enqueueContextOperation(async () => {
          if (epoch !== contextEpoch) return;
          const tree = await readTree();
          if (epoch === contextEpoch) this.tree = tree;
        });
      },

      observeAfterWrite(): void {
        const context = contextEpoch;
        // A save can complete after a foreground check has already started.
        // Wait for that check before observing the saved projection.
        void Promise.resolve(observingDisk?.task).then(() => { if (context === contextEpoch) return this.observeDisk(); });
      },

      observeDisk(): Promise<WorkspaceObservationResult | undefined> {
        const root = this.root;
        const workspaceId = this.workspace?.id;
        if (!root || !workspaceId || pendingOpenCount.value || diskRefreshPending.value || typeof api.wsObserve !== "function") return Promise.resolve(undefined);
        const epoch = observationEpoch;
        if (observingDisk?.epoch === epoch) return observingDisk.task;
        const context = contextEpoch;
        const isCurrent = () => epoch === observationEpoch && context === contextEpoch && root === this.root && workspaceId === this.workspace?.id;
        const task = Promise.resolve().then(() => api.wsObserve({ root, workspaceId })).then(result => {
          if (!isCurrent() || result.root !== root || result.workspaceId !== workspaceId) return undefined;
          this.diskObservation = result.changes.length ? result : null;
          this.diskObservationIssue = null;
          return result;
        }).catch(error => {
          if (!isCurrent()) return undefined;
          const reason = error instanceof LocalWorkspaceError ? error.failure.reason : "failed";
          if (reason !== "busy" && reason !== "context-changed") {
            this.diskObservationIssue = reason;
            if (reason === "directory-changed" || reason === "directory-unavailable" || reason === "workspace-replaced") this.diskObservation = null;
          }
          return undefined;
        }).finally(() => {
          if (observingDisk?.task === task) observingDisk = undefined;
        });
        observingDisk = { epoch, task };
        return task;
      },

      refreshFromDisk(reconcile: (receipt: WorkspaceRefreshResult, isCurrent: () => boolean) => Promise<void>, observedRevision?: string): Promise<WorkspaceRefreshResult | undefined> {
        if (diskRefreshTask) return diskRefreshTask;
        const root = this.root;
        const workspaceId = this.workspace?.id;
        if (!root || !workspaceId || pendingOpenCount.value) {
          return Promise.reject(localWorkspaceError("context-changed", "The active workspace changed.", root));
        }
        const epoch = contextEpoch;
        const isCurrent = () => root === this.root && workspaceId === this.workspace?.id;
        diskRefreshPending.value = true;
        const task = enqueueContextOperation(async () => {
          if (contextEpoch !== epoch || !isCurrent()) return;
          const result = await api.wsRefresh({ root, workspaceId, ...(observedRevision ? { observedRevision } : {}) });
          if (!isCurrent() || result.root !== root || result.workspace.id !== workspaceId) return;
          // A queued open waits for reconciliation of the receipt already sent
          // to main, including when the newer open later fails.
          this.apply(result);
          await reconcile(result, isCurrent);
          return result;
        }).finally(() => {
          if (diskRefreshTask === task) {
            diskRefreshTask = null;
            diskRefreshPending.value = false;
          }
        });
        diskRefreshTask = task;
        return task;
      },

      hasPendingDiskRefresh(): boolean {
        return diskRefreshPending.value;
      },

      reset(): Promise<void> {
        const epoch = ++contextEpoch;
        return enqueueContextOperation(async () => {
          if (epoch !== contextEpoch) return;
          this.opened = false;
          this.name = "";
          this.root = "";
          this.workspace = null;
          this.tree = null;
          this.problems = [];
          this.readOnly = false;
          this.revision = "";
          this.diskObservation = null;
          this.diskObservationIssue = null;
          observationEpoch++;
        });
      },

      hasPendingOpen(): boolean {
        return pendingOpenCount.value > 0;
      },

      projectLocatorForApi(locator: ApiLocator): ProjectLocator | null {
        const matches: ProjectLocator[] = [];
        const visit = (node: LocalTreeNodeDTO, project: ProjectLocator | null): void => {
          if (node.kind === "project") {
            project = { workspaceId: node.locator.workspaceId, groupId: node.locator.groupId, projectId: node.locator.projectId };
          }
          if (node.kind === "api" && sameApiLocator(node.locator, locator) && project) matches.push(project);
          for (const child of node.children ?? []) visit(child, project);
        };
        if (this.tree) visit(this.tree, null);
        return matches.length === 1 ? { ...matches[0]! } : null;
      },

      async saveStressPolicy(locator: ProjectLocator, policy: StressTargetPolicy): Promise<StressTargetPolicy> {
        const normalized = normalizePolicy(policy);
        const saved = await api.stressPolicySave(locator, normalized);
        const project = this.findProject(locator);
        if (project) project.stressPolicy = saved;
        return saved;
      },

      async trustStressOrigin(locator: ProjectLocator, origin: string): Promise<StressTargetPolicy> {
        const project = this.findProject(locator);
        const current = project?.stressPolicy ?? { trustedOrigins: [], deniedOrigins: [] };
        return this.saveStressPolicy(locator, {
          ...current,
          trustedOrigins: [...(current.trustedOrigins ?? []), normalizeOrigin(origin)],
        });
      },

      apply(result: OpenResult): void {
        // Pinia's recursive `this` typing expands deeply with ContractWorkspace; the runtime state
        // has this exact, explicitly declared shape and the cast is limited to that boundary.
        this.$patch((state) => applyOpenResult(state as unknown as WorkspaceState, result));
        observationEpoch++;
        this.diskObservation = null;
        this.diskObservationIssue = null;
      },

      findProject(locator: ProjectLocator): LocalProjectTreeNodeDTO | null {
        const tree = this.tree;
        if (!tree) return null;
        const group: LocalGroupTreeNodeDTO | undefined = tree.children.find((node): node is LocalGroupTreeNodeDTO => node.kind === "group"
          && node.locator.workspaceId === locator.workspaceId && node.locator.groupId === locator.groupId);
        if (!group) return null;
        const project: LocalProjectTreeNodeDTO | undefined = group.children.find((node): node is LocalProjectTreeNodeDTO => node.kind === "project"
          && node.locator.workspaceId === locator.workspaceId
          && node.locator.groupId === locator.groupId
          && node.locator.projectId === locator.projectId);
        return project ?? null;
      },
    },
  })(createPinia());
}
