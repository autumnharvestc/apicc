package com.autumnharvestc.server.auth;

import java.time.Instant;

/**
 * 登录响应（规格 m3 §3.1）：{ token, expiresAt, user }。
 * expiresAt 序列化为 ISO-8601 UTC（裁定 B：Jackson write-dates-as-timestamps=false，Instant → "…Z"）。
 */
public record LoginResponse(String token, Instant expiresAt, UserView user) {
}
