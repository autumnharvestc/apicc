package com.autumnharvestc.server.core;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 任务 5：path 校验器（规格 m3 §3.4 path 规则）与项目推导/稳定 id（裁定 B）单测。
 */
class ProjectPathsTest {

    // ---- validate ----

    /** 合法路径族：根配置、项目内深层文件、组级文件、单段文件。 */
    @Test
    void acceptsContractCompliantPaths() {
        for (String path : new String[]{
                "apicc.workspace.yaml", "a.yaml",
                "groups/g1/projects/p1/api.yaml",
                "groups/g1/projects/p1/collections/c1/apis/a1/api.yaml",
                "groups/g1/notes.txt"}) {
            assertThatCode(() -> ProjectPaths.validate(path)).as(path).doesNotThrowAnyException();
        }
    }

    /** 非法路径族 → ApiException(400, path_invalid)：..、绝对、反斜杠、空段、尾斜杠、冒号、空串。 */
    @Test
    void rejectsContractViolatingPaths() {
        for (String bad : new String[]{
                null, "", "  ",
                "../evil.yaml", "a/../b.yaml", "a/..", "..",
                "/abs.yaml",
                "a\\b.yaml",
                "a//b.yaml",
                "a/b/", "/",
                ".",
                "C:/evil.yaml", "a:b.yaml"}) {
            assertThatThrownBy(() -> ProjectPaths.validate(bad))
                    .as("path <%s> 应被拒绝", bad)
                    .isInstanceOf(ApiException.class)
                    .satisfies(ex -> {
                        ApiException api = (ApiException) ex;
                        assertThat(api.getCode()).as("path <%s> 的 code", bad).isEqualTo("path_invalid");
                        assertThat(api.getStatus().value()).as("path <%s> 的 status", bad).isEqualTo(400);
                    });
        }
    }

    // ---- projectDir 推导（M1 §6 结构）----

    /** groups/<g>/projects/<name>/… 内的路径归属项目目录；根文件/组级文件/项目目录本身不属于任何项目。 */
    @Test
    void derivesProjectDirOnlyForPathsInsideProjectDirectory() {
        assertThat(ProjectPaths.projectDir("groups/ecommerce/projects/order-service/apis/a/api.yaml"))
                .hasValue("groups/ecommerce/projects/order-service");
        assertThat(ProjectPaths.projectDir("groups/ecommerce/projects/order-service/project.yaml"))
                .hasValue("groups/ecommerce/projects/order-service");
        // 项目目录路径本身（4 段）不是「项目内文件」
        assertThat(ProjectPaths.projectDir("groups/ecommerce/projects/order-service")).isEmpty();
        // 组级杂项与根文件不属于任何项目
        assertThat(ProjectPaths.projectDir("groups/ecommerce/readme.md")).isEmpty();
        assertThat(ProjectPaths.projectDir("apicc.workspace.yaml")).isEmpty();
        // 非法路径不推导
        assertThat(ProjectPaths.projectDir("../groups/g/projects/p/x.yaml")).isEmpty();
    }

    // ---- projectId（裁定 B 选型：项目目录路径 UTF-8 的 SHA-256 hex 前 12 位）----

    /** id = sha256(projectDir)[0:12]，小写 hex；同目录同 id（跨重启/部署稳定），异目录异 id。 */
    @Test
    void projectIdIsStableTwelveHexCharsDerivedFromProjectDir() {
        String dir = "groups/ecommerce/projects/order-service";
        String expected = Hashes.sha256HexUtf8(dir).substring(0, 12);

        assertThat(ProjectPaths.projectId(dir)).isEqualTo(expected);
        assertThat(ProjectPaths.projectId(dir)).isEqualTo(ProjectPaths.projectId(dir)); // 纯函数稳定
        assertThat(ProjectPaths.projectId(dir)).matches("[0-9a-f]{12}");
        assertThat(ProjectPaths.projectId("groups/ecommerce/projects/other")).isNotEqualTo(expected);
    }

    /** 长度上限与 DDL 对齐：VARCHAR(512) 按**字符**计（H2/Postgres 一致，非 UTF-8 字节）——恰 512 合法、513 拒绝。 */
    @Test
    void pathLengthLimitAlignsWithDdlVarchar512() {
        assertThat(ProjectPaths.MAX_PATH_LENGTH).isEqualTo(512);
        String base = "groups/g1/projects/p1/";
        String suffix = ".yaml";
        String exactly512 = base + "x".repeat(512 - base.length() - suffix.length()) + suffix;
        String overlong513 = base + "x".repeat(512 - base.length() - suffix.length() + 1) + suffix;
        assertThat(exactly512.length()).isEqualTo(512);
        assertThat(ProjectPaths.isValid(exactly512)).isTrue();
        assertThat(overlong513.length()).isEqualTo(513);
        assertThat(ProjectPaths.isValid(overlong513)).isFalse();
    }

    /** projectName = 项目目录末段。 */
    @Test
    void projectNameIsLastSegmentOfProjectDir() {
        assertThat(ProjectPaths.projectName("groups/ecommerce/projects/order-service")).isEqualTo("order-service");
    }
}
