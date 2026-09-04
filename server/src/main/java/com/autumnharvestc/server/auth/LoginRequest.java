package com.autumnharvestc.server.auth;

import jakarta.validation.constraints.NotBlank;

/** 登录载荷（规格 m3 §3.1）。校验失败 → 400 validation_failed；凭据不符 → 401 invalid_credentials。 */
public record LoginRequest(
        @NotBlank(message = "不能为空")
        String username,

        @NotBlank(message = "不能为空")
        String password) {
}
