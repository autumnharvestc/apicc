/**
 * 工作区 store 工厂（M4-A 任务 3，裁定 B/D）：清单/创建/删除 + loading/error 通道 + 选中
 * 工作区详情（myRole 驱动侧栏管理入口显隐）。语义沿用 desktop 先例：失败 error 上屏且不清
 * 旧态（清单保留、current 不动）、创建/删除成功后自动刷新清单（裁定 B）、删除 current 时
 * 清选中（删除 current → current=null，侧栏入口随之隐藏）、防重复提交。选中详情未拉取/
 * 拉取失败 → current=null（成员/ACL 入口默认隐藏防闪烁，裁定 C）。工厂隔离同 session store
 * （每次调用独立 Pinia 实例）；组件内零工厂调用：实例由装配层创建后经路由 props 下传。
 * 401 由共享 client 的会话失效钩子统一处理（session store 接线），本 store 不另设。
 */
import { createPinia, defineStore } from "pinia";
import type { AdminClient } from "../api/client.js";
import type { AdminWorkspaceDetail, AdminWorkspaceSummary } from "../api/contract.js";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface WorkspacesStoreDeps {
  client: AdminClient;
}

export function createWorkspacesStore(deps: WorkspacesStoreDeps) {
  const client = deps.client;
  return defineStore("admin-workspaces", {
    state: () => ({
      /** 工作区清单（GET /workspaces）。 */
      list: [] as AdminWorkspaceSummary[],
      /** 清单拉取在途。 */
      loading: false,
      /** 创建/删除在途（按钮 loading 与防重复提交）。 */
      submitting: false,
      /** api 失败文案（清单/创建/删除共享一条错误通道；组件上屏）。 */
      error: null as string | null,
      /** 选中工作区详情；null = 未选中/未拉取/拉取失败（管理入口隐藏，防闪烁）。 */
      current: null as AdminWorkspaceDetail | null,
      /** 选中详情拉取在途。 */
      currentLoading: false,
    }),
    actions: {
      /** 清单拉取：失败 → error 上屏且不清旧清单（desktop 错误语义）。 */
      async refresh(): Promise<void> {
        this.loading = true;
        try {
          this.list = await client.listWorkspaces();
          this.error = null;
        } catch (e) {
          this.error = errorMessage(e);
        } finally {
          this.loading = false;
        }
      },

      /**
       * 选中工作区：详情拉取（myRole 驱动侧栏管理入口显隐，裁定 A）。失败 → current=null
       * （防闪烁隐藏入口）+ error 上屏。
       */
      async select(workspaceId: string): Promise<void> {
        this.currentLoading = true;
        try {
          this.current = await client.getWorkspace(workspaceId);
        } catch (e) {
          this.current = null;
          this.error = errorMessage(e);
        } finally {
          this.currentLoading = false;
        }
      },

      /** 创建：成功后自动刷新清单（裁定 B）；成功 true / 失败 false + error 上屏。 */
      async create(input: { name: string }): Promise<boolean> {
        if (this.submitting) return false;
        this.submitting = true;
        this.error = null;
        try {
          await client.createWorkspace(input);
          await this.refresh();
          return true;
        } catch (e) {
          this.error = errorMessage(e);
          return false;
        } finally {
          this.submitting = false;
        }
      },

      /** 删除：成功后自动刷新清单；删除的是 current → 清选中。失败不清任何既有态。 */
      async remove(workspaceId: string): Promise<boolean> {
        if (this.submitting) return false;
        this.submitting = true;
        this.error = null;
        try {
          await client.deleteWorkspace(workspaceId);
          if (this.current?.id === workspaceId) this.current = null;
          await this.refresh();
          return true;
        } catch (e) {
          this.error = errorMessage(e);
          return false;
        } finally {
          this.submitting = false;
        }
      },
    },
  })(createPinia());
}

export type WorkspacesStore = ReturnType<typeof createWorkspacesStore>;
