package com.autumnharvestc.server.content;

/**
 * PUT 成功响应体（规格 m3 §3.4：{path, version, hash}；201 新建/变更，200 同 hash 幂等返回现状——裁定 D）。
 */
public record PutResult(String path, long version, String hash) {
}
