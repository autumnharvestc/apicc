package com.autumnharvestc.server.workspace;

/**
 * 连接握手响应（规格 2026-09-08 §6）：GET /api/v1/connect 认证后返回默认工作区与调用者角色。
 * 字段名 workspaceName 与契约测试钉住（计划文本的 {workspaceId, name, myRole} 以测试为准）。
 */
public record ConnectView(
        String workspaceId,
        String workspaceName,
        String myRole) {
}
