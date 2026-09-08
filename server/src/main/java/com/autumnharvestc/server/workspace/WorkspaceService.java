package com.autumnharvestc.server.workspace;

import com.autumnharvestc.server.content.WorkspaceContentStore;
import com.autumnharvestc.server.core.ApiException;
import com.autumnharvestc.server.core.Role;
import com.autumnharvestc.server.store.AclRepo;
import com.autumnharvestc.server.store.FileVersionRepo;
import com.autumnharvestc.server.store.GroupRecord;
import com.autumnharvestc.server.store.GroupRepo;
import com.autumnharvestc.server.store.MembershipRepo;
import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.store.WorkspaceRecord;
import com.autumnharvestc.server.store.WorkspaceRepo;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * 工作区用例（规格 m3 §3.2）：列表/创建/详情/删除。
 * 事务约定（裁定 B）：不使用 @Transactional——各写步骤以单条语句自持原子；
 * 创建按「建目录 → 工作区行 → OWNER 成员行 → 默认分组行」顺序，任一失败不产生半可用状态
 * （目录失败则无 DB 写入；同名工作区行失败 → 清掉刚建的目录转 409 workspace_name_taken；
 * 成员行/默认分组行无冲突风险（新工作区 id 下成员主键与 (workspace_id, name) 均不可能已存在），
 * 插入失败概率可忽略，注释留痕）。
 * 删除按裁定 D：逻辑校验 OWNER → 清 memberships/project_acl/file_versions → 删工作区行 → 递归删内容目录；
 * 任一 DB 步失败即中止不触盘，删盘失败 → 500 content_delete_failed（记录已删，取舍见报告）。
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
    private final WorkspaceGuard guard;
    private final WorkspaceContentStore contentStore;

    public WorkspaceService(WorkspaceRepo workspaces,
                            MembershipRepo memberships,
                            AclRepo acl,
                            FileVersionRepo fileVersions,
                            GroupRepo groups,
                            WorkspaceGuard guard,
                            WorkspaceContentStore contentStore) {
        this.workspaces = workspaces;
        this.memberships = memberships;
        this.acl = acl;
        this.fileVersions = fileVersions;
        this.groups = groups;
        this.guard = guard;
        this.contentStore = contentStore;
    }

    /** 创建工作区（规格 §3.2：创建者自动 OWNER；§2 D6：建内容目录；规格 2026-09-08 §4：联动建「默认分组」）。 */
    public WorkspaceView create(UserAccount caller, CreateWorkspaceRequest request) {
        WorkspaceRecord workspace = new WorkspaceRecord(
                UUID.randomUUID().toString(), request.name().trim(), caller.id(), Instant.now());
        contentStore.createWorkspaceDir(workspace.id());
        try {
            workspaces.insert(workspace);
        } catch (DuplicateKeyException ex) {
            // 并发同名工作区兜底：uk_workspaces_name（预检不预占，唯一约束是唯一事实源）；
            // 目录先于库行建立（裁定 B 顺序），此处清掉刚建的空目录再转 409，不留无主目录
            contentStore.deleteWorkspaceDirRecursively(workspace.id());
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

    /** 删除工作区（规格 §3.2：OWNER；含内容目录——裁定 D 顺序）。 */
    public void delete(UserAccount caller, String workspaceId) {
        guard.requireOwner(workspaceId, caller);
        // 先库后盘：任一 DB 步失败即中止（异常上抛），不触碰内容目录
        memberships.deleteByWorkspace(workspaceId);
        acl.deleteByWorkspace(workspaceId);
        fileVersions.deleteByWorkspace(workspaceId);
        workspaces.delete(workspaceId);
        // 记录已删后再删盘；失败 → 500 content_delete_failed（取舍见任务 4 报告）
        contentStore.deleteWorkspaceDirRecursively(workspaceId);
    }
}
