package com.autumnharvestc.server.store;

import com.autumnharvestc.server.core.ApiException;
import com.autumnharvestc.server.core.EntityIds;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** 规格 2026-09-09 BIGINT 化：id 策略默认 identity（appAssigned=false）+ EntityIds 数字解析守卫。 */
class IdGenerationTest {

    @Test
    void defaultStrategyIsDatabaseIdentity() {
        IdGeneration gen = new DatabaseIdGeneration();
        assertThat(gen.appAssigned()).isFalse();
    }

    /** 配置守卫：非 identity 值必须启动失败（fail-fast），消息点名配置键 apicc.id-generation。 */
    @Test
    void guardRejectsNonIdentityStrategy() {
        assertThatThrownBy(() -> new DatabaseIdGeneration("snowflake"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("apicc.id-generation");
    }

    @Test
    void entityIdsParsesDigitStrings() {
        assertThat(EntityIds.parse("1")).isEqualTo(1L);
        assertThat(EntityIds.parse(" 42 ")).isEqualTo(42L);
    }

    @Test
    void entityIdsRejectsNonNumericWith400() {
        assertThatThrownBy(() -> EntityIds.parse("abc"))
                .isInstanceOfSatisfying(ApiException.class,
                        e -> assertThat(e.getCode()).isEqualTo("validation_failed"));
        assertThatThrownBy(() -> EntityIds.parse("")).isInstanceOf(ApiException.class);
        assertThatThrownBy(() -> EntityIds.parse(null)).isInstanceOf(ApiException.class);
    }
}
