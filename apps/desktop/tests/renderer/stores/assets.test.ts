// @vitest-environment node
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileStorage, type ComponentAsset, type ModelAsset, type StorageAdapter } from "@apicc/core";
import { isProxy, reactive } from "vue";
import { useAssetsStore } from "../../../src/renderer/src/stores/assets.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { contractAssetFixture, componentInputs, modelInput } from "../helpers/contract-assets.js";

function assetState(value: unknown): { models: ModelAsset[]; components: ComponentAsset[] } {
  // Pinia recursively unwraps the store instance; observe only the tested state fields here.
  return value as { models: ModelAsset[]; components: ComponentAsset[] };
}

describe("assets store", () => {
  it("saves a reactive model read from the Pinia asset state", async () => {
    const fixture = await contractAssetFixture();
    const assets = useAssetsStore(fixture.api, () => ({ root: fixture.root, readOnly: false }));
    await assets.load(fixture.projectLocator);
    const model = await assets.createModel(modelInput);
    const storedModel = assetState(assets).models.find((item) => item.id === model.id);
    if (!storedModel) throw new Error("Created model missing from asset store");
    expect(isProxy(storedModel)).toBe(true);
    storedModel.description = "edited through Pinia state";

    await assets.saveModel({ ...fixture.projectLocator, modelId: model.id }, storedModel);

    expect(await fixture.api.modelGet({ ...fixture.projectLocator, modelId: model.id })).toMatchObject({ description: "edited through Pinia state" });
  });

  it("saves a reactive component read from the Pinia asset state", async () => {
    const fixture = await contractAssetFixture();
    const assets = useAssetsStore(fixture.api, () => ({ root: fixture.root, readOnly: false }));
    await assets.load(fixture.projectLocator);
    const component = await assets.createComponent(componentInputs[0]!);
    const storedComponent = assetState(assets).components.find((item) => item.id === component.id);
    if (!storedComponent) throw new Error("Created component missing from asset store");
    expect(isProxy(storedComponent)).toBe(true);
    storedComponent.description = "edited through Pinia state";

    await assets.saveComponent({ ...fixture.projectLocator, componentKind: storedComponent.kind, componentId: component.id }, storedComponent);

    expect(await fixture.api.componentGet({ ...fixture.projectLocator, componentKind: component.kind, componentId: component.id })).toMatchObject({ description: "edited through Pinia state" });
  });

  it("projects a reactive formal model locator before retaining it", async () => {
    const fixture = await contractAssetFixture();
    const assets = useAssetsStore(fixture.api, () => ({ root: fixture.root, readOnly: false }));
    await assets.load(fixture.projectLocator);
    const model = await assets.createModel(modelInput);
    const locator = reactive({ ...fixture.projectLocator, modelId: model.id });
    expect(isProxy(locator)).toBe(true);

    await expect(assets.getModel(locator)).resolves.toMatchObject({ id: model.id, name: modelInput.name });
  });

  it("creates and saves the model and each component kind in one project source, then reopens them", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-contract-assets-"));
    const api = createMemoryApi({ root });
    const fixture = await contractAssetFixture(api, root);
    const assets = useAssetsStore(api, () => ({ root, readOnly: false }));
    await assets.load(fixture.projectLocator);

    const model = await assets.createModel(modelInput);
    const components = await Promise.all(componentInputs.map((input) => assets.createComponent(input)));
    expect((await assets.listModels()).map((asset) => asset.id)).toEqual([model.id]);
    expect((await assets.listComponents()).map((asset) => asset.kind)).toEqual(["parameter", "auth", "response", "example"]);

    model.description = "saved model";
    await assets.saveModel({ ...fixture.projectLocator, modelId: model.id }, model);
    for (const component of components) {
      component.description = `saved ${component.kind}`;
      await assets.saveComponent({ ...fixture.projectLocator, componentKind: component.kind, componentId: component.id }, component);
    }
    const reopened = createMemoryApi({ root });
    await reopened.wsOpen(root);
    expect(await reopened.modelGet({ ...fixture.projectLocator, modelId: model.id })).toMatchObject({ description: "saved model", schema: modelInput.schema });
    expect(await reopened.componentList(fixture.projectLocator)).toHaveLength(4);
    for (const component of components) {
      expect(await reopened.componentGet({ ...fixture.projectLocator, componentKind: component.kind, componentId: component.id })).toMatchObject(component);
    }
  });

  it("keeps prior model and component values in memory and on disk after storage save failures", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-contract-assets-failed-save-"));
    let failNextSave = false;
    const storage: StorageAdapter = {
      load: (path) => fileStorage.load(path),
      save: (path, workspace, options) => {
        if (failNextSave) {
          failNextSave = false;
          return Promise.reject(new Error("injected storage failure"));
        }
        return fileStorage.save(path, workspace, options);
      },
    };
    const api = createMemoryApi({ root, storage });
    const fixture = await contractAssetFixture(api, root);
    const assets = useAssetsStore(api, () => ({ root, readOnly: false }));
    await assets.load(fixture.projectLocator);
    const model = await assets.createModel(modelInput);
    const component = await assets.createComponent(componentInputs[0]!);
    const modelLocator = { ...fixture.projectLocator, modelId: model.id };
    const componentLocator = { ...fixture.projectLocator, componentKind: component.kind, componentId: component.id };
    const priorModel = await api.modelGet(modelLocator);
    const priorComponent = await api.componentGet(componentLocator);

    failNextSave = true;
    await expect(assets.saveModel(modelLocator, { ...priorModel, description: "unsaved model edit" })).rejects.toThrow("injected storage failure");
    expect(assetState(assets).models.find((item) => item.id === model.id)).toEqual(priorModel);
    expect(await api.modelGet(modelLocator)).toEqual(priorModel);

    failNextSave = true;
    await expect(assets.saveComponent(componentLocator, { ...priorComponent, description: "unsaved component edit" })).rejects.toThrow("injected storage failure");
    expect(assetState(assets).components.find((item) => item.id === component.id && item.kind === component.kind)).toEqual(priorComponent);
    expect(await api.componentGet(componentLocator)).toEqual(priorComponent);

    const reopened = createMemoryApi({ root });
    await reopened.wsOpen(root);
    expect(await reopened.modelGet(modelLocator)).toEqual(priorModel);
    expect(await reopened.componentGet(componentLocator)).toEqual(priorComponent);
  });

  it("updates one component shared by two APIs and refuses its referenced deletion", async () => {
    const fixture = await contractAssetFixture();
    const assets = useAssetsStore(fixture.api, () => ({ root: fixture.root, readOnly: false }));
    await assets.load(fixture.projectLocator);
    const secondApi = await fixture.api.nodeCreate({ kind: "api", parent: fixture.collection.locator, api: { name: "另一个接口" } });
    if (secondApi.kind !== "api") throw new Error("Expected second API creation result");
    const component = await assets.createComponent(componentInputs[0]!);
    const firstDetail = await fixture.api.apiGet(fixture.apiLocator);
    const secondDetail = await fixture.api.apiGet(secondApi.locator);
    firstDetail.api.contract.request.query.push({
      kind: "componentRef", id: "11111111-1111-4111-8111-111111111111", componentId: component.id, expectedKind: "parameter",
    });
    secondDetail.api.contract.request.query.push({
      kind: "componentRef", id: "22222222-2222-4222-8222-222222222222", componentId: component.id, expectedKind: "parameter",
    });
    await fixture.api.apiSave(fixture.apiLocator, firstDetail.api, firstDetail.sourceApiRevision);
    await fixture.api.apiSave(secondApi.locator, secondDetail.api, secondDetail.sourceApiRevision);
    component.description = "one shared component source";
    await assets.saveComponent({ ...fixture.projectLocator, componentKind: "parameter", componentId: component.id }, component);

    const references = await assets.references(component.id);
    const deleted = await assets.deleteAsset({
      kind: "component",
      locator: { ...fixture.projectLocator, componentKind: "parameter", componentId: component.id },
    });

    expect(references).toContainEqual({
      code: "ASSET_REFERENCE",
      ownerId: firstDetail.api.contract.id,
      path: "contract.request.query[0].componentId",
      targetId: component.id,
    });
    expect(references).toContainEqual({
      code: "ASSET_REFERENCE",
      ownerId: secondDetail.api.contract.id,
      path: "contract.request.query[0].componentId",
      targetId: component.id,
    });
    expect((await fixture.api.apiGet(fixture.apiLocator)).api.contract.request.query).toContainEqual(expect.objectContaining({ componentId: component.id }));
    expect((await fixture.api.apiGet(secondApi.locator)).api.contract.request.query).toContainEqual(expect.objectContaining({ componentId: component.id }));
    expect(await fixture.api.componentGet({ ...fixture.projectLocator, componentKind: "parameter", componentId: component.id })).toMatchObject({ description: "one shared component source" });
    expect(deleted).toEqual({ deleted: false, references });
    expect(await fixture.api.componentGet({ ...fixture.projectLocator, componentKind: "parameter", componentId: component.id })).toEqual(component);
  });

  it("keeps the requested model locator fixed while reference lookup is pending", async () => {
    const fixture = await contractAssetFixture();
    const assets = useAssetsStore(fixture.api, () => ({ root: fixture.root, readOnly: false }));
    await assets.load(fixture.projectLocator);
    const first = await assets.createModel({ ...modelInput, name: "First" });
    const second = await assets.createModel({ ...modelInput, name: "Second" });
    const firstLocator = { ...fixture.projectLocator, modelId: first.id };
    const secondLocator = { ...fixture.projectLocator, modelId: second.id };
    let releaseReferences: () => void = () => {};
    let enterReferences: () => void = () => {};
    const referencesGate = new Promise<void>((resolve) => { releaseReferences = resolve; });
    const referencesEntered = new Promise<void>((resolve) => { enterReferences = resolve; });
    const originalReferences = fixture.api.assetReferences.bind(fixture.api);
    fixture.api.assetReferences = async (locator, assetId) => {
      enterReferences();
      await referencesGate;
      return originalReferences(locator, assetId);
    };
    const input = { kind: "model" as const, locator: firstLocator };
    let deleting: Promise<Awaited<ReturnType<typeof assets.deleteAsset>>> | undefined;
    try {
      deleting = assets.deleteAsset(input);
      await referencesEntered;
      input.locator = secondLocator;
      releaseReferences();
      await expect(deleting).resolves.toEqual({ deleted: true, references: [] });
      await expect(fixture.api.modelGet(firstLocator)).rejects.toThrow(/not found/i);
      await expect(fixture.api.modelGet(secondLocator)).resolves.toMatchObject({ id: second.id, name: "Second" });
      expect(assetState(assets).models.map((asset) => asset.id)).toEqual([second.id]);
    } finally {
      releaseReferences();
      await deleting?.catch(() => {});
    }
  });

  it.each([
    { change: "root" as const, rejection: /工作区已切换/ },
    { change: "readOnly" as const, rejection: /只读/ },
  ])("revalidates $change before sending deletion after references resolve", async ({ change, rejection }) => {
    const fixture = await contractAssetFixture();
    const context = { root: fixture.root, readOnly: false };
    const assets = useAssetsStore(fixture.api, () => context);
    await assets.load(fixture.projectLocator);
    const model = await assets.createModel(modelInput);
    let releaseReferences: () => void = () => {};
    let enterReferences: () => void = () => {};
    const referencesGate = new Promise<void>((resolve) => { releaseReferences = resolve; });
    const referencesEntered = new Promise<void>((resolve) => { enterReferences = resolve; });
    const originalReferences = fixture.api.assetReferences.bind(fixture.api);
    fixture.api.assetReferences = async (locator, assetId) => {
      enterReferences();
      await referencesGate;
      return originalReferences(locator, assetId);
    };
    let deleteCalls = 0;
    const originalDelete = fixture.api.nodeDelete.bind(fixture.api);
    fixture.api.nodeDelete = async (target) => {
      deleteCalls += 1;
      return originalDelete(target);
    };
    let deleting: Promise<Awaited<ReturnType<typeof assets.deleteAsset>>> | undefined;
    try {
      deleting = assets.deleteAsset({ kind: "model", locator: { ...fixture.projectLocator, modelId: model.id } });
      await referencesEntered;
      if (change === "root") context.root = `${fixture.root}-copy`;
      else context.readOnly = true;
      releaseReferences();
      await expect(deleting).rejects.toThrow(rejection);
      expect(deleteCalls).toBe(0);
      await expect(fixture.api.modelGet({ ...fixture.projectLocator, modelId: model.id })).resolves.toMatchObject({ id: model.id });
    } finally {
      releaseReferences();
      await deleting?.catch(() => {});
    }
  });

  it("does not remove a same-ID cache entry after switching project during nodeDelete", async () => {
    const fixture = await contractAssetFixture();
    const second = await fixture.api.nodeCreate({ kind: "project", parent: fixture.group.locator, name: "Second" });
    if (second.kind !== "project") throw new Error("Expected project creation result");
    const secondLocator = { ...fixture.projectLocator, projectId: second.locator.projectId };
    const assets = useAssetsStore(fixture.api, () => ({ root: fixture.root, readOnly: false }));
    await assets.load(fixture.projectLocator);
    const model = await assets.createModel(modelInput);
    let releaseDelete: () => void = () => {};
    let enterDelete: () => void = () => {};
    const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
    const deleteEntered = new Promise<void>((resolve) => { enterDelete = resolve; });
    const originalDelete = fixture.api.nodeDelete.bind(fixture.api);
    fixture.api.nodeDelete = async (target) => {
      enterDelete();
      await deleteGate;
      return originalDelete(target);
    };
    let deleting: Promise<Awaited<ReturnType<typeof assets.deleteAsset>>> | undefined;
    try {
      deleting = assets.deleteAsset({ kind: "model", locator: { ...fixture.projectLocator, modelId: model.id } });
      await deleteEntered;
      await assets.load(secondLocator);
      // Same IDs may occur in different project scopes; retain the active slot's item after the old delete settles.
      assetState(assets).models = [{ ...model }];
      releaseDelete();
      await expect(deleting).resolves.toEqual({ deleted: true, references: [] });
      expect(assetState(assets).models).toEqual([{ ...model }]);
    } finally {
      releaseDelete();
      await deleting?.catch(() => {});
    }
  });

  it("keeps a late project load out of the newly active project", async () => {
    const fixture = await contractAssetFixture();
    const second = await fixture.api.nodeCreate({ kind: "project", parent: fixture.group.locator, name: "Second" });
    if (second.kind !== "project") throw new Error("Expected project creation result");
    const secondLocator = { ...fixture.projectLocator, projectId: second.locator.projectId };
    await fixture.api.nodeCreate({ kind: "collection", parent: secondLocator, name: "Second collection" });
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const listModels = fixture.api.modelList.bind(fixture.api);
    fixture.api.modelList = async (locator) => {
      if (locator.projectId === fixture.projectLocator.projectId) await firstGate;
      return listModels(locator);
    };
    const assets = useAssetsStore(fixture.api, () => ({ root: fixture.root, readOnly: false }));
    let loadingFirst: Promise<void> | undefined;
    try {
      loadingFirst = assets.load(fixture.projectLocator);
      await assets.load(secondLocator);
      releaseFirst!();
      await loadingFirst;
      expect(assets.projectLocator).toEqual(secondLocator);
    } finally {
      releaseFirst!();
      await loadingFirst?.catch(() => {});
    }
  });

  it("rejects writes in a read-only workspace before calling the API", async () => {
    const fixture = await contractAssetFixture();
    const assets = useAssetsStore(fixture.api, () => ({ root: fixture.root, readOnly: true }));
    await assets.load(fixture.projectLocator);
    await expect(assets.createModel(modelInput)).rejects.toThrow(/只读/);
    expect(await fixture.api.modelList(fixture.projectLocator)).toEqual([]);
  });
});
