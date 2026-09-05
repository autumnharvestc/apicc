/**
 * 工作区 store 工厂（M4-A 任务 3/4，裁定 B/D）：清单/创建/删除 + 选中工作区上下文 + 成员管理
 * actions。错误通道按呈现面拆分（任务 3 审查次要 2 顺修）：`error`=工作区清单/选中失败（列表页
 * alert）；`actionError`=创建/删除失败（弹窗内就近呈现，取消不残留）；`membersError`=成员面
 * 失败（成员页顶部 alert）。语义沿用 desktop 先例：失败 error 上屏且不清旧态、创建/删除成功后
 * 自动刷新、删除 current 清选中、防重复提交。选中竞态防护（任务 3 审查次要 1 顺修）：序号
 * 校验，乱序完成的旧结果丢弃。成员 actions（任务 4，裁定 D）：清单/改角色/移除/添加（§3.2
 * PUT 对非成员即创建）+ 行级 memberBusyId；成功后刷新成员清单并重选 current（转让后自身
 * myRole 变化联动 Layout 管理入口显隐）。401 由共享 client 的会话失效钩子统一处理。
 */
import { createPinia, defineStore } from "pinia";
import { AdminApiError, type AdminClient } from "../api/client.js";
import type { AdminAclEntry, AdminAclRole, AdminMember, AdminRole, AdminTree, AdminWorkspaceDetail, AdminWorkspaceSummary } from "../api/contract.js";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface WorkspacesStoreDeps {
  client: AdminClient;
}

