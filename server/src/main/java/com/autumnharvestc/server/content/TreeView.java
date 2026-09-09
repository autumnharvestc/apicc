package com.autumnharvestc.server.content;

import java.util.List;

/**
 * GET tree 响应（规格 m3 §3.4 + 2026-09-08 实体化修订：projects 来自 projects 实体表，
 * 行形状 {id, name, groupId, myRole}——旧 path 字段退役，内容 path 首段即项目 id 可推导）。
 * rootVersion 口径：工作区全部版本行 version 之和（裁定 A 配套，见 FileVersionRepo.sumVersions）。
 */
public record TreeView(String workspaceId, long rootVersion, List<FileEntry> files, List<ProjectEntry> projects) {

    /** 文件行：path 为相对工作区根的 / 分隔路径（首段=项目数字 id，BIGINT 化）；hash=sha-256 hex；size=content 列 UTF-8 字节长（OCTET_LENGTH，§5 内容入库）。 */
    public record FileEntry(String path, String hash, long version, long size) {
    }

    /**
     * 项目行：id 为管理面创建的实体项目主键（同名项目各异；BIGINT 化后对外字符串化数字，全局不变量 1）；
     * groupId 为所属分组实体 id；myRole 为调用者在该项目的有效角色（NONE/不可读行不出现）。
     */
    public record ProjectEntry(String id, String name, String groupId, String myRole) {
    }
}
