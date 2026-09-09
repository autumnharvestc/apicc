package com.autumnharvestc.server.workspace;

import com.autumnharvestc.server.store.UserAccount;

/**
 * 成员候选行（规格 2026-09-09 成员搜索）：添加成员/项目 ACL 搜索下拉的数据源。
 * 无 role——候选尚非成员；不含 password 哈希（出参最小化同 MemberView 口径）。
 * id 保持 String：对外 JSON 字符串化数字（规格 2026-09-09 BIGINT 化，全局不变量 1）。
 */
public record UserCandidateView(String id, String username, String displayName) {

    public static UserCandidateView of(UserAccount user) {
        return new UserCandidateView(String.valueOf(user.id()), user.username(), user.displayName());
    }
}
