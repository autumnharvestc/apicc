package com.autumnharvestc.server.auth;

import com.autumnharvestc.server.store.PlatformRole;
import com.autumnharvestc.server.store.UserAccount;

/**
 * 用户安全视图（规格 m3 §3.1 / 2026-09-08 §6）：register / login.user / me 的响应形状。
 * 仅含 id/username/displayName/role——passwordHash 与 token 永不出现在响应 DTO。
 * role 供前端按角色显隐超管入口（规格 §6「/me 返回 role」）。
 */
public record UserView(String id, String username, String displayName, PlatformRole role) {

    public static UserView of(UserAccount account) {
        return new UserView(account.id(), account.username(), account.displayName(), account.role());
    }
}
