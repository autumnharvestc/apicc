import { createPinia, defineStore } from "pinia";
import type { ApiccApi, EnvCreateInput } from "../../../shared/types.js";
import type { EnvironmentLocator, ProjectLocator } from "../../../shared/locations.js";
import type { ProjectGlobalSettings } from "../../../shared/types.js";
import type { LocalWorkspaceContext } from "./localIdentity.js";

type ConfirmFn = (message: string) => Promise<boolean>;
export interface EnvItem { id: string; name: string; extends?: string; variables: Record<string, string>; baseUrls: Record<string, string>; locator: EnvironmentLocator }

function projectOf(locator: EnvironmentLocator): ProjectLocator {
  return { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId };
}

function copyProject(locator: ProjectLocator): ProjectLocator {
  return { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId };
}

function sameProject(left: ProjectLocator, right: ProjectLocator): boolean {
  return left.workspaceId === right.workspaceId && left.groupId === right.groupId && left.projectId === right.projectId;
}

/** Environment loads and mutations are pinned to a directory root and full workspace/group/project identity. */
export function useEnvsStore(api: ApiccApi, getContext: () => LocalWorkspaceContext = () => ({ root: "", readOnly: false })) {
  return defineStore("envs", {
    state: () => ({
      root: null as string | null,
      projectLocator: null as ProjectLocator | null,
      envs: [] as EnvItem[],
      selectedEnvironment: null as EnvironmentLocator | null,
      globals: { variables: {}, query: [], headers: [], cookies: [], body: [] } as ProjectGlobalSettings,
      loadToken: 0,
    }),
    getters: {
      selectedEnvId(): string | null { return this.selectedEnvironment?.environmentId ?? null; },
      projectId(): string | null { return this.projectLocator?.projectId ?? null; },
      selectedEnv(): EnvItem | null {
        return this.selectedEnvironment ? this.envs.find((item) => item.locator.environmentId === this.selectedEnvironment!.environmentId) ?? null : null;
      },
    },
    actions: {
      assertWritable(): void {
        if (getContext().readOnly) throw new Error("工作区处于只读模式，不能修改环境");
      },
      async load(locator: ProjectLocator): Promise<void> {
        const fixed = copyProject(locator);
        const root = getContext().root;
        const token = ++this.loadToken;
        const [tree, globals] = await Promise.all([api.treeGet(), api.globalsGet(fixed)]);
        if (token !== this.loadToken || getContext().root !== root) return;
        const group = tree.source === "local" && tree.kind === "root"
          ? tree.children.find((node) => node.kind === "group" && node.locator.workspaceId === fixed.workspaceId && node.locator.groupId === fixed.groupId)
          : undefined;
        const project = group?.kind === "group"
          ? group.children.find((node) => node.kind === "project" && node.locator.workspaceId === fixed.workspaceId
            && node.locator.groupId === fixed.groupId && node.locator.projectId === fixed.projectId)
          : undefined;
        this.root = root;
        this.projectLocator = fixed;
        this.envs = project?.kind === "project" ? project.envs.map((env) => ({
          id: env.id,
          name: env.name,
          extends: env.extends,
          variables: { ...env.variables },
          baseUrls: { ...(env.baseUrls ?? {}) },
          locator: { ...env.locator },
        })) : [];
        this.globals = globals;
        if (this.selectedEnvironment && (!sameProject(projectOf(this.selectedEnvironment), fixed)
          || !this.envs.some((item) => item.locator.environmentId === this.selectedEnvironment!.environmentId))) {
          this.selectedEnvironment = null;
        }
      },
      select(locator: EnvironmentLocator | null): void {
        this.selectedEnvironment = locator ? { ...locator } : null;
      },
      async create(input: EnvCreateInput) {
        this.assertWritable();
        const root = getContext().root;
        const fixed = copyProject(input.locator);
        const env = await api.envCreate({ ...input, locator: fixed });
        if (getContext().root !== root || !this.projectLocator || !sameProject(this.projectLocator, fixed)) return env;
        await this.load(fixed);
        const created = this.envs.find((item) => item.id === env.id);
        this.select(created?.locator ?? null);
        return env;
      },
      async saveVars(locator: EnvironmentLocator, variables: Record<string, string>) {
        this.assertWritable();
        const root = getContext().root;
        const fixed = { ...locator };
        const saved = await api.envVarsSave(fixed, { ...variables });
        if (root !== getContext().root || this.root !== root || !this.projectLocator || !sameProject(this.projectLocator, projectOf(fixed))) return;
        const item = this.envs.find((entry) => entry.locator.environmentId === fixed.environmentId);
        if (item) item.variables = { ...saved.variables };
      },
      async saveBaseUrls(locator: EnvironmentLocator, baseUrls: Record<string, string>) {
        this.assertWritable();
        const root = getContext().root;
        const fixed = { ...locator };
        const saved = await api.envBaseUrlsSave(fixed, { ...baseUrls });
        if (root !== getContext().root || this.root !== root || !this.projectLocator || !sameProject(this.projectLocator, projectOf(fixed))) return;
        const item = this.envs.find((entry) => entry.locator.environmentId === fixed.environmentId);
        if (item) item.baseUrls = { ...(saved.baseUrls ?? {}) };
      },
      async saveGlobals(locator: ProjectLocator, globals: ProjectGlobalSettings) {
        this.assertWritable();
        const root = getContext().root;
        const fixed = copyProject(locator);
        const saved = await api.globalsSave(fixed, globals);
        if (root === getContext().root && this.root === root && this.projectLocator && sameProject(this.projectLocator, fixed)) this.globals = saved;
      },
      async remove(locator: EnvironmentLocator, confirm: ConfirmFn): Promise<void> {
        this.assertWritable();
        const root = getContext().root;
        const fixed = { ...locator };
        if (!(await confirm(`delete:${fixed.environmentId}`))) return;
        // Confirmation is asynchronous; do not redirect an operation captured in one root
        // into whichever workspace became active while the dialog was open.
        if (getContext().root !== root) return;
        this.assertWritable();
        await api.nodeDelete({ kind: "environment", locator: fixed });
        if (root !== getContext().root || !this.projectLocator || !sameProject(this.projectLocator, projectOf(fixed))) return;
        if (this.selectedEnvironment?.environmentId === fixed.environmentId
          && sameProject(projectOf(this.selectedEnvironment), projectOf(fixed))) this.selectedEnvironment = null;
        await this.load(projectOf(fixed));
      },
    },
  })(createPinia());
}
