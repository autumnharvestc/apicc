package com.autumnharvestc.server.workspace;

import com.autumnharvestc.server.core.AclRole;
import com.autumnharvestc.server.store.AclEntryRow;

/**
 * 项目 ACL 行视图（规格 m3 §3.3：[{userId, role}]，role ∈ NONE/VIEWER/EDITOR/ADMIN）。
 */
public record AclEntryView(
        String userId,
        AclRole role) {

    public static AclEntryView of(AclEntryRow row) {
        return new AclEntryView(row.userId(), row.role());
    }
}
