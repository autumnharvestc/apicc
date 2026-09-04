package com.autumnharvestc.server.content;

import com.jayway.jsonpath.JsonPath;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.stream.Collectors;
import java.util.stream.IntStream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.containsInAnyOrder;
import static org.hamcrest.Matchers.hasSize;
import static org.hamcrest.Matchers.nullValue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 任务 5 内容同步 API 契约测试（规格 m3 §3.4 逐条 + 简报契约修订/裁定 A–D）。
 * 覆盖：tree（清单形状/hash/version/size、projects 带 path 必填、无权项目过滤）；
 * files 批量取（missing 语义/≤200）；PUT（新文件 201/变更递增/同 hash 幂等 200 不递增/409 现状/
 * 非法路径 400/apicc.workspace.yaml 仅 ADMIN+/VIEWER 只读/NONE 项目 project_forbidden）；
 * DELETE 并发语义与重建；batch 混合部分成功与上限；UTF-8 字节口径。
 */
@SpringBootTest
@AutoConfigureMockMvc
@TestPropertySource(properties = {
        "spring.datasource.url=jdbc:h2:mem:apicc-content-test;DB_CLOSE_DELAY=-1",
        "apicc.server.data-dir=target/test-data-content"
})
class ContentApiContractTest {

    @Autowired
    private MockMvc mockMvc;

    // ---- 测试脚手架 ----

