package com.autumnharvestc.server.auth;

import org.springframework.stereotype.Service;

import java.security.SecureRandom;
import java.util.Base64;
import java.util.HexFormat;

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

    /** 明文 → SHA-256 hex 小写（HexFormat 默认小写），入库/查找唯一形态。 */
    public String sha256Hex(String plainToken) {
        byte[] digest;
        try {
            digest = java.security.MessageDigest.getInstance("SHA-256")
                    .digest(plainToken.getBytes(java.nio.charset.StandardCharsets.US_ASCII));
        } catch (java.security.NoSuchAlgorithmException ex) {
            throw new IllegalStateException("JVM 缺少 SHA-256 算法", ex);
        }
        return HexFormat.of().formatHex(digest);
    }
}
