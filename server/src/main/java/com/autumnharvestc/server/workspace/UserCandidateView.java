package com.autumnharvestc.server.workspace;

import com.autumnharvestc.server.store.UserAccount;

/**
 * 成员候选行（规格 2026-09-09 成员搜索）：添加成员/项目 ACL 搜索下拉的数据源。
 * 无 role——候选尚非成员；不含 password 哈希（出参最小化同 MemberView 口径）。
 */
public record UserCandidateView(String id, String username, String displayName) {

    public static UserCandidateView of(UserAccount user) {
        return new UserCandidateView(user.id(), user.username(), user.displayName());
    }
}
