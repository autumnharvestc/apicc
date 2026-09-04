package com.autumnharvestc.server.core;

import org.springframework.http.HttpStatus;

/**
 * 乐观并发冲突（规格 m3 §3.4：baseVersion 不匹配 → 409 携带服务端现状）。
 * 除 {code,message} 外还需 currentVersion/currentHash 字段，故独立成类携带；
 * 由 GlobalExceptionHandler 映射为 409 版本体，batch 面取其现状字段填 conflict 行。
 */
public class VersionConflictException extends ApiException {

    private final long currentVersion;
    private final String currentHash;

    public VersionConflictException(long currentVersion, String currentHash) {
        super(HttpStatus.CONFLICT, "version_conflict", "baseVersion 与服务端现状不一致");
        this.currentVersion = currentVersion;
        this.currentHash = currentHash;
    }

    public long getCurrentVersion() {
        return currentVersion;
    }

    public String getCurrentHash() {
        return currentHash;
    }
}
