package com.autumnharvestc.server.core;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 任务 2 枚举与 DB 字符串互转契约：角色以字符串列存储（VARCHAR + CHECK 约束，裁定 A 可移植写法），
 * 互转必须全值稳定——DB 里的值永远来自这组枚举，未知值/NULL 的行为在此钉死。
 */
class RoleEnumsTest {

    /** Role 全值往返一致（存储形态即枚举名）。 */
    @Test
    void roleRoundTripsAllValues() {
        for (Role role : Role.values()) {
            assertThat(Role.fromDb(role.toDb())).isEqualTo(role);
        }
    }

    /** AclRole 全值往返一致，且 NONE 在列（拒读的显式存储形态）。 */
    @Test
    void aclRoleRoundTripsAllValues() {
        for (AclRole role : AclRole.values()) {
            assertThat(AclRole.fromDb(role.toDb())).isEqualTo(role);
        }
        assertThat(AclRole.fromDb("NONE")).isEqualTo(AclRole.NONE);
    }

    /** NULL 入参 → null 出参（映射层便捷：DB NULL 不炸行）。 */
    @Test
    void fromDbNullReturnsNull() {
        assertThat(Role.fromDb(null)).isNull();
        assertThat(AclRole.fromDb(null)).isNull();
    }

    /** 未知值 → IllegalArgumentException（CHECK 约束之上的第二道防线，快速失败优于静默错配）。 */
    @Test
    void fromDbUnknownValueFails() {
        assertThatThrownBy(() -> Role.fromDb("MASTER")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> AclRole.fromDb("OWNER")).isInstanceOf(IllegalArgumentException.class);
    }
}
