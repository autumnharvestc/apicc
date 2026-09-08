/**
 * 组织管理 store 工厂（任务 6，规格 2026-09-08 §4 分组/项目端点消费面）：分组/项目清单并行
 * 拉取 + 建分组/改名/删除 + 建项目/改名/移动/删除 actions。错误通道按呈现面拆分（users/workspaces
 * 先例）：`error`=清单拉取失败——页顶 alert 呈现；`actionError`=弹窗动作（创建/改名/移动/删除
 * 确认）失败——Modal 内就近呈现（弹窗遮罩会挡页面 alert）。语义沿用既有 store：失败 error 上屏
 * 不清旧清单、动作成功后自动刷新、submitting（弹窗表单）与 busyId（删除确认，行级）防重复提交。
 * 401 由共享 client 的会话失效钩子统一处理。组件内零工厂调用：实例由装配层创建后经路由 props
 * 下传。
 */
import { createPinia, defineStore } from "pinia";
import type { AdminClient } from "../api/client.js";
import type { AdminGroup, AdminProject } from "../api/contract.js";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface OrgStoreDeps {
  client: AdminClient;
}

export function createOrgStore(deps: OrgStoreDeps) {
  const client = deps.client;
  return defineStore("admin-org", {
    state: () => ({
      /** 分组清单（GET /workspaces/{id}/groups）。 */
      groups: [] as AdminGroup[],
      /** 项目清单（GET /workspaces/{id}/projects）。 */
      projects: [] as AdminProject[],
      /** 清单拉取在途（分组+项目并行）。 */
      loading: false,
      /** 弹窗表单提交在途（建分组/建项目/改名/移动的按钮 loading 与防重复提交）。 */
      submitting: false,
      /** 删除确认动作在途（目标 id 的按钮 loading 与防重复提交）。 */
      busyId: null as string | null,
      /** 清单拉取失败文案（页顶 alert 呈现）。 */
      error: null as string | null,
      /** 弹窗动作失败文案（Modal 内就近呈现）。 */
      actionError: null as string | null,
    }),
    actions: {
      /** 会话销毁后的状态重置（防换账号残留上一账号的清单/错误通道）。 */
      reset(): void {
        this.$reset();
      },
      /** 清单拉取（分组+项目并行）：失败 → error 上屏且不清旧清单（desktop 错误语义）。 */
      async refresh(workspaceId: string): Promise<void> {
        this.loading = true;
        try {
          const [groups, projects] = await Promise.all([client.orgListGroups(workspaceId), client.orgListProjects(workspaceId)]);
          this.groups = groups;
          this.projects = projects;
          this.error = null;
        } catch (e) {
          this.error = errorMessage(e);
        } finally {
          this.loading = false;
        }
      },
      /** 建分组：成功后自动刷新清单；错误走 actionError（弹窗内呈现，不抛出）。 */
      async createGroup(workspaceId: string, name: string): Promise<boolean> {
        if (this.submitting) return false;
        this.submitting = true;
        this.actionError = null;
        try {
          await client.orgCreateGroup(workspaceId, { name });
          await this.refresh(workspaceId);
          return true;
        } catch (e) {
          this.actionError = errorMessage(e);
          return false;
        } finally {
          this.submitting = false;
        }
      },
      /** 分组改名：成功后自动刷新；错误走 actionError（改名弹窗内呈现）。 */
      async renameGroup(workspaceId: string, groupId: string, name: string): Promise<boolean> {
        if (this.submitting) return false;
        this.submitting = true;
        this.actionError = null;
        try {
          await client.orgRenameGroup(workspaceId, groupId, name);
          await this.refresh(workspaceId);
          return true;
        } catch (e) {
          this.actionError = errorMessage(e);
          return false;
        } finally {
          this.submitting = false;
        }
      },
      /** 删分组（确认弹窗动作）：成功后自动刷新；错误走 actionError（确认窗内呈现）。 */
      async deleteGroup(workspaceId: string, groupId: string): Promise<boolean> {
        if (this.busyId !== null) return false;
        this.busyId = groupId;
        this.actionError = null;
        try {
          await client.orgDeleteGroup(workspaceId, groupId);
          await this.refresh(workspaceId);
          return true;
        } catch (e) {
          this.actionError = errorMessage(e);
          return false;
        } finally {
          this.busyId = null;
        }
      },
      /** 建项目：成功后自动刷新清单；错误走 actionError。 */
      async createProject(workspaceId: string, input: { groupId: string; name: string }): Promise<boolean> {
        if (this.submitting) return false;
        this.submitting = true;
        this.actionError = null;
        try {
          await client.orgCreateProject(workspaceId, input);
          await this.refresh(workspaceId);
          return true;
        } catch (e) {
          this.actionError = errorMessage(e);
          return false;
        } finally {
          this.submitting = false;
        }
      },
      /** 项目改名：成功后自动刷新；错误走 actionError。 */
      async renameProject(workspaceId: string, projectId: string, name: string): Promise<boolean> {
        if (this.submitting) return false;
        this.submitting = true;
        this.actionError = null;
        try {
          await client.orgRenameProject(workspaceId, projectId, name);
          await this.refresh(workspaceId);
          return true;
        } catch (e) {
          this.actionError = errorMessage(e);
          return false;
        } finally {
          this.submitting = false;
        }
      },
      /** 移动项目（POST move { groupId }）：成功后自动刷新；错误走 actionError。 */
      async moveProject(workspaceId: string, projectId: string, groupId: string): Promise<boolean> {
        if (this.submitting) return false;
        this.submitting = true;
        this.actionError = null;
        try {
          await client.orgMoveProject(workspaceId, projectId, groupId);
          await this.refresh(workspaceId);
          return true;
        } catch (e) {
          this.actionError = errorMessage(e);
          return false;
        } finally {
          this.submitting = false;
        }
      },
      /** 删项目（确认弹窗动作）：成功后自动刷新；错误走 actionError。 */
      async deleteProject(workspaceId: string, projectId: string): Promise<boolean> {
        if (this.busyId !== null) return false;
        this.busyId = projectId;
        this.actionError = null;
        try {
          await client.orgDeleteProject(workspaceId, projectId);
          await this.refresh(workspaceId);
          return true;
        } catch (e) {
          this.actionError = errorMessage(e);
          return false;
        } finally {
          this.busyId = null;
        }
      },
    },
  })(createPinia());
}

export type OrgStore = ReturnType<typeof createOrgStore>;
