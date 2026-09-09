package com.autumnharvestc.server.workspace;

import com.autumnharvestc.server.core.ApiException;
import com.autumnharvestc.server.core.EntityIds;
import com.autumnharvestc.server.core.Role;
import com.autumnharvestc.server.store.AclRepo;
import com.autumnharvestc.server.store.FileVersionRepo;
import com.autumnharvestc.server.store.GroupRepo;
import com.autumnharvestc.server.store.ProjectRecord;
import com.autumnharvestc.server.store.ProjectRepo;
import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.store.WorkspaceRecord;
import com.autumnharvestc.server.store.WorkspaceRepo;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.List;

/**
 * 项目管理用例（规格 2026-09-08 §4，计划 B 任务 2）+ 连接握手（§6）。
 * 写操作（建/改名/移动/删）= 工作区 ADMIN+，守卫在方法首行（越权 403 先于存在性检查）；
 * 清单（GET）= 成员可读。
 * 项目名允许同名（§4，身份=id，不查重）；分组归属校验在服务层——fk_projects_group 仅保证
 * 分组全局存在，「项目须挂同工作区分组」是业务规则（404 group_not_found，外键不保证，留痕）。
 * 删除级联（裁定 D 逐条自持，不包事务——失败中断留部分行可重试删除）：先内容版本行
 * （file_versions 按 {@code <projectId>/%} 前缀删，数字 id 无 SQL 通配字符，LIKE 安全），
 * 再项目 ACL 行，最后实体行。
 * connect：取唯一工作区（空库 404 workspace_not_found）→ 成员守卫（非成员 403 forbidden）
 * → {workspaceId, workspaceName, myRole}。
 * id 口径（规格 2026-09-09 BIGINT 化）：路径/请求体 id 字符串接参、守卫先行后再 parse
 * （先鉴权后 parse，同 GroupService）；服务间内调直接传 long。
 */
@Service
public class ProjectService {

    private final ProjectRepo projects;
    private final GroupRepo groups;
    private final FileVersionRepo fileVersions;
    private final AclRepo acl;
    private final WorkspaceRepo workspaces;
    private final WorkspaceGuard guard;

    /** 项目视图（{id, groupId, name, createdAt}）。id/groupId 保持 String：对外字符串化数字
     * （规格 2026-09-09 BIGINT 化，全局不变量 1）。 */
    public record ProjectView(String id, String groupId, String name, Instant createdAt) {

        public static ProjectView of(ProjectRecord project) {
            return new ProjectView(String.valueOf(project.id()), String.valueOf(project.groupId()),
                    project.name(), project.createdAt());
        }
    }

    public ProjectService(ProjectRepo projects,
                          GroupRepo groups,
                          FileVersionRepo fileVersions,
                          AclRepo acl,
                          WorkspaceRepo workspaces,
                          WorkspaceGuard guard) {
        this.projects = projects;
        this.groups = groups;
        this.fileVersions = fileVersions;
        this.acl = acl;
        this.workspaces = workspaces;
        this.guard = guard;
    }

    /** 项目清单（成员可读），按创建时间稳定排序（repo 保证）。 */
    public List<ProjectView> list(UserAccount caller, String workspaceId) {
        long wsId = EntityIds.parse(workspaceId);
        guard.requireMember(wsId, caller);
        return projects.listByWorkspace(wsId).stream()
                .map(ProjectView::of)
                .toList();
    }

    /** 建项目（ADMIN+）：分组须属于该工作区（404 group_not_found）；同名允许。 */
    public ProjectView create(UserAccount caller, String workspaceId,
                              OrgRequests.CreateProjectRequest request) {
        long wsId = EntityIds.parse(workspaceId);
        guard.requireAdmin(wsId, caller);
        long groupId = EntityIds.parse(request.groupId());
        requireGroupInWorkspace(wsId, groupId);
        ProjectRecord project = projects.insert(new ProjectRecord(
                null, wsId, groupId, request.name().trim(), Instant.now()));
        return ProjectView.of(project);
    }

    /** 改名（ADMIN+）：同名允许，不查重（规格 §4）。 */
    public ProjectView rename(UserAccount caller, String workspaceId, String projectId,
                              OrgRequests.RenameProjectRequest request) {
        long wsId = EntityIds.parse(workspaceId);
        guard.requireAdmin(wsId, caller);
        long pid = EntityIds.parse(projectId);
        ProjectRecord project = findInWorkspace(wsId, pid);
        String newName = request.name().trim();
        projects.updateName(pid, newName);
        return new ProjectView(String.valueOf(pid), String.valueOf(project.groupId()), newName, project.createdAt());
    }

    /** 移动分组（ADMIN+）：目标分组须属于该工作区（404 group_not_found）。 */
    public void move(UserAccount caller, String workspaceId, String projectId,
                     OrgRequests.MoveProjectRequest request) {
        long wsId = EntityIds.parse(workspaceId);
        guard.requireAdmin(wsId, caller);
        long pid = EntityIds.parse(projectId);
        findInWorkspace(wsId, pid);
        long targetGroupId = EntityIds.parse(request.groupId());
        requireGroupInWorkspace(wsId, targetGroupId);
        projects.moveGroup(pid, targetGroupId);
    }

    /** 删除（ADMIN+）：级联内容版本行（前缀删）→ ACL 行 → 实体行（依赖顺序）。 */
    public void delete(UserAccount caller, String workspaceId, String projectId) {
        long wsId = EntityIds.parse(workspaceId);
        guard.requireAdmin(wsId, caller);
        long pid = EntityIds.parse(projectId);
        findInWorkspace(wsId, pid);
        fileVersions.deleteByProjectPrefix(wsId, pid);
        acl.deleteByProject(wsId, pid);
        projects.delete(pid);
    }

    /**
     * 连接握手（规格 §6）：本期恒返默认工作区（区内第一个工作区行）；空库 → 404 workspace_not_found；
     * 非成员 → 403 forbidden（守卫自然处理）。myRole 为调用者的工作区角色 DB 字符串。
     */
    public ConnectView connect(UserAccount caller) {
        WorkspaceRecord workspace = workspaces.findFirst()
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "workspace_not_found", "默认工作区不存在"));
        Role role = guard.requireMember(workspace.id(), caller).role();
        return new ConnectView(String.valueOf(workspace.id()), workspace.name(), role.toDb());
    }

    /** 区内项目（跨工作区项目 id 按 404 project_not_found 处理）。 */
    private ProjectRecord findInWorkspace(long workspaceId, long projectId) {
        return projects.find(projectId)
                .filter(project -> project.workspaceId() == workspaceId)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "project_not_found", "项目不存在"));
    }

    /** 分组须落在同一工作区（外键只保证全局存在——业务规则在服务层校验，404 group_not_found）。 */
    private void requireGroupInWorkspace(long workspaceId, long groupId) {
        groups.find(groupId)
                .filter(group -> group.workspaceId() == workspaceId)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "group_not_found", "分组不存在"));
    }
}
