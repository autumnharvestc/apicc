package com.autumnharvestc.server.workspace;

import com.autumnharvestc.server.core.AclRole;
import com.autumnharvestc.server.store.AclEntryRow;

/**
 * 项目 ACL 行视图（规格 m3 §3.3：[{userId, role}]，role ∈ NONE/VIEWER/EDITOR/ADMIN）。
 * userId 保持 String：对外 JSON 字符串化数字（规格 2026-09-09 BIGINT 化，全局不变量 1）。
 */
public record AclEntryView(
        String userId,
        AclRole role) {

    public static AclEntryView of(AclEntryRow row) {
        return new AclEntryView(String.valueOf(row.userId()), row.role());
    }
}
