package com.autumnharvestc.server.workspace;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * 创建工作区载荷（规格 m3 §3.2：POST /api/v1/workspaces {name}）。
 * name 上限 64 与 schema.sql workspaces.name VARCHAR(64) 对齐；校验失败 → 400 validation_failed。
 */
public record CreateWorkspaceRequest(
        @NotBlank(message = "不能为空")
        @Size(max = 64, message = "长度须不超过 64 个字符")
        String name) {
}
