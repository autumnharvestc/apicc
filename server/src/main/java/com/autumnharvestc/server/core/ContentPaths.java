package com.autumnharvestc.server.core;

import org.springframework.http.HttpStatus;

import java.util.Optional;
import java.util.function.Predicate;
import java.util.regex.Pattern;

/**
 * 内容 path 校验与项目段解析（2026-09-08 内容 path 实体化；2026-09-09 BIGINT 化：项目 id 为数字）。
 *
 * <p>path 规则：首段必须是<b>存在的项目数字 id</b>（{@code <projectId>/...}，十进制正整数——
 * BIGINT 化后实体主键）；根级仅允许 {@link #WORKSPACE_CONFIG}（工作区配置，仅 ADMIN+ 可写）。
 * 项目 id 为管理面创建的实体主键——旧「groups/&lt;组&gt;/projects/&lt;名&gt;/… 目录推导 +
 * 路径哈希 id」随实体化退役，项目名不再上盘。</p>
 *
 * <p>通用校验保留：长度 512（与 schema.sql path VARCHAR(512) 字符数对齐）、空段、{@code .}/{@code ..}、
 * 绝对路径/尾斜杠、反斜杠与控制字符；<b>禁冒号移除</b>——id 段无冒号风险、名称不再上盘，
 * Windows 盘符形态（如 {@code C:/evil.yaml}）由「首段非数字 id」规则拦截，穿越/逃逸防御不回退。</p>
 */
public final class ContentPaths {

    /** 工作区根配置文件（规格 §3.4：仅 ADMIN+ 可写；根级唯一放行的非项目路径）。 */
    public static final String WORKSPACE_CONFIG = "apicc.workspace.yaml";

    /**
     * 路径长度上限：与 schema.sql 的 path VARCHAR(512) 对齐（字符数口径，H2/Postgres 一致）。
     * 超长路径放行将在 insertNew 处抛 DataIntegrityViolation → 500，单 PUT/batch 语义失效；
     * 在此拦为 400 path_invalid 后 batch 自然转 invalid 行。
     */
    public static final int MAX_PATH_LENGTH = 512;

    /** 项目 id 形态：十进制数字（BIGINT 化实体主键，2026-09-09——存在性按实体表精确匹配判定）。 */
    private static final Pattern PROJECT_ID_PATTERN =
            Pattern.compile("\\d+");

    private ContentPaths() {
    }

    /** 通用校验（结构规则）：失败 → 400 path_invalid；通过即返回。 */
    public static void validate(String path) {
        if (path == null || path.isBlank()) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "path_invalid", "路径不能为空");
        }
        if (path.length() > MAX_PATH_LENGTH) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "path_invalid",
                    "路径长度超过上限 " + MAX_PATH_LENGTH + " 字符");
        }
        if (path.indexOf('\\') >= 0 || path.indexOf('\0') >= 0) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "path_invalid", "路径禁止反斜杠与控制字符");
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
     * 解析路径所属项目：首段为数字 id 形态且后随 {@code /}（项目内至少一层文件）即返回该段；
     * 根配置/其余根级路径/裸数字单段 → empty。裸数字不属项目——防「文件占位项目目录」的
     * 盘上目录/文件碰撞（{@code <projectId>} 既是落盘目录名又是文件路径时 writeFile 必然 IO 失败）。
     */
    public static Optional<String> parseProject(String path) {
        if (path == null) {
            return Optional.empty();
        }
        int slash = path.indexOf('/');
        if (slash <= 0) {
            return Optional.empty(); // 无段分隔：单段路径（含裸数字项目 id）不归属项目
        }
        String first = path.substring(0, slash);
        if (PROJECT_ID_PATTERN.matcher(first).matches()) {
            return Optional.of(first);
        }
        return Optional.empty();
    }

    /**
     * 路径首段 → 项目主键（2026-09-09 BIGINT 化）：数字段落进 long 值域且为规范十进制形
     * （{@code String.valueOf(parseLong(段))} 与原段相等——拦前导零别名，如 {@code 007}）才返回主键。
     * 越界（如 20 位数字，形态匹配 {@code \d+} 但超 long）与非规范别名 → empty：调用方按
     * 「项目不存在」处理（写面 404 project_not_found / 读面空有效角色）——绝不以
     * NumberFormatException 击穿为 500，也不放行别名致同项目双 path（否则 deleteByProjectPrefix
     * 的 {@code <id>/%} 前缀清理漏删别名行留孤儿）。与 {@link EntityIds#parse} 语义不同：
     * 那里是对外请求 id，非数字即 400；这里是内容 path 段，形态已合法、只判实体可及性。
     */
    public static Optional<Long> parseProjectId(String segment) {
        long key;
        try {
            key = Long.parseLong(segment);
        } catch (NumberFormatException ex) {
            return Optional.empty();
        }
        return String.valueOf(key).equals(segment) ? Optional.of(key) : Optional.empty();
    }

    /**
     * 写面全量校验：通用规则 → 首段规则。首段非数字 id（且非根配置）→ 400 path_invalid；
     * 首段为数字 id 但项目不存在（含越界/非规范别名，见 {@link #parseProjectId}）→
     * 404 project_not_found（projectIdExists 由服务层查实体表判定，含「项目属于其他工作区」的
     * 跨区形态——对当前工作区即不存在）。谓词入参为解析后的项目主键（与 ContentService 同型）。
     */
    public static void validate(String path, Predicate<Long> projectIdExists) {
        validate(path);
        Optional<String> projectId = parseProject(path);
        if (projectId.isEmpty()) {
            if (!WORKSPACE_CONFIG.equals(path)) {
                throw new ApiException(HttpStatus.BAD_REQUEST, "path_invalid",
                        "路径首段必须是项目 id（数字），根级仅允许 " + WORKSPACE_CONFIG);
            }
            return;
        }
        Long key = parseProjectId(projectId.get()).orElse(null);
        if (key == null || !projectIdExists.test(key)) {
            throw new ApiException(HttpStatus.NOT_FOUND, "project_not_found", "项目不存在");
        }
    }
}
