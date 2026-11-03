/**
 * 工作区 store 工厂（M4-A 任务 3/4，裁定 B/D）：清单/创建/删除 + 选中工作区上下文 + 成员管理
 * actions。错误通道按呈现面拆分（任务 3 审查次要 2 顺修）：`error`=工作区清单/选中失败（列表页
 * alert）；`actionError`=创建/删除失败（弹窗内就近呈现，取消不残留）；`membersError`=成员面
 * 失败（成员页顶部 alert）；`candidatesError`=候选搜索失败（添加行就地呈现，终审顺手⑥补记
 * 第四通道——不入 membersError 顶部通道）。语义沿用 desktop 先例：失败 error 上屏且不清旧态、创建/删除成功后
 * 自动刷新、删除 current 清选中、防重复提交。选中竞态防护（任务 3 审查次要 1 顺修）：序号
 * 校验，乱序完成的旧结果丢弃。成员 actions（任务 4，裁定 D）：清单/改角色/移除/添加（§3.2
 * PUT 对非成员即创建）+ 行级 memberBusyId；成功后刷新成员清单并重选 current（转让后自身
 * myRole 变化联动 Layout 管理入口显隐）。401 由共享 client 的会话失效钩子统一处理。
 */
import { createPinia, defineStore } from "pinia";
import { AdminApiError, type AdminClient } from "../api/client.js";
import type { AdminAclEntry, AdminAclRole, AdminMember, AdminRole, AdminTree, AdminUserCandidate, AdminWorkspaceDetail, AdminWorkspaceSummary } from "../api/contract.js";
import { createCollaborationApi, type AccessMember, type AccessScope, type ManagementProject, type CapabilityMode } from '../api/collaboration.js';

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface WorkspacesStoreDeps {
  client: AdminClient;
}

