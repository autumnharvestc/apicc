package com.autumnharvestc.server.content;

import com.autumnharvestc.server.core.ApiException;
import com.autumnharvestc.server.core.ContentPaths;
import com.autumnharvestc.server.core.Hashes;
import com.autumnharvestc.server.core.PermissionService;
import com.autumnharvestc.server.core.Role;
import com.autumnharvestc.server.core.VersionConflictException;
import com.autumnharvestc.server.store.FileVersionRecord;
import com.autumnharvestc.server.store.FileVersionRepo;
import com.autumnharvestc.server.store.ProjectRecord;
import com.autumnharvestc.server.store.ProjectRepo;
import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.workspace.WorkspaceGuard;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;

/**
 * 内容同步用例（规格 m3 §3.4 契约 + §2 D6 写路径 + §2 D8 同步协议，任务 5 简报裁定 A–D；
 * 2026-09-08 内容 path 实体化：首段=项目 UUID）。
 *
 * <p>path 规则（ContentPaths）：首段必须是<b>存在的项目 UUID</b>，根级仅允许 apicc.workspace.yaml——
 * 首段非 UUID 400 path_invalid；首段 UUID 但项目不存在（含跨工作区）404 project_not_found。
 * 读面不 404：tree/files 按有效角色过滤与 missing 呈现，不泄露实体存在性。</p>
 *
 * <p>写路径顺序（D6 + 裁定 D）：校验（含项目实体存在性）→ 权限 → baseVersion 比对（先于 hash 判同）→
 * 同 hash 幂等返回现状 → 版本表原子推进（条件 UPDATE 取胜者，不丢更新）→ 落盘 → 落盘失败条件化精确
 * 回滚版本行（500 io_error，重试按原 baseVersion 可恢复——ContentIoFailureTest 钉住）。删除与回滚
 * 对称条件化（审查修复）：DELETE 走 DELETE ... WHERE version=?（败者 re-read 转 409/404），回滚仅在
 * 「行仍是我写入的那行」时执行。</p>
 *
 * <p>权限面口径（裁定 C② 留痕）：「移除成员不级联清 project_acl」——内容面按 ACL 行判定，为任务 4 起的
 * 既定模型（D5 自洽）：工作区守卫 requireMember 先挡非成员，project_acl 行只对仍具成员关系者细分读/写；
 * 成员被移除后保留的 ACL 行不清理，其重新加入工作区即自动恢复效力。</p>
 *
 * <p>读面过滤：NONE 项目（有效角色为空）——tree 的 projects（实体表产出）与 files 两面整体不出现，
 * 在 files 批量取中进 missing（不 403、不泄露存在性）。</p>
 */
@Service
public class ContentService {

    /** 批量上限（规格 §3.4：files 批量取与 batch 均 ≤200）。 */
    private static final int MAX_BATCH = 200;

    private final WorkspaceGuard guard;
    private final PermissionService permissions;
    private final ProjectRepo projects;
    private final FileVersionRepo fileVersions;
    private final WorkspaceContentStore contentStore;

    public ContentService(WorkspaceGuard guard,
                          PermissionService permissions,
                          ProjectRepo projects,
                          FileVersionRepo fileVersions,
                          WorkspaceContentStore contentStore) {
        this.guard = guard;
        this.permissions = permissions;
        this.projects = projects;
        this.fileVersions = fileVersions;
        this.contentStore = contentStore;
    }

    // ---- GET tree ----

