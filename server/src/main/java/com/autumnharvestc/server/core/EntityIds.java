package com.autumnharvestc.server.core;

import org.springframework.http.HttpStatus;

/**
 * URL/请求体中实体 id 的解析守卫（规格 2026-09-09 BIGINT 化口径 5）：对外是字符串化数字，
 * 进服务层前统一 parse；非数字/空白一律 400 validation_failed——不放进各控制器散写。
 */
public final class EntityIds {

    private EntityIds() {
    }

    public static long parse(String raw) {
        if (raw == null) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "validation_failed", "id 必须是数字");
        }
        String trimmed = raw.trim();
        try {
            return Long.parseLong(trimmed);
        } catch (NumberFormatException ex) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "validation_failed", "id 必须是数字: " + trimmed);
        }
    }
}
