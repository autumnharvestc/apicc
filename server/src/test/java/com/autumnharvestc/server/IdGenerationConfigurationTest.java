package com.autumnharvestc.server;

import com.autumnharvestc.server.store.DatabaseIdGeneration;
import com.autumnharvestc.server.store.IdGeneration;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * id 策略装配回归钉（终审 2026-09-09 Important 2）：默认实现经自动装配 +
 * @ConditionalOnMissingBean(IdGeneration.class) 注册——
 * ① 无自定义 Bean 时 DatabaseIdGeneration 生效（含 apicc.id-generation=garbage 启动 fail-fast）；
 * ② 注册自定义 Bean（无需 @Primary）即覆盖默认：上下文唯一 IdGeneration 是自定义实例，
 *    DatabaseIdGeneration 未注册（修复「README 指引照做 → 双实现按类型注入冲突」）。
 * runner 以 AutoConfigurations.of 装配，与生产中自动装配「后于用户 Bean 注册」的顺序一致。
 */
class IdGenerationConfigurationTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(IdGenerationConfiguration.class));

    /** 默认（无自定义 Bean）：唯一 IdGeneration 是 DatabaseIdGeneration。 */
    @Test
    void withoutCustomBeanDefaultDatabaseIdentityIsRegistered() {
        runner.run(context -> {
            assertThat(context).hasSingleBean(IdGeneration.class);
            assertThat(context.getBean(IdGeneration.class)).isInstanceOf(DatabaseIdGeneration.class);
        });
    }

    /** fail-fast（收编 Minor 1 回归钉）：走默认实现时 id-generation=garbage 必须启动失败，消息点名配置键。 */
    @Test
    void garbageIdGenerationPropertyValueFailsStartup() {
        runner.withPropertyValues("apicc.id-generation=garbage").run(context -> {
            assertThat(context).hasFailed();
            assertThat(context.getStartupFailure())
                    .hasRootCauseInstanceOf(IllegalStateException.class)
                    .hasStackTraceContaining("apicc.id-generation: garbage");
        });
    }

    /** 自定义 Bean 覆盖默认（无需 @Primary）：注册即生效，DatabaseIdGeneration 不再注册。 */
    @Test
    void customIdGenerationBeanOverridesDefault() {
        IdGeneration custom = new IdGeneration() {
            @Override
            public boolean appAssigned() {
                return true;
            }

            @Override
            public long nextId() {
                return 42L;
            }
        };
        runner.withBean("customIds", IdGeneration.class, () -> custom).run(context -> {
            assertThat(context).hasSingleBean(IdGeneration.class);
            assertThat(context.getBean(IdGeneration.class)).isSameAs(custom);
            assertThat(context).doesNotHaveBean(DatabaseIdGeneration.class);
        });
    }
}