    /**
     * 树清单（§3.4 + 实体化修订）：files 按路径字典序（repo 保证）并按读权过滤；
     * projects 来自 projects 实体表（{id, name, groupId, myRole}，path 字段退役——内容 path
     * 首段即 id 可推导），NONE/不可读项目行不出现。
     */
    public TreeView tree(UserAccount caller, String workspaceId) {
        guard.requireMember(workspaceId, caller);
        Path root = contentStore.workspaceRoot(workspaceId);
        List<FileVersionRecord> rows = fileVersions.listByWorkspace(workspaceId);

        List<TreeView.FileEntry> files = new ArrayList<>();
        for (FileVersionRecord row : rows) {
            if (!readable(workspaceId, caller.id(), row.path())) {
                continue; // NONE 项目：子树文件整体不出现（读面按无权过滤，不泄露存在性）
            }
            // 裁定 A：size 取落盘文件真实字节数（file_versions 不加列，读取时 stat）
            files.add(new TreeView.FileEntry(row.path(), row.contentHash(), row.version(),
                    contentStore.sizeOfFile(root, row.path())));
        }

        List<TreeView.ProjectEntry> projectEntries = new ArrayList<>();
        for (ProjectRecord project : projects.listByWorkspace(workspaceId)) {
            Optional<Role> role = permissions.effectiveRole(workspaceId, caller.id(), project.id());
            if (role.isEmpty() || !permissions.canRead(role.get())) {
                continue; // NONE 项目：整体不出现
            }
            projectEntries.add(new TreeView.ProjectEntry(
                    project.id(), project.name(), project.groupId(), role.get().toDb()));
        }
        return new TreeView(workspaceId, fileVersions.sumVersions(workspaceId), files, projectEntries);
    }

    // ---- GET files（批量取）----

