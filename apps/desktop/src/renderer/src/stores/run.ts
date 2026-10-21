import { createPinia, defineStore } from "pinia";
import type { EvidenceIdentity, RunResult } from "@apicc/core";
import type { CollectionLocator } from "../../../shared/locations.js";
import type { ApiccApi, RunSummaryDTO, StressReportDTO, StressRunSummaryDTO } from "../../../shared/types.js";

function copyLocator(locator: CollectionLocator): CollectionLocator {
  return { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId, collectionId: locator.collectionId };
}

/** Collection runs capture their full target before any asynchronous work starts. */
export function useRunStore(api: ApiccApi) {
  type EvidenceExecution = { input?: import("../../../shared/testing.js").EvidenceInvocation; cancelled: boolean; completion: Promise<void>; cleanup?: Promise<void> };
  let activeEvidence: EvidenceExecution | null = null;
  let cleanup: Promise<void> = Promise.resolve();
  const stopEvidence = () => {
    const captured = activeEvidence; if (!captured) return cleanup;
    captured.cancelled = true;
    captured.cleanup ??= (async () => { try { if (captured.input) await api.cancelEvidence(captured.input); } finally { await captured.completion.catch(() => {}); } })().catch(() => {});
    cleanup = captured.cleanup;
    return cleanup;
  };
  return defineStore("run", {
    state: () => ({
      running: false,
      result: null as RunResult | null,
      summaries: [] as Array<RunSummaryDTO | StressRunSummaryDTO>,
      historyOpen: false,
      stressReport: null as StressReportDTO | null,
      target: null as CollectionLocator | null,
      targetRoot: null as string | null,
      generation: 0,
    }),
    actions: {
      setTarget(root: string | null, locator: CollectionLocator | null) {
        const next = root && locator ? copyLocator(locator) : null;
        if (this.targetRoot === root && JSON.stringify(this.target) === JSON.stringify(next)) return cleanup;
        const stopped = stopEvidence();
        this.generation += 1;
        this.targetRoot = root;
        this.target = next;
        this.result = null;
        this.running = activeEvidence !== null;
        return stopped;
      },
      async runCollection(root: string, locator: CollectionLocator, envName?: string) {
        if (this.running || activeEvidence) return;
        const target = copyLocator(locator);
        this.setTarget(root, target);
        const generation = this.generation;
        this.running = true;
        try {
          await cleanup; if (generation !== this.generation) return;
          const result = await api.runCollection({ locator: target, envName });
          if (generation === this.generation) this.result = result;
        } finally {
          if (generation === this.generation) this.running = false;
        }
      },
      async loadHistory() {
        const generation = this.generation; const values = await api.runsList();
        if (generation === this.generation) this.summaries = values.filter((value) => !value.projectId || value.projectId === this.target?.projectId);
      },
      async openRun(file: string): Promise<RunResult | StressReportDTO | null> {
        const generation = this.generation; const projectId = this.target?.projectId;
        const run = await api.runsGet(file);
        if (!run || generation !== this.generation) return null;
        const owner = run.kind === "stress" ? run.report.projectId : run.projectId ?? run.suite?.projectId;
        if (owner && owner !== projectId) throw new Error("历史记录不属于当前项目");
        if (run.kind === "stress") this.stressReport = run;
        else this.result = run;
        return run;
      },
      async inspectEvidence(identity: EvidenceIdentity) {
        if (!this.target || !this.targetRoot || identity.projectId !== this.target.projectId) throw new Error("历史证据不属于当前项目");
        const view = await api.listTestingAssets({ root: this.targetRoot, project: { workspaceId: this.target.workspaceId, groupId: this.target.groupId, projectId: this.target.projectId } });
        return api.inspectEvidence({ context: view.context, identity, invocationId: crypto.randomUUID() });
      },
      async rerunEvidence(identity: EvidenceIdentity) {
        if (this.running || activeEvidence || !this.target || !this.targetRoot || identity.projectId !== this.target.projectId) return;
        const token = this.generation; const root = this.targetRoot; const target = copyLocator(this.target); const priorCleanup = cleanup;
        const capturedIdentity = { ...identity, ...(identity.locator ? { locator: { ...identity.locator, folderIds: [...identity.locator.folderIds] } } : {}) };
        const execution: EvidenceExecution = { cancelled: false, completion: Promise.resolve() };
        activeEvidence = execution;
        this.running = true;
        const current = () => activeEvidence === execution && !execution.cancelled && token === this.generation;
        execution.completion = (async () => {
          try {
            await priorCleanup; if (!current()) return;
            const view = await api.listTestingAssets({ root, project: { workspaceId: target.workspaceId, groupId: target.groupId, projectId: target.projectId } });
            if (!current()) return;
            execution.input = { context: view.context, identity: capturedIdentity, invocationId: crypto.randomUUID() };
            const value = await api.rerunEvidence(execution.input);
            if (current()) this.result = value;
          } finally { if (activeEvidence === execution) { activeEvidence = null; this.running = false; } }
        })();
        return execution.completion;
      },
    },
  })(createPinia());
}
