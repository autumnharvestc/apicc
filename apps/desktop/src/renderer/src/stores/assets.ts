import { createPinia, defineStore } from "pinia";
import type { AssetDiagnostic, ComponentAsset, ModelAsset } from "@apicc/core";
import type { CreateComponentInput, CreateModelInput, ApiccApi } from "../../../shared/types.js";
import type { ComponentLocator, ModelLocator, NodeLocator, ProjectLocator } from "../../../shared/locations.js";
import { projectSessionKey, type LocalWorkspaceContext } from "./localIdentity.js";

type AssetLocator = ModelLocator | ComponentLocator;

interface AssetStoreState {
  projectLocator: ProjectLocator | null;
  root: string;
  models: ModelAsset[];
  components: ComponentAsset[];
  revision: number;
}

export type DeleteAssetResult = { deleted: true; references: [] } | { deleted: false; references: AssetDiagnostic[] };

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function copyAssetLocator(locator: AssetLocator): AssetLocator {
  const project = {
    workspaceId: locator.workspaceId,
    groupId: locator.groupId,
    projectId: locator.projectId,
  };
  if ("modelId" in locator) return { ...project, modelId: locator.modelId };
  return { ...project, componentKind: locator.componentKind, componentId: locator.componentId };
}

function mutableAssetState(value: unknown): AssetStoreState {
  // Pinia's recursively inferred action `this` can exceed TS instantiation depth for contract assets.
  return value as AssetStoreState;
}

