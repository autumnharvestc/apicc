package com.autumnharvestc.server;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * apicc 在线协作服务端入口（规格 m3 §2 D1：Spring Boot 3.5.x 单模块，包前缀 com.autumnharvestc.server）。
 * 分层约定：auth/ workspace/ content/ core/（权限与错误映射）、store/（JdbcTemplate 仓储）。
 */
@SpringBootApplication
public class ApiccServerApplication {

    public static void main(String[] args) {
        SpringApplication.run(ApiccServerApplication.class, args);
    }
}
