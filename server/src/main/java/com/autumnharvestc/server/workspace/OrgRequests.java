package com.autumnharvestc.server.workspace;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * 组织面请求载荷（规格 2026-09-08 §4）：名称 1-64 字符（400 validation_failed 由
 * GlobalExceptionHandler 的 MethodArgumentNotValidException 映射），服务层 trim 后落库。
 */
public final class OrgRequests {

    public record CreateGroupRequest(@NotBlank @Size(max = 64) String name) { }

    public record RenameGroupRequest(@NotBlank @Size(max = 64) String name) { }

    /** 建项目载荷：groupId 必填（简报记录草图漏列，端点语义所需——目标分组合法性由服务层校验）。 */
    public record CreateProjectRequest(@NotBlank String groupId, @NotBlank @Size(max = 64) String name) { }

    public record RenameProjectRequest(@NotBlank @Size(max = 64) String name) { }

    /** 移动分组载荷（POST .../projects/{pid}/move）；目标分组合法性由 ProjectService 校验。 */
    public record MoveProjectRequest(@NotBlank String groupId) { }

    private OrgRequests() {
    }
}