export function createWorkspacesStore(deps: WorkspacesStoreDeps) {
  const client = deps.client;
  const collaboration=createCollaborationApi(client);
  let accessGeneration=0;
  let directorySequence=0;
  /** 选中请求序号：竞态防护（任务 3 审查次要 1 顺修）——仅最新请求可落地结果。 */
  let selectSeq = 0;
  /** 树请求序号（收口顺修）：工作区切换乱序完成时丢弃旧结果，与 aclSeq/selectSeq 同口径。 */
  let treeSeq = 0;
  /** ACL 清单请求序号（任务 4 审查备案 4 同口径）：项目切换乱序完成时丢弃旧结果。 */
  let aclSeq = 0;
  /** 候选搜索请求序号：乱序完成的旧结果丢弃（selectSeq 同口径）。 */
  let candidateSeq = 0;
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
      /** 非成员候选（GET member-candidates；规格 2026-09-09 成员搜索）——搜索下拉数据源。 */
      candidates: [] as AdminUserCandidate[],
      /** 候选搜索在途。 */
      candidatesLoading: false,
      /** 候选搜索失败文案（添加行就地呈现，不入成员面顶部通道）。 */
      candidatesError: null as string | null,

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
      managementProjects: [] as ManagementProject[],
      managementWorkspaceId:null as string|null,
      accessMembers: {} as Record<string,AccessMember>,
      memberDrafts: {} as Record<string,AdminRole>,
      aclDrafts: {} as Record<string,AdminAclRole>,
    }),
    actions: {
      async changeCapabilities(scope:AccessScope,userId:string,capabilities:Record<string,CapabilityMode>):Promise<boolean>{
        const generation=accessGeneration;
        try{const subject=await this.readAccessMember(scope,userId);if(generation!==accessGeneration)return false;const value=await collaboration.putMember(scope,userId,{expectedRevision:subject.revision,capabilities});if(generation!==accessGeneration)return false;this.accessMembers[`${scope.workspaceId}/${scope.projectId??''}/${userId}`]=value;return true;}
        catch(e){if(generation===accessGeneration){if(scope.projectId)this.aclError=errorMessage(e);else this.membersError=errorMessage(e);}return false;}
      },
      async refreshAccessMember(scope:AccessScope,userId:string):Promise<void>{
        const generation=accessGeneration;
        try{await this.readAccessMember(scope,userId,true);}catch(e){if(generation===accessGeneration){if(scope.projectId)this.aclError=errorMessage(e);else this.membersError=errorMessage(e);}}
      },
      async confirmAccess(workspaceId:string,projectId:string,userId:string,action:'confirm-inheritance'|'confirm-override',role?:AdminAclRole):Promise<boolean>{
        const generation=accessGeneration;
        this.aclBusyUserId=userId;this.aclError=null;
        try{
          const subject=await this.readAccessMember({workspaceId,projectId},userId);
          if(generation!==accessGeneration)return false;
          const value=await collaboration.putMember({workspaceId,projectId},userId,{expectedRevision:subject.revision,action,...(role===undefined?{}:{role})});
          if(generation!==accessGeneration)return false;this.accessMembers[`${workspaceId}/${projectId}/${userId}`]=value;
          await this.loadAcl(workspaceId,projectId);return true;
        }catch(e){if(generation===accessGeneration)this.aclError=errorMessage(e);return false;}finally{if(generation===accessGeneration)this.aclBusyUserId=null;}
      },
      async loadManagementProjects(workspaceId:string):Promise<void>{
        const generation=accessGeneration,sequence=++directorySequence;
        if(this.managementWorkspaceId!==workspaceId)this.managementProjects=[];
        this.managementWorkspaceId=workspaceId;this.aclError=null;
        try{const rows=await collaboration.directory(workspaceId);if(generation===accessGeneration&&sequence===directorySequence)this.managementProjects=rows;}catch(e){if(generation===accessGeneration&&sequence===directorySequence)this.aclError=errorMessage(e);}
      },
      async readAccessMember(scope:AccessScope,userId:string,refresh=false):Promise<AccessMember>{
        const generation=accessGeneration;
        const key=`${scope.workspaceId}/${scope.projectId??''}/${userId}`;
        if(!refresh&&this.accessMembers[key])return this.accessMembers[key]!;
        const value=await collaboration.member(scope,userId);
        if(generation!==accessGeneration)throw new AdminApiError(0,'admin_session_changed','管理会话已变化，请重新读取当前权限');
        this.accessMembers[key]=value;return value;
      },
      /** 会话销毁后的状态重置（终审 Important 2）：装配层在登出/会话失效时调用，防换账号残留上一账号的选中/成员/树/ACL 上下文。 */
      reset(): void {
        accessGeneration+=1;
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
        const generation = accessGeneration;
        const seq = ++selectSeq;
        this.currentLoading = true;
        try {
          const detail = await client.getWorkspace(workspaceId);
          if (generation !== accessGeneration || seq !== selectSeq) return;
          this.current = detail;
        } catch (e) {
          if (generation !== accessGeneration || seq !== selectSeq) return;
          this.current = null;
          this.error = errorMessage(e);
        } finally {
          if (generation === accessGeneration && seq === selectSeq) this.currentLoading = false;
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
        const generation = accessGeneration;
        this.membersLoading = true;
        this.membersError = null;
        try {
          const entries=await client.listMembers(workspaceId);
          if (generation !== accessGeneration) return { ok: false, forbidden: false };
          await Promise.all(entries.map(entry=>this.readAccessMember({workspaceId},entry.userId,true)));
          if (generation !== accessGeneration) return { ok: false, forbidden: false };
          this.members = entries;
          return { ok: true, forbidden: false };
        } catch (e) {
          if (generation !== accessGeneration) return { ok: false, forbidden: false };
          const forbidden = e instanceof AdminApiError && e.status === 403;
          this.membersError = errorMessage(e);
          return { ok: false, forbidden };
        } finally {
          if (generation === accessGeneration) this.membersLoading = false;
        }
      },

      /** 成员变更成功后的统一收口：刷新清单 + 重选 current（myRole/memberCount 变化联动）。 */
      async refreshMembersAndCurrent(workspaceId: string): Promise<void> {
        const generation = accessGeneration;
        await this.loadMembers(workspaceId);
        if (generation !== accessGeneration) return;
        if (this.current?.id === workspaceId) await this.select(workspaceId);
      },

      /** 改角色（行级 busy 防重复提交）；OWNER 行由 UI 禁用（D6 体验层，后端 403 为准）。 */
      async changeRole(workspaceId: string, userId: string, role: AdminRole): Promise<boolean> {
        const generation = accessGeneration;
        if (this.memberBusyId !== null) return false;
        this.memberBusyId = userId;
        this.membersError = null;
        this.memberDrafts[`${workspaceId}//${userId}`]=role;
        try {
          const subject=await this.readAccessMember({workspaceId},userId);
          if (generation !== accessGeneration) return false;
          const actor=role==='OWNER'?await this.readAccessMember({workspaceId},this.members.find(m=>m.role==='OWNER')!.userId):undefined;
          if (generation !== accessGeneration) return false;
          await client.setMemberRole(workspaceId, userId, role,subject.revision,actor?.revision);
          if (generation !== accessGeneration) return false;
          delete this.accessMembers[`${workspaceId}//${userId}`];
          delete this.memberDrafts[`${workspaceId}//${userId}`];
          await this.refreshMembersAndCurrent(workspaceId);
          return generation === accessGeneration;
        } catch (e) {
          if (generation === accessGeneration) this.membersError = errorMessage(e);
          return false;
        } finally {
          if (generation === accessGeneration) this.memberBusyId = null;
        }
      },

      /** 添加成员（§3.2 PUT 对非成员即创建行）。 */
      async addMember(workspaceId: string, userId: string, role: AdminRole,expectedRevision?:number): Promise<boolean> {
        const generation = accessGeneration;
        if (this.memberSubmitting) return false;
        this.memberSubmitting = true;
        this.membersError = null;
        try {
          const revision=expectedRevision??(await this.readAccessMember({workspaceId},userId)).revision;
          if (generation !== accessGeneration) return false;
          await client.setMemberRole(workspaceId, userId, role,revision);
          if (generation !== accessGeneration) return false;
          delete this.accessMembers[`${workspaceId}//${userId}`];
          await this.refreshMembersAndCurrent(workspaceId);
          return generation === accessGeneration;
        } catch (e) {
          if (generation === accessGeneration) this.membersError = errorMessage(e);
          return false;
        } finally {
          if (generation === accessGeneration) this.memberSubmitting = false;
        }
      },

      /** 候选搜索（规格 2026-09-09）：空关键字不发请求直接清空；limit 固定 10（服务端上限 50）。 */
      async searchCandidates(workspaceId: string, q: string): Promise<void> {
        const keyword = q.trim();
        const seq = ++candidateSeq;
        if (!keyword) {
          this.candidates = [];
          this.candidatesError = null;
          this.candidatesLoading = false; // 在途请求已被序号作废，此处不复位将滞留 true（任务 3 审查重要 1）
          return;
        }
        this.candidatesLoading = true;
        try {
          const rows = await client.searchUserCandidates(workspaceId, keyword, 10);
          if (seq === candidateSeq) {
            this.candidates = rows;
            this.candidatesError = null;
          }
        } catch (e) {
          if (seq === candidateSeq) {
            this.candidates = [];
            this.candidatesError = errorMessage(e);
          }
        } finally {
          if (seq === candidateSeq) this.candidatesLoading = false;
        }
      },

      /** 添加成功后由视图调用复位候选区。 */
      clearCandidates(): void {
        candidateSeq += 1; // 在途响应作废
        this.candidates = [];
        this.candidatesError = null;
        this.candidatesLoading = false; // 同上：作废在途请求后必须亲手复位 loading（任务 3 审查重要 1）
      },

      /** 移除成员（行级 busy；OWNER 行由 UI 禁用）。 */
      async removeMember(workspaceId: string, userId: string): Promise<boolean> {
        const generation = accessGeneration;
        if (this.memberBusyId !== null) return false;
        this.memberBusyId = userId;
        this.membersError = null;
        try {
          const subject=await this.readAccessMember({workspaceId},userId);
          if (generation !== accessGeneration) return false;
          await client.removeMember(workspaceId, userId,subject.revision);
          if (generation !== accessGeneration) return false;
          delete this.accessMembers[`${workspaceId}//${userId}`];
          await this.refreshMembersAndCurrent(workspaceId);
          return generation === accessGeneration;
        } catch (e) {
          if (generation === accessGeneration) this.membersError = errorMessage(e);
          return false;
        } finally {
          if (generation === accessGeneration) this.memberBusyId = null;
        }
      },

      /**
       * 拉取工作区树（任务 5，裁定 A/C）：项目清单与 projects[].myRole 来源；失败 → aclError
       * 上屏（ACL 页顶部 alert 单通道）。竞态防护（收口顺修）：工作区切换乱序完成时以最新
       * 请求为准，与 aclSeq/selectSeq 同口径。
       */
      async loadTree(workspaceId: string): Promise<void> {
        const generation = accessGeneration;
        const seq = ++treeSeq;
        this.treeLoading = true;
        try {
          const tree = await client.getTree(workspaceId);
          if (generation !== accessGeneration || seq !== treeSeq) return;
          this.tree = tree;
        } catch (e) {
          if (generation !== accessGeneration || seq !== treeSeq) return;
          this.aclError = errorMessage(e);
        } finally {
          if (generation === accessGeneration && seq === treeSeq) this.treeLoading = false;
        }
      },

      /**
       * 拉取项目 ACL 行（任务 5，裁定 A）。竞态防护：项目切换乱序完成时以最新请求为准
       * （select 同款序号口径，任务 4 审查备案 4）。
       */
      async loadAcl(workspaceId: string, projectId: string): Promise<void> {
        const generation = accessGeneration;
        const seq = ++aclSeq;
        this.aclLoading = true;
        try {
          const entries = await client.listAcl(workspaceId, projectId);
          if (generation !== accessGeneration || seq !== aclSeq) return;
          await Promise.all(entries.map(entry=>this.readAccessMember({workspaceId,projectId},entry.userId)));
          if (generation !== accessGeneration || seq !== aclSeq) return;
          this.aclEntries = entries;
          this.aclProjectId = projectId;
        } catch (e) {
          if (generation !== accessGeneration || seq !== aclSeq) return;
          this.aclError = errorMessage(e);
        } finally {
          if (generation === accessGeneration && seq === aclSeq) this.aclLoading = false;
        }
      },

      /** ACL 变更成功后的统一收口：重载当前项目 ACL 行 + 重载树（myRole 变化联动，裁定 B/C）。
       * 树重载以 tree.workspaceId 归属判定（防跨工作区覆写），不依赖选中详情 current。 */
      async refreshAclAndTree(workspaceId: string, projectId: string): Promise<void> {
        const generation = accessGeneration;
        await this.loadAcl(workspaceId, projectId);
        if (generation !== accessGeneration) return;
        await this.loadManagementProjects(workspaceId);
        if (generation !== accessGeneration) return;
        if (this.tree?.workspaceId === workspaceId) await this.loadTree(workspaceId);
      },

      /**
       * 设置 ACL 行（PUT；NONE=拒之门外，任务 5 裁定 B——行仍在显示 NONE）。行级 busy 防重复提交。
       */
      async setAclEntry(workspaceId: string, projectId: string, input: { userId: string; role: AdminAclRole }): Promise<boolean> {
        const generation = accessGeneration;
        if (this.aclBusyUserId !== null) return false;
        this.aclBusyUserId = input.userId;
        this.aclError = null;
        this.aclDrafts[`${workspaceId}/${projectId}/${input.userId}`]=input.role;
        try {
          const subject=await this.readAccessMember({workspaceId,projectId},input.userId);
          if (generation !== accessGeneration) return false;
          await client.setAclEntry(workspaceId, projectId, {...input,expectedRevision:subject.revision});
          if (generation !== accessGeneration) return false;
          delete this.accessMembers[`${workspaceId}/${projectId}/${input.userId}`];
          delete this.aclDrafts[`${workspaceId}/${projectId}/${input.userId}`];
          await this.refreshAclAndTree(workspaceId, projectId);
          return generation === accessGeneration;
        } catch (e) {
          if (generation === accessGeneration) this.aclError = errorMessage(e);
          return false;
        } finally {
          if (generation === accessGeneration) this.aclBusyUserId = null;
        }
      },

      /**
       * 添加 ACL 行（收口顺修：对齐 members addMember 先例——aclSubmitting 在途/防重复提交，
       * 添加按钮 loading 生效；与行级 aclBusyUserId 通道分离）。
       */
      async addAclEntry(workspaceId: string, projectId: string, input: { userId: string; role: AdminAclRole;expectedRevision?:number }): Promise<boolean> {
        const generation = accessGeneration;
        if (this.aclSubmitting) return false;
        this.aclSubmitting = true;
        this.aclError = null;
        try {
          const revision=input.expectedRevision??(await this.readAccessMember({workspaceId,projectId},input.userId)).revision;
          if (generation !== accessGeneration) return false;
          await client.setAclEntry(workspaceId, projectId, {...input,expectedRevision:revision});
          if (generation !== accessGeneration) return false;
          delete this.accessMembers[`${workspaceId}/${projectId}/${input.userId}`];
          await this.refreshAclAndTree(workspaceId, projectId);
          return generation === accessGeneration;
        } catch (e) {
          if (generation === accessGeneration) this.aclError = errorMessage(e);
          return false;
        } finally {
          if (generation === accessGeneration) this.aclSubmitting = false;
        }
      },

      /**
       * 删除 ACL 行（DELETE ?userId=，契约修订 2026-09-04：删行=恢复工作区角色继承——行消失）。
       */
      async removeAclEntry(workspaceId: string, projectId: string, userId: string): Promise<boolean> {
        const generation = accessGeneration;
        if (this.aclBusyUserId !== null) return false;
        this.aclBusyUserId = userId;
        this.aclError = null;
        try {
          const subject=await this.readAccessMember({workspaceId,projectId},userId);
          if (generation !== accessGeneration) return false;
          await client.deleteAclEntry(workspaceId, projectId, userId,subject.revision);
          if (generation !== accessGeneration) return false;
          delete this.accessMembers[`${workspaceId}/${projectId}/${userId}`];
          await this.refreshAclAndTree(workspaceId, projectId);
          return generation === accessGeneration;
        } catch (e) {
          if (generation === accessGeneration) this.aclError = errorMessage(e);
          return false;
        } finally {
          if (generation === accessGeneration) this.aclBusyUserId = null;
        }
      },
    },
  })(createPinia());
}

export type WorkspacesStore = ReturnType<typeof createWorkspacesStore>;
