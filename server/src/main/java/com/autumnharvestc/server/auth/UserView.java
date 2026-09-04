package com.autumnharvestc.server.auth;

import com.autumnharvestc.server.store.UserAccount;

/**
 * 用户安全视图（规格 m3 §3.1）：register / login.user / me 的响应形状。
 * 仅含 id/username/displayName——passwordHash 与 token 永不出现在响应 DTO。
 */
public record UserView(String id, String username, String displayName) {

    public static UserView of(UserAccount account) {
        return new UserView(account.id(), account.username(), account.displayName());
    }
}
