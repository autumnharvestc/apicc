package com.autumnharvestc.server.core;

/**
 * 工作区成员角色（规格 m3 §2 D5 第一层）：OWNER &gt; ADMIN &gt; EDITOR &gt; VIEWER。
 * 以枚举名字符串存库（memberships.role，VARCHAR + CHECK 约束，schema.sql）。
 */
public enum Role {
    OWNER, ADMIN, EDITOR, VIEWER;

    /** DB 字符串 → 枚举；NULL 直通为 null（行映射便捷），未知值快速失败（CHECK 约束之上的第二道防线）。 */
    public static Role fromDb(String value) {
        return value == null ? null : Role.valueOf(value);
    }

    /** 枚举 → DB 字符串（即枚举名，与 DDL CHECK 列表一致）。 */
    public String toDb() {
        return name();
    }
}
