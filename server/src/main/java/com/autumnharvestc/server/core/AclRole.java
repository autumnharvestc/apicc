package com.autumnharvestc.server.core;

/**
 * 项目级 ACL 角色（规格 m3 §2 D5 第二层）：NONE / VIEWER / EDITOR / ADMIN。
 * NONE 表示显式拒之门外（拒读），与「无 ACL 行 = 继承工作区角色」相区分。
 * 以枚举名字符串存库（project_acl.role，VARCHAR + CHECK 约束，schema.sql）。
 */
public enum AclRole {
    NONE, VIEWER, EDITOR, ADMIN;

    /** DB 字符串 → 枚举；NULL 直通为 null（行映射便捷），未知值快速失败。 */
    public static AclRole fromDb(String value) {
        return value == null ? null : AclRole.valueOf(value);
    }

    /** 枚举 → DB 字符串（即枚举名，与 DDL CHECK 列表一致）。 */
    public String toDb() {
        return name();
    }
}
