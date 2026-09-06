import { createPinia, defineStore } from "pinia";
import type { ApiccApi, EnvCreateInput } from "../../../shared/types.js";
import type { WorkspaceGlobals } from "@apicc/core";

type ConfirmFn = (message: string) => Promise<boolean>;

/** 列表项与 TreeNodeDTO project 节点的 envs 形状对齐（含 extends 与已存 variables，供水合）。 */
export interface EnvItem { id: string; name: string; extends?: string; variables: Record<string, string>; baseUrls: Record<string, string> }

/**
 * 环境 store 工厂：接受依赖 api 参数（测试传新实例即天然隔离），每次工厂调用绑定
 * 独立 Pinia 实例。数据源 = treeGet 的 project 节点 envs 数组（含已存 variables，
 * 供组件层选中环境时水合行缓冲）；projectId 记录当前加载的项目，供 remove 后刷新复用。
 * saveVars 落盘（主进程 IPC 显式 save）后同步更新本地项，保证切换环境再切回时
 * 水合到已存值；load 末尾清理悬空 selectedEnvId（跨项目切换防误删/误写）。
 */
export function useEnvsStore(api: ApiccApi) {
  return defineStore("envs", {
    state: () => ({
      projectId: null as string | null,
      envs: [] as EnvItem[],
      selectedEnvId: null as string | null,
      globals: { variables: {}, query: [], headers: [] } as WorkspaceGlobals,
    }),
    actions: {
      async load(projectId: string) {
        const tree = await api.treeGet();
        const project = (tree.children ?? [])
          .flatMap((g) => g.children ?? [])
          .find((n) => n.kind === "project" && n.id === projectId);
        this.projectId = projectId;
        this.envs = (project?.envs ?? []).map((e) => ({ id: e.id, name: e.name, extends: e.extends, variables: { ...e.variables }, baseUrls: { ...(e.baseUrls ?? {}) } }));
        // 全局变量/全局参数（M9-B）：工作区级，随 load 一并水合（替换式落盘前的编辑基准）。
        this.globals = await api.globalsGet();
        // 悬空选中清理：新列表不含当前选中（跨项目切换/被并发删除）时置空。
        if (this.selectedEnvId !== null && !this.envs.some((e) => e.id === this.selectedEnvId)) {
          this.selectedEnvId = null;
        }
      },
      async create(input: EnvCreateInput) {
        const env = await api.envCreate(input);
        await this.load(input.projectId);
        this.selectedEnvId = env.id;
        return env;
      },
      async saveVars(envId: string, variables: Record<string, string>) {
        await api.envVarsSave(envId, variables);
        // setEnvironmentVariables 为全量替换：同步本地项，行缓冲再水合即已存值。
        const item = this.envs.find((e) => e.id === envId);
        if (item) item.variables = { ...variables };
      },
      /** 环境前置 URL 整体替换（M9-B）：落盘 + 本地项同步。 */
      async saveBaseUrls(envId: string, baseUrls: Record<string, string>) {
        await api.envBaseUrlsSave(envId, baseUrls);
        const item = this.envs.find((e) => e.id === envId);
        if (item) item.baseUrls = { ...baseUrls };
      },
      /** 全局设置整体替换（M9-B）：variables/query/headers 一起落盘。 */
      async saveGlobals(globals: WorkspaceGlobals) {
        await api.globalsSave(globals);
        this.globals = globals;
      },
      // 复用 tree store 的删除模式：确认回调放行才删除，删除后清选中并刷新。
      async remove(kind: "environment", id: string, confirm: ConfirmFn) {
        if (!(await confirm(`delete:${id}`))) return;
        await api.nodeDelete(kind, id);
        if (this.selectedEnvId === id) this.selectedEnvId = null;
        if (this.projectId) await this.load(this.projectId);
      },
    },
  })(createPinia());
}
