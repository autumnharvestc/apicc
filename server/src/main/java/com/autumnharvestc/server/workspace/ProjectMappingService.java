package com.autumnharvestc.server.workspace;

import com.autumnharvestc.server.core.ApiException;
import com.autumnharvestc.server.core.EntityIds;
import com.autumnharvestc.server.core.PermissionService;
import com.autumnharvestc.server.store.GroupRecord;
import com.autumnharvestc.server.store.GroupRepo;
import com.autumnharvestc.server.store.ProjectRecord;
import com.autumnharvestc.server.store.ProjectRepo;
import com.autumnharvestc.server.store.UserAccount;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * 项目映射用例（计划 C 任务 1，迁移桥）：本地名称目录（groups/&lt;组&gt;/projects/&lt;项目&gt;）
 * ↔ 服务端实体 id（&lt;projectId&gt;/...）的换算面——迁移向导把 batch 推送路径换算为实体寻址前先走此桥。
 * 守卫首行 {@code guard.requireMember}（404 workspace_not_found / 403 forbidden 先于一切）；
 * 解析 = 成员可读（与组织清单面同口径）；按需建 = 工作区 ADMIN+（permissions.isAdmin 含 OWNER，
 * 与 GroupService/ProjectService 的实体创建权限同口径；项目级 ACL 只管内容面，不管实体创建）。
 * 逐 entry 部分成功（行级 missing/forbidden 呈现，不整批失败，裁定见 MappingView）；
 * 幂等：同 (group, project) 重复映射命中既有实体返回同一 id（存在即取——批量内重复与跨请求重放均成立）。
 * 组按名解析限同工作区（findByName 按 workspace_id 作用域）；项目按名取组内首个
 * （listByGroup ORDER BY created_at, id 决定性稳定，同名并存映射创建序首个，同刻并列由 id 决定性落位）。
 * 新建分组 is_default=FALSE；并发同名建组由 uk_groups_ws_name 兜底——落败方重按名解析（存在即取，
 * 桥语义不因并发落败方收 409）。不引事务（裁定 B：单行插入各自原子，批量部分成功本就不要求整批原子）。
 * id 口径（规格 2026-09-09 BIGINT 化）：路径 id 字符串接参、首行 parse；实体 id 由 IDENTITY 生成
 * （insert 返回补全 id 的记录）；对外行仍字符串化数字（MappingView 保持 String）。
 */
@Service
public class ProjectMappingService {

    /** 单批条目上限（与 files/batch 同款，超限 400 batch_too_large）。 */
    static final int MAX_BATCH = 200;

    private final GroupRepo groups;
    private final ProjectRepo projects;
    private final WorkspaceGuard guard;
    private final PermissionService permissions;

    public ProjectMappingService(GroupRepo groups, ProjectRepo projects,
                                 WorkspaceGuard guard, PermissionService permissions) {
        this.groups = groups;
        this.projects = projects;
        this.guard = guard;
        this.permissions = permissions;
    }

    /** 批量映射（部分成功）：守卫 → 上限 → 逐条解析/按需建。request/entries 非 null 由 @RequestBody required + @NotEmpty 保证。 */
    public MappingView map(UserAccount caller, String workspaceId, MappingRequest request) {
        long wsId = EntityIds.parse(workspaceId);
        WorkspaceGuard.Access access = guard.requireMember(wsId, caller);
        List<MappingRequest.Item> entries = request.entries();
        if (entries.size() > MAX_BATCH) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "batch_too_large", "单批最多 " + MAX_BATCH + " 条映射");
        }
        boolean canCreate = permissions.isAdmin(access.role());
        List<MappingView.Row> rows = new ArrayList<>(entries.size());
        for (MappingRequest.Item item : entries) {
            rows.add(mapOne(wsId, canCreate, item));
        }
        return new MappingView(rows);
    }

    /** 逐条映射：组解析/按需建 → 项目按名解析/按需建（行级 missing/forbidden，不抛业务异常）。 */
    private MappingView.Row mapOne(long workspaceId, boolean canCreate, MappingRequest.Item item) {
        String groupName = item.group() == null ? null : item.group().trim();
        String projectName = item.project() == null ? null : item.project().trim();
        boolean createIfMissing = Boolean.TRUE.equals(item.createIfMissing());

        Optional<GroupRecord> group = groups.findByName(workspaceId, groupName);
        if (group.isEmpty()) {
            if (!createIfMissing) {
                return missing(groupName, projectName);
            }
            if (!canCreate) {
                return forbidden(groupName, projectName);
            }
            group = Optional.of(createGroup(workspaceId, groupName));
        }
        GroupRecord groupRecord = group.get();
        // 组内按名取首个（listByGroup ORDER BY created_at, id 决定性稳定；同名并存映射创建序首个）
        Optional<ProjectRecord> project = projects.listByGroup(groupRecord.id()).stream()
                .filter(candidate -> candidate.name().equals(projectName))
                .findFirst();
        if (project.isEmpty()) {
            if (!createIfMissing) {
                return missing(groupName, projectName);
            }
            if (!canCreate) {
                return forbidden(groupName, projectName);
            }
            ProjectRecord created = projects.insert(new ProjectRecord(
                    null, workspaceId, groupRecord.id(), projectName, Instant.now()));
            return new MappingView.Row(groupName, projectName,
                    String.valueOf(groupRecord.id()), String.valueOf(created.id()), true, null, null);
        }
        return new MappingView.Row(groupName, projectName,
                String.valueOf(groupRecord.id()), String.valueOf(project.get().id()), false, null, null);
    }

    /** 建组（is_default=FALSE）：并发同名建组由 uk_groups_ws_name 兜底——落败方重按名解析（存在即取）。 */
    private GroupRecord createGroup(long workspaceId, String name) {
        try {
            return groups.insert(new GroupRecord(null, workspaceId, name, false, Instant.now()));
        } catch (DuplicateKeyException ex) {
            return groups.findByName(workspaceId, name)
                    .orElseThrow(() -> new ApiException(HttpStatus.CONFLICT, "group_name_taken", "分组名称已存在"));
        }
    }

    private MappingView.Row missing(String group, String project) {
        return new MappingView.Row(group, project, null, null, null, true, null);
    }

    private MappingView.Row forbidden(String group, String project) {
        return new MappingView.Row(group, project, null, null, null, null, true);
    }
}
