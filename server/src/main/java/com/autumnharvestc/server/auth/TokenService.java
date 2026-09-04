package com.autumnharvestc.server.auth;

import org.springframework.stereotype.Service;

import java.security.SecureRandom;
import java.util.Base64;

/**
 * 令牌材料（规格 m3 §2 D4，裁定 B）：明文 = 32 字节随机数的 base64url（无填充）；
 * 库存形态 = 明文的 SHA-256 hex 小写。明文只在签发响应中出现一次，服务端不存明文。
 */
@Service
public class TokenService {

    /** 256 bit 随机（规格 §2 D4）。 */
    private static final int TOKEN_BYTES = 32;

    private final SecureRandom random = new SecureRandom();

    /** 签发新明文 token：32 字节安全随机 → base64url 无填充（约 43 字符）。 */
    public String issue() {
        byte[] raw = new byte[TOKEN_BYTES];
        random.nextBytes(raw);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
    }

    /** 明文 → SHA-256 hex 小写（统一走 core.Hashes——令牌指纹与内容哈希共用同一实现）。 */
    public String sha256Hex(String plainToken) {
        return com.autumnharvestc.server.core.Hashes.sha256Hex(
                plainToken.getBytes(java.nio.charset.StandardCharsets.US_ASCII));
    }
}
