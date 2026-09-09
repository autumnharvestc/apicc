package com.autumnharvestc.server.store;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * 默认策略：数据库 IDENTITY 自增（规格 2026-09-09）。配置 apicc.id-generation 仅接受
 * identity（默认）；显式配置其他值即启动失败——外部策略应提供自定义 IdGeneration Bean，
 * 而非在此硬编码开关。
 */
@Component
public class DatabaseIdGeneration implements IdGeneration {

    /** 无参形态 = 配置缺省（等价 @Value 默认值 identity），供直接构造与单测使用。 */
    public DatabaseIdGeneration() {
        this("identity");
    }

    /** 标 @Autowired 确保 Spring 选此构造器（否则多构造器时回退无参，@Value 守卫不执行）。 */
    @Autowired
    public DatabaseIdGeneration(@Value("${apicc.id-generation:identity}") String strategy) {
        if (!"identity".equals(strategy)) {
            throw new IllegalStateException("不支持的 apicc.id-generation: " + strategy + "（当前仅 identity；外部策略请提供自定义 IdGeneration Bean）");
        }
    }

    @Override
    public boolean appAssigned() {
        return false;
    }

    @Override
    public long nextId() {
        throw new UnsupportedOperationException("identity 策略由数据库自增，不走应用侧生成");
    }
}
