package com.autumnharvestc.server.execution.assets;

import com.autumnharvestc.server.core.*;
import com.autumnharvestc.server.store.*;
import com.autumnharvestc.server.workspace.WorkspaceGuard;
import com.autumnharvestc.server.execution.ExecutionDtos.*;
import org.springframework.stereotype.Service;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;
import java.util.*;
import java.nio.charset.StandardCharsets;

@Service
@Transactional
public class ProjectAssetsService {
    private final JdbcTemplate jdbc;
    private final WorkspaceGuard guard;
    private final PermissionService permissions;
    private final ProjectRepo projects;
    private final FileVersionRepo files;
    private final com.autumnharvestc.server.execution.config.ExecutionConfigService configs;
    public ProjectAssetsService(JdbcTemplate jdbc, WorkspaceGuard guard, PermissionService permissions, ProjectRepo projects, FileVersionRepo files,com.autumnharvestc.server.execution.config.ExecutionConfigService configs) {
        this.jdbc = jdbc; this.guard = guard; this.permissions = permissions; this.projects = projects; this.files = files;
        this.configs=configs;
    }
    public ProjectAssets get(UserAccount caller, String ws, String project) {
        return readLocked(authorized(caller, ws, project, false));
    }
    public ProjectAssets put(UserAccount caller, String ws, String project, AssetDelta delta) {
        var entity = authorized(caller, ws, project, true);
        var current = readLocked(entity);
        if (delta == null || !"contract-files-v1".equals(delta.format()) || delta.changes() == null || delta.deletes() == null
                || delta.contractProjectId() == null || !delta.contractProjectId().matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"))
            throw error(HttpStatus.BAD_REQUEST, "validation_failed", "需要有效的 contract-files-v1 项目变更");
        long expected = version(delta.expectedVersion());
        if (expected != Long.parseLong(current.version())) throw error(HttpStatus.CONFLICT, "version_conflict", "项目版本已变化");
        if ((long)delta.changes().size() + delta.deletes().size() > ((Number)configs.policyForProject(entity.workspaceId(),entity.id()).get("maxAssetChangeFiles")).longValue())
            throw error(HttpStatus.BAD_REQUEST, "asset_change_limit", "项目原子变更文件数超过配置额度");
        if (current.format() == null && !current.files().isEmpty()) throw error(HttpStatus.CONFLICT, "legacy_project_layout", "旧在线格式保留原文；请显式发布到新在线项目");
        if (current.contractProjectId() != null && !current.contractProjectId().equals(delta.contractProjectId()))
            throw error(HttpStatus.CONFLICT, "contract_identity_conflict", "不能更改已发布项目的契约 UUID");
        Set<String> paths = new HashSet<>();
        for (var change : delta.changes()) {
            if (change == null || change.content() == null) throw error(HttpStatus.BAD_REQUEST, "validation_failed", "文件内容必填");
            if (!new String(change.content().getBytes(StandardCharsets.UTF_8), StandardCharsets.UTF_8).equals(change.content()))
                throw error(HttpStatus.BAD_REQUEST, "validation_failed", "文件内容必须是有效 UTF-8 文本");
            path(entity.id(), change.path());
            if (!paths.add(change.path())) throw error(HttpStatus.BAD_REQUEST, "validation_failed", "变更路径不能重复");
        }
        for (String deleted : delta.deletes()) {
            path(entity.id(), deleted);
            if (!paths.add(deleted)) throw error(HttpStatus.BAD_REQUEST, "validation_failed", "变更与删除路径不能重复");
        }
        for (var change : delta.changes()) files.applyProjectAssetFile(entity.workspaceId(), entity.id()+"/"+change.path(), change.content(), Hashes.sha256HexUtf8(change.content()), caller.id());
        for (String deleted : delta.deletes()) files.deleteProjectAssetFile(entity.workspaceId(), entity.id()+"/"+deleted);
        if (expected == Long.MAX_VALUE) throw error(HttpStatus.CONFLICT, "version_exhausted", "项目版本已达到上限");
        jdbc.update("UPDATE projects SET asset_format = ?, contract_project_id = ?, asset_version = asset_version + 1 WHERE id = ?",
                delta.format(), delta.contractProjectId(), entity.id());
        return readLocked(entity);
    }
    ProjectRecord authorized(UserAccount caller, String ws, String project, boolean write) {
        long workspaceId = EntityIds.parse(ws); long projectId = EntityIds.parse(project);
        guard.requireMember(workspaceId, caller);
        var entity = projects.find(projectId).filter(value -> value.workspaceId() == workspaceId)
            .orElseThrow(() -> error(HttpStatus.NOT_FOUND, "project_not_found", "项目不存在"));
        var role = permissions.effectiveRole(workspaceId, caller.id(), projectId)
            .orElseThrow(() -> error(HttpStatus.FORBIDDEN, "project_forbidden", "该项目不可见"));
        if (write && !permissions.canWrite(role)) throw error(HttpStatus.FORBIDDEN, "forbidden", "需要 EDITOR 及以上角色");
        if (jdbc.queryForList("SELECT id FROM projects WHERE id = ? AND workspace_id = ? FOR UPDATE", projectId, workspaceId).isEmpty())
            throw error(HttpStatus.NOT_FOUND, "project_not_found", "项目已删除");
        // Membership/ACL revocation does not acquire this lock. Discard pre-wait authorization.
        guard.requireMember(workspaceId, caller);
        var currentRole = permissions.effectiveRole(workspaceId, caller.id(), projectId)
            .orElseThrow(() -> error(HttpStatus.FORBIDDEN, "project_forbidden", "该项目不可见"));
        if (write && !permissions.canWrite(currentRole)) throw error(HttpStatus.FORBIDDEN, "forbidden", "需要 EDITOR 及以上角色");
        // The entity may have moved groups while waiting for the publication lock.
        return projects.find(projectId).filter(value -> value.workspaceId() == workspaceId)
            .orElseThrow(() -> error(HttpStatus.NOT_FOUND, "project_not_found", "项目不存在"));
    }
    ProjectAssets readLocked(ProjectRecord entity) {
        var metadata = jdbc.queryForMap("SELECT asset_format, contract_project_id, asset_version FROM projects WHERE id = ?", entity.id());
        String prefix = entity.id()+"/";
        var entries = files.listByProject(entity.workspaceId(), entity.id()).stream().map(row -> {
            if (row.content() == null) throw error(HttpStatus.CONFLICT, "asset_content_missing", "文件正文缺失: "+row.path());
            String hash = Hashes.sha256HexUtf8(row.content());
            if (!hash.equals(row.contentHash())) throw error(HttpStatus.CONFLICT, "asset_hash_mismatch", "文件摘要不匹配: "+row.path());
            return new AssetFile(row.path().substring(prefix.length()), row.content(), String.valueOf(row.version()), hash, row.content().getBytes(StandardCharsets.UTF_8).length);
        }).toList();
        return new ProjectAssets(String.valueOf(entity.workspaceId()), String.valueOf(entity.groupId()), String.valueOf(entity.id()),
            (String)metadata.get("asset_format"), (String)metadata.get("contract_project_id"), String.valueOf(metadata.get("asset_version")), manifestHash(entries), entries);
    }
    public static String manifestHash(List<AssetFile> entries) {
        var text = new StringBuilder();
        entries.stream().sorted(Comparator.comparing(AssetFile::path)).forEach(file -> text.append(file.path()).append('\0').append(file.version()).append('\0').append(file.hash()).append('\0').append(file.size()).append('\n'));
        return Hashes.sha256HexUtf8(text.toString());
    }
    static long version(String value) {
        try { if (value == null || !value.matches("0|[1-9][0-9]*")) throw new NumberFormatException(); return Long.parseLong(value); }
        catch (NumberFormatException e) { throw error(HttpStatus.BAD_REQUEST, "validation_failed", "expectedVersion 必须是 BIGINT 非负整数字符串"); }
    }
    private void path(long projectId, String path) {
        if (path == null || path.contains(":") || path.chars().anyMatch(c -> c < 32)) throw error(HttpStatus.BAD_REQUEST, "path_invalid", "需要规范项目相对路径");
        ContentPaths.validate(projectId+"/"+path);
    }
    static ApiException error(HttpStatus status, String code, String message) { return new ApiException(status, code, message); }
}
