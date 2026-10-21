// @vitest-environment jsdom
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import { mount, flushPromises, enableAutoUnmount } from "@vue/test-utils";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { createTestingStore } from "../../../src/renderer/src/stores/testing.js";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import { contractAssetFixture } from "../helpers/contract-assets.js";
import DatasetPanel from "../../../src/renderer/src/components/DatasetPanel.vue";
import SuitePanel from "../../../src/renderer/src/components/SuitePanel.vue";
enableAutoUnmount(afterEach);

async function testingCenter(stressClient?: NonNullable<Parameters<typeof createMemoryApi>[0]>["stressClient"]) {
  const root = mkdtempSync(join(tmpdir(), "apicc-testing-center-"));
  const api = createMemoryApi({ root, stressClient });
  const fixture = await contractAssetFixture(api, root);
  const confirmDiscard = vi.fn(() => true);
  const store = createTestingStore(api, { confirmDiscard });
  await store.activate(root, fixture.projectLocator);
  const { i18n } = createI18nInstance();
  return { ...fixture, store, confirmDiscard, mountDataset: () => mount(DatasetPanel, { props: { testing: store }, global: { plugins: [i18n] } }), mountSuite: () => mount(SuitePanel, { props: { testing: store }, global: { plugins: [i18n] } }) };
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
describe("current project testing center", () => {
  it("G binds exported bytes to their actual format after the selection changes", async () => {
    const { store, mountDataset } = await testingCenter();
    await store.newDataset("exported"); store.dataset!.columns = ["value"]; store.dataset!.rows = [{ value: 1 }]; await store.save();
    const panel = mountDataset();
    await panel.findAll("button").find(button => /导出预览|Preview export/.test(button.text()))!.trigger("click"); await flushPromises();
    await panel.get(".exchange select").setValue("csv");
    let blob!: Blob; const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL"); const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: (value: Blob) => { blob = value; return "blob:export-test"; } });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { expect(this.download).toBe("exported.json"); });
    try { await panel.findAll("button").find(button => /^(下载|Download)$/.test(button.text()))!.trigger("click"); expect(blob.type).toBe("application/json"); }
    finally { click.mockRestore(); if (createDescriptor) Object.defineProperty(URL, "createObjectURL", createDescriptor); else Reflect.deleteProperty(URL, "createObjectURL"); if (revokeDescriptor) Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor); else Reflect.deleteProperty(URL, "revokeObjectURL"); }
  });
  it("G creates and clears optional query dimensions consistently through save, preview and run", async () => {
    const { store, mountSuite, api, collection, apiLocator } = await testingCenter();
    const detail = await api.apiGet(apiLocator); detail.api.cases[0]!.tags = ["smoke"];
    await api.apiSave(apiLocator, detail.api, detail.sourceApiRevision); await store.refresh();
    await store.newSuite("query"); const panel = mountSuite();
    await panel.findAll("select").find(select => Array.from((select.element as HTMLSelectElement).options).some(option => option.value === "query"))!.setValue("query");
    expect(store.suite!.selection).toEqual({ kind: "query" });
    await panel.get('select[multiple]').setValue([collection.id]);
    await store.save(); await store.previewSuite(); await store.run();
    expect(store.result!.result.total).toBe(1);
    expect((await api.runsList())[0]).toMatchObject({ total: 1, passed: 1, failed: 0, reportingUnits: { total: 1, entryDiagnostics: 0 } });
    await panel.get('select[multiple]').setValue([]); await store.save(); await store.previewSuite();
    expect(store.suite!.selection).toEqual({ kind: "query" });
    const tagInput = panel.findAll('.editor-scroll input:not([type="checkbox"])').at(-1)!;
    await tagInput.setValue("smoke"); expect(store.suite!.selection).toEqual({ kind: "query", caseTags: ["smoke"] });
    await store.save(); await store.previewSuite();
    await api.containerSave({ kind: "collection", locator: collection.locator, operations: { variables: {}, preOperations: [], postOperations: [{ id: crypto.randomUUID(), type: "script", content: 'throw new Error("container diagnostic");' }] } });
    await store.refresh(); await store.run();
    expect((await api.runsList())[0]).toMatchObject({ total: 1, passed: 1, failed: 0, reportingUnits: { total: 2, failed: 1, entryDiagnostics: 1 } });
    expect(panel.text()).toContain("row=—");
    await tagInput.setValue(""); expect(store.suite!.selection).toEqual({ kind: "query" });
  });
  it.each(["dataset", "suite"] as const)("preserves %s edits made while refresh awaits its saved response", async kind => {
    const { store, api, root, projectLocator, confirmDiscard } = await testingCenter();
    if (kind === "dataset") {
      await store.newDataset("before"); store.dataset!.columns = ["value"]; store.dataset!.rows = [{ value: "before" }];
    } else await store.newSuite("before");
    await store.save();
    const stale = await api.listTestingAssets({ root, project: projectLocator });
    const response = deferred<typeof stale>(); api.listTestingAssets = () => response.promise;
    const refreshing = store.refresh();
    if (kind === "dataset") { store.dataset!.name = "edited"; store.dataset!.rows[0]!.value = false; }
    else { store.suite!.name = "edited"; store.suite!.selection = { kind: "query", caseTags: ["changed"] }; }
    const edited = JSON.stringify(store.dataset ?? store.suite);
    response.resolve(stale); await refreshing;
    expect(JSON.stringify(store.dataset ?? store.suite)).toBe(edited);
    expect(store.dirty).toBe(true);
    confirmDiscard.mockReturnValueOnce(false);
    expect(store.confirmLeave()).toBe(false);
    expect(JSON.stringify(store.dataset ?? store.suite)).toBe(edited);
  });
  it.each(["select", "newSuite", "newDataset", "activate", "evict"] as const)("aborts and finishes A before %s can replace its cancellable invocation", async action => {
    const entered = deferred<void>(); const finished = deferred<void>();
    let requests = 0; let aborts = 0;
    const fixture = await testingCenter({ name: "held-http", canHandle: () => true, close: async () => {}, execute: async (_request, options) => {
      requests++; entered.resolve();
      return new Promise(resolve => options.signal!.addEventListener("abort", () => {
        aborts++; void finished.promise.then(() => resolve({ status: 0, headers: {}, bodyText: "", timeMs: 0 }));
      }, { once: true }));
    } });
    const { store, api, root, projectLocator, group } = fixture;
    const other = await api.nodeCreate({ kind: "project", parent: group.locator, name: "other" });
    if (other.kind !== "project") throw new Error("Expected other project");
    await store.refresh();
    await store.newSuite("A"); store.suite!.selection = { kind: "query" }; await store.save(); const a = store.suite!.id;
    await store.newSuite("B"); store.suite!.selection = { kind: "query" }; await store.save(); const b = store.suite!.id;
    await store.select("suite", a);
    let captured: Parameters<typeof api.runSuite>[0] | null = null;
    const run = api.runSuite.bind(api); api.runSuite = input => { captured = input; return run(input); };
    const pending = store.run(); await entered.promise;
    let changed = false;
    const transition = Promise.resolve(action === "select" ? store.select("suite", b) : action === "newSuite" ? store.newSuite("new") : action === "newDataset" ? store.newDataset("new") : action === "activate" ? store.activate(root, other.locator) : store.evict(root, projectLocator)).then(() => { changed = true; });
    try {
      await flushPromises();
      expect(aborts).toBe(1);
      expect(changed).toBe(false);
      expect(store.running).toBe(true);
      expect(store.readOnly).toBe(true);
      expect(store.suite?.id).toBe(a);
      await store.run().catch(() => {});
      expect(requests).toBe(1);
      const cancelling = store.cancel();
      finished.resolve(); await cancelling; await pending; await transition;
      expect(store.running).toBe(false);
      expect(store.result).toBeNull();
      if (action === "select") expect(store.suite?.id).toBe(b);
      if (action === "newSuite") expect(store.suite?.name).toBe("new");
      if (action === "newDataset") expect(store.dataset?.name).toBe("new");
      if (action === "activate") expect(store.view?.context.project).toEqual(other.locator);
      if (action === "evict") expect(store.view).toBeNull();
    } finally {
      if (captured) await api.cancelSuite(captured);
      finished.resolve(); await pending.catch(() => {}); await transition.catch(() => {});
    }
  });
  it("previews typed import, saves/reopens cells and paginates at 100 rows", async () => {
    const { store, api, root, projectLocator, mountDataset } = await testingCenter();
    await store.newDataset("table");
    const wrapper = mountDataset();
    const saving = vi.spyOn(store, "save");
    await wrapper.get('[data-testid="dataset-import-content"]').setValue(JSON.stringify(Array.from({ length: 101 }, (_, index) => ({ value: index, optional: index === 0 ? null : false }))));
    await wrapper.get('[data-testid="dataset-import-preview"]').trigger("click");
    await flushPromises();
    expect(store.importPreview?.rows).toHaveLength(101);
    expect(store.dataset!.rows).toEqual([]);
    await wrapper.get('[data-testid="dataset-import-apply"]').trigger("click");
    expect(wrapper.findAll('[data-testid="dataset-row"]')).toHaveLength(100);
    await wrapper.get('[data-testid="dataset-page-next"]').trigger("click");
    expect(wrapper.findAll('[data-testid="dataset-row"]')).toHaveLength(1);
    await wrapper.get('[data-testid="dataset-save"]').trigger("click");
    await saving.mock.results[0]!.value;
    await flushPromises();
    expect(store.dirty).toBe(false);
    const fresh = createMemoryApi({ root }); await fresh.wsOpen(root);
    const reopened = await fresh.listTestingAssets({ root, project: projectLocator });
    expect(reopened.datasets[0]!.rows[0]).toEqual({ value: 0, optional: null });
    expect(await api.exportDataset({ context: reopened.context, locator: { ...projectLocator, datasetId: reopened.datasets[0]!.id }, format: "json" })).toContain('"optional": null');
  });
  it("keeps dirty confirmation and readonly protection, rejects late imports after project selection changes", async () => {
    const { store, confirmDiscard, api, projectLocator, root, mountDataset } = await testingCenter();
    await store.newDataset("keep");
    confirmDiscard.mockReturnValueOnce(false);
    expect(await store.newSuite("rejected")).toBe(false);
    expect(store.dataset!.name).toBe("keep");
    await store.save();
    store.dataset!.name = "unsaved rename";
    confirmDiscard.mockReturnValueOnce(false);
    await store.remove();
    expect(store.dataset?.name).toBe("unsaved rename");
    store.discard();
    let resolve!: (value: { columns: string[]; rows: Array<Record<string, number>> }) => void;
    const original = api.importDataset;
    api.importDataset = () => new Promise(done => { resolve = done; });
    const pending = store.previewImport("json", '[{"value":1}]');
    await store.activate(root, { ...projectLocator, projectId: crypto.randomUUID() }).catch(() => {});
    resolve({ columns: ["value"], rows: [{ value: 1 }] }); await pending;
    expect(store.importPreview).toBeNull();
    api.importDataset = original;
    await store.activate(root, projectLocator, true);
    const wrapper = mountDataset();
    expect((wrapper.get('[data-testid="dataset-save"]').element as HTMLButtonElement).disabled).toBe(true);
    await expect(store.newDataset("forbidden")).rejects.toThrow(/read.only|只读/i);
  });
  it("saves a selected suite, previews the actual scope/scale and shows entry counts after run", async () => {
    const { store, mountSuite } = await testingCenter();
    await store.newSuite("smoke");
    const wrapper = mountSuite();
    const saving = vi.spyOn(store, "save");
    await wrapper.get('[data-testid="suite-case-choice"]').setValue(true);
    await wrapper.get('[data-testid="suite-save"]').trigger("click"); await saving.mock.results[0]!.value; await flushPromises();
    const previewing = vi.spyOn(store, "previewSuite");
    await wrapper.get('[data-testid="suite-preview"]').trigger("click"); await flushPromises();
    await previewing.mock.results[0]!.value; await flushPromises();
    expect(store.preview!.plannedExecutions).toBe(1);
    expect(wrapper.get('[data-testid="suite-preview-result"]').text()).toContain("base");
    const running = vi.spyOn(store, "run");
    await wrapper.get('[data-testid="suite-run"]').trigger("click"); await running.mock.results[0]!.value; await flushPromises();
    expect(store.result!.result.suite).toMatchObject({ total: 1, passed: 1, failed: 0, skipped: 0 });
    expect(wrapper.get('[data-testid="suite-result"]').text()).toContain("smoke");
  });
});
