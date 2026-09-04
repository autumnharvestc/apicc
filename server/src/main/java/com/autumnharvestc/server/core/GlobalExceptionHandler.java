package com.autumnharvestc.server.core;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.HandlerMethodValidationException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

/**
 * 全局错误映射骨架（规格 m3 §3：错误统一 {code, message}）。
 * 各端点的语义化 code（如 username_taken/version_conflict）由服务层抛 ApiException 携带；
 * 此处仅兜底框架层异常，不向客户端泄露堆栈细节。
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

    /** 错误响应体：{code, message}。 */
    public record ApiError(String code, String message) {
    }

    @ExceptionHandler(ApiException.class)
    public ResponseEntity<ApiError> handleApiException(ApiException ex) {
        return ResponseEntity.status(ex.getStatus())
                .body(new ApiError(ex.getCode(), ex.getMessage()));
    }

    /** 无匹配路由 → 404 not_found。 */
    @ExceptionHandler(NoResourceFoundException.class)
    public ResponseEntity<ApiError> handleNoResource(NoResourceFoundException ex) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND)
                .body(new ApiError("not_found", "资源不存在"));
    }

    /** 请求体缺失或 JSON 格式错 → 400 bad_request。 */
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<ApiError> handleUnreadable(HttpMessageNotReadableException ex) {
        return ResponseEntity.badRequest()
                .body(new ApiError("bad_request", "请求体缺失或格式错误"));
    }

    /** 方法级参数校验失败（如 @PathVariable 上的约束）→ 400 validation_failed。 */
    @ExceptionHandler(HandlerMethodValidationException.class)
    public ResponseEntity<ApiError> handleHandlerMethodValidation(HandlerMethodValidationException ex) {
        return ResponseEntity.badRequest()
                .body(new ApiError("validation_failed", "请求参数校验失败"));
    }

    /** 兜底 → 500 internal_error。 */
    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiError> handleUnexpected(Exception ex) {
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(new ApiError("internal_error", "服务端内部错误"));
    }
}
