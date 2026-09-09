package com.autumnharvestc.server.workspace;

import com.autumnharvestc.server.core.ApiException;
import com.autumnharvestc.server.core.Role;
import com.autumnharvestc.server.store.AclRepo;
import com.autumnharvestc.server.store.FileVersionRepo;
import com.autumnharvestc.server.store.GroupRecord;
import com.autumnharvestc.server.store.GroupRepo;
import com.autumnharvestc.server.store.MembershipRepo;
import com.autumnharvestc.server.store.ProjectRepo;
import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.store.WorkspaceRecord;
import com.autumnharvestc.server.store.WorkspaceRepo;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * 工作区用例（规格 m3 §3.2）：列表/创建/详情/删除。
 * 事务约定（裁定 B + 计划要求的例外）：默认不使用 @Transactional——各写步骤以单条语句自持原子；
 * 例外是 create：三次 DB 写（工作区行/OWNER 成员行/默认分组行）包裹同一事务，任一失败全部回滚，
 * 不产生「有工作区、无默认分组」的永久半状态（审查修复）。
 * 删除按裁定 D（维持逐条自持，不包事务）：逻辑校验 OWNER → 清 memberships/project_acl/file_versions
 * → projects → groups（fk_projects_group 依赖顺序：先删引用行再删被引用行）→ 删工作区行。
 * 内容随 file_versions.content 入库（规格 §5），磁盘内容树退役——建区/删区不再有任何目录操作。
 */
@Service
public class WorkspaceService {

    /** 规格 2026-09-08 §4：每工作区固定一个不可删改的「默认分组」。 */
    public static final String DEFAULT_GROUP_NAME = "默认分组";

    private final WorkspaceRepo workspaces;
    private final MembershipRepo memberships;
    private final AclRepo acl;
    private final FileVersionRepo fileVersions;
    private final GroupRepo groups;
    private final ProjectRepo projects;
    private final WorkspaceGuard guard;

    public WorkspaceService(WorkspaceRepo workspaces,
                            MembershipRepo memberships,
                            AclRepo acl,
                            FileVersionRepo fileVersions,
                            GroupRepo groups,
                            ProjectRepo projects,
                            WorkspaceGuard guard) {
        this.workspaces = workspaces;
        this.memberships = memberships;
        this.acl = acl;
        this.fileVersions = fileVersions;
        this.groups = groups;
        this.projects = projects;
        this.guard = guard;
    }

    /**
     * 创建工作区（规格 §3.2：创建者自动 OWNER；规格 2026-09-08 §4：联动建「默认分组」）。
     * 三次 DB 写同事务（见类头）：任一失败全回滚。
     */
    @Transactional
    public WorkspaceView create(UserAccount caller, CreateWorkspaceRequest request) {
        // created_by 列本轮仍 VARCHAR（任务 3 收口）：users.id 已 BIGINT 化，此处暂以字符串桥接
        WorkspaceRecord workspace = new WorkspaceRecord(
                UUID.randomUUID().toString(), request.name().trim(), String.valueOf(caller.id()), Instant.now());
        try {
            workspaces.insert(workspace);
        } catch (DuplicateKeyException ex) {
            // 并发同名工作区兜底：uk_workspaces_name（预检不预占，唯一约束是唯一事实源）→ 409
            throw new ApiException(HttpStatus.CONFLICT, "workspace_name_taken", "工作区名称已存在");
        }
        memberships.insert(workspace.id(), caller.id(), Role.OWNER);
        groups.insert(new GroupRecord(
                UUID.randomUUID().toString(), workspace.id(), DEFAULT_GROUP_NAME, true, Instant.now()));
        return new WorkspaceView(workspace.id(), workspace.name(), Role.OWNER, workspace.createdAt());
    }

    /** 我参与的工作区列表（规格 §3.2）。 */
    public List<WorkspaceView> list(UserAccount caller) {
        return workspaces.findByMember(caller.id()).stream()
                .map(WorkspaceView::of)
                .toList();
    }

    /** 工作区详情（规格 §3.2：{id, name, myRole, memberCount}，成员可读）。 */
    public WorkspaceDetailView detail(UserAccount caller, String workspaceId) {
        WorkspaceGuard.Access access = guard.requireMember(workspaceId, caller);
        return new WorkspaceDetailView(
                access.workspace().id(),
                access.workspace().name(),
                access.role(),
                memberships.countByWorkspace(workspaceId));
    }

    /** 删除工作区（规格 §3.2：OWNER；内容随版本行同删，无磁盘面）。 */
    public void delete(UserAccount caller, String workspaceId) {
        guard.requireOwner(workspaceId, caller);
        memberships.deleteByWorkspace(workspaceId);
        acl.deleteByWorkspace(workspaceId);
        fileVersions.deleteByWorkspace(workspaceId);
        // groups/projects 一并清理（审查修复）：projects 先于 groups——fk_projects_group 引用顺序
        projects.deleteByWorkspace(workspaceId);
        groups.deleteByWorkspace(workspaceId);
        workspaces.delete(workspaceId);
    }
}