export function createWorkspacesStore(deps: WorkspacesStoreDeps) {
  const client = deps.client;
  /** 选中请求序号：竞态防护（任务 3 审查次要 1 顺修）——仅最新请求可落地结果。 */
  let selectSeq = 0;
  /** 树请求序号（收口顺修）：工作区切换乱序完成时丢弃旧结果，与 aclSeq/selectSeq 同口径。 */
  let treeSeq = 0;
  /** ACL 清单请求序号（任务 4 审查备案 4 同口径）：项目切换乱序完成时丢弃旧结果。 */
  let aclSeq = 0;
  return defineStore("admin-workspaces", {
    state: () => ({
      /** 工作区清单（GET /workspaces）。 */
      list: [] as AdminWorkspaceSummary[],
      /** 清单拉取在途。 */
      loading: false,
      /** 创建/删除在途（按钮 loading 与防重复提交）。 */
      submitting: false,
      /** 工作区清单/选中失败文案（列表页 alert 呈现）。 */
      error: null as string | null,
      /** 选中工作区详情；null = 未选中/未拉取/拉取失败（管理入口隐藏，防闪烁）。 */
      current: null as AdminWorkspaceDetail | null,
      /** 选中详情拉取在途（成员页与骨架加载态消费）。 */
      currentLoading: false,
      /** 创建/删除失败文案（弹窗内就近呈现，任务 3 审查次要 2 顺修拆分）。 */
      actionError: null as string | null,

      // —— 成员（任务 4，裁定 D）——
      /** 成员清单（GET /workspaces/{id}/members）。 */
      members: [] as AdminMember[],
      /** 成员清单拉取在途。 */
      membersLoading: false,
      /** 成员面失败文案（成员页顶部 alert 呈现）。 */
      membersError: null as string | null,
      /** 行级在途（改角色/移除的行 loading 与防重复提交）。 */
      memberBusyId: null as string | null,
      /** 添加成员提交在途。 */
      memberSubmitting: false,

      // —— 项目 ACL（任务 5，裁定 A/B）——
      /** 工作区树（GET tree；项目清单与 projects[].myRole 来源）。 */
      tree: null as AdminTree | null,
      /** 树拉取在途。 */
      treeLoading: false,
      /** 当前 ACL 行所属项目 id；null = 未加载。 */
      aclProjectId: null as string | null,
      /** 当前项目 ACL 行。 */
      aclEntries: [] as AdminAclEntry[],
      /** ACL 清单拉取在途。 */
      aclLoading: false,
      /** ACL 面失败文案（ACL 页顶部 alert 呈现）。 */
      aclError: null as string | null,
      /** ACL 行级在途（改角色/删行的行 loading 与防重复提交）。 */
      aclBusyUserId: null as string | null,
      /** 添加 ACL 行提交在途。 */
      aclSubmitting: false,
    }),
    actions: {
      /** 会话销毁后的状态重置（终审 Important 2）：装配层在登出/会话失效时调用，防换账号残留上一账号的选中/成员/树/ACL 上下文。 */
      reset(): void {
        this.$reset();
      },
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
       * （防闪烁隐藏入口）+ error 上屏。竞态防护：仅最新请求落地（顺修 1）。
       */
      async select(workspaceId: string): Promise<void> {
        const seq = ++selectSeq;
        this.currentLoading = true;
        try {
          const detail = await client.getWorkspace(workspaceId);
          if (seq !== selectSeq) return; // 乱序完成：已有更新的选中请求，丢弃本次结果
          this.current = detail;
        } catch (e) {
          if (seq !== selectSeq) return;
          this.current = null;
          this.error = errorMessage(e);
        } finally {
          if (seq === selectSeq) this.currentLoading = false;
        }
      },

      /** 创建：成功后自动刷新清单（裁定 B）；错误走 actionError（弹窗内呈现）。 */
      async create(input: { name: string }): Promise<boolean> {
        if (this.submitting) return false;
        this.submitting = true;
        this.actionError = null;
        try {
          await client.createWorkspace(input);
          await this.refresh();
          return true;
        } catch (e) {
          this.actionError = errorMessage(e);
          return false;
        } finally {
          this.submitting = false;
        }
      },

      /** 删除：成功后自动刷新清单；删除的是 current → 清选中。错误走 actionError。 */
      async remove(workspaceId: string): Promise<boolean> {
        if (this.submitting) return false;
        this.submitting = true;
        this.actionError = null;
        try {
          await client.deleteWorkspace(workspaceId);
          if (this.current?.id === workspaceId) this.current = null;
          await this.refresh();
          return true;
        } catch (e) {
          this.actionError = errorMessage(e);
          return false;
        } finally {
          this.submitting = false;
        }
      },

      /**
       * 成员清单拉取（任务 4，裁定 D）。403（非 ADMIN 直达 URL，裁定 C）→ forbidden=true
       * 供视图弹回列表；原因入 membersError（成员面唯一错误通道——不外溢工作区列表页通道，
       * 避免与列表刷新清空 error 的时序耦合）。
       */
      async loadMembers(workspaceId: string): Promise<{ ok: boolean; forbidden: boolean }> {
        this.membersLoading = true;
        this.membersError = null;
        try {
          this.members = await client.listMembers(workspaceId);
          return { ok: true, forbidden: false };
        } catch (e) {
          const forbidden = e instanceof AdminApiError && e.status === 403;
          this.membersError = errorMessage(e);
          return { ok: false, forbidden };
        } finally {
          this.membersLoading = false;
        }
      },

      /** 成员变更成功后的统一收口：刷新清单 + 重选 current（myRole/memberCount 变化联动）。 */
      async refreshMembersAndCurrent(workspaceId: string): Promise<void> {
        await this.loadMembers(workspaceId);
        if (this.current?.id === workspaceId) await this.select(workspaceId);
      },

      /** 改角色（行级 busy 防重复提交）；OWNER 行由 UI 禁用（D6 体验层，后端 403 为准）。 */
      async changeRole(workspaceId: string, userId: string, role: AdminRole): Promise<boolean> {
        if (this.memberBusyId !== null) return false;
        this.memberBusyId = userId;
        this.membersError = null;
        try {
          await client.setMemberRole(workspaceId, userId, role);
          await this.refreshMembersAndCurrent(workspaceId);
          return true;
        } catch (e) {
          this.membersError = errorMessage(e);
          return false;
        } finally {
          this.memberBusyId = null;
        }
      },

      /** 添加成员（§3.2 PUT 对非成员即创建行）。 */
      async addMember(workspaceId: string, userId: string, role: AdminRole): Promise<boolean> {
        if (this.memberSubmitting) return false;
        this.memberSubmitting = true;
        this.membersError = null;
        try {
          await client.setMemberRole(workspaceId, userId, role);
          await this.refreshMembersAndCurrent(workspaceId);
          return true;
        } catch (e) {
          this.membersError = errorMessage(e);
          return false;
        } finally {
          this.memberSubmitting = false;
        }
      },

      /** 移除成员（行级 busy；OWNER 行由 UI 禁用）。 */
      async removeMember(workspaceId: string, userId: string): Promise<boolean> {
        if (this.memberBusyId !== null) return false;
        this.memberBusyId = userId;
        this.membersError = null;
        try {
          await client.removeMember(workspaceId, userId);
          await this.refreshMembersAndCurrent(workspaceId);
          return true;
        } catch (e) {
          this.membersError = errorMessage(e);
          return false;
        } finally {
          this.memberBusyId = null;
        }
      },

      /**
       * 拉取工作区树（任务 5，裁定 A/C）：项目清单与 projects[].myRole 来源；失败 → aclError
       * 上屏（ACL 页顶部 alert 单通道）。竞态防护（收口顺修）：工作区切换乱序完成时以最新
       * 请求为准，与 aclSeq/selectSeq 同口径。
       */
      async loadTree(workspaceId: string): Promise<void> {
        const seq = ++treeSeq;
        this.treeLoading = true;
        try {
          const tree = await client.getTree(workspaceId);
          if (seq !== treeSeq) return; // 乱序完成：已有更新的工作区切换，丢弃本次结果
          this.tree = tree;
        } catch (e) {
          if (seq !== treeSeq) return;
          this.aclError = errorMessage(e);
        } finally {
          if (seq === treeSeq) this.treeLoading = false;
        }
      },

      /**
       * 拉取项目 ACL 行（任务 5，裁定 A）。竞态防护：项目切换乱序完成时以最新请求为准
       * （select 同款序号口径，任务 4 审查备案 4）。
       */
      async loadAcl(workspaceId: string, projectId: string): Promise<void> {
        const seq = ++aclSeq;
        this.aclLoading = true;
        try {
          const entries = await client.listAcl(workspaceId, projectId);
          if (seq !== aclSeq) return; // 乱序完成：已有更新的项目切换，丢弃本次结果
          this.aclEntries = entries;
          this.aclProjectId = projectId;
        } catch (e) {
          if (seq !== aclSeq) return;
          this.aclError = errorMessage(e);
        } finally {
          if (seq === aclSeq) this.aclLoading = false;
        }
      },

      /** ACL 变更成功后的统一收口：重载当前项目 ACL 行 + 重载树（myRole 变化联动，裁定 B/C）。
       * 树重载以 tree.workspaceId 归属判定（防跨工作区覆写），不依赖选中详情 current。 */
      async refreshAclAndTree(workspaceId: string, projectId: string): Promise<void> {
        await this.loadAcl(workspaceId, projectId);
        if (this.tree?.workspaceId === workspaceId) await this.loadTree(workspaceId);
      },

      /**
       * 设置 ACL 行（PUT；NONE=拒之门外，任务 5 裁定 B——行仍在显示 NONE）。行级 busy 防重复提交。
       */
      async setAclEntry(workspaceId: string, projectId: string, input: { userId: string; role: AdminAclRole }): Promise<boolean> {
        if (this.aclBusyUserId !== null) return false;
        this.aclBusyUserId = input.userId;
        this.aclError = null;
        try {
          await client.setAclEntry(workspaceId, projectId, input);
          await this.refreshAclAndTree(workspaceId, projectId);
          return true;
        } catch (e) {
          this.aclError = errorMessage(e);
          return false;
        } finally {
          this.aclBusyUserId = null;
        }
      },

      /**
       * 添加 ACL 行（收口顺修：对齐 members addMember 先例——aclSubmitting 在途/防重复提交，
       * 添加按钮 loading 生效；与行级 aclBusyUserId 通道分离）。
       */
      async addAclEntry(workspaceId: string, projectId: string, input: { userId: string; role: AdminAclRole }): Promise<boolean> {
        if (this.aclSubmitting) return false;
        this.aclSubmitting = true;
        this.aclError = null;
        try {
          await client.setAclEntry(workspaceId, projectId, input);
          await this.refreshAclAndTree(workspaceId, projectId);
          return true;
        } catch (e) {
          this.aclError = errorMessage(e);
          return false;
        } finally {
          this.aclSubmitting = false;
        }
      },

      /**
       * 删除 ACL 行（DELETE ?userId=，契约修订 2026-09-04：删行=恢复工作区角色继承——行消失）。
       */
      async removeAclEntry(workspaceId: string, projectId: string, userId: string): Promise<boolean> {
        if (this.aclBusyUserId !== null) return false;
        this.aclBusyUserId = userId;
        this.aclError = null;
        try {
          await client.deleteAclEntry(workspaceId, projectId, userId);
          await this.refreshAclAndTree(workspaceId, projectId);
          return true;
        } catch (e) {
          this.aclError = errorMessage(e);
          return false;
        } finally {
          this.aclBusyUserId = null;
        }
      },
    },
  })(createPinia());
}

export type WorkspacesStore = ReturnType<typeof createWorkspacesStore>;
