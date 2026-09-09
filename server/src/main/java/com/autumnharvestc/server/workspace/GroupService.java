package com.autumnharvestc.server.workspace;

import com.autumnharvestc.server.core.ApiException;
import com.autumnharvestc.server.core.EntityIds;
import com.autumnharvestc.server.core.PermissionService;
import com.autumnharvestc.server.store.GroupRecord;
import com.autumnharvestc.server.store.GroupRepo;
import com.autumnharvestc.server.store.ProjectRepo;
import com.autumnharvestc.server.store.UserAccount;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.List;

/**
 * 分组管理用例（规格 2026-09-08 §4，计划 B 任务 2）：
 * 写操作（建/改名/删）= 工作区 ADMIN+，守卫在方法首行（guard.requireAdmin → 403 forbidden 先于
 * 一切存在性/重名检查——越权探测分组 id 得 403 而非 404/409，不泄露路由外信息）；
 * 清单（GET）= 成员可读（控制台组织页对全体成员可见）。
 * 守卫判据：默认分组以 is_default=TRUE 标记列判定（非名称比对）→ 400 default_group_immutable；
 * 同工作区重名 → 409 group_name_taken（预检 + uk_groups_ws_name 唯一约束 DuplicateKeyException 兜底）；
 * 非空删除 → 409 group_not_empty。分组 id 不属于该工作区按 404 group_not_found 处理
 * （跨工作区不泄露存在性，与 workspace_not_found 口径一致）。单写操作各自原子（裁定 B，不引 @Transactional）。
 * id 口径（规格 2026-09-09 BIGINT 化）：路径 id 字符串接参、守卫先行后再 parse 目标 id
 * （先鉴权后 parse，与 AdminService 口径一致——非数字 id 对无权调用者同样 403，不泄露解析层）。
 */
@Service
public class GroupService {

    private final GroupRepo groups;
    private final ProjectRepo projects;
    private final WorkspaceGuard guard;

    /** 分组视图（{id, name, isDefault, createdAt}；isDefault 供控制台禁用改删按钮与测试过滤）。
     * id 保持 String：对外 JSON 字符串化数字（规格 2026-09-09 BIGINT 化，全局不变量 1）。 */
    public record GroupView(String id, String name, boolean isDefault, Instant createdAt) {

        public static GroupView of(GroupRecord group) {
            return new GroupView(String.valueOf(group.id()), group.name(), group.isDefault(), group.createdAt());
        }
    }

    public GroupService(GroupRepo groups, ProjectRepo projects, WorkspaceGuard guard) {
        this.groups = groups;
        this.projects = projects;
        this.guard = guard;
    }

    /** 分组清单（成员可读），按创建时间稳定排序（repo 保证）。 */
    public List<GroupView> list(UserAccount caller, String workspaceId) {
        long wsId = EntityIds.parse(workspaceId);
        guard.requireMember(wsId, caller);
        return groups.listByWorkspace(wsId).stream()
                .map(GroupView::of)
                .toList();
    }

    /** 建分组（ADMIN+）：重名 409 group_name_taken；新建行 is_default=FALSE。id 由 IDENTITY 生成。 */
    public GroupView create(UserAccount caller, String workspaceId, OrgRequests.CreateGroupRequest request) {
        long wsId = EntityIds.parse(workspaceId);
        guard.requireAdmin(wsId, caller);
        String name = request.name().trim();
        groups.findByName(wsId, name).ifPresent(existing -> {
            throw new ApiException(HttpStatus.CONFLICT, "group_name_taken", "分组名称已存在");
        });
        GroupRecord group;
        try {
            group = groups.insert(new GroupRecord(null, wsId, name, false, Instant.now()));
        } catch (DuplicateKeyException ex) {
            // 并发同名建组兜底：uk_groups_ws_name（预检不预占，唯一约束是唯一事实源）
            throw new ApiException(HttpStatus.CONFLICT, "group_name_taken", "分组名称已存在");
        }
        return GroupView.of(group);
    }

    /** 改名（ADMIN+）：默认分组 400 default_group_immutable；撞名 409；不存在 404 group_not_found。 */
    public GroupView rename(UserAccount caller, String workspaceId, String groupId,
                            OrgRequests.RenameGroupRequest request) {
        long wsId = EntityIds.parse(workspaceId);
        guard.requireAdmin(wsId, caller);
        long gid = EntityIds.parse(groupId);
        GroupRecord group = findInWorkspace(wsId, gid);
        if (group.isDefault()) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "default_group_immutable", "默认分组不可改名");
        }
        String newName = request.name().trim();
        groups.findByName(wsId, newName)
                .filter(existing -> !existing.id().equals(gid))
                .ifPresent(existing -> {
                    throw new ApiException(HttpStatus.CONFLICT, "group_name_taken", "分组名称已存在");
                });
        try {
            groups.updateName(gid, newName);
        } catch (DuplicateKeyException ex) {
            // 并发撞名兜底：改名目标名被并发占用（uk_groups_ws_name）
            throw new ApiException(HttpStatus.CONFLICT, "group_name_taken", "分组名称已存在");
        }
        return new GroupView(String.valueOf(group.id()), newName, group.isDefault(), group.createdAt());
    }

    /** 删除（ADMIN+）：默认分组 400；非空 409 group_not_empty；空分组删行 204。 */
    public void delete(UserAccount caller, String workspaceId, String groupId) {
        long wsId = EntityIds.parse(workspaceId);
        guard.requireAdmin(wsId, caller);
        long gid = EntityIds.parse(groupId);
        GroupRecord group = findInWorkspace(wsId, gid);
        if (group.isDefault()) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "default_group_immutable", "默认分组不可删除");
        }
        if (projects.countByGroup(gid) > 0) {
            throw new ApiException(HttpStatus.CONFLICT, "group_not_empty", "分组下仍有项目，不能删除");
        }
        groups.delete(gid);
    }

    /** 区内分组（跨工作区分组 id 按 404 group_not_found 处理——不向别区泄露存在性）。 */
    private GroupRecord findInWorkspace(long workspaceId, long groupId) {
        return groups.find(groupId)
                .filter(group -> group.workspaceId() == workspaceId)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "group_not_found", "分组不存在"));
    }
}
