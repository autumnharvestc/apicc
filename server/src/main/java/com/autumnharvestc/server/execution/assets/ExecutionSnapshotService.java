package com.autumnharvestc.server.execution.assets;

import com.autumnharvestc.server.execution.ExecutionDtos.*;
import com.autumnharvestc.server.store.UserAccount;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.http.HttpStatus;
import static com.autumnharvestc.server.execution.assets.ProjectAssetsService.error;

@Service
@Transactional
public class ExecutionSnapshotService {
    private final ProjectAssetsService assets;
    private final ExecutionSnapshotRepo snapshots;
    private final com.autumnharvestc.server.execution.config.ExecutionConfigService configs;
    public ExecutionSnapshotService(ProjectAssetsService assets, ExecutionSnapshotRepo snapshots,com.autumnharvestc.server.execution.config.ExecutionConfigService configs) { this.assets = assets; this.snapshots = snapshots;this.configs=configs; }
    public ExecutionSnapshot create(UserAccount caller, String ws, String project, SnapshotRequest request) {
        var entity = assets.authorized(caller, ws, project, true);
        var fixed = assets.readLocked(entity);
        if (request == null) throw error(HttpStatus.BAD_REQUEST, "validation_failed", "expectedVersion 必填");
        long expected = ProjectAssetsService.version(request.expectedVersion());
        if (!fixed.version().equals(String.valueOf(expected))) throw error(HttpStatus.CONFLICT, "version_conflict", "项目版本已变化，请重新准备");
        if (!"contract-files-v1".equals(fixed.format())) throw error(HttpStatus.CONFLICT, "project_format_unsupported", "项目未标记为 contract-files-v1；请显式发布有效项目到新在线项目");
        long limit = ((Number)configs.policyForProject(entity.workspaceId(),entity.id()).get("snapshotBytes")).longValue(); long bytes = 0;
        for (var file : fixed.files()) {
            if (file.size() > limit - bytes) throw error(HttpStatus.BAD_REQUEST, "snapshot_size_limit", "项目快照 UTF-8 字节数超过配置额度");
            bytes += file.size();
        }
        return snapshots.insert(caller.id(), fixed);
    }
    /** Latest member/project execution rights are rechecked whenever a member reuses a snapshot. */
    public ExecutionSnapshot loadAuthorized(UserAccount caller, long id) {
        var fixed = snapshots.find(id).orElseThrow(() -> error(HttpStatus.NOT_FOUND, "snapshot_not_found", "执行快照不存在"));
        assets.authorized(caller, fixed.assets().workspaceId(), fixed.assets().projectId(), true);
        return fixed;
    }
}
