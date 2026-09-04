package com.autumnharvestc.server.core;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 健康探测端点（规格 m3 §3.5）：GET /api/v1/ping → 200 {"status":"ok"}。
 * 无认证（认证过滤器在任务 3 引入时须对本路径放行），供联调与 CI 就绪探测。
 */
@RestController
public class PingController {

    @GetMapping("/api/v1/ping")
    public Map<String, String> ping() {
        return Map.of("status", "ok");
    }
}
