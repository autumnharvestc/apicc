package com.autumnharvestc.server.core;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

/**
 * SHA-256 十六进制摘要工具（全工程唯一实现）：认证令牌指纹（auth）与内容哈希（content）共用。
 * 令牌串按 US_ASCII、文件内容按 UTF-8 取字节——由调用方传入字节，本类不感知语义。
 */
public final class Hashes {

    private Hashes() {
    }

    /** 字节 → SHA-256 hex 小写（HexFormat 默认小写）。 */
    public static String sha256Hex(byte[] input) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(input));
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException("JVM 缺少 SHA-256 算法", ex);
        }
    }

    /** 文本 → SHA-256 hex 小写（按 UTF-8 编码取字节——内容哈希统一口径，裁定 A）。 */
    public static String sha256HexUtf8(String text) {
        return sha256Hex(text.getBytes(StandardCharsets.UTF_8));
    }
}
