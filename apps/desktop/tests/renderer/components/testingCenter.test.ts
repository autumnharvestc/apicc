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
  return { ...fixture, store, confirmDiscard, i18n, mountDataset: () => mount(DatasetPanel, { props: { testing: store }, global: { plugins: [i18n] } }), mountSuite: () => mount(SuitePanel, { props: { testing: store }, global: { plugins: [i18n] } }) };
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
describe("current project testing center", () => {
  it("P3c treats inherited property names as missing cells in real JSON imports", async () => {
    const { store, mountDataset, i18n } = await testingCenter(); i18n.global.locale.value = 'en';
    await store.newDataset('prototype columns');
    const source = '[{"toString":0,"constructor":false},{}]';
    await store.previewImport('json', source);
    const panel = mountDataset();
    expect(panel.get('[data-testid="dataset-import-table"]').findAll('tbody tr').map(row => row.findAll('td').map(cell => cell.text()))).toEqual([['0','false'],['Missing','Missing']]);
    await panel.get('[data-testid="dataset-import-apply"]').trigger('click');
    expect(store.dataset!.rows).toEqual(JSON.parse(source));
    expect(panel.get('input[aria-label="Row 2 · toString"]').element).toHaveProperty('value','');
    expect(panel.get('input[aria-label="Row 2 · constructor"]').element).toHaveProperty('value','');
  });
  it("P3c renders typed import cells without losing missing, null, false, zero or business JSON", async () => {
    const { store, mountDataset, i18n } = await testingCenter();
    await store.newDataset("typed");
    const source = [{ value: 0, extra: null }, { value: false }, { value: "", extra: { label: "passed" } }];
    await store.previewImport("json", JSON.stringify(source));
    const panel = mountDataset();
    for (const locale of ["zh-CN", "en"] as const) {
      i18n.global.locale.value = locale; await flushPromises();
      const table = panel.get('[data-testid="dataset-import-table"]');
      expect(table.findAll('tbody tr').map(row => row.findAll('td').map(cell => cell.text()))).toEqual([
        ['0', 'null'], ['false', locale === 'zh-CN' ? '缺字段' : 'Missing'], ['""', '{"label":"passed"}'],
      ]);
      expect(store.dataset!.rows).toEqual([]);
    }
    await panel.get('[data-testid="dataset-import-apply"]').trigger('click');
    expect(store.dataset!.rows).toEqual(source);
  });
  it("P3c names page and row controls and deletes only the chosen second-page row", async () => {
    const { store, mountDataset, i18n } = await testingCenter(); i18n.global.locale.value = 'en';
    await store.newDataset('pages'); store.dataset!.columns = ['value']; store.dataset!.rows = Array.from({length: 101}, (_, value) => ({value}));
    const panel = mountDataset();
    await panel.get('button[aria-label="Next page"]').trigger('click');
    expect(panel.get('input[aria-label="Row 101 · value"]').element).toHaveProperty('value', '100');
    await panel.get('button[aria-label="Delete row 101"]').trigger('click');
    expect(store.dataset!.rows).toHaveLength(100); expect(store.dataset!.rows[99]).toEqual({value:99});
    expect(panel.find('button[aria-label="Delete row 101"]').exists()).toBe(false);
    store.view!.readOnly = true; await flushPromises();
    expect(panel.get('button[aria-label="Delete row 1"]').attributes('disabled')).toBeDefined();
  });
  it("P3c presents suite preview facts and moves named entries without translating business names", async () => {
    const { store, mountSuite, i18n } = await testingCenter(); i18n.global.locale.value = 'en';
    await store.newSuite('ordered');
    const item = store.view!.cases[0]!;
    store.view!.workflows.push({id:'workflow', name:'passed', status:'draft'});
    store.suite!.selection = {kind:'explicit', entries:[{id:'case-entry',kind:'case',collectionId:item.locator.collectionId,folderIds:item.locator.folderIds,apiId:item.locator.apiId,caseId:item.caseId},{id:'workflow-entry',kind:'workflow',workflowId:'workflow'}]};
    const panel = mountSuite();
    expect(panel.get('.choices').text()).toContain('passed · Draft');
    await panel.get('button[aria-label="Move up: passed"]').trigger('click');
    expect(store.suite!.selection.entries.map(entry => entry.id)).toEqual(['workflow-entry','case-entry']);
    // Use the actual resolved preview for a valid persisted query suite.
    store.suite!.selection = {kind:'query'}; await store.save(); await store.previewSuite(); await flushPromises();
    const table = panel.get('[data-testid="suite-preview-table"]');
    expect(table.findAll('tbody tr')).toHaveLength(store.preview!.plan.entries.length);
    expect(table.get('tbody tr').text()).toContain('Case'); expect(table.text()).toContain(item.caseId); expect(table.text()).toContain('base');
    expect(table.get('tbody tr').findAll('td')[1]!.text()).toBe(String(store.preview!.entries[0]!.plannedExecutions));
    i18n.global.locale.value = 'zh-CN'; await flushPromises(); expect(table.text()).toContain('用例');
  });
  it("P3c preserves the external suite run boundary and forwards the draft choice", async () => {
    const { store, i18n } = await testingCenter(); await store.newSuite('external'); await store.save();
    const externalRun = vi.fn(async () => {}), localRun = vi.spyOn(store, 'run');
    const panel = mount(SuitePanel, {props:{testing:store, externalRun},global:{plugins:[i18n]}});
    expect(panel.find('[data-testid="suite-preview"]').exists()).toBe(false); expect(panel.find('[data-testid="suite-cancel"]').exists()).toBe(false);
    await panel.get('.run-toolbar input[type="checkbox"]').setValue(true);
    await panel.get('[data-testid="suite-run"]').trigger('click'); await flushPromises();
    expect(externalRun).toHaveBeenCalledExactlyOnceWith(true); expect(localRun).not.toHaveBeenCalled();
    store.suite!.name = 'dirty'; await flushPromises(); expect(panel.get('[data-testid="suite-run"]').attributes('disabled')).toBeDefined();
    store.discard(); store.running = true; await flushPromises(); expect(panel.get('[data-testid="suite-run"]').attributes('disabled')).toBeDefined();
  });
  it("localizes nonempty suite result rows and reporting units without translating business evidence or unknown codes", async () => {
    const { store, api, apiLocator } = await testingCenter({ name: "suite-result-language", canHandle: () => true, close: async () => {},
      execute: async () => ({ status: 200, headers: { "content-type": "text/plain" }, bodyText: "业务正文 User original", timeMs: 1 }) });
    const detail = await api.apiGet(apiLocator);
    detail.api.contract.metadata.name = "业务接口 User API";
    const passing = detail.api.cases[0]!;
    passing.name = "成功用例 User passed case"; passing.assertions = [];
    detail.api.cases.push({ ...structuredClone(passing), id: crypto.randomUUID(), name: "失败用例 User failed case", assertions: [{ id: crypto.randomUUID(), target: "status", op: "eq", expected: "201" }] });
    await api.apiSave(apiLocator, detail.api, detail.sourceApiRevision); await store.refresh();
    await store.newSuite("业务套件 User suite"); store.suite!.selection = { kind: "query" }; store.evidenceMode = "all";
    await store.save(); await store.run();
    const result = store.result!.result;
    expect(result.cases).toHaveLength(2); expect(result.reportingUnits).toMatchObject({ total: 2, failed: 1, entryDiagnostics: 0 });
    expect(result.cases.map(row => row.passed)).toEqual([true, false]);
    expect(result.cases[0]!.evidence?.response?.body.text).toBe("业务正文 User original");
    result.warnings = ["custom-result-warning-v9：用户原文"];
    const before = JSON.stringify(result);
    for (const locale of ["zh-CN", "en"] as const) {
      const { i18n } = createI18nInstance(); i18n.global.locale.value = locale;
      const panel = mount(SuitePanel, { props: { testing: store }, global: { plugins: [i18n] } });
      const units = panel.get('.result-scroll > div > p').text();
      expect.soft(units).toContain(locale === "zh-CN" ? "逻辑报告单位 2（失败 1）" : "Logical reporting units 2 (1 failed)");
      expect.soft(units).toContain(locale === "zh-CN" ? "非请求诊断 0" : "Non-request diagnostics 0");
      const summaries = panel.findAll('.result-scroll > div > details > summary');
      expect(summaries).toHaveLength(2);
      expect.soft(summaries[0]!.text()).toContain(locale === "zh-CN" ? "· 通过 · 数据行=— · 条目=" : "· Passed · Data row=— · Entry=");
      expect.soft(summaries[1]!.text()).toContain(locale === "zh-CN" ? "· 失败 · 数据行=— · 条目=" : "· Failed · Data row=— · Entry=");
      expect(summaries[0]!.text()).toContain("业务接口 User API / 成功用例 User passed case");
      expect(summaries[1]!.text()).toContain("业务接口 User API / 失败用例 User failed case");
      expect(summaries[0]!.text()).toContain(result.cases[0]!.entryId!);
      expect(panel.text()).toContain("custom-result-warning-v9：用户原文"); expect(panel.text()).toContain("业务正文 User original");
      expect(JSON.stringify(result)).toBe(before); panel.unmount();
    }
  });
  it("localizes suite terminal states while preserving aborted case facts and business errors", async () => {
    const { store } = await testingCenter();
    await store.newSuite("User suite");
    store.result = { context: store.view!.context, invocationId: "run", result: {
      collectionId: store.suite!.id, collectionName: "User suite", startedAt: "start", finishedAt: "end", total: 1, passed: 0, failed: 1,
      cases: [{ apiId: "api", apiName: "User aborted API", caseId: "case", caseName: "User aborted case", entryId: "User aborted entry", passed: false, durationMs: 0, assertions: [], failureKind: "aborted", error: "Untranslated user error" }],
      suite: { suiteRunId: "run", projectId: store.view!.context.project.projectId, definitionRevision: "revision", verdict: "aborted", total: 2, passed: 0, failed: 1, skipped: 1,
        entries: [{ entryId: "User aborted entry", kind: "case", status: "aborted", error: "Untranslated user error" }, { entryId: "User skipped entry", kind: "case", status: "skipped", skipReason: "aborted" }] },
    } };
    for (const locale of ["zh-CN", "en"] as const) {
      const { i18n } = createI18nInstance(); i18n.global.locale.value = locale;
      const panel = mount(SuitePanel, { props: { testing: store }, global: { plugins: [i18n] } });
      const summary = panel.get('[data-testid="suite-result"]').text();
      expect(summary).toContain(locale === "zh-CN" ? "中止" : "Aborted");
      expect(summary).toContain(locale === "zh-CN" ? "跳过" : "Skipped");
      expect(summary).toContain("User skipped entry"); expect(summary).toContain("Untranslated user error");
      const entries = panel.get('[data-testid="suite-result-table"]').findAll('tbody tr');
      expect(entries.map(row => row.get('th').text())).toEqual(['User aborted entry', 'User skipped entry']);
      expect(entries[0]!.findAll('td').map(cell => cell.text())).toEqual(['—', locale === 'zh-CN' ? '中止' : 'Aborted', 'Untranslated user error']);
      panel.unmount();
    }
  });
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
    const { store, mountSuite, api, collection, apiLocator, i18n } = await testingCenter();
    i18n.global.locale.value = "zh-CN";
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
    expect(panel.text()).toContain("数据行=—");
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
