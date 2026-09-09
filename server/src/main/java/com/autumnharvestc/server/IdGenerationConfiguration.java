package com.autumnharvestc.server;

import com.autumnharvestc.server.store.DatabaseIdGeneration;
import com.autumnharvestc.server.store.IdGeneration;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;

/**
 * id 生成策略装配点（规格 2026-09-09 BIGINT 化口径 2 扩展点的收口，终审 2026-09-09）：
 * 默认经自动装配注册 DatabaseIdGeneration（identity，含 apicc.id-generation 的 fail-fast 校验）；
 * 部署方定义任意自定义 IdGeneration Bean（无需 @Primary）即整体覆盖默认。
 * 走自动装配而非组件扫描注册是刻意的：用户配置（组件扫描/手动导入）恒先于自动装配注册，
 * @ConditionalOnMissingBean 评估时自定义 Bean 必已在场——「注册即覆盖」确定生效。
 */
@AutoConfiguration
public class IdGenerationConfiguration {

    @Bean
    @ConditionalOnMissingBean(IdGeneration.class)
    DatabaseIdGeneration databaseIdGeneration(@Value("${apicc.id-generation:identity}") String strategy) {
        return new DatabaseIdGeneration(strategy);
    }
}
