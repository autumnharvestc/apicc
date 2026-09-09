package com.autumnharvestc.server.core;

import org.junit.jupiter.api.Test;

import java.util.function.Predicate;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 内容 path 校验器与项目段解析单测（2026-09-08 path 实体化规则；2026-09-09 BIGINT 化：项目 id 为数字）。
 * 通用结构规则（长度/空段/../绝对/控制字符）保留，禁冒号移除由
 * 「含冒号路径过通用校验」钉住；首段规则（数字 id 形态/存在性/根配置特判）由写面 validate 两参形态钉住，
 * 存在性谓词与 ContentService 同型（Predicate&lt;Long&gt;，入参为解析后的项目主键）。
 */
class ContentPathsTest {

    /** 形态合法的项目数字 id（BIGINT 化实体主键的十进制文本）。 */
    private static final String PROJECT_ID = "77";
    /** 恒真/恒假存在性判定（写面单测用；入参为解析后的项目主键）。 */
    private static final Predicate<Long> EXISTS = id -> true;
    private static final Predicate<Long> MISSING = id -> false;

    // ---- validate（通用结构规则）----

    /** 合法路径族：根配置、项目内深层文件、项目内含冒号文件（禁冒号移除）。 */
    @Test
    void acceptsContractCompliantPaths() {
        for (String path : new String[]{
                ContentPaths.WORKSPACE_CONFIG,
                PROJECT_ID + "/a.yaml",
                PROJECT_ID + "/collections/c/apis/a/api.yaml",
                PROJECT_ID + "/a:b.yaml"}) {
            assertThatCode(() -> ContentPaths.validate(path)).as(path).doesNotThrowAnyException();
        }
    }

    /** 非法路径族 → ApiException(400, path_invalid)：..、绝对、反斜杠、空段、尾斜杠、空串。 */
    @Test
    void rejectsContractViolatingPaths() {
        for (String bad : new String[]{
                null, "", "  ",
                "../evil.yaml", "a/../b.yaml", "a/..", "..",
                "/abs.yaml",
                "a\\b.yaml",
                "a//b.yaml",
                "a/b/", "/",
                "."}) {
            assertThatThrownBy(() -> ContentPaths.validate(bad))
                    .as("path <%s> 应被拒绝", bad)
                    .isInstanceOf(ApiException.class)
                    .satisfies(ex -> {
                        ApiException api = (ApiException) ex;
                        assertThat(api.getCode()).as("path <%s> 的 code", bad).isEqualTo("path_invalid");
                        assertThat(api.getStatus().value()).as("path <%s> 的 status", bad).isEqualTo(400);
                    });
        }
    }

    /** 长度上限与 DDL 对齐：VARCHAR(512) 按**字符**计——恰 512 合法、513 拒绝。 */
    @Test
    void pathLengthLimitAlignsWithDdlVarchar512() {
        assertThat(ContentPaths.MAX_PATH_LENGTH).isEqualTo(512);
        String base = PROJECT_ID + "/";
        String suffix = ".yaml";
        String exactly512 = base + "x".repeat(512 - base.length() - suffix.length()) + suffix;
        String overlong513 = base + "x".repeat(512 - base.length() - suffix.length() + 1) + suffix;
        assertThat(exactly512.length()).isEqualTo(512);
        assertThat(ContentPaths.isValid(exactly512)).isTrue();
        assertThat(overlong513.length()).isEqualTo(513);
        assertThat(ContentPaths.isValid(overlong513)).isFalse();
    }

    // ---- parseProject ----

    /** 首段数字 id 形态且后随 / → 返回该段（项目内任意深度同值）。 */
    @Test
    void parseProjectReturnsFirstSegmentWhenNumericShaped() {
        assertThat(ContentPaths.parseProject(PROJECT_ID + "/a.yaml")).hasValue(PROJECT_ID);
        assertThat(ContentPaths.parseProject(PROJECT_ID + "/collections/c/apis/a/api.yaml"))
                .hasValue(PROJECT_ID);
    }

    /** 根配置/单段文件/非数字首段/裸数字（无后随 /）/非法路径 → empty。 */
    @Test
    void parseProjectEmptyForNonProjectPaths() {
        assertThat(ContentPaths.parseProject(ContentPaths.WORKSPACE_CONFIG)).isEmpty();
        assertThat(ContentPaths.parseProject("a.yaml")).isEmpty();
        assertThat(ContentPaths.parseProject("not-a-number/apis/a.yaml")).isEmpty();
        // 裸数字单段不归属项目（防文件占位项目目录的盘上碰撞）
        assertThat(ContentPaths.parseProject(PROJECT_ID)).isEmpty();
        assertThat(ContentPaths.parseProject("../groups/g/x.yaml")).isEmpty();
        assertThat(ContentPaths.parseProject(null)).isEmpty();
    }

    // ---- validate(path, projectIdExists)（写面首段规则）----

    /** 首段非数字 id（且非根配置）→ 400 path_invalid：多段别名/单段根文件/盘符形态/裸数字。 */
    @Test
    void writeFaceRejectsNonNumericFirstSegmentWithPathInvalid() {
        for (String bad : new String[]{
                "not-a-number/apis/a.yaml", "a.yaml", "C:/evil.yaml", "groups/g/projects/p/x.yaml", PROJECT_ID}) {
            assertThatThrownBy(() -> ContentPaths.validate(bad, EXISTS))
                    .as("path <%s> 应 400 path_invalid", bad)
                    .isInstanceOf(ApiException.class)
                    .satisfies(ex -> {
                        ApiException api = (ApiException) ex;
                        assertThat(api.getCode()).as("path <%s> 的 code", bad).isEqualTo("path_invalid");
                        assertThat(api.getStatus().value()).as("path <%s> 的 status", bad).isEqualTo(400);
                    });
        }
    }

    /** 首段数字 id 但项目不存在 → 404 project_not_found（非路径非法）。 */
    @Test
    void writeFaceReturnsProjectNotFoundWhenProjectMissing() {
        assertThatThrownBy(() -> ContentPaths.validate(PROJECT_ID + "/x.yaml", MISSING))
                .isInstanceOf(ApiException.class)
                .satisfies(ex -> {
                    ApiException api = (ApiException) ex;
                    assertThat(api.getCode()).isEqualTo("project_not_found");
                    assertThat(api.getStatus().value()).isEqualTo(404);
                });
    }

    /** 项目存在 → 放行；根配置不查实体（任何存在性判定下皆过——角色门在服务层）。 */
    @Test
    void writeFaceAcceptsExistingProjectPathAndRootConfig() {
        assertThatCode(() -> ContentPaths.validate(PROJECT_ID + "/x.yaml", EXISTS)).doesNotThrowAnyException();
        assertThatCode(() -> ContentPaths.validate(ContentPaths.WORKSPACE_CONFIG, MISSING)).doesNotThrowAnyException();
    }

    /** WORKSPACE_CONFIG 常量保持规格字面（契约钉子）。 */
    @Test
    void workspaceConfigConstantIsStable() {
        assertThat(ContentPaths.WORKSPACE_CONFIG).isEqualTo("apicc.workspace.yaml");
    }
}
