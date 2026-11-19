import { reactive } from "vue";
import type { DatasetAsset, EvidenceIdentity, SuiteAsset, SuitePreview, SuiteRunOverrides } from "@apicc/core";
import type { ApiccApi, WorkspaceRefreshResult } from "../../../shared/types.js";
import type { ProjectLocator } from "../../../shared/locations.js";
import type { AssertionOperatorDTO, EvidenceInvocation, SuiteInvocation, SuiteOutput, TestingAssets } from "../../../shared/testing.js";
import { LocalWorkspaceError, type LocalWorkspaceFailure } from "../../../shared/workspace-refresh.js";
import { currentDiskRead, diskProject, sameDiskValue, type DiskDraftConflict } from "./diskDrafts.js";
import { localTestingDependencies } from "../../../shared/workspace-testing-dependencies.js";

export function createTestingStore(api: ApiccApi, options: { confirmDiscard: () => boolean; getActive?: () => { root: string; project: ProjectLocator; readOnly: boolean } | null }) {
  let generation = 0;
  let activeKey = "";
  let readonlyOverride = false;
  let activeRun: { input: SuiteInvocation | EvidenceInvocation; completion: Promise<void>; cancel: () => Promise<boolean> } | null = null;
  let navigation = 0;
  let changing = 0;
  let diskEpoch = 0;
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const key = (root: string, project: ProjectLocator) => JSON.stringify([root, project.workspaceId, project.groupId, project.projectId]);
  type Selection = {
    dataset: DatasetAsset | null; suite: SuiteAsset | null; snapshot: string; creating: boolean;
    pendingDatasetColumns: string | null; importPreview: Pick<DatasetAsset, "columns" | "rows"> | null;
    dirty: boolean; revision: string;
  };
  const parked = reactive(new Map<string, Selection>());
  const store = reactive({
    view: null as TestingAssets | null,
    operators: [] as AssertionOperatorDTO[],
    dataset: null as DatasetAsset | null,
    suite: null as SuiteAsset | null,
    snapshot: "",
    creating: false,
    busy: false,
    running: false,
    transitioning: false,
    error: "",
    diskConflict: null as DiskDraftConflict | null,
    saveFailure: null as LocalWorkspaceFailure | null,
    preview: null as SuitePreview | null,
    result: null as SuiteOutput | null,
    evidenceMode: "failures" as "none" | "failures" | "all",
    importPreview: null as Pick<DatasetAsset, "columns" | "rows"> | null,
    pendingDatasetColumns: null as string | null,
    get dirty(): boolean {
      const value = store.dataset ?? store.suite;
      return !!value && (store.creating || JSON.stringify(value) !== store.snapshot || store.pendingDatasetColumns !== null);
    },
    get current(): boolean {
      const loaded = store.view?.context;
      if (!loaded) return false;
      if (!options.getActive) return true;
      const current = options.getActive();
      return !!current && key(loaded.root, loaded.project) === key(current.root, current.project);
    },
    get readOnly(): boolean { return store.transitioning || !store.current || readonlyOverride || !!store.view?.readOnly || !!options.getActive?.()?.readOnly; },
    confirmLeave(discard = true): boolean {
      if (!store.dirty) return true;
      if (!options.confirmDiscard()) return false;
      if (discard) store.discard();
      return true;
    },
    async leave(confirmed = false) {
      if (!confirmed && !store.confirmLeave()) return false;
      if (confirmed && store.dirty) store.discard();
      return navigate(() => true);
    },
    discard() {
      if (store.creating) { store.dataset = null; store.suite = null; }
      else if (store.snapshot) {
        if (store.dataset) store.dataset = JSON.parse(store.snapshot) as DatasetAsset;
        if (store.suite) store.suite = JSON.parse(store.snapshot) as SuiteAsset;
      }
      store.creating = false; store.importPreview = null; generation++;
      store.pendingDatasetColumns = null;
      store.diskConflict = null; store.saveFailure = null;
    },
    hasDraft(root: string, project: ProjectLocator) {
      const scope = key(root, project);
      return scope === activeKey ? store.dirty : !!parked.get(scope)?.dirty;
    },
    async evict(root: string, project: ProjectLocator) {
      parked.delete(key(root, project));
      if (activeKey !== key(root, project)) return;
      return navigate(() => {
        generation++; activeKey = ""; store.view = null; store.dataset = null; store.suite = null; store.snapshot = ""; store.creating = false; store.importPreview = null; store.preview = null; store.result = null; store.running = false; store.busy = false;
        store.diskConflict = null; store.saveFailure = null;
        store.pendingDatasetColumns = null;
      });
    },
    async activate(root: string, project: ProjectLocator | null, readOnly = false, retainSelection = false) {
      const target = project ? key(root, project) : "";
      if (!retainSelection && target !== activeKey && store.dirty && !store.confirmLeave()) return false;
      if (target === activeKey && store.view && !changing) { readonlyOverride = readOnly; return true; }
      return navigate(async () => {
        if (retainSelection && activeKey !== target && store.view) {
          if (store.dataset || store.suite) parked.set(activeKey, {
            dataset: store.dataset, suite: store.suite, snapshot: store.snapshot, creating: store.creating, dirty: store.dirty,
            pendingDatasetColumns: store.pendingDatasetColumns, importPreview: store.importPreview, revision: store.view.context.revision,
          });
          else parked.delete(activeKey);
        }
        const token = ++generation;
        activeKey = target; readonlyOverride = readOnly;
        store.view = null; store.dataset = null; store.suite = null; store.snapshot = ""; store.creating = false;
        store.preview = null; store.result = null; store.importPreview = null; store.error = ""; store.busy = true; store.running = false;
        store.diskConflict = null; store.saveFailure = null;
        store.pendingDatasetColumns = null;
        if (!project || !root) { store.busy = false; return true; }
        try {
          const view = await currentDiskRead(() => api.listTestingAssets({ root, project: clone(project) }), () => diskEpoch,
            () => generation === token && activeKey === target);
          if (!view || generation !== token || activeKey !== target) return false;
          const operators = await api.assertionOperators();
          if (generation !== token || activeKey !== target) return false;
          store.view = view; store.operators = operators;
          const saved = retainSelection ? parked.get(target) : undefined;
          if (saved) {
            const current = saved.dataset ? view.datasets.find(item => item.id === saved.dataset?.id)
              : view.suites.find(item => item.id === saved.suite?.id);
            parked.delete(target);
            if (!saved.creating && !current) { store.error = "workbenchPosition.unavailable"; return true; }
            const restoreSaved = () => {
              if (generation !== token || target !== activeKey) return;
              store.dataset = current && saved.dataset ? clone(current as DatasetAsset) : null;
              store.suite = current && saved.suite ? clone(current as SuiteAsset) : null;
              store.snapshot = JSON.stringify(current ?? null); store.creating = false;
              store.importPreview = null; store.pendingDatasetColumns = null; store.diskConflict = null;
            };
            if (saved.dirty && !readOnly && !view.readOnly) {
              store.dataset = saved.dataset; store.suite = saved.suite; store.snapshot = saved.snapshot;
              store.creating = saved.creating; store.pendingDatasetColumns = saved.pendingDatasetColumns; store.importPreview = saved.importPreview;
              if (saved.creating ? !!current : !sameDiskValue(current, JSON.parse(saved.snapshot)) || !!saved.suite && view.context.revision !== saved.revision)
                store.diskConflict = { reason: "changed", name: (saved.dataset ?? saved.suite)!.name, restore: restoreSaved };
            } else restoreSaved();
          }
          return true;
        } catch (error) { if (generation === token) store.error = message(error); throw error; }
        finally { if (generation === token) store.busy = false; }
      });
    },
    validateSelection(assets: { datasets?: readonly DatasetAsset[]; suites?: readonly SuiteAsset[] }) {
      if (!store.current || !store.view) return;
      const datasetIds = new Set(assets.datasets?.map(item => item.id));
      const suiteIds = new Set(assets.suites?.map(item => item.id));
      store.view.datasets = store.view.datasets.filter(item => datasetIds.has(item.id));
      store.view.suites = store.view.suites.filter(item => suiteIds.has(item.id));
      if (store.creating) return;
      if (store.dataset && !datasetIds.has(store.dataset.id)
        || store.suite && !suiteIds.has(store.suite.id)) {
        generation++; store.dataset = null; store.suite = null; store.snapshot = ""; store.pendingDatasetColumns = null;
        store.preview = null; store.result = null; store.importPreview = null; store.diskConflict = null; store.saveFailure = null;
        store.busy = false; store.error = "workbenchPosition.unavailable";
      }
    },
    async select(kind: "dataset" | "suite", id: string) {
      if (!store.current || !store.view) return false;
      if (!changing && (store.dataset?.id === id && kind === "dataset" || store.suite?.id === id && kind === "suite")) return true;
      const find = () => (kind === "dataset" ? store.view?.datasets : store.view?.suites)?.find(item => item.id === id);
      if (id && !find() || !store.confirmLeave(false)) return false;
      return navigate(() => {
        const asset = find();
        if (!store.current || id && !asset) return false;
        generation++; store.dataset = asset && kind === "dataset" ? clone(asset as DatasetAsset) : null; store.suite = asset && kind === "suite" ? clone(asset as SuiteAsset) : null;
        store.snapshot = asset ? JSON.stringify(asset) : ""; store.creating = false; store.preview = null; store.result = null; store.importPreview = null; store.error = ""; store.busy = false; store.running = false;
        store.diskConflict = null; store.saveFailure = null;
        store.pendingDatasetColumns = null;
        return true;
      });
    },
    async newDataset(name: string) {
      writable(); if (!store.confirmLeave()) return false;
      return navigate(() => {
        writable();
        generation++; store.dataset = { formatVersion: 1, id: crypto.randomUUID(), name, columns: [], rows: [] }; store.suite = null; store.creating = true; store.snapshot = ""; store.importPreview = null; store.preview = null; store.result = null; store.busy = false; store.running = false; return true;
      });
    },
    async newSuite(name: string) {
      writable(); if (!store.confirmLeave()) return false;
      return navigate(() => {
        writable();
        generation++; store.suite = { formatVersion: 1, id: crypto.randomUUID(), name, tags: [], failFast: false, reporters: ["html"], selection: { kind: "explicit", entries: [] } }; store.dataset = null; store.creating = true; store.snapshot = ""; store.importPreview = null; store.preview = null; store.result = null; store.busy = false; store.running = false; return true;
      });
    },
    async save() {
      writable(); const token = generation; const asset = clone(store.dataset ?? store.suite); if (!asset) return;
      if (store.diskConflict) throw new Error("disk-draft-blocked");
      const currentDisk = diskEpoch;
      const context = clone(store.view!.context); const savedSnapshot = JSON.stringify(asset); store.busy = true;
      store.saveFailure = null;
      try {
        const view = store.dataset
          ? await api.saveDataset({ context, locator: { ...context.project, datasetId: asset.id }, asset: asset as DatasetAsset, create: store.creating })
          : await api.saveSuite({ context, locator: { ...context.project, suiteId: asset.id }, asset: asset as SuiteAsset, create: store.creating });
        if (token !== generation || currentDisk !== diskEpoch || !store.current) return;
        store.view = view; store.snapshot = savedSnapshot; store.creating = false; store.error = ""; store.preview = null;
      } catch (error) {
        if (token === generation && currentDisk === diskEpoch) {
          if (error instanceof LocalWorkspaceError) {
            store.saveFailure = error.failure;
            store.error = error.failure.reason;
          } else store.error = message(error);
        }
        throw error;
      }
      finally { if (token === generation) store.busy = false; }
    },
    async remove() {
      if (store.diskConflict) throw new Error("disk-draft-blocked");
      writable(); if (!store.confirmLeave()) return;
      return navigate(async () => {
        writable();
        const token = generation; const context = clone(store.view!.context);
        const target = store.dataset ? { kind: "dataset" as const, locator: { ...context.project, datasetId: store.dataset.id } } : store.suite ? { kind: "suite" as const, locator: { ...context.project, suiteId: store.suite.id } } : null;
        if (!target) return;
        const view = await api.deleteTestingAsset({ context, target });
        if (token !== generation || !store.current) return;
        store.view = view; store.dataset = null; store.suite = null; store.snapshot = ""; store.creating = false; store.preview = null; store.result = null; generation++;
        store.pendingDatasetColumns = null;
      });
    },
    async previewImport(format: "csv" | "json", content: string) {
      writable(); const token = generation; const before = JSON.stringify(store.dataset);
      const preview = await api.importDataset({ context: clone(store.view!.context), format, content });
      if (token === generation && store.current && JSON.stringify(store.dataset) === before) store.importPreview = preview;
    },
    applyImport() { writable(); if (store.dataset && store.importPreview) { Object.assign(store.dataset, clone(store.importPreview)); store.importPreview = null; store.pendingDatasetColumns = null; } },
    async exportDataset(format: "csv" | "json") {
      if (!store.current || !store.view || !store.dataset || store.dirty) throw new Error("Save dataset before export");
      const token = generation; const result = await api.exportDataset({ context: clone(store.view.context), locator: { ...store.view.context.project, datasetId: store.dataset.id }, format });
      return token === generation && store.current ? result : null;
    },
    async refresh() {
      if (!store.current || !store.view || store.dirty) return;
      const token = generation; const context = clone(store.view.context);
      const draft = JSON.stringify(store.dataset ?? store.suite);
      const snapshot = store.snapshot;
      const view = await api.listTestingAssets({ root: context.root, project: context.project });
      if (generation !== token || !store.current || store.dirty || store.snapshot !== snapshot || JSON.stringify(store.dataset ?? store.suite) !== draft) return;
      const datasetId = store.dataset?.id; const suiteId = store.suite?.id;
      store.view = view;
      if (datasetId) store.dataset = clone(view.datasets.find(item => item.id === datasetId) ?? null);
      if (suiteId) store.suite = clone(view.suites.find(item => item.id === suiteId) ?? null);
      store.snapshot = JSON.stringify(store.dataset ?? store.suite); store.preview = null;
    },
    async reconcileDiskRefresh(receipt: WorkspaceRefreshResult, isCurrent: () => boolean) {
      diskEpoch++;
      const readEpoch = diskEpoch;
      const context = store.view?.context;
      if (!context || context.root !== receipt.root) return;
      const scope = key(context.root, context.project);
      const before = diskProject(receipt.previousWorkspace, context.project);
      const after = diskProject(receipt.workspace, context.project);
      const view = after ? await api.listTestingAssets({ root: context.root, project: context.project }).catch(() => null) : null;
      if (!isCurrent() || activeKey !== scope || readEpoch !== diskEpoch || (view && view.context.revision !== receipt.revision)) return;
      if (store.error === store.saveFailure?.reason) store.error = "";
      store.saveFailure = null;
      if (view) store.view = view;
      const current = store.dataset ?? store.suite;
      if (!current) return;
      const isDataset = store.dataset !== null;
      const incoming = isDataset ? after?.datasets?.find((item) => item.id === current.id) : after?.suites?.find((item) => item.id === current.id);
      const draftChanged = store.creating ? !!incoming : !sameDiskValue(JSON.parse(store.snapshot), incoming);
      const dependenciesChanged = store.suite
        ? !sameDiskValue(localTestingDependencies(receipt.previousWorkspace, before, context.project, undefined, store.suite),
          localTestingDependencies(receipt.workspace, after, context.project, undefined, store.suite))
        : false;
      const epoch = diskEpoch, token = generation;
      const restore = () => {
        if (epoch !== diskEpoch || token !== generation || activeKey !== scope || !isCurrent()) return;
        if (isDataset) store.dataset = incoming ? clone(incoming as DatasetAsset) : null;
        else store.suite = incoming ? clone(incoming as SuiteAsset) : null;
        store.snapshot = incoming ? JSON.stringify(incoming) : "";
        store.creating = false;
        store.diskConflict = null;
        store.saveFailure = null;
        store.error = "";
        store.importPreview = null;
        store.pendingDatasetColumns = null;
        store.preview = null;
      };
      if (store.dirty && (store.diskConflict || !view || draftChanged || dependenciesChanged)) {
        store.diskConflict = {
          reason: !after || (!incoming && !store.creating) ? "deleted" : !view ? "unverified" : "changed",
          name: current.name,
          ...(view || !after ? { restore } : {}),
        };
      } else if (!store.dirty && (view || !after)) restore();
    },
    async previewSuite(overrides: SuiteRunOverrides = {}) {
      const input = suiteInput(overrides); const token = generation;
      try { const value = await api.previewSuite(input); if (token === generation && store.current) { store.preview = value; store.error = ""; } }
      catch (error) { if (token === generation) { store.preview = null; store.error = message(error); } throw error; }
    },
    async run(overrides: SuiteRunOverrides = {}, saved?: { context: TestingAssets["context"]; suiteId: string; expectedDataDigest?: string }) {
      if (activeRun || changing) return;
      const input = suiteInput(overrides, saved); const token = generation;
      let output: SuiteOutput | undefined;
      const execution = { input, completion: Promise.resolve(), cancel: () => api.cancelSuite(clone(input)) };
      activeRun = execution; store.running = true; store.result = null;
      execution.completion = (async () => {
        try { output = await api.runSuite(input); if (token === generation && store.current && store.suite?.id === input.locator.suiteId) { store.result = output; store.error = ""; } }
        catch (error) { if (token === generation && store.current) store.error = message(error); throw error; }
        finally { if (activeRun === execution) { activeRun = null; store.running = false; } }
      })();
      await execution.completion;
      return output;
    },
    async cancel() {
      if (activeRun && store.current && store.view && key(store.view.context.root, store.view.context.project) === key(activeRun.input.context.root, activeRun.input.context.project)) await stopRun();
    },
    async inspectEvidence(identity: EvidenceIdentity) {
      if (!store.current || !store.view) throw new Error("当前项目不可用");
      return api.inspectEvidence({ context: clone(store.view.context), identity: clone(identity), invocationId: crypto.randomUUID() });
    },
    async rerunEvidence(identity: EvidenceIdentity) {
      if (activeRun || changing) return;
      if (!store.current || !store.view || store.dirty) throw new Error("请先保存或丢弃当前草稿；重跑不会自动保存");
      const input: EvidenceInvocation = clone({ context: store.view.context, identity, invocationId: crypto.randomUUID() }); const token = generation;
      const execution = { input, completion: Promise.resolve(), cancel: () => api.cancelEvidence(clone(input)) };
      activeRun = execution; store.running = true;
      execution.completion = (async () => {
        try { const result = await api.rerunEvidence(input); if (token === generation && store.current) { store.result = { context: input.context, invocationId: input.invocationId, result }; store.error = ""; } }
        catch (error) { if (token === generation && store.current) store.error = message(error); throw error; }
        finally { if (activeRun === execution) { activeRun = null; store.running = false; } }
      })();
      return execution.completion;
    },
  });
  async function stopRun(): Promise<void> {
    const execution = activeRun;
    if (!execution) return;
    await execution.cancel();
    // Keep the handle until the runner has closed its owned resources, even if cancellation
    // reports an already-completed invocation or the run finishes with an aborted error.
    await execution.completion.catch(() => {});
  }
  async function navigate<T>(change: () => T | Promise<T>): Promise<T | false> {
    const token = ++navigation; const scope = activeKey;
    const draft = JSON.stringify(store.dataset ?? store.suite); changing++; store.transitioning = true;
    try {
      await stopRun();
      if (navigation !== token || activeKey !== scope) return false;
      if (JSON.stringify(store.dataset ?? store.suite) !== draft && store.dirty && !store.confirmLeave(false)) return false;
      return await change();
    } finally { changing--; store.transitioning = changing > 0; }
  }
  function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
  function writable() { if (!store.current || readonlyOverride || store.view?.readOnly || options.getActive?.()?.readOnly) throw new Error("Testing project is read-only"); }
  function suiteInput(overrides: SuiteRunOverrides, saved?: { context: TestingAssets["context"]; suiteId: string; expectedDataDigest?: string }): SuiteInvocation {
    const context = saved?.context ?? store.view?.context, suiteId = saved?.suiteId ?? store.suite?.id;
    if (!store.current || !context || !suiteId || key(context.root, context.project) !== activeKey
      || (store.suite?.id === suiteId && store.dirty)) throw new Error("Save suite before preview/run");
    const { reporters, ...values } = overrides;
    return clone({ context, locator: { ...context.project, suiteId }, ...(saved?.expectedDataDigest ? {expectedDataDigest: saved.expectedDataDigest} : {}), evidenceMode: store.evidenceMode, overrides: { ...values, ...(reporters ? { reporters: [...reporters] } : {}) }, invocationId: crypto.randomUUID() });
  }
  return store;
}
export type TestingStore = ReturnType<typeof createTestingStore>;
