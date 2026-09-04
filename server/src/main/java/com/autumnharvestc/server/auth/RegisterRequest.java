package com.autumnharvestc.server.auth;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/**
 * 注册载荷（规格 m3 §3.1）：username 3-32 且 [a-zA-Z0-9_-]；password ≥8；
 * displayName 裁定 C：必填，trim 后 1-32 字符。校验失败经 GlobalExceptionHandler → 400 validation_failed。
 */
public record RegisterRequest(
        @NotBlank(message = "不能为空")
        @Size(min = 3, max = 32, message = "须为 3-32 个字符")
        @Pattern(regexp = "[a-zA-Z0-9_-]+", message = "仅允许字母、数字、下划线与连字符")
        String username,

        /** 上限 72：bcrypt 仅处理前 72 字节，超出部分静默截断（规格只约定下限 ≥8）。 */
        @NotBlank(message = "不能为空")
        @Size(min = 8, max = 72, message = "长度须为 8-72 个字符")
        String password,

        @NotBlank(message = "不能为空")
        @Size(max = 32, message = "trim 后须为 1-32 个字符")
        String displayName) {
}
