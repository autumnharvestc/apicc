package com.autumnharvestc.server.store;

/** 平台角色（规格 2026-09-08 §2）：SUPERADMIN=账号管家（首个引导账号），USER=普通账号。 */
public enum PlatformRole {
    USER, SUPERADMIN;

    public static PlatformRole of(String value) {
        return value == null ? USER : valueOf(value);
    }
}
