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
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.util.HexFormat;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 落盘失败回滚测试（规格 m3 §2 D6「文件落盘失败回滚版本记录并 500」+ 计划步骤 1 的可重试要求）。
 * 手法：让目标路径被目录占位（或父段为普通文件）制造必然的文件 IO 失败——纯 JDK、跨平台、不依赖只读盘。
 * 断言：500 io_error + 版本不前进（回滚），修复后同 baseVersion 重试可恢复。
 */
@SpringBootTest
@AutoConfigureMockMvc
@TestPropertySource(properties = {
        "spring.datasource.url=jdbc:h2:mem:apicc-content-io-test;DB_CLOSE_DELAY=-1",
        "apicc.server.data-dir=target/test-data-content-io"
})
class ContentIoFailureTest {

    @Autowired
    private MockMvc mockMvc;

    // ---- 测试脚手架 ----

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

    private MvcResult putFile(String token, String wsId, String path, String content, long baseVersion)
            throws Exception {
        return mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/files/" + path)
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"" + content + "\",\"baseVersion\":" + baseVersion + "}"))
                .andReturn();
    }

    private static String sha256Hex(String content) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(content.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception ex) {
            throw new IllegalStateException(ex);
        }
    }

    private Path diskPath(String wsId, String relPath) {
        return Paths.get("target/test-data-content-io", "workspaces", wsId).resolve(relPath);
    }

    // ---- 落盘失败回滚 ----

    /** 既有文件落盘失败：500 io_error、版本回滚保持 v1/hash 不变；修复后同 baseVersion 重试 → v2。 */
    @Test
    void diskWriteFailureOnExistingFileRollsBackVersionAndRecoversOnRetry() throws Exception {
        String[] owner = newUser("c-io1-owner");
        String wsId = createWorkspace(owner[1], "落盘回滚");
        assertThat(putFile(owner[1], wsId, "groups/g1/projects/p1/f.yaml", "v1", 0)
                .getResponse().getStatus()).isEqualTo(201);
        String h1 = sha256Hex("v1");

        // 目录占位目标路径 → 后续写文件必然 IO 失败（跨平台纯 JDK 手法）
        Path target = diskPath(wsId, "groups/g1/projects/p1/f.yaml");
        Files.delete(target);
        Files.createDirectory(target);
        try {
            mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/files/groups/g1/projects/p1/f.yaml")
                            .header("Authorization", "Bearer " + owner[1])
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{\"content\":\"v2\",\"baseVersion\":1}"))
                    .andExpect(status().isInternalServerError())
                    .andExpect(jsonPath("$.code").value("io_error"));

            // 版本已回滚：tree 仍是 v1 / h1（重试方可按原 baseVersion 恢复）
            mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/tree")
                            .header("Authorization", "Bearer " + owner[1]))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.rootVersion").value(1))
                    .andExpect(jsonPath("$.files[0].version").value(1))
                    .andExpect(jsonPath("$.files[0].hash").value(h1));
        } finally {
            // 修复占位目录，验证重试可恢复
            try (var paths = Files.walk(target)) {
                paths.sorted(java.util.Comparator.reverseOrder()).forEach(p -> {
                    try {
                        Files.delete(p);
                    } catch (java.io.IOException ex) {
                        throw new IllegalStateException(ex);
                    }
                });
            }
        }

        MvcResult retry = putFile(owner[1], wsId, "groups/g1/projects/p1/f.yaml", "v2", 1);
        assertThat(retry.getResponse().getStatus()).isEqualTo(201);
        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/tree")
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(jsonPath("$.rootVersion").value(2))
                .andExpect(jsonPath("$.files[0].version").value(2));
    }

    /** 新文件落盘失败：500 io_error 且不留版本行（树中不出现，rootVersion 不变）。 */
    @Test
    void diskWriteFailureOnNewFileLeavesNoVersionRowBehind() throws Exception {
        String[] owner = newUser("c-io2-owner");
        String wsId = createWorkspace(owner[1], "落盘新文件");
        assertThat(putFile(owner[1], wsId, "blocker", "root file", 0).getResponse().getStatus()).isEqualTo(201);

        // 父段「blocker」是普通文件 → blocker/inner.yaml 建父目录必然失败
        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/files/blocker/inner.yaml")
                        .header("Authorization", "Bearer " + owner[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"x\",\"baseVersion\":0}"))
                .andExpect(status().isInternalServerError())
                .andExpect(jsonPath("$.code").value("io_error"));

        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/tree")
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.rootVersion").value(1))
                .andExpect(jsonPath("$.files", org.hamcrest.Matchers.hasSize(1)))
                .andExpect(jsonPath("$.files[0].path").value("blocker"));
    }
}