    /** 注册并登录，返回 [userId, token]。 */
    private String[] newUser(String username) throws Exception {
        mockMvc.perform(post("/api/v1/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"" + username + "\",\"password\":\"password123\",\"displayName\":\""
                                + username + "\"}"))
                .andExpect(status().isCreated());
        MvcResult result = mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"" + username + "\",\"password\":\"password123\"}"))
                .andExpect(status().isOk())
                .andReturn();
        String body = result.getResponse().getContentAsString();
        return new String[]{JsonPath.read(body, "$.user.id"), JsonPath.read(body, "$.token")};
    }

    private String createWorkspace(String token, String name) throws Exception {
        MvcResult result = mockMvc.perform(post("/api/v1/workspaces")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"" + name + "\"}"))
                .andExpect(status().isCreated())
                .andReturn();
        return JsonPath.read(result.getResponse().getContentAsString(), "$.id");
    }

    private void putMember(String callerToken, String wsId, String targetUserId, String role) throws Exception {
        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/members/" + targetUserId)
                        .header("Authorization", "Bearer " + callerToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"role\":\"" + role + "\"}"))
                .andExpect(status().isOk());
    }

    private void setAcl(String callerToken, String wsId, String projectId, String userId, String role)
            throws Exception {
        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/projects/" + projectId + "/acl")
                        .header("Authorization", "Bearer " + callerToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"userId\":\"" + userId + "\",\"role\":\"" + role + "\"}"))
                .andExpect(status().isOk());
    }

    private MvcResult putFile(String token, String wsId, String path, String content, long baseVersion)
            throws Exception {
        return mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/files/" + path)
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"" + content + "\",\"baseVersion\":" + baseVersion + "}"))
                .andReturn();
    }

    private MvcResult getTree(String token, String wsId) throws Exception {
        return mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/tree")
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andReturn();
    }

    private MvcResult getFiles(String token, String wsId, String commaJoinedPaths) throws Exception {
        return mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/files?paths=" + commaJoinedPaths)
                        .header("Authorization", "Bearer " + token))
                .andReturn();
    }

    /** 与服务端同口径的 sha-256 hex 小写（内容按 UTF-8 字节，裁定 A）。 */
    private static String sha256Hex(String content) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(content.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception ex) {
            throw new IllegalStateException(ex);
        }
    }

    /** 从 tree 响应提取指定项目目录的推导 id（黑盒：不复制服务端 id 规则）。 */
    private String projectIdOf(String treeBody, String projectPath) {
        return filterSingle(treeBody, "$.projects[?(@.path=='" + projectPath + "')].id", String.class);
    }

    /** JsonPath 过滤表达式恒返回数组——取单值便捷封装。 */
    @SuppressWarnings("unchecked")
    private static <T> T filterSingle(String body, String expression, Class<T> type) {
        Object value = ((java.util.List<?>) JsonPath.read(body, expression)).get(0);
        return type.cast(value);
    }

    // ---- GET tree ----

    /** 多项目清单：files[path,hash,version,size] + projects[id,name,path,myRole]（契约修订：path 必填）。 */
    @Test
    void treeReturnsMultiProjectListingWithHashVersionSizeAndProjectPath() throws Exception {
        String[] owner = newUser("c-t1-owner");
        String wsId = createWorkspace(owner[1], "树清单多项目");
        assertThat(putFile(owner[1], wsId, "apicc.workspace.yaml", "root: config", 0)
                .getResponse().getStatus()).isEqualTo(201);
        assertThat(putFile(owner[1], wsId, "groups/g1/projects/p1/a.yaml", "hello", 0)
                .getResponse().getStatus()).isEqualTo(201);
        assertThat(putFile(owner[1], wsId, "groups/g2/projects/p2/b.yaml", "world!", 0)
                .getResponse().getStatus()).isEqualTo(201);

        MvcResult tree = getTree(owner[1], wsId);
        String body = tree.getResponse().getContentAsString(StandardCharsets.UTF_8);
        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/tree").header("Authorization", "Bearer " + owner[1]))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.workspaceId").value(wsId))
                .andExpect(jsonPath("$.rootVersion").value(3))
                .andExpect(jsonPath("$.files", hasSize(3)))
                .andExpect(jsonPath("$.files[*].path", containsInAnyOrder(
                        "apicc.workspace.yaml", "groups/g1/projects/p1/a.yaml", "groups/g2/projects/p2/b.yaml")))
                .andExpect(jsonPath("$.projects", hasSize(2)))
                .andExpect(jsonPath("$.projects[*].path", containsInAnyOrder(
                        "groups/g1/projects/p1", "groups/g2/projects/p2")))
                .andExpect(jsonPath("$.projects[*].name", containsInAnyOrder("p1", "p2")))
                .andExpect(jsonPath("$.projects[*].myRole", containsInAnyOrder("OWNER", "OWNER")));

        // 裁定 A：size = 落盘文件真实字节数；hash = sha-256 hex（UTF-8 内容字节）
        assertThat(filterSingle(body, "$.files[?(@.path=='groups/g1/projects/p1/a.yaml')].hash", String.class))
                .isEqualTo(sha256Hex("hello"));
        assertThat(filterSingle(body, "$.files[?(@.path=='groups/g1/projects/p1/a.yaml')].version", Integer.class))
                .isEqualTo(1);
        assertThat(filterSingle(body, "$.files[?(@.path=='groups/g1/projects/p1/a.yaml')].size", Integer.class))
                .isEqualTo(5);
        assertThat(filterSingle(body, "$.files[?(@.path=='apicc.workspace.yaml')].size", Integer.class))
                .isEqualTo("root: config".getBytes(StandardCharsets.UTF_8).length);
        // 契约修订：projects[].id 存在且为稳定标识（12 位小写 hex——裁定 B 选型，见 ProjectPathsTest）
        String p1Id = projectIdOf(body, "groups/g1/projects/p1");
        assertThat(p1Id).matches("[0-9a-f]{12}");
    }

    /** 空工作区 → files/projects 为空数组、rootVersion=0。 */
    @Test
    void treeEmptyWorkspaceReturnsEmptyCollectionsAndZeroRootVersion() throws Exception {
        String[] owner = newUser("c-t2-owner");
        String wsId = createWorkspace(owner[1], "树清单空");

        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/tree")
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.rootVersion").value(0))
                .andExpect(jsonPath("$.files", hasSize(0)))
                .andExpect(jsonPath("$.projects", hasSize(0)));
    }

    /** NONE 项目过滤：projects 与 files 三面整体不出现；编辑者同项目 myRole=EDITOR；编辑写 NONE 项目 403。 */
    @Test
    void treeFiltersNoneProjectFromProjectsAndFiles() throws Exception {
        String[] owner = newUser("c-t3-owner");
        String[] editor = newUser("c-t3-editor");
        String[] viewer = newUser("c-t3-viewer");
        String wsId = createWorkspace(owner[1], "树清单NONE过滤");
        putMember(owner[1], wsId, editor[0], "EDITOR");
        putMember(owner[1], wsId, viewer[0], "VIEWER");
        assertThat(putFile(owner[1], wsId, "groups/g1/projects/p1/a.yaml", "secret", 0)
                .getResponse().getStatus()).isEqualTo(201);
        assertThat(putFile(owner[1], wsId, "groups/g2/projects/p2/b.yaml", "open", 0)
                .getResponse().getStatus()).isEqualTo(201);

        String p1Id = projectIdOf(getTree(owner[1], wsId).getResponse().getContentAsString(), "groups/g1/projects/p1");
        setAcl(owner[1], wsId, p1Id, viewer[0], "NONE");
        setAcl(owner[1], wsId, p1Id, editor[0], "NONE");

        // viewer：p1 子树整体不出现（projects + files 两面）
        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/tree")
                        .header("Authorization", "Bearer " + viewer[1]))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.projects", hasSize(1)))
                .andExpect(jsonPath("$.projects[0].path").value("groups/g2/projects/p2"))
                .andExpect(jsonPath("$.files", hasSize(1)))
                .andExpect(jsonPath("$.files[0].path").value("groups/g2/projects/p2/b.yaml"));

        // viewer 批量取：NONE 项目路径进 missing（不 403，不泄露存在性）
        MvcResult files = getFiles(viewer[1], wsId,
                "groups/g1/projects/p1/a.yaml,groups/g2/projects/p2/b.yaml");
        assertThat(files.getResponse().getStatus()).isEqualTo(200);
        String filesBody = files.getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat((Integer) JsonPath.read(filesBody, "$.files.length()")).isEqualTo(1);
        assertThat((String) JsonPath.read(filesBody, "$.files[0].path")).isEqualTo("groups/g2/projects/p2/b.yaml");
        assertThat((String) JsonPath.read(filesBody, "$.missing[0]")).isEqualTo("groups/g1/projects/p1/a.yaml");

        // editor：无 ACL 行继承工作区角色（p2）→ myRole=EDITOR；p1 已对 editor 置 NONE → 写 403 project_forbidden
        String editorTree = getTree(editor[1], wsId).getResponse().getContentAsString();
        assertThat(filterSingle(editorTree, "$.projects[?(@.path=='groups/g2/projects/p2')].myRole", String.class))
                .isEqualTo("EDITOR");
        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/files/groups/g1/projects/p1/a.yaml")
                        .header("Authorization", "Bearer " + editor[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"x\",\"baseVersion\":1}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("project_forbidden"));
    }

    // ---- GET files（批量取）----

    /** 命中返回 {path,content,version,hash}；不存在路径进 missing。 */
    @Test
    void filesBatchReturnsContentAndMissingSemantics() throws Exception {
        String[] owner = newUser("c-t4-owner");
        String[] viewer = newUser("c-t4-viewer");
        String wsId = createWorkspace(owner[1], "批量取");
        putMember(owner[1], wsId, viewer[0], "VIEWER");
        assertThat(putFile(owner[1], wsId, "groups/g1/projects/p1/a.yaml", "abc", 0)
                .getResponse().getStatus()).isEqualTo(201);

        MvcResult files = getFiles(viewer[1], wsId,
                "groups/g1/projects/p1/a.yaml,groups/g1/projects/p1/nope.yaml");
        assertThat(files.getResponse().getStatus()).isEqualTo(200);
        String body = files.getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat((Integer) JsonPath.read(body, "$.files.length()")).isEqualTo(1);
        assertThat((String) JsonPath.read(body, "$.files[0].path")).isEqualTo("groups/g1/projects/p1/a.yaml");
        assertThat((String) JsonPath.read(body, "$.files[0].content")).isEqualTo("abc");
        assertThat((Integer) JsonPath.read(body, "$.files[0].version")).isEqualTo(1);
        assertThat((String) JsonPath.read(body, "$.files[0].hash")).isEqualTo(sha256Hex("abc"));
        assertThat((String) JsonPath.read(body, "$.missing[0]")).isEqualTo("groups/g1/projects/p1/nope.yaml");
    }

    /** >200 路径/批 → 400 batch_too_large。 */
    @Test
    void filesBatchRejectsMoreThan200PathsWithBatchTooLarge() throws Exception {
        String[] owner = newUser("c-t5-owner");
        String wsId = createWorkspace(owner[1], "批量取上限");
        String paths = IntStream.rangeClosed(1, 201)
                .mapToObj(i -> "f" + i + ".yaml")
                .collect(Collectors.joining(","));

        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/files?paths=" + paths)
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("batch_too_large"));
    }

    // ---- PUT files（乐观并发）----

    /** 新文件 baseVersion=0 → 201 {path, version:1, hash}。 */
    @Test
    void putNewFileReturns201WithVersionOne() throws Exception {
        String[] owner = newUser("c-t6-owner");
        String wsId = createWorkspace(owner[1], "PUT新文件");

        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/files/groups/g1/projects/p1/new.yaml")
                        .header("Authorization", "Bearer " + owner[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"hello\",\"baseVersion\":0}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.path").value("groups/g1/projects/p1/new.yaml"))
                .andExpect(jsonPath("$.version").value(1))
                .andExpect(jsonPath("$.hash").value(sha256Hex("hello")));
    }

    /** 内容变更（baseVersion 匹配）→ version 递增。 */
    @Test
    void putChangedContentIncrementsVersion() throws Exception {
        String[] owner = newUser("c-t7-owner");
        String wsId = createWorkspace(owner[1], "PUT变更");
        assertThat(putFile(owner[1], wsId, "a.yaml", "v1", 0).getResponse().getStatus()).isEqualTo(201);

        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/files/a.yaml")
                        .header("Authorization", "Bearer " + owner[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"v2\",\"baseVersion\":1}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.version").value(2))
                .andExpect(jsonPath("$.hash").value(sha256Hex("v2")));

        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/tree")
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(jsonPath("$.rootVersion").value(2));
    }

    /** 裁定 D：同 hash 重写幂等 → 200 返回现状，version 不递增。 */
    @Test
    void putSameContentIsIdempotentAndKeepsVersion() throws Exception {
        String[] owner = newUser("c-t8-owner");
        String wsId = createWorkspace(owner[1], "PUT幂等");
        assertThat(putFile(owner[1], wsId, "a.yaml", "same", 0).getResponse().getStatus()).isEqualTo(201);

        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/files/a.yaml")
                        .header("Authorization", "Bearer " + owner[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"same\",\"baseVersion\":1}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.version").value(1))
                .andExpect(jsonPath("$.hash").value(sha256Hex("same")));

        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/tree")
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(jsonPath("$.rootVersion").value(1));
    }

    /** baseVersion 不匹配 → 409 {code:version_conflict, currentVersion, currentHash}。 */
    @Test
    void putStaleBaseVersionReturns409WithCurrentVersionAndHash() throws Exception {
        String[] owner = newUser("c-t9-owner");
        String wsId = createWorkspace(owner[1], "PUT冲突");
        assertThat(putFile(owner[1], wsId, "a.yaml", "v1", 0).getResponse().getStatus()).isEqualTo(201);

        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/files/a.yaml")
                        .header("Authorization", "Bearer " + owner[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"v2\",\"baseVersion\":0}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("version_conflict"))
                .andExpect(jsonPath("$.currentVersion").value(1))
                .andExpect(jsonPath("$.currentHash").value(sha256Hex("v1")));
    }

    /** 新文件带非 0 baseVersion → 409（currentVersion=0、currentHash=null）。 */
    @Test
    void putNewFileWithNonZeroBaseVersionConflictsAtZero() throws Exception {
        String[] owner = newUser("c-t10-owner");
        String wsId = createWorkspace(owner[1], "PUT新文件冲突");

        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/files/groups/g1/projects/p1/new.yaml")
                        .header("Authorization", "Bearer " + owner[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"x\",\"baseVersion\":5}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("version_conflict"))
                .andExpect(jsonPath("$.currentVersion").value(0))
                .andExpect(jsonPath("$.currentHash").value(nullValue()));
    }

    /** 非法路径族 → 400 path_invalid：..、反斜杠、尾斜杠、点段、盘符、超长（>512，与 DDL 对齐）。
     *  注：URL 面经 MockMvc/URI 链会折叠 //（空段与前导斜杠无法经 URL 表达）——
     *  绝对路径/空段拒绝由 ProjectPathsTest 与 batch 面（JSON 体不经 URL 机制）钉住。 */
    @Test
    void putRejectsInvalidPathsWithPathInvalid() throws Exception {
        String[] owner = newUser("c-t11-owner");
        String wsId = createWorkspace(owner[1], "PUT非法路径");
        for (String bad : new String[]{
                "../evil.yaml", "a/../b.yaml", "a\\b.yaml", "a/b/", ".", "a/./b.yaml", "C:/evil.yaml",
                // 超长：519 字符 > DDL VARCHAR(512)——未钉时 insertNew 抛 DataIntegrityViolation → 500
                "groups/g1/projects/p1/" + "x".repeat(492) + ".yaml"}) {
            MvcResult result = putFile(owner[1], wsId, bad, "x", 0);
            assertThat(result.getResponse().getStatus())
                    .as("path <%s> 应 400", bad)
                    .isEqualTo(400);
            assertThat(JsonPath.<String>read(result.getResponse().getContentAsString(), "$.code"))
                    .as("path <%s> 应报 path_invalid", bad)
                    .isEqualTo("path_invalid");
        }
    }

    /** apicc.workspace.yaml 仅 ADMIN+ 可写（EDITOR/VIEWER → 403）。 */
    @Test
    void putWorkspaceConfigRequiresAdminRole() throws Exception {
        String[] owner = newUser("c-t12-owner");
        String[] admin = newUser("c-t12-admin");
        String[] editor = newUser("c-t12-editor");
        String wsId = createWorkspace(owner[1], "根配置权限");
        putMember(owner[1], wsId, admin[0], "ADMIN");
        putMember(owner[1], wsId, editor[0], "EDITOR");

        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/files/apicc.workspace.yaml")
                        .header("Authorization", "Bearer " + editor[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"x: 1\",\"baseVersion\":0}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("forbidden"));

        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/files/apicc.workspace.yaml")
                        .header("Authorization", "Bearer " + admin[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"x: 1\",\"baseVersion\":0}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.version").value(1));

        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/files/apicc.workspace.yaml")
                        .header("Authorization", "Bearer " + admin[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"x: 2\",\"baseVersion\":1}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.version").value(2));
    }

    /** VIEWER 写任意路径 403 forbidden；根级非项目路径 EDITOR 可写（继承工作区角色）。 */
    @Test
    void putEnforcesWriteRolesAndRootLevelInheritance() throws Exception {
        String[] owner = newUser("c-t13-owner");
        String[] editor = newUser("c-t13-editor");
        String[] viewer = newUser("c-t13-viewer");
        String wsId = createWorkspace(owner[1], "写权限角色");
        putMember(owner[1], wsId, editor[0], "EDITOR");
        putMember(owner[1], wsId, viewer[0], "VIEWER");
        assertThat(putFile(owner[1], wsId, "groups/g1/projects/p1/f.yaml", "v1", 0)
                .getResponse().getStatus()).isEqualTo(201);

        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/files/groups/g1/projects/p1/f.yaml")
                        .header("Authorization", "Bearer " + viewer[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"x\",\"baseVersion\":1}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("forbidden"));

        // 根级路径（不在任何项目内）按工作区角色判定：EDITOR 可写
        assertThat(putFile(editor[1], wsId, "groups/notes.txt", "n", 0).getResponse().getStatus()).isEqualTo(201);
    }

    // ---- DELETE files ----

    /** DELETE 并发语义：baseVersion 不匹配 409 现状；匹配 204；删除后 tree/files 消失；再删 404。 */
    @Test
    void deleteFileHonorsOptimisticConcurrencyThenRemoves() throws Exception {
        String[] owner = newUser("c-t14-owner");
        String wsId = createWorkspace(owner[1], "DELETE并发");
        assertThat(putFile(owner[1], wsId, "a.yaml", "v1", 0).getResponse().getStatus()).isEqualTo(201);
        String h1 = sha256Hex("v1");

        mockMvc.perform(delete("/api/v1/workspaces/" + wsId + "/files/a.yaml?baseVersion=0")
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("version_conflict"))
                .andExpect(jsonPath("$.currentVersion").value(1))
                .andExpect(jsonPath("$.currentHash").value(h1));

        mockMvc.perform(delete("/api/v1/workspaces/" + wsId + "/files/a.yaml?baseVersion=1")
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(status().isNoContent());

        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/tree")
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(jsonPath("$.rootVersion").value(0))
                .andExpect(jsonPath("$.files", hasSize(0)));
        MvcResult files = getFiles(owner[1], wsId, "a.yaml");
        assertThat((String) JsonPath.read(files.getResponse().getContentAsString(), "$.missing[0]"))
                .isEqualTo("a.yaml");

        mockMvc.perform(delete("/api/v1/workspaces/" + wsId + "/files/a.yaml?baseVersion=1")
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("file_not_found"));
    }

    /** 删除后重建：行已删 → 新文件语义（baseVersion=0 → 201 version=1）。 */
    @Test
    void deletedFileCanBeRecreatedAtVersionOne() throws Exception {
        String[] owner = newUser("c-t15-owner");
        String wsId = createWorkspace(owner[1], "删除重建");
        assertThat(putFile(owner[1], wsId, "a.yaml", "v1", 0).getResponse().getStatus()).isEqualTo(201);
        mockMvc.perform(delete("/api/v1/workspaces/" + wsId + "/files/a.yaml?baseVersion=1")
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(status().isNoContent());

        assertThat(putFile(owner[1], wsId, "a.yaml", "v2", 0).getResponse().getStatus()).isEqualTo(201);
        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/tree")
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(jsonPath("$.rootVersion").value(1))
                .andExpect(jsonPath("$.files[0].version").value(1))
                .andExpect(jsonPath("$.files[0].hash").value(sha256Hex("v2")));
    }

    // ---- POST files/batch ----

    /** 混合结果部分成功：pushed/conflict/forbidden/invalid 逐文件独立。 */
    @Test
    void batchPushReturnsPartialSuccessWithMixedStatuses() throws Exception {
        String[] owner = newUser("c-t16-owner");
        String[] editor = newUser("c-t16-editor");
        String wsId = createWorkspace(owner[1], "批推送混合");
        putMember(owner[1], wsId, editor[0], "EDITOR");
        assertThat(putFile(owner[1], wsId, "groups/g1/projects/p1/exist.yaml", "old", 0)
                .getResponse().getStatus()).isEqualTo(201);
        // p2 预置种子文件以获得推导 id，随后对 editor 置 NONE
        assertThat(putFile(owner[1], wsId, "groups/g1/projects/p2/seed.yaml", "s", 0)
                .getResponse().getStatus()).isEqualTo(201);
        String tree = getTree(owner[1], wsId).getResponse().getContentAsString();
        setAcl(owner[1], wsId, projectIdOf(tree, "groups/g1/projects/p2"), editor[0], "NONE");

        String batch = "{\"files\":["
                + "{\"path\":\"groups/g1/projects/p3/new.yaml\",\"content\":\"n\",\"baseVersion\":0}"
                + ",{\"path\":\"groups/g1/projects/p1/exist.yaml\",\"content\":\"new\",\"baseVersion\":1}"
                + ",{\"path\":\"groups/g1/projects/p1/exist.yaml\",\"content\":\"new\",\"baseVersion\":1}"
                + ",{\"path\":\"groups/g1/projects/p2/locked.yaml\",\"content\":\"y\",\"baseVersion\":0}"
                + ",{\"path\":\"../evil.yaml\",\"content\":\"x\",\"baseVersion\":0}"
                + ",{\"path\":\"/abs.yaml\",\"content\":\"x\",\"baseVersion\":0}"
                + ",{\"path\":\"a//b.yaml\",\"content\":\"x\",\"baseVersion\":0}"
                + ",{\"path\":\"" + "groups/g1/projects/p1/" + "x".repeat(492) + ".yaml"
                + "\",\"content\":\"x\",\"baseVersion\":0}"
                + ",{\"path\":\"groups/g1/projects/p1/exist.yaml\",\"content\":\"newer\",\"baseVersion\":99}"
                + "]}";
        mockMvc.perform(post("/api/v1/workspaces/" + wsId + "/files/batch")
                        .header("Authorization", "Bearer " + editor[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(batch))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.results", hasSize(9)))
                .andExpect(jsonPath("$.results[0].status").value("pushed"))
                .andExpect(jsonPath("$.results[0].version").value(1))
                .andExpect(jsonPath("$.results[1].status").value("pushed"))
                .andExpect(jsonPath("$.results[1].version").value(2))
                .andExpect(jsonPath("$.results[2].status").value("conflict"))
                .andExpect(jsonPath("$.results[2].currentVersion").value(2))
                .andExpect(jsonPath("$.results[3].status").value("forbidden"))
                .andExpect(jsonPath("$.results[4].status").value("invalid"))
                .andExpect(jsonPath("$.results[5].status").value("invalid"))
                .andExpect(jsonPath("$.results[6].status").value("invalid"))
                .andExpect(jsonPath("$.results[7].status").value("invalid"))
                .andExpect(jsonPath("$.results[8].status").value("conflict"))
                .andExpect(jsonPath("$.results[8].currentVersion").value(2));

        // 部分成功落盘验证：p3/new.yaml 已建（v1）
        MvcResult files = getFiles(owner[1], wsId, "groups/g1/projects/p3/new.yaml");
        String body = files.getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat((String) JsonPath.read(body, "$.files[0].content")).isEqualTo("n");
    }

    /** batch >200 条 → 400 batch_too_large（整批拒绝，不做部分成功）。 */
    @Test
    void batchRejectsMoreThan200FilesWithBatchTooLarge() throws Exception {
        String[] owner = newUser("c-t17-owner");
        String wsId = createWorkspace(owner[1], "批推送上限");
        String items = IntStream.rangeClosed(1, 201)
                .mapToObj(i -> "{\"path\":\"f" + i + ".yaml\",\"content\":\"x\",\"baseVersion\":0}")
                .collect(Collectors.joining(","));
        mockMvc.perform(post("/api/v1/workspaces/" + wsId + "/files/batch")
                        .header("Authorization", "Bearer " + owner[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"files\":[" + items + "]}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("batch_too_large"));
    }

    // ---- 字节口径与访问面 ----

    /** UTF-8 内容：hash/size 按字节（裁定 A），content 读回无损。 */
    @Test
    void utf8ContentRoundTripsWithByteBasedSizeAndHash() throws Exception {
        String[] owner = newUser("c-t18-owner");
        String wsId = createWorkspace(owner[1], "UTF8口径");
        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/files/groups/g1/projects/p1/unicode.yaml")
                        .header("Authorization", "Bearer " + owner[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"你好\",\"baseVersion\":0}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.hash").value(sha256Hex("你好")));

        MvcResult tree = getTree(owner[1], wsId);
        String treeBody = tree.getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat(filterSingle(treeBody, "$.files[?(@.path=='groups/g1/projects/p1/unicode.yaml')].size",
                Integer.class)).isEqualTo(6);

        MvcResult files = getFiles(owner[1], wsId, "groups/g1/projects/p1/unicode.yaml");
        String body = files.getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat((String) JsonPath.read(body, "$.files[0].content")).isEqualTo("你好");
    }

    /** 访问面：非成员 403 forbidden；未知工作区 404 workspace_not_found。 */
    @Test
    void contentEndpointsRequireMembership() throws Exception {
        String[] owner = newUser("c-t19-owner");
        String[] outsider = newUser("c-t19-outsider");
        String wsId = createWorkspace(owner[1], "访问面");

        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/tree")
                        .header("Authorization", "Bearer " + outsider[1]))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("forbidden"));
        assertThat(putFile(outsider[1], wsId, "a.yaml", "x", 0).getResponse().getStatus()).isEqualTo(403);

        mockMvc.perform(get("/api/v1/workspaces/" + java.util.UUID.randomUUID() + "/tree")
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("workspace_not_found"));
    }
}
