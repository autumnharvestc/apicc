package com.autumnharvestc.server.content;

/**
 * 写入结果 + HTTP 状态标记：created=true → 201（新建或内容变更），false → 200（同 hash 幂等，裁定 D）。
 * 服务层语义与控制器状态码解耦，避免以 version 推断（删后重建同为 version 1）。
 */
public record PutOutcome(boolean created, PutResult body) {
}