/** Renderer cache for project-owned models and reusable components. */
export function useAssetsStore(api: ApiccApi, getContext: () => LocalWorkspaceContext) {
  return defineStore("assets", {
    state: () => ({
      projectLocator: null as ProjectLocator | null,
      root: "",
      models: [] as ModelAsset[],
      components: [] as ComponentAsset[],
      revision: 0,
    }),
    getters: {
      readOnly(): boolean {
        return getContext().readOnly;
      },
    },
    actions: {
      async load(locator: ProjectLocator): Promise<void> {
        const context = getContext();
        const root = context.root;
        const fixedLocator: ProjectLocator = {
          workspaceId: locator.workspaceId,
          groupId: locator.groupId,
          projectId: locator.projectId,
        };
        const key = projectSessionKey(root, fixedLocator);
        const revision = ++this.revision;
        this.projectLocator = fixedLocator;
        this.root = root;

        const [models, components] = await Promise.all([
          api.modelList(fixedLocator),
          api.componentList(fixedLocator),
        ]);
        if (revision !== this.revision || !this.isActive(key, root, revision)) return;
        const state = mutableAssetState(this);
        state.models = models.map(clone);
        state.components = components.map(clone);
      },

      async listModels(): Promise<ModelAsset[]> {
        const { locator, root, key, revision } = this.activeProject();
        const models = await api.modelList(locator);
        if (this.isActive(key, root, revision)) mutableAssetState(this).models = models.map(clone);
        return models.map(clone);
      },

      async listComponents(): Promise<ComponentAsset[]> {
        const { locator, root, key, revision } = this.activeProject();
        const components = await api.componentList(locator);
        if (this.isActive(key, root, revision)) mutableAssetState(this).components = components.map(clone);
        return components.map(clone);
      },

      async getModel(locator: ModelLocator): Promise<ModelAsset> {
        const active = this.activeAsset(locator);
        const model = await api.modelGet(active.locator as ModelLocator);
        if (this.isActive(active.key, active.root, active.revision)) this.replaceModel(model);
        return clone(model);
      },

      async createModel(input: CreateModelInput): Promise<ModelAsset> {
        this.assertWritable();
        const active = this.activeProject();
        const model = await api.modelCreate(active.locator, clone(input));
        if (this.isActive(active.key, active.root, active.revision)) this.replaceModel(model);
        return clone(model);
      },

      async saveModel(locator: ModelLocator, model: ModelAsset): Promise<ModelAsset> {
        this.assertWritable();
        const active = this.activeAsset(locator);
        const saved = await api.modelSave(active.locator as ModelLocator, clone(model));
        if (this.isActive(active.key, active.root, active.revision)) this.replaceModel(saved);
        return clone(saved);
      },

      async getComponent(locator: ComponentLocator): Promise<ComponentAsset> {
        const active = this.activeAsset(locator);
        const component = await api.componentGet(active.locator as ComponentLocator);
        if (this.isActive(active.key, active.root, active.revision)) this.replaceComponent(component);
        return clone(component);
      },

      async createComponent(input: CreateComponentInput): Promise<ComponentAsset> {
        this.assertWritable();
        const active = this.activeProject();
        const component = await api.componentCreate(active.locator, clone(input));
        if (this.isActive(active.key, active.root, active.revision)) this.replaceComponent(component);
        return clone(component);
      },

      async saveComponent(locator: ComponentLocator, component: ComponentAsset): Promise<ComponentAsset> {
        this.assertWritable();
        const active = this.activeAsset(locator);
        const saved = await api.componentSave(active.locator as ComponentLocator, clone(component));
        if (this.isActive(active.key, active.root, active.revision)) this.replaceComponent(saved);
        return clone(saved);
      },

      async references(assetId: string): Promise<AssetDiagnostic[]> {
        const { locator } = this.activeProject();
        return api.assetReferences(locator, assetId);
      },

      async deleteAsset(input: { kind: "model"; locator: ModelLocator } | { kind: "component"; locator: ComponentLocator }): Promise<DeleteAssetResult> {
        this.assertWritable();
        const kind = input.kind;
        const active = this.activeAsset(input.locator);
        const locator = active.locator;
        const projectLocator: ProjectLocator = {
          workspaceId: locator.workspaceId,
          groupId: locator.groupId,
          projectId: locator.projectId,
        };
        const assetId = kind === "model"
          ? (locator as ModelLocator).modelId
          : (locator as ComponentLocator).componentId;
        const target: NodeLocator = kind === "model"
          ? { kind, locator: locator as ModelLocator }
          : { kind, locator: locator as ComponentLocator };
        const references = await api.assetReferences(projectLocator, assetId);
        if (references.length > 0) return { deleted: false, references: clone(references) };

        if (getContext().root !== active.root) throw new Error("当前工作区已切换，请先重新加载项目资产");
        this.assertWritable();
        if (!this.isActive(active.key, active.root, active.revision)) {
          throw new Error("当前项目资产已切换，请重新加载项目资产");
        }

        await api.nodeDelete(target);
        if (this.isActive(active.key, active.root, active.revision)) {
          const state = mutableAssetState(this);
          if (kind === "model") {
            state.models = state.models.filter((asset) => asset.id !== assetId);
          } else {
            state.components = state.components.filter((asset) => asset.id !== assetId || asset.kind !== (locator as ComponentLocator).componentKind);
          }
        }
        return { deleted: true, references: [] };
      },

      activeProject(): { locator: ProjectLocator; root: string; key: string; revision: number } {
        const locator = this.projectLocator;
        if (!locator) throw new Error("未加载项目资产");
        const context = getContext();
        if (context.root !== this.root) throw new Error("当前工作区已切换，请先重新加载项目资产");
        const fixed: ProjectLocator = { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId };
        return { locator: fixed, root: this.root, key: projectSessionKey(this.root, fixed), revision: this.revision };
      },

      activeAsset(locator: AssetLocator): { locator: AssetLocator; root: string; key: string; revision: number } {
        const active = this.activeProject();
        if (projectSessionKey(active.root, locator) !== active.key) throw new Error("资产不属于当前项目");
        return { locator: copyAssetLocator(locator), root: active.root, key: active.key, revision: active.revision };
      },

      assertWritable(): void {
        if (getContext().readOnly) throw new Error("工作区处于只读模式，不能修改资产");
      },

      isActive(key: string, root: string, revision: number): boolean {
        if (getContext().root !== root || this.root !== root || this.revision !== revision || !this.projectLocator) return false;
        return projectSessionKey(this.root, this.projectLocator) === key;
      },

      replaceModel(model: ModelAsset): void {
        const models = mutableAssetState(this).models;
        const index = models.findIndex((item) => item.id === model.id);
        const next = clone(model);
        if (index < 0) models.push(next);
        else models.splice(index, 1, next);
      },

      replaceComponent(component: ComponentAsset): void {
        const components = mutableAssetState(this).components;
        const index = components.findIndex((item) => item.id === component.id && item.kind === component.kind);
        const next = clone(component);
        if (index < 0) components.push(next);
        else components.splice(index, 1, next);
      },
    },
  })(createPinia());
}
