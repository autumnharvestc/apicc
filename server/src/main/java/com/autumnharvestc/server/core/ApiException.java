package com.autumnharvestc.server.core;

import org.springframework.http.HttpStatus;

/**
 * 携带语义化错误码的业务异常：服务层抛出，由 GlobalExceptionHandler 统一映射为 {code,message}（规格 m3 §3 约定）。
 * code 取各端点契约定义的语义化标识（如 username_taken / version_conflict / project_forbidden），
 * status 为对应 HTTP 状态（401/403/404/409/400 等）。
 */
public class ApiException extends RuntimeException {

    private final String code;
    private final HttpStatus status;

    public ApiException(HttpStatus status, String code, String message) {
        super(message);
        this.code = code;
        this.status = status;
    }

    public String getCode() {
        return code;
    }

    public HttpStatus getStatus() {
        return status;
    }
}
