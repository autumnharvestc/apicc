package com.autumnharvestc.server.core;

import org.springframework.http.HttpStatus;

/**
 * 路径校验（规格 m3 §3.4 path 规则）与项目目录推导（裁定 B）的统一入口。
 *
 * path 规则（契约）：禁止 {@code ..}、绝对路径、反斜杠、空段、尾斜杠；另禁 {@code :}
 * （Windows 盘符绝对路径/文件名非法字符——跨平台落盘安全所需，报告留痕口径扩展）。
 *
 * 项目推导（裁定 B）：路径落在 {@code groups/<组>/projects/<名>/…} 内即归属项目目录
 * {@code groups/<组>/projects/<名>}（M1 §6 结构）；projectId = 项目目录路径 UTF-8 字节
 * SHA-256 hex 的前 12 位——纯函数、跨重启/跨部署稳定（同内容树同 id），且不受
 * project_acl.project_id VARCHAR(64) 长度约束（路径本身可能超 64 字符，故不用路径作 id）。
 * <b>id 规则一经选定，待控制者写入规格备注（M3-B 按 path 定位不依赖 id，members/Acl UI 未来用）。</b>
 */
public final class ProjectPaths {

    /** 工作区根配置文件（规格 §3.4：仅 ADMIN+ 可写）。 */
    public static final String WORKSPACE_CONFIG = "apicc.workspace.yaml";

    /** projectId 长度：SHA-256 hex 前 12 位（48 bit，碰撞概率工程可忽略）。 */
    private static final int PROJECT_ID_HEX_CHARS = 12;

    private ProjectPaths() {
    }

    /** 校验失败 → 400 path_invalid；通过即返回。 */
    public static void validate(String path) {
        if (path == null || path.isBlank()) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "path_invalid", "路径不能为空");
        }
        if (path.indexOf('\\') >= 0 || path.indexOf('\0') >= 0) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "path_invalid", "路径禁止反斜杠与控制字符");
        }
        if (path.indexOf(':') >= 0) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "path_invalid", "路径禁止冒号（防 Windows 盘符绝对路径）");
        }
        if (path.startsWith("/") || path.endsWith("/")) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "path_invalid", "路径禁止绝对形态与尾斜杠");
        }
        for (String segment : path.split("/", -1)) {
            if (segment.isEmpty() || segment.equals(".") || segment.equals("..")) {
                throw new ApiException(HttpStatus.BAD_REQUEST, "path_invalid", "路径存在空段或 . / .. 段");
            }
        }
    }

    /** 校验通过与否的布尔形态（读面批量判定用）。 */
    public static boolean isValid(String path) {
        try {
            validate(path);
            return true;
        } catch (ApiException ex) {
            return false;
        }
    }

    /**
     * 路径归属的项目目录：{@code groups/<g>/projects/<name>/…}（至少项目内一层文件，≥5 段）
     * → {@code groups/<g>/projects/<name>}；其余（根文件、组级杂项）不属于任何项目。
     */
    public static java.util.Optional<String> projectDir(String path) {
        if (!isValid(path)) {
            return java.util.Optional.empty();
        }
        String[] segments = path.split("/");
        if (segments.length >= 5
                && "groups".equals(segments[0])
                && "projects".equals(segments[2])
                && !segments[1].isEmpty() && !segments[3].isEmpty()) {
            return java.util.Optional.of(segments[0] + "/" + segments[1] + "/" + segments[2] + "/" + segments[3]);
        }
        return java.util.Optional.empty();
    }

    /** 项目目录 → 稳定 projectId（裁定 B：项目目录路径 UTF-8 的 SHA-256 hex 前 12 位）。 */
    public static String projectId(String projectDir) {
        return Hashes.sha256HexUtf8(projectDir).substring(0, PROJECT_ID_HEX_CHARS);
    }

    /** 项目目录 → 项目名（末段，即 {@code groups/<g>/projects/<名>} 的 {@code <名>}）。 */
    public static String projectName(String projectDir) {
        return projectDir.substring(projectDir.lastIndexOf('/') + 1);
    }
}