    /** 批量取（§3.4）：命中给内容；不存在/无读权/非法/盘上缺失 → missing。 */
    public FilesBatchView readFiles(UserAccount caller, String workspaceId, String pathsParam) {
        guard.requireMember(workspaceId, caller);
        if (pathsParam == null || pathsParam.isBlank()) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "bad_request", "paths 不能为空");
        }
        Set<String> paths = new LinkedHashSet<>();
        for (String raw : pathsParam.split(",")) {
            String path = raw.trim();
            if (!path.isEmpty()) {
                paths.add(path);
            }
        }
        if (paths.isEmpty()) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "bad_request", "paths 不能为空");
        }
        if (paths.size() > MAX_BATCH) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "batch_too_large", "单批最多 " + MAX_BATCH + " 个路径");
        }
        Path root = contentStore.workspaceRoot(workspaceId);
        List<FilesBatchView.FileContent> files = new ArrayList<>();
        List<String> missing = new ArrayList<>();
        for (String path : paths) {
            FileVersionRecord row = readableRow(workspaceId, caller.id(), path);
            byte[] bytes = row == null ? null : readQuietly(root, path);
            if (row == null || bytes == null) {
                missing.add(path);
                continue;
            }
            files.add(new FilesBatchView.FileContent(path, new String(bytes, StandardCharsets.UTF_8),
                    row.version(), row.contentHash()));
        }
        return new FilesBatchView(files, missing);
    }

    // ---- PUT files（乐观并发写）----

    /** 单文件写：201 新建/变更；200 同 hash 幂等（裁定 D）；409 冲突带现状；400 非法路径；404 项目不存在；403 越权。 */
    public PutOutcome putFile(UserAccount caller, String workspaceId, String path, PutFileRequest request) {
        guard.requireMember(workspaceId, caller);
        return putChecked(caller, workspaceId, path, request);
    }

    /** 写主体（入口守卫已过的检查与落库落盘；batch 逐文件复用，避免重复工作区守卫查询）。 */
    private PutOutcome putChecked(UserAccount caller, String workspaceId, String path, PutFileRequest request) {
        ContentPaths.validate(path, projectId -> projectExists(workspaceId, projectId));
        if (request == null || request.content() == null) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "validation_failed", "content 必填");
        }
        if (request.baseVersion() == null || request.baseVersion() < 0) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "validation_failed", "baseVersion 必填且 ≥ 0");
        }
        requireWriteAccess(workspaceId, caller.id(), path);
        Path root = contentStore.workspaceRoot(workspaceId);
        long baseVersion = request.baseVersion();
        String newHash = Hashes.sha256HexUtf8(request.content());

        FileVersionRecord current = fileVersions.find(workspaceId, path).orElse(null);
        if (current == null) {
            if (baseVersion != 0L) {
                throw new VersionConflictException(0L, null);
            }
        } else {
            // 裁定 D：baseVersion 比对在 hash 相同与否之前
            if (current.version() != baseVersion) {
                throw new VersionConflictException(current.version(), current.contentHash());
            }
            if (current.contentHash().equals(newHash)) {
                // 同 hash 重写：幂等——版本不递增、不重落盘，200 返回现状
                return new PutOutcome(false, new PutResult(path, current.version(), current.contentHash()));
            }
        }

        // 先原子推进版本（单条条件 UPDATE 决出胜者），后落盘；落盘失败精确回滚（D6：版本表为准）
        if (current == null) {
            try {
                fileVersions.insertNew(workspaceId, path, newHash, caller.id());
            } catch (DuplicateKeyException ex) {
                // 并发首写落败：以库内现状转冲突
                FileVersionRecord winner = fileVersions.find(workspaceId, path)
                        .orElseThrow(() -> new ApiException(HttpStatus.CONFLICT, "version_conflict", "并发写入冲突"));
                throw new VersionConflictException(winner.version(), winner.contentHash());
            }
        } else if (!fileVersions.bumpVersion(workspaceId, path, baseVersion, newHash, caller.id())) {
            FileVersionRecord winner = fileVersions.find(workspaceId, path)
                    .orElseThrow(() -> new ApiException(HttpStatus.CONFLICT, "version_conflict", "并发写入冲突"));
            throw new VersionConflictException(winner.version(), winner.contentHash());
        }
        try {
            contentStore.writeFile(root, path, request.content().getBytes(StandardCharsets.UTF_8));
        } catch (IOException ex) {
            // 回滚条件化（审查修复③）：仅当行仍是我写入的那一行才回滚——并发后写者若已把行推走，
            // 放弃回滚保持其新值（新文件删行/既有文件拨回），不产生「库旧盘新」撕裂
            if (current == null) {
                fileVersions.deleteIfVersion(workspaceId, path, 1L);
            } else {
                fileVersions.restoreAfterBump(workspaceId, path, current, current.version() + 1);
            }
            throw new ApiException(HttpStatus.INTERNAL_SERVER_ERROR, "io_error", "文件落盘失败，版本已回滚");
        }
        return new PutOutcome(true, new PutResult(path, current == null ? 1L : current.version() + 1, newHash));
    }

    // ---- DELETE files ----

    /**
     * 删文件（§3.4：同 PUT 并发语义）：条件删除（DELETE ... WHERE version=?，与 PUT 条件更新同构——
     * 同版本并发双 DELETE / DELETE×PUT 交错至多一方得手，败者 re-read 转 409 带现状 / 行已删转 404，
     * 审查修复①）→ 删盘；删盘失败仅当无人重建版本行时补回原行（restoreIfAbsent，审查修复②）→ 500 io_error。
     */
    public void deleteFile(UserAccount caller, String workspaceId, String path, long baseVersion) {
        guard.requireMember(workspaceId, caller);
        ContentPaths.validate(path, projectId -> projectExists(workspaceId, projectId));
        requireWriteAccess(workspaceId, caller.id(), path);
        FileVersionRecord current = fileVersions.find(workspaceId, path)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "file_not_found", "文件不存在"));
        if (current.version() != baseVersion) {
            throw new VersionConflictException(current.version(), current.contentHash());
        }
        if (!fileVersions.deleteIfVersion(workspaceId, path, baseVersion)) {
            // 条件删除落空：并发 PUT 已推进行 → 409 带现状；并发 DELETE 已删行 → 404（与顺序双 DELETE 同口径）
            FileVersionRecord winner = fileVersions.find(workspaceId, path)
                    .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "file_not_found", "文件已被并发删除"));
            throw new VersionConflictException(winner.version(), winner.contentHash());
        }
        try {
            contentStore.deleteFile(contentStore.workspaceRoot(workspaceId), path);
        } catch (IOException ex) {
            fileVersions.restoreIfAbsent(workspaceId, current);
            throw new ApiException(HttpStatus.INTERNAL_SERVER_ERROR, "io_error", "文件删除失败");
        }
    }

    // ---- POST files/batch ----

    /**
     * 批推送（D8 迁移/推送面）：逐文件独立 try/catch 部分成功。
     * 状态口径：pushed / conflict / forbidden / invalid / failed（单文件 io 失败以 failed 行呈现，
     * 不整批 500——§2 D8「逐文件结果 failed」；联调轨对齐口径）。项目不存在（project_not_found）
     * 与非法路径同转 invalid 行——该条目在项目建好前不可推，客户端修复后重推。
     */
    public BatchResultView batchPush(UserAccount caller, String workspaceId, BatchPushRequest request) {
        guard.requireMember(workspaceId, caller);
        List<BatchPushRequest.Item> files = request == null ? List.of() : request.files();
        if (files == null || files.isEmpty()) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "validation_failed", "files 不能为空");
        }
        if (files.size() > MAX_BATCH) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "batch_too_large", "单批最多 " + MAX_BATCH + " 个文件");
        }
        List<BatchResultView.FileResult> results = new ArrayList<>(files.size());
        for (BatchPushRequest.Item item : files) {
            results.add(pushOne(caller, workspaceId, item));
        }
        return new BatchResultView(results);
    }

    private BatchResultView.FileResult pushOne(UserAccount caller, String workspaceId, BatchPushRequest.Item item) {
        String path = item == null ? null : item.path();
        try {
            PutOutcome outcome = putChecked(caller, workspaceId, path, item == null ? null
                    : new PutFileRequest(item.content(), item.baseVersion()));
            return new BatchResultView.FileResult(path, "pushed", outcome.body().version(), null, null);
        } catch (VersionConflictException ex) {
            return new BatchResultView.FileResult(path, "conflict", null, ex.getCurrentVersion(), "baseVersion 过期");
        } catch (ApiException ex) {
            return switch (ex.getCode()) {
                case "path_invalid", "validation_failed", "project_not_found" ->
                        new BatchResultView.FileResult(path, "invalid", null, null, ex.getMessage());
                case "project_forbidden", "forbidden" ->
                        new BatchResultView.FileResult(path, "forbidden", null, null, ex.getMessage());
                case "io_error" ->
                        new BatchResultView.FileResult(path, "failed", null, null, ex.getMessage());
                default -> throw ex; // 面级错误（workspace_not_found 等）不应到逐文件层——上抛兜底
            };
        }
    }

    // ---- 权限判定 ----

    /** 路径生效角色：项目内路径按首段 projectId（ACL 覆盖），根级路径（根配置）按工作区角色继承。 */
    private Optional<Role> effectiveRoleFor(String workspaceId, String userId, String path) {
        String projectId = ContentPaths.parseProject(path).orElse(null);
        return permissions.effectiveRole(workspaceId, userId, projectId);
    }

    private boolean readable(String workspaceId, String userId, String path) {
        return effectiveRoleFor(workspaceId, userId, path).filter(permissions::canRead).isPresent();
    }

    /** 可读且存在版本行的行（读面用）；否则 null。 */
    private FileVersionRecord readableRow(String workspaceId, String userId, String path) {
        if (!readable(workspaceId, userId, path)) {
            return null;
        }
        return fileVersions.find(workspaceId, path).orElse(null);
    }

    private byte[] readQuietly(Path root, String path) {
        try {
            return contentStore.readFile(root, path);
        } catch (IOException ex) {
            return null; // 盘上异常按 missing 处理（读面不 500，同步端重试即恢复）
        }
    }

    /**
     * 写权限（D5）：有效角色为空 → NONE 项目 403 project_forbidden（根级不可达，防御保留）；
     * VIEWER 只读 403 forbidden；根配置 apicc.workspace.yaml 仅 ADMIN+（§3.4 path 规则）。
     */
    private void requireWriteAccess(String workspaceId, String userId, String path) {
        boolean inProject = ContentPaths.parseProject(path).isPresent();
        Role role = effectiveRoleFor(workspaceId, userId, path).orElseThrow(() ->
                inProject
                        ? new ApiException(HttpStatus.FORBIDDEN, "project_forbidden", "该项目对你不可见（NONE）")
                        : new ApiException(HttpStatus.FORBIDDEN, "forbidden", "无写入权限"));
        if (!permissions.canWrite(role)) {
            throw new ApiException(HttpStatus.FORBIDDEN, "forbidden", "需要 EDITOR 及以上角色");
        }
        if (ContentPaths.WORKSPACE_CONFIG.equals(path) && !permissions.isAdmin(role)) {
            throw new ApiException(HttpStatus.FORBIDDEN, "forbidden", "apicc.workspace.yaml 仅 ADMIN+ 可写");
        }
    }

    /** 项目实体存在性（含工作区归属）：跨工作区项目对当前工作区即「不存在」。 */
    private boolean projectExists(String workspaceId, String projectId) {
        return projects.find(projectId)
                .filter(project -> project.workspaceId().equals(workspaceId))
                .isPresent();
    }
}
