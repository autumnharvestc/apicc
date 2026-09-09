package com.autumnharvestc.server.content;

import com.jayway.jsonpath.JsonPath;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;
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
 * 内容同步 API 契约测试（规格 m3 §3.4 逐条 + 2026-09-08 path 实体化修订 + 裁定 A–D）。
 * path 新规则：首段必须是**存在的项目数字 id**（{@code <projectId>/...}，BIGINT 化实体主键），
 * 根级仅允许 apicc.workspace.yaml——首段非数字 400 path_invalid；首段为数字但项目不存在 404
 * project_not_found（写面；读面不 404，按无权/missing 处理）。
 * 覆盖：tree（清单形状/hash/version/size、projects 来自实体表 {id,name,groupId,myRole}、
 * NONE 过滤）；files 批量取（missing 语义/≤200）；PUT（新文件 201/变更递增/同 hash 幂等 200/
 * 409 现状/非法路径 400/项目不存在 404/apicc.workspace.yaml 仅 ADMIN+/VIEWER 只读）；
 * DELETE 并发语义与重建；batch 混合部分成功与上限；UTF-8 字节口径；
 * 内容入库（规格 §5）：PUT 直写 file_versions.content，磁盘内容树退役。
 */
@SpringBootTest
@AutoConfigureMockMvc
@TestPropertySource(properties = {
        "apicc.server.allow-registration=true",
        "spring.datasource.url=jdbc:h2:mem:apicc-content-test;DB_CLOSE_DELAY=-1"
})
class ContentApiContractTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private JdbcTemplate jdbc;

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

    /** 建分组（ADMIN+，创建者为 OWNER），返回分组 id。 */
    private String createGroup(String token, String wsId, String name) throws Exception {
        MvcResult result = mockMvc.perform(post("/api/v1/workspaces/" + wsId + "/groups")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"" + name + "\"}"))
                .andExpect(status().isCreated())
                .andReturn();
        return JsonPath.read(result.getResponse().getContentAsString(), "$.id");
    }

    /** 建项目（ADMIN+），返回实体项目 id（数字字符串）——内容 path 首段即此 id。 */
    private String createProject(String token, String wsId, String groupId, String name) throws Exception {
        MvcResult result = mockMvc.perform(post("/api/v1/workspaces/" + wsId + "/projects")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"groupId\":\"" + groupId + "\",\"name\":\"" + name + "\"}"))
                .andExpect(status().isCreated())
                .andReturn();
        return JsonPath.read(result.getResponse().getContentAsString(), "$.id");
    }

    /** 便捷夹具：建分组 + 项目，返回项目 id（同一工作区内可多次调用建多项目）。 */
    private String newProject(String token, String wsId, String groupName, String projectName) throws Exception {
        return createProject(token, wsId, createGroup(token, wsId, groupName), projectName);
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

    /** JsonPath 过滤表达式恒返回数组——取单值便捷封装。 */
    @SuppressWarnings("unchecked")
    private static <T> T filterSingle(String body, String expression, Class<T> type) {
        Object value = ((java.util.List<?>) JsonPath.read(body, expression)).get(0);
        return type.cast(value);
    }

    // ---- path 实体化规则 ----

    /**
     * 新 path 规则：首段必须是存在的项目数字 id；根级仅允许 apicc.workspace.yaml。
     * 首段非数字 → 400 path_invalid；首段为数字但项目不存在 → 404 project_not_found（写面，
     * DELETE 对称）；读面不 404（ghost 项目路径批量取进 missing，不泄露存在性）。
     */
    @Test
    void pathFirstSegmentMustBeExistingProjectId() throws Exception {
        String[] owner = newUser("c-t20-owner");
        String wsId = createWorkspace(owner[1], "path首段实体校验");
        String groupId = createGroup(owner[1], wsId, "g1");
        String projectId = createProject(owner[1], wsId, groupId, "实体项目");

        // 首段非数字（多段）→ 400 path_invalid
        MvcResult badShape = putFile(owner[1], wsId, "not-a-number/apis/a.yaml", "x", 0);
        assertThat(badShape.getResponse().getStatus()).as("非数字首段应 400").isEqualTo(400);
        assertThat(JsonPath.<String>read(badShape.getResponse().getContentAsString(), "$.code"))
                .isEqualTo("path_invalid");
        // 单段根级文件亦不允许（根级仅 apicc.workspace.yaml）
        assertThat(putFile(owner[1], wsId, "a.yaml", "x", 0).getResponse().getStatus()).isEqualTo(400);

        // 首段为数字但项目不存在 → 404 project_not_found（PUT 与 DELETE 写面对称；
        // 幽灵 id 用不存在的大数字——BIGINT 化口径 5）
        String ghost = "999999";
        MvcResult ghostPut = putFile(owner[1], wsId, ghost + "/x.yaml", "x", 0);
        assertThat(ghostPut.getResponse().getStatus()).as("不存在项目应 404").isEqualTo(404);
        assertThat(JsonPath.<String>read(ghostPut.getResponse().getContentAsString(), "$.code"))
                .isEqualTo("project_not_found");
        mockMvc.perform(delete("/api/v1/workspaces/" + wsId + "/files/" + ghost + "/x.yaml?baseVersion=0")
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("project_not_found"));

        // 读面不 404：ghost 项目路径批量取进 missing（与既有读面语义一致）
        MvcResult ghostRead = getFiles(owner[1], wsId, ghost + "/x.yaml");
        assertThat(ghostRead.getResponse().getStatus()).isEqualTo(200);
        assertThat((String) JsonPath.read(ghostRead.getResponse().getContentAsString(), "$.missing[0]"))
                .isEqualTo(ghost + "/x.yaml");

        // 根配置既有语义保持：owner（ADMIN+）可写
        assertThat(putFile(owner[1], wsId, "apicc.workspace.yaml", "root: 1", 0)
                .getResponse().getStatus()).isEqualTo(201);

        // tree.projects 来自实体表：两个同名项目各推 1 文件 → 2 行、id 各异、groupId 在列
        String p1 = createProject(owner[1], wsId, groupId, "同名项目");
        String p2 = createProject(owner[1], wsId, groupId, "同名项目");
        assertThat(putFile(owner[1], wsId, p1 + "/a.yaml", "1", 0).getResponse().getStatus()).isEqualTo(201);
        assertThat(putFile(owner[1], wsId, p2 + "/a.yaml", "2", 0).getResponse().getStatus()).isEqualTo(201);
        String body = getTree(owner[1], wsId).getResponse().getContentAsString(StandardCharsets.UTF_8);
        List<String> sameNameIds = JsonPath.read(body, "$.projects[?(@.name=='同名项目')].id");
        assertThat(sameNameIds).hasSize(2).containsExactlyInAnyOrder(p1, p2);
        @SuppressWarnings("unchecked")
        List<String> groupIdsOfSameName = JsonPath.read(body, "$.projects[?(@.name=='同名项目')].groupId");
        assertThat(groupIdsOfSameName).containsOnly(groupId);
        // 推导 id 退役：同名项目 id 互异（实体数字主键，不再是路径哈希）
        assertThat(sameNameIds.get(0)).isNotEqualTo(sameNameIds.get(1));
    }

    /**
     * 越界数字首段（20 位，匹配 \d+ 但超 long 值域）按「项目不存在」处理（BIGINT 化审查修复）：
     * 单写 PUT → 404 project_not_found（不得 NumberFormatException → 500）；读面批量取进 missing
     * （空有效角色）；batch 含该路径 → 该文件 invalid 行、其余 pushed——D8 逐文件部分成功不被击穿。
     */
    @Test
    void overflowProjectIdSegmentIsProjectNotFoundNever500() throws Exception {
        String[] owner = newUser("c-t22-owner");
        String wsId = createWorkspace(owner[1], "越界首段");
        String p1 = newProject(owner[1], wsId, "g1", "p1");
        String overflow = "99999999999999999999"; // 20 位：形态合法、Long.parseLong 越界

        // 单写 PUT → 404 project_not_found（写面守卫先于权限/落库；非 500）
        MvcResult put = putFile(owner[1], wsId, overflow + "/x.yaml", "x", 0);
        assertThat(put.getResponse().getStatus()).as("越界首段应 404 而非 500").isEqualTo(404);
        assertThat(JsonPath.<String>read(put.getResponse().getContentAsString(), "$.code"))
                .isEqualTo("project_not_found");
        // DELETE 写面对称：同样 404
        mockMvc.perform(delete("/api/v1/workspaces/" + wsId + "/files/" + overflow + "/x.yaml?baseVersion=0")
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("project_not_found"));

        // 读面不 404 亦不 500：无有效角色 → 批量取进 missing
        MvcResult read = getFiles(owner[1], wsId, overflow + "/x.yaml");
        assertThat(read.getResponse().getStatus()).isEqualTo(200);
        assertThat((String) JsonPath.read(read.getResponse().getContentAsString(), "$.missing[0]"))
                .isEqualTo(overflow + "/x.yaml");

        // batch：越界行 invalid、其余 pushed——逐文件部分成功不被 NFE 整批 500
        String batch = "{\"files\":["
                + "{\"path\":\"" + p1 + "/ok.yaml\",\"content\":\"n\",\"baseVersion\":0}"
                + ",{\"path\":\"" + overflow + "/bad.yaml\",\"content\":\"x\",\"baseVersion\":0}"
                + "]}";
        mockMvc.perform(post("/api/v1/workspaces/" + wsId + "/files/batch")
                        .header("Authorization", "Bearer " + owner[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(batch))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.results", hasSize(2)))
                .andExpect(jsonPath("$.results[0].status").value("pushed"))
                .andExpect(jsonPath("$.results[1].status").value("invalid"));
    }

    /**
     * 规范形守卫（审查修复）：非规范数字别名（前导零，如 007/0123）按「项目不存在」404 拒绝——
     * 即便 parse 后命中真实项目也不放行，杜绝同项目双 path 别名（deleteByProjectPrefix 前缀
     * 清不尽孤儿行）；真实项目 id 的规范形寻址不受影响。
     */
    @Test
    void nonCanonicalProjectIdAliasIsRejected() throws Exception {
        String[] owner = newUser("c-t23-owner");
        String wsId = createWorkspace(owner[1], "规范形首段");
        String p1 = newProject(owner[1], wsId, "g1", "p1");

        // 真实项目规范形 → 正常写入（201）
        assertThat(putFile(owner[1], wsId, p1 + "/x.yaml", "x", 0).getResponse().getStatus())
                .as("规范形 id 寻址不受守卫影响").isEqualTo(201);

        // 前导零别名（parse 后命中真实项目 p1）→ 404 project_not_found（非 500、非 201）
        String alias = "0" + p1;
        MvcResult aliasPut = putFile(owner[1], wsId, alias + "/x.yaml", "x", 0);
        assertThat(aliasPut.getResponse().getStatus()).as("别名首段应 404").isEqualTo(404);
        assertThat(JsonPath.<String>read(aliasPut.getResponse().getContentAsString(), "$.code"))
                .isEqualTo("project_not_found");

        // 字面 007 同样拒绝（无论是否存在项目 7）
        MvcResult alias007 = putFile(owner[1], wsId, "007/x.yaml", "x", 0);
        assertThat(alias007.getResponse().getStatus()).isEqualTo(404);
        assertThat(JsonPath.<String>read(alias007.getResponse().getContentAsString(), "$.code"))
                .isEqualTo("project_not_found");
    }

    // ---- GET tree ----

    /** 多项目清单：files[path,hash,version,size] + projects[id,name,groupId,myRole]（实体表产出）。 */
    @Test
    void treeReturnsMultiProjectListingWithHashVersionSizeAndProjectEntity() throws Exception {
        String[] owner = newUser("c-t1-owner");
        String wsId = createWorkspace(owner[1], "树清单多项目");
        String g1 = createGroup(owner[1], wsId, "g1");
        String g2 = createGroup(owner[1], wsId, "g2");
        String p1 = createProject(owner[1], wsId, g1, "p1");
        String p2 = createProject(owner[1], wsId, g2, "p2");
        assertThat(putFile(owner[1], wsId, "apicc.workspace.yaml", "root: config", 0)
                .getResponse().getStatus()).isEqualTo(201);
        assertThat(putFile(owner[1], wsId, p1 + "/a.yaml", "hello", 0).getResponse().getStatus()).isEqualTo(201);
        assertThat(putFile(owner[1], wsId, p2 + "/b.yaml", "world!", 0).getResponse().getStatus()).isEqualTo(201);

        MvcResult tree = getTree(owner[1], wsId);
        String body = tree.getResponse().getContentAsString(StandardCharsets.UTF_8);
        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/tree").header("Authorization", "Bearer " + owner[1]))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.workspaceId").value(wsId))
                .andExpect(jsonPath("$.rootVersion").value(3))
                .andExpect(jsonPath("$.files", hasSize(3)))
                .andExpect(jsonPath("$.files[*].path", containsInAnyOrder(
                        "apicc.workspace.yaml", p1 + "/a.yaml", p2 + "/b.yaml")))
                .andExpect(jsonPath("$.projects", hasSize(2)))
                .andExpect(jsonPath("$.projects[*].id", containsInAnyOrder(p1, p2)))
                .andExpect(jsonPath("$.projects[*].name", containsInAnyOrder("p1", "p2")))
                .andExpect(jsonPath("$.projects[*].groupId", containsInAnyOrder(g1, g2)))
                .andExpect(jsonPath("$.projects[*].myRole", containsInAnyOrder("OWNER", "OWNER")));

        // 裁定 A：size = 落盘文件真实字节数；hash = sha-256 hex（UTF-8 内容字节）
        assertThat(filterSingle(body, "$.files[?(@.path=='" + p1 + "/a.yaml')].hash", String.class))
                .isEqualTo(sha256Hex("hello"));
        assertThat(filterSingle(body, "$.files[?(@.path=='" + p1 + "/a.yaml')].version", Integer.class))
                .isEqualTo(1);
        assertThat(filterSingle(body, "$.files[?(@.path=='" + p1 + "/a.yaml')].size", Integer.class))
                .isEqualTo(5);
        assertThat(filterSingle(body, "$.files[?(@.path=='apicc.workspace.yaml')].size", Integer.class))
                .isEqualTo("root: config".getBytes(StandardCharsets.UTF_8).length);
        // 实体化：projects[].id 即管理面创建的实体 id（不再从路径推导；BIGINT 化后对外为字符串化数字）
        assertThat(filterSingle(body, "$.projects[?(@.name=='p1')].id", String.class)).isEqualTo(p1);
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

    /** NONE 项目过滤：projects 与 files 两面整体不出现；编辑者同项目 myRole=EDITOR；编辑写 NONE 项目 403。 */
    @Test
    void treeFiltersNoneProjectFromProjectsAndFiles() throws Exception {
        String[] owner = newUser("c-t3-owner");
        String[] editor = newUser("c-t3-editor");
        String[] viewer = newUser("c-t3-viewer");
        String wsId = createWorkspace(owner[1], "树清单NONE过滤");
        putMember(owner[1], wsId, editor[0], "EDITOR");
        putMember(owner[1], wsId, viewer[0], "VIEWER");
        String p1 = newProject(owner[1], wsId, "g1", "p1");
        String p2 = newProject(owner[1], wsId, "g2", "p2");
        assertThat(putFile(owner[1], wsId, p1 + "/a.yaml", "secret", 0).getResponse().getStatus()).isEqualTo(201);
        assertThat(putFile(owner[1], wsId, p2 + "/b.yaml", "open", 0).getResponse().getStatus()).isEqualTo(201);

        setAcl(owner[1], wsId, p1, viewer[0], "NONE");
        setAcl(owner[1], wsId, p1, editor[0], "NONE");

        // viewer：p1 子树整体不出现（projects + files 两面）
        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/tree")
                        .header("Authorization", "Bearer " + viewer[1]))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.projects", hasSize(1)))
                .andExpect(jsonPath("$.projects[0].id").value(p2))
                .andExpect(jsonPath("$.files", hasSize(1)))
                .andExpect(jsonPath("$.files[0].path").value(p2 + "/b.yaml"));

        // viewer 批量取：NONE 项目路径进 missing（不 403，不泄露存在性）
        MvcResult files = getFiles(viewer[1], wsId, p1 + "/a.yaml," + p2 + "/b.yaml");
        assertThat(files.getResponse().getStatus()).isEqualTo(200);
        String filesBody = files.getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat((Integer) JsonPath.read(filesBody, "$.files.length()")).isEqualTo(1);
        assertThat((String) JsonPath.read(filesBody, "$.files[0].path")).isEqualTo(p2 + "/b.yaml");
        assertThat((String) JsonPath.read(filesBody, "$.missing[0]")).isEqualTo(p1 + "/a.yaml");

        // editor：无 ACL 行继承工作区角色（p2）→ myRole=EDITOR；p1 已对 editor 置 NONE → 写 403 project_forbidden
        String editorTree = getTree(editor[1], wsId).getResponse().getContentAsString();
        assertThat(filterSingle(editorTree, "$.projects[?(@.id=='" + p2 + "')].myRole", String.class))
                .isEqualTo("EDITOR");
        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/files/" + p1 + "/a.yaml")
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
        String p1 = newProject(owner[1], wsId, "g1", "p1");
        assertThat(putFile(owner[1], wsId, p1 + "/a.yaml", "abc", 0).getResponse().getStatus()).isEqualTo(201);

        MvcResult files = getFiles(viewer[1], wsId, p1 + "/a.yaml," + p1 + "/nope.yaml");
        assertThat(files.getResponse().getStatus()).isEqualTo(200);
        String body = files.getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat((Integer) JsonPath.read(body, "$.files.length()")).isEqualTo(1);
        assertThat((String) JsonPath.read(body, "$.files[0].path")).isEqualTo(p1 + "/a.yaml");
        assertThat((String) JsonPath.read(body, "$.files[0].content")).isEqualTo("abc");
        assertThat((Integer) JsonPath.read(body, "$.files[0].version")).isEqualTo(1);
        assertThat((String) JsonPath.read(body, "$.files[0].hash")).isEqualTo(sha256Hex("abc"));
        assertThat((String) JsonPath.read(body, "$.missing[0]")).isEqualTo(p1 + "/nope.yaml");
    }

    /** >200 路径/批 → 400 batch_too_large（先于逐路径处理，路径形状不参与该判定）。 */
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
        String p1 = newProject(owner[1], wsId, "g1", "p1");

        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/files/" + p1 + "/new.yaml")
                        .header("Authorization", "Bearer " + owner[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"hello\",\"baseVersion\":0}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.path").value(p1 + "/new.yaml"))
                .andExpect(jsonPath("$.version").value(1))
                .andExpect(jsonPath("$.hash").value(sha256Hex("hello")));
    }

    /** 内容变更（baseVersion 匹配）→ version 递增。 */
    @Test
    void putChangedContentIncrementsVersion() throws Exception {
        String[] owner = newUser("c-t7-owner");
        String wsId = createWorkspace(owner[1], "PUT变更");
        String p1 = newProject(owner[1], wsId, "g1", "p1");
        assertThat(putFile(owner[1], wsId, p1 + "/a.yaml", "v1", 0).getResponse().getStatus()).isEqualTo(201);

        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/files/" + p1 + "/a.yaml")
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
        String p1 = newProject(owner[1], wsId, "g1", "p1");
        assertThat(putFile(owner[1], wsId, p1 + "/a.yaml", "same", 0).getResponse().getStatus()).isEqualTo(201);

        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/files/" + p1 + "/a.yaml")
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
        String p1 = newProject(owner[1], wsId, "g1", "p1");
        assertThat(putFile(owner[1], wsId, p1 + "/a.yaml", "v1", 0).getResponse().getStatus()).isEqualTo(201);

        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/files/" + p1 + "/a.yaml")
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
        String p1 = newProject(owner[1], wsId, "g1", "p1");

        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/files/" + p1 + "/new.yaml")
                        .header("Authorization", "Bearer " + owner[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"x\",\"baseVersion\":5}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("version_conflict"))
                .andExpect(jsonPath("$.currentVersion").value(0))
                .andExpect(jsonPath("$.currentHash").value(nullValue()));
    }

    /** 非法路径族 → 400 path_invalid：..、反斜杠、尾斜杠、点段、盘符、非数字首段、超长（>512）。
     *  注：盘符 "C:/evil.yaml" 现由「首段非数字 id」规则拦截（通用校验已移除禁冒号——id 段无冒号风险）；
     *  绝对路径/空段仍由通用校验拒绝（URL 面经 MockMvc/URI 链折叠 //，故空段经 batch 面 JSON 体钉住）。 */
    @Test
    void putRejectsInvalidPathsWithPathInvalid() throws Exception {
        String[] owner = newUser("c-t11-owner");
        String wsId = createWorkspace(owner[1], "PUT非法路径");
        String p1 = newProject(owner[1], wsId, "g1", "p1");
        for (String bad : new String[]{
                "../evil.yaml", "a/../b.yaml", "a\\b.yaml", "a/b/", ".", "a/./b.yaml", "C:/evil.yaml",
                "not-a-number/apis/a.yaml", "a.yaml",
                // 超长：>512（与 DDL VARCHAR(512) 对齐）——未钉时 insertNew 抛 DataIntegrityViolation → 500
                p1 + "/" + "x".repeat(520) + ".yaml"}) {
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

    /** VIEWER 写任意路径 403 forbidden；项目内路径按工作区角色继承（EDITOR 无 ACL 行可写）。 */
    @Test
    void putEnforcesWriteRolesAndProjectInheritance() throws Exception {
        String[] owner = newUser("c-t13-owner");
        String[] editor = newUser("c-t13-editor");
        String[] viewer = newUser("c-t13-viewer");
        String wsId = createWorkspace(owner[1], "写权限角色");
        putMember(owner[1], wsId, editor[0], "EDITOR");
        putMember(owner[1], wsId, viewer[0], "VIEWER");
        String p1 = newProject(owner[1], wsId, "g1", "p1");
        assertThat(putFile(owner[1], wsId, p1 + "/f.yaml", "v1", 0).getResponse().getStatus()).isEqualTo(201);

        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/files/" + p1 + "/f.yaml")
                        .header("Authorization", "Bearer " + viewer[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"x\",\"baseVersion\":1}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("forbidden"));

        // 编辑继承：EDITOR 无 ACL 行 → 继承工作区角色可写项目内文件
        assertThat(putFile(editor[1], wsId, p1 + "/editor.yaml", "n", 0).getResponse().getStatus()).isEqualTo(201);
    }

    // ---- DELETE files ----

    /** DELETE 并发语义：baseVersion 不匹配 409 现状；匹配 204；删除后 tree/files 消失；再删 404。 */
    @Test
    void deleteFileHonorsOptimisticConcurrencyThenRemoves() throws Exception {
        String[] owner = newUser("c-t14-owner");
        String wsId = createWorkspace(owner[1], "DELETE并发");
        String p1 = newProject(owner[1], wsId, "g1", "p1");
        assertThat(putFile(owner[1], wsId, p1 + "/a.yaml", "v1", 0).getResponse().getStatus()).isEqualTo(201);
        String h1 = sha256Hex("v1");

        mockMvc.perform(delete("/api/v1/workspaces/" + wsId + "/files/" + p1 + "/a.yaml?baseVersion=0")
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("version_conflict"))
                .andExpect(jsonPath("$.currentVersion").value(1))
                .andExpect(jsonPath("$.currentHash").value(h1));

        mockMvc.perform(delete("/api/v1/workspaces/" + wsId + "/files/" + p1 + "/a.yaml?baseVersion=1")
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(status().isNoContent());

        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/tree")
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(jsonPath("$.rootVersion").value(0))
                .andExpect(jsonPath("$.files", hasSize(0)));
        MvcResult files = getFiles(owner[1], wsId, p1 + "/a.yaml");
        assertThat((String) JsonPath.read(files.getResponse().getContentAsString(), "$.missing[0]"))
                .isEqualTo(p1 + "/a.yaml");

        mockMvc.perform(delete("/api/v1/workspaces/" + wsId + "/files/" + p1 + "/a.yaml?baseVersion=1")
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("file_not_found"));
    }

    /** 删除后重建：行已删 → 新文件语义（baseVersion=0 → 201 version=1）。 */
    @Test
    void deletedFileCanBeRecreatedAtVersionOne() throws Exception {
        String[] owner = newUser("c-t15-owner");
        String wsId = createWorkspace(owner[1], "删除重建");
        String p1 = newProject(owner[1], wsId, "g1", "p1");
        assertThat(putFile(owner[1], wsId, p1 + "/a.yaml", "v1", 0).getResponse().getStatus()).isEqualTo(201);
        mockMvc.perform(delete("/api/v1/workspaces/" + wsId + "/files/" + p1 + "/a.yaml?baseVersion=1")
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(status().isNoContent());

        assertThat(putFile(owner[1], wsId, p1 + "/a.yaml", "v2", 0).getResponse().getStatus()).isEqualTo(201);
        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/tree")
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(jsonPath("$.rootVersion").value(1))
                .andExpect(jsonPath("$.files[0].version").value(1))
                .andExpect(jsonPath("$.files[0].hash").value(sha256Hex("v2")));
    }

    // ---- POST files/batch ----

    /** 混合结果部分成功：pushed/conflict/forbidden/invalid 逐文件独立（含项目不存在与非数字首段行）。 */
    @Test
    void batchPushReturnsPartialSuccessWithMixedStatuses() throws Exception {
        String[] owner = newUser("c-t16-owner");
        String[] editor = newUser("c-t16-editor");
        String wsId = createWorkspace(owner[1], "批推送混合");
        putMember(owner[1], wsId, editor[0], "EDITOR");
        String groupId = createGroup(owner[1], wsId, "g1");
        String p1 = createProject(owner[1], wsId, groupId, "p1");
        String p2 = createProject(owner[1], wsId, groupId, "p2");
        String p3 = createProject(owner[1], wsId, groupId, "p3");
        assertThat(putFile(owner[1], wsId, p1 + "/exist.yaml", "old", 0).getResponse().getStatus()).isEqualTo(201);
        // p2 预置种子文件后对 editor 置 NONE
        assertThat(putFile(owner[1], wsId, p2 + "/seed.yaml", "s", 0).getResponse().getStatus()).isEqualTo(201);
        setAcl(owner[1], wsId, p2, editor[0], "NONE");

        // 幽灵项目 id 用不存在的大数字（BIGINT 化口径 5）；与非数字首段 → 逐文件 invalid 行，不整批失败
        String ghost = "999999";
        String batch = "{\"files\":["
                + "{\"path\":\"" + p3 + "/new.yaml\",\"content\":\"n\",\"baseVersion\":0}"
                + ",{\"path\":\"" + p1 + "/exist.yaml\",\"content\":\"new\",\"baseVersion\":1}"
                + ",{\"path\":\"" + p1 + "/exist.yaml\",\"content\":\"new\",\"baseVersion\":1}"
                + ",{\"path\":\"" + p2 + "/locked.yaml\",\"content\":\"y\",\"baseVersion\":0}"
                + ",{\"path\":\"../evil.yaml\",\"content\":\"x\",\"baseVersion\":0}"
                + ",{\"path\":\"/abs.yaml\",\"content\":\"x\",\"baseVersion\":0}"
                + ",{\"path\":\"a//b.yaml\",\"content\":\"x\",\"baseVersion\":0}"
                + ",{\"path\":\"" + p1 + "/" + "x".repeat(520) + ".yaml\",\"content\":\"x\",\"baseVersion\":0}"
                + ",{\"path\":\"" + p1 + "/exist.yaml\",\"content\":\"newer\",\"baseVersion\":99}"
                // 项目不存在（写面 404）与非数字首段 → 逐文件 invalid 行，不整批失败
                + ",{\"path\":\"" + ghost + "/new.yaml\",\"content\":\"x\",\"baseVersion\":0}"
                + ",{\"path\":\"not-a-number/new.yaml\",\"content\":\"x\",\"baseVersion\":0}"
                + "]}";
        mockMvc.perform(post("/api/v1/workspaces/" + wsId + "/files/batch")
                        .header("Authorization", "Bearer " + editor[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(batch))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.results", hasSize(11)))
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
                .andExpect(jsonPath("$.results[8].currentVersion").value(2))
                .andExpect(jsonPath("$.results[9].status").value("invalid"))
                .andExpect(jsonPath("$.results[10].status").value("invalid"));

        // 部分成功落盘验证：p3/new.yaml 已建（v1）
        MvcResult files = getFiles(owner[1], wsId, p3 + "/new.yaml");
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
        String p1 = newProject(owner[1], wsId, "g1", "p1");
        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/files/" + p1 + "/unicode.yaml")
                        .header("Authorization", "Bearer " + owner[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"你好\",\"baseVersion\":0}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.hash").value(sha256Hex("你好")));

        MvcResult tree = getTree(owner[1], wsId);
        String treeBody = tree.getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat(filterSingle(treeBody, "$.files[?(@.path=='" + p1 + "/unicode.yaml')].size",
                Integer.class)).isEqualTo(6);

        MvcResult files = getFiles(owner[1], wsId, p1 + "/unicode.yaml");
        String body = files.getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat((String) JsonPath.read(body, "$.files[0].content")).isEqualTo("你好");
    }

    /** 规格 §5 内容入库：PUT 后 file_versions.content 即有字节；盘上无文件（磁盘内容树退役）。 */
    @Test
    void putPersistsContentInDbWithoutDiskTree() throws Exception {
        String[] owner = newUser("c-t21-owner");
        String wsId = createWorkspace(owner[1], "内容入库");
        String p1 = newProject(owner[1], wsId, "g1", "p1");
        String path = p1 + "/db-roundtrip.yaml";
        String content = "入库内容 round-trip 中文与 ASCII 混排 123";

        // 首写：content 列逐字一致（insertNew 与内容同一条 INSERT）
        assertThat(putFile(owner[1], wsId, path, content, 0).getResponse().getStatus()).isEqualTo(201);
        assertThat(jdbc.queryForObject(
                "SELECT content FROM file_versions WHERE workspace_id = ? AND path = ?",
                String.class, Long.parseLong(wsId), path)).isEqualTo(content);

        // 变更推进：bump 与内容写入同一条 UPDATE——同事务天然无撕裂，content 列随版本同步刷新
        String v2 = "第二版内容 changed 456";
        assertThat(putFile(owner[1], wsId, path, v2, 1).getResponse().getStatus()).isEqualTo(201);
        assertThat(jdbc.queryForObject(
                "SELECT content FROM file_versions WHERE workspace_id = ? AND path = ?",
                String.class, Long.parseLong(wsId), path)).isEqualTo(v2);

        // 磁盘内容树退役：历史落盘位置（data-dir 旧默认值 ./server-data）无文件（workspaces 根目录可能因历史运行残留，只断言文件路径不存在）
        assertThat(Files.notExists(Path.of("server-data", "workspaces", wsId, path)))
                .as("内容入库后盘上不应再有内容文件")
                .isTrue();
    }

    /** 访问面：非成员 403 forbidden（先于 path 校验）；未知工作区 404 workspace_not_found。 */
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

        mockMvc.perform(get("/api/v1/workspaces/999999/tree")
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("workspace_not_found"));
    }
}
