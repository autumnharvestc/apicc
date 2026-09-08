/**
 * 用户管理 store 工厂（任务 5，规格 2026-09-08 §2 账号管理）：平台账号清单/创建/重置密码/停用启用
 * actions（全部超管专属端点；非超管 403 由服务端裁决、路由守卫先行）。错误通道按呈现面拆分
 * （workspaces store 先例）：`error`=清单拉取/行内动作（停用启用）失败——页顶 alert 呈现；
 * `actionError`=创建/重置密码弹窗失败——Modal 内就近呈现（弹窗遮罩会挡页面 alert，MembersView
 * 转让先例）。语义沿用既有 store：失败 error 上屏不清旧清单、创建成功后自动刷新、行级 busyId 与
 * 创建 submitting 防重复提交；重置密码不改清单形状故不刷新。401 由共享 client 的会话失效钩子统一
 * 处理。组件内零工厂调用：实例由装配层创建后经路由 props 下传。
 */
import { createPinia, defineStore } from "pinia";
import type { AdminClient } from "../api/client.js";
import type { AdminAccount } from "../api/contract.js";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface UsersStoreDeps {
  client: AdminClient;
}

export function createUsersStore(deps: UsersStoreDeps) {
  const client = deps.client;
  return defineStore("admin-users", {
    state: () => ({
      /** 账号清单（GET /admin/users）。 */
      items: [] as AdminAccount[],
      /** 清单拉取在途。 */
      loading: false,
      /** 创建在途（提交按钮 loading 与防重复提交）。 */
      submitting: false,
      /** 行级在途（重置密码/停用启用的行 loading 与防重复提交）。 */
      busyId: null as string | null,
      /** 清单/行内动作失败文案（页顶 alert 呈现）。 */
      error: null as string | null,
      /** 创建/重置密码弹窗失败文案（Modal 内就近呈现）。 */
      actionError: null as string | null,
    }),
    actions: {
      /** 会话销毁后的状态重置（防换账号残留上一账号的清单/错误通道）。 */
      reset(): void {
        this.$reset();
      },
      /** 清单拉取：失败 → error 上屏且不清旧清单（desktop 错误语义）。 */
      async refresh(): Promise<void> {
        this.loading = true;
        try {
          this.items = await client.adminListUsers();
          this.error = null;
        } catch (e) {
          this.error = errorMessage(e);
        } finally {
          this.loading = false;
        }
      },
      /** 创建账号：成功后自动刷新清单；错误走 actionError（弹窗内呈现，不抛出）。 */
      async create(input: { username: string; password: string; displayName: string }): Promise<boolean> {
        if (this.submitting) return false;
        this.submitting = true;
        this.actionError = null;
        try {
          await client.adminCreateUser(input);
          await this.refresh();
          return true;
        } catch (e) {
          this.actionError = errorMessage(e);
          return false;
        } finally {
          this.submitting = false;
        }
      },
      /** 重置密码：不改清单形状，成功不刷新；错误走 actionError（重置弹窗内呈现）。 */
      async resetPassword(userId: string, newPassword: string): Promise<boolean> {
        if (this.busyId !== null) return false;
        this.busyId = userId;
        this.actionError = null;
        try {
          await client.adminResetPassword(userId, newPassword);
          return true;
        } catch (e) {
          this.actionError = errorMessage(e);
          return false;
        } finally {
          this.busyId = null;
        }
      },
      /** 停用/启用：disabled 状态随行呈现 → 成功后刷新清单；错误走 error（页顶通道）。 */
      async setDisabled(userId: string, disabled: boolean): Promise<boolean> {
        if (this.busyId !== null) return false;
        this.busyId = userId;
        this.error = null;
        try {
          await client.adminSetDisabled(userId, disabled);
          await this.refresh();
          return true;
        } catch (e) {
          this.error = errorMessage(e);
          return false;
        } finally {
          this.busyId = null;
        }
      },
    },
  })(createPinia());
}

export type UsersStore = ReturnType<typeof createUsersStore>;
