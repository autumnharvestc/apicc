package com.autumnharvestc.server.content;

import java.util.List;

/**
 * GET tree 响应（规格 m3 §3.4 + 契约修订：projects[].path 必填——项目目录相对路径）。
 * rootVersion 口径：工作区全部版本行 version 之和（裁定 A 配套，见 FileVersionRepo.sumVersions）。
 */
public record TreeView(String workspaceId, long rootVersion, List<FileEntry> files, List<ProjectEntry> projects) {

    /** 文件行：path 为相对工作区根的 / 分隔路径；hash=sha-256 hex；size=落盘文件真实字节（裁定 A）。 */
    public record FileEntry(String path, String hash, long version, long size) {
    }

    /**
     * 项目行：id 为推导稳定标识（裁定 B：项目目录路径 SHA-256 hex 前 12 位），
     * path 为项目目录相对路径（契约修订，必填），myRole 为调用者在该项目的有效角色。
     */
    public record ProjectEntry(String id, String name, String path, String myRole) {
    }
}
