import { createPinia, defineStore } from "pinia";
import type { RunResult } from "@apicc/core";
import type { CollectionLocator } from "../../../shared/locations.js";
import type { ApiccApi, RunSummaryDTO, StressReportDTO, StressRunSummaryDTO } from "../../../shared/types.js";

function copyLocator(locator: CollectionLocator): CollectionLocator {
  return { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId, collectionId: locator.collectionId };
}

/** Collection runs capture their full target before any asynchronous work starts. */
export function useRunStore(api: ApiccApi) {
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
        if (this.targetRoot === root && JSON.stringify(this.target) === JSON.stringify(next)) return;
        this.generation += 1;
        this.targetRoot = root;
        this.target = next;
        this.result = null;
        this.running = false;
      },
      async runCollection(root: string, locator: CollectionLocator, envName?: string) {
        if (this.running) return;
        const target = copyLocator(locator);
        this.setTarget(root, target);
        const generation = this.generation;
        this.running = true;
        try {
          const result = await api.runCollection({ locator: target, envName });
          if (generation === this.generation) this.result = result;
        } finally {
          if (generation === this.generation) this.running = false;
        }
      },
      async loadHistory() {
        this.summaries = await api.runsList();
      },
      async openRun(file: string): Promise<RunResult | StressReportDTO | null> {
        const run = await api.runsGet(file);
        if (!run) return null;
        if ("kind" in run) this.stressReport = run;
        else this.result = run;
        return run;
      },
    },
  })(createPinia());
}
