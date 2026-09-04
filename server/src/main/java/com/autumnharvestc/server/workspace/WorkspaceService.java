package com.autumnharvestc.server.workspace;

import com.autumnharvestc.server.content.WorkspaceContentStore;
import com.autumnharvestc.server.core.Role;
import com.autumnharvestc.server.store.AclRepo;
import com.autumnharvestc.server.store.FileVersionRepo;
import com.autumnharvestc.server.store.MembershipRepo;
import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.store.WorkspaceRecord;
import com.autumnharvestc.server.store.WorkspaceRepo;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * 工作区用例（规格 m3 §3.2）：列表/创建/详情/删除。
 * 事务约定（裁定 B）：不使用 @Transactional——各写步骤以单条语句自持原子；
 * 创建按「建目录 → 工作区行 → OWNER 成员行」顺序，任一失败不产生半可用状态（目录失败则无 DB 写入；
 * 成员行无外键依赖，插入失败概率可忽略，注释留痕）。
 * 删除按裁定 D：逻辑校验 OWNER → 清 memberships/project_acl/file_versions → 删工作区行 → 递归删内容目录；
 * 任一 DB 步失败即中止不触盘，删盘失败 → 500 content_delete_failed（记录已删，取舍见报告）。
 */
@Service
public class WorkspaceService {

    private final WorkspaceRepo workspaces;
    private final MembershipRepo memberships;
    private final AclRepo acl;
    private final FileVersionRepo fileVersions;
    private final WorkspaceGuard guard;
    private final WorkspaceContentStore contentStore;

    public WorkspaceService(WorkspaceRepo workspaces,
                            MembershipRepo memberships,
                            AclRepo acl,
                            FileVersionRepo fileVersions,
                            WorkspaceGuard guard,
                            WorkspaceContentStore contentStore) {
        this.workspaces = workspaces;
        this.memberships = memberships;
        this.acl = acl;
        this.fileVersions = fileVersions;
        this.guard = guard;
        this.contentStore = contentStore;
    }

    /** 创建工作区（规格 §3.2：创建者自动 OWNER；§2 D6：建内容目录）。 */
    public WorkspaceView create(UserAccount caller, CreateWorkspaceRequest request) {
        WorkspaceRecord workspace = new WorkspaceRecord(
                UUID.randomUUID().toString(), request.name().trim(), caller.id(), Instant.now());
        contentStore.createWorkspaceDir(workspace.id());
        workspaces.insert(workspace);
        memberships.insert(workspace.id(), caller.id(), Role.OWNER);
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
