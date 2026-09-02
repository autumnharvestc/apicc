import { createPinia, defineStore } from "pinia";
import type { ApiccApi, EnvCreateInput } from "../../../shared/types.js";

type ConfirmFn = (message: string) => Promise<boolean>;

/** 列表项与 TreeNodeDTO project 节点的 envs 形状对齐（id/name；api 无变量读取通道）。 */
export interface EnvItem { id: string; name: string }

/**
 * 环境 store 工厂：接受依赖 api 参数（测试传新实例即天然隔离），每次工厂调用绑定
 * 独立 Pinia 实例。数据源 = treeGet 的 project 节点 envs 数组（控制者裁定：api 无
 * envList 通道）；projectId 记录当前加载的项目，供 remove 后刷新列表复用。
 * 变量编辑为组件内缓冲：saveVars 经 api.envVarsSave 落盘（主进程 IPC 显式 save）。
 */
export function useEnvsStore(api: ApiccApi) {
  return defineStore("envs", {
    state: () => ({
      projectId: null as string | null,
      envs: [] as EnvItem[],
      selectedEnvId: null as string | null,
    }),
    actions: {
      async load(projectId: string) {
        const tree = await api.treeGet();
        const project = (tree.children ?? [])
          .flatMap((g) => g.children ?? [])
          .find((n) => n.kind === "project" && n.id === projectId);
        this.projectId = projectId;
        this.envs = (project?.envs ?? []).map((e) => ({ id: e.id, name: e.name }));
      },
      async create(input: EnvCreateInput) {
        const env = await api.envCreate(input);
        await this.load(input.projectId);
        this.selectedEnvId = env.id;
        return env;
      },
      async saveVars(envId: string, variables: Record<string, string>) {
        await api.envVarsSave(envId, variables);
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
