package com.autumnharvestc.server.workspace;

import com.autumnharvestc.server.core.Role;
import com.autumnharvestc.server.store.MemberRow;

/**
 * 成员视图（规格 m3 §3.2：[{userId, username, displayName, role}]）。
 * 只携带安全字段——password_hash 不出仓储投影，更不出本视图。
 * userId 保持 String：对外 JSON 字符串化数字（规格 2026-09-09 BIGINT 化，全局不变量 1）。
 */
public record MemberView(
        String userId,
        String username,
        String displayName,
        Role role) {

    public static MemberView of(MemberRow row) {
        return new MemberView(String.valueOf(row.userId()), row.username(), row.displayName(), row.role());
    }
}
