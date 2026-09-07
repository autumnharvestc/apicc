package com.autumnharvestc.server.workspace;

import com.jayway.jsonpath.JsonPath;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import java.util.UUID;

import static org.hamcrest.Matchers.hasItem;
import static org.hamcrest.Matchers.hasSize;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 任务 4 成员 API 契约测试（规格 m3 §3.2 + 裁定 C 角色规则）：
 * GET /workspaces/{id}/members（成员可读）、PUT members/{userId}（ADMIN+，OWNER 不可变更、
 * 提升至 OWNER 仅 OWNER=转让且自身降 ADMIN）、DELETE members/{userId}（ADMIN+，不可移除 OWNER）。
 */
@SpringBootTest
@AutoConfigureMockMvc
@TestPropertySource(properties = {
        "apicc.server.allow-registration=true",
        "spring.datasource.url=jdbc:h2:mem:apicc-members-test;DB_CLOSE_DELAY=-1",
        "apicc.server.data-dir=target/test-data-members"
})
class MemberApiContractTest {

    @Autowired
    private MockMvc mockMvc;

    // ---- 测试脚手架 ----

    /** 注册并登录，返回 [userId, token]。 */
    private String[] newUser(String username) throws Exception {
        mockMvc.perform(post("/api/v1/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"" + username + "\",\"password\":\"password123\",\"displayName\":\""
                                + "显示名-" + username + "\"}"))
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

    // ---- GET members（规格 §3.2：[{userId, username, displayName, role}]，权限=成员）----

    /** 成员列表形状：userId/username/displayName/role；不泄露 password 哈希。 */
    @Test
    void membersListReturnsSafeMemberView() throws Exception {
        String[] owner = newUser("m-alice");
        String wsId = createWorkspace(owner[1], "成员列表");

        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/members")
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$", hasSize(1)))
                .andExpect(jsonPath("$[0].userId").value(owner[0]))
                .andExpect(jsonPath("$[0].username").value("m-alice"))
                .andExpect(jsonPath("$[0].displayName").value("显示名-m-alice"))
                .andExpect(jsonPath("$[0].role").value("OWNER"))
                .andExpect(jsonPath("$[0].passwordHash").doesNotExist());
    }

    /** 全体成员角色可读列表；非成员 → 403 forbidden。 */
    @Test
    void membersListReadableByMembersOnly() throws Exception {
        String[] owner = newUser("m-bob");
        String[] editor = newUser("m-carl");
        String outsider = newUser("m-outsider1")[1];
        String wsId = createWorkspace(owner[1], "成员可读");
        putMember(owner[1], wsId, editor[0], "EDITOR");

        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/members")
                        .header("Authorization", "Bearer " + editor[1]))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$", hasSize(2)));

        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/members")
                        .header("Authorization", "Bearer " + outsider))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("forbidden"));
    }

    // ---- PUT members（规格 §3.2 + 裁定 C）----

    /** ADMIN 可把非成员用户直接加为成员（裁定 C：非成员添加=直接创建 membership 行）。 */
    @Test
    void adminCanAddNonMemberDirectly() throws Exception {
        String[] owner = newUser("m-dave");
        String[] admin = newUser("m-erin");
        String[] candidate = newUser("m-frank");
        String wsId = createWorkspace(owner[1], "直接添加");
        putMember(owner[1], wsId, admin[0], "ADMIN");

        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/members/" + candidate[0])
                        .header("Authorization", "Bearer " + admin[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"role\":\"EDITOR\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.userId").value(candidate[0]))
                .andExpect(jsonPath("$.username").value("m-frank"))
                .andExpect(jsonPath("$.role").value("EDITOR"));

        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/members")
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(jsonPath("$.length()").value(3));
    }

    /** ADMIN 可变更成员角色（ADMIN/EDITOR/VIEWER 之间）。 */
    @Test
    void adminCanChangeRolesBelowOwner() throws Exception {
        String[] owner = newUser("m-grace");
        String[] admin = newUser("m-heidi");
        String[] member = newUser("m-ivan");
        String wsId = createWorkspace(owner[1], "角色变更");
        putMember(owner[1], wsId, admin[0], "ADMIN");
        putMember(owner[1], wsId, member[0], "EDITOR");

        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/members/" + member[0])
                        .header("Authorization", "Bearer " + admin[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"role\":\"ADMIN\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.role").value("ADMIN"));

        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/members/" + member[0])
                        .header("Authorization", "Bearer " + admin[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"role\":\"VIEWER\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.role").value("VIEWER"));
    }

    /** ADMIN 不可设 OWNER → 403 requires_owner（裁定 C）。 */
    @Test
    void adminCannotAssignOwnerRole() throws Exception {
        String[] owner = newUser("m-judy");
        String[] admin = newUser("m-ken");
        String[] member = newUser("m-lisa");
        String wsId = createWorkspace(owner[1], "仅OWNER可转让");
        putMember(owner[1], wsId, admin[0], "ADMIN");
        putMember(owner[1], wsId, member[0], "VIEWER");

        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/members/" + member[0])
                        .header("Authorization", "Bearer " + admin[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"role\":\"OWNER\"}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("requires_owner"));
    }

    /** 目标已是 OWNER → 403 owner_immutable（任何调用者，含 OWNER 自己——裁定 C 平规则）。 */
    @Test
    void ownerTargetIsImmutable() throws Exception {
        String[] owner = newUser("m-mallory");
        String[] admin = newUser("m-nancy");
        String wsId = createWorkspace(owner[1], "OWNER不可变");
        putMember(owner[1], wsId, admin[0], "ADMIN");

        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/members/" + owner[0])
                        .header("Authorization", "Bearer " + admin[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"role\":\"VIEWER\"}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("owner_immutable"));

        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/members/" + owner[0])
                        .header("Authorization", "Bearer " + owner[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"role\":\"VIEWER\"}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("owner_immutable"));
    }

    /** OWNER 转让（裁定 C）：把他人设为 OWNER 且自身降 ADMIN，单操作完成。 */
    @Test
    void ownerTransferPromotesTargetAndDemotesSelf() throws Exception {
        String[] owner = newUser("m-olivia");
        String[] member = newUser("m-peter");
        String wsId = createWorkspace(owner[1], "转让");
        putMember(owner[1], wsId, member[0], "EDITOR");

        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/members/" + member[0])
                        .header("Authorization", "Bearer " + owner[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"role\":\"OWNER\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.userId").value(member[0]))
                .andExpect(jsonPath("$.role").value("OWNER"));

        // 新 OWNER 视角：myRole=OWNER；原 OWNER 已降 ADMIN
        mockMvc.perform(get("/api/v1/workspaces/" + wsId).header("Authorization", "Bearer " + member[1]))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.myRole").value("OWNER"))
                .andExpect(jsonPath("$.memberCount").value(2));

        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/members")
                        .header("Authorization", "Bearer " + member[1]))
                .andExpect(jsonPath("$[?(@.userId == '" + owner[0] + "')].role", hasItem("ADMIN")));
    }

    /** OWNER 可把非成员用户直接转让为 OWNER（加入+升位一次完成）。 */
    @Test
    void transferToNonMemberCreatesMembership() throws Exception {
        String[] owner = newUser("m-quinn");
        String[] outsider = newUser("m-rob");
        String wsId = createWorkspace(owner[1], "转让非成员");

        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/members/" + outsider[0])
                        .header("Authorization", "Bearer " + owner[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"role\":\"OWNER\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.role").value("OWNER"));

        mockMvc.perform(get("/api/v1/workspaces/" + wsId).header("Authorization", "Bearer " + outsider[1]))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.myRole").value("OWNER"));
    }

    /** EDITOR/VIEWER/非成员调 PUT → 403 forbidden；目标用户不存在 → 404 user_not_found；非法角色值 → 400。 */
    @Test
    void putMemberAuthorizationAndTargetValidation() throws Exception {
        String[] owner = newUser("m-sally");
        String[] editor = newUser("m-tom");
        String outsider = newUser("m-outsider2")[1];
        String wsId = createWorkspace(owner[1], "PUT校验");
        putMember(owner[1], wsId, editor[0], "EDITOR");

        for (String token : new String[]{editor[1], outsider}) {
            mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/members/" + owner[0])
                            .header("Authorization", "Bearer " + token)
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{\"role\":\"VIEWER\"}"))
                    .andExpect(status().isForbidden())
                    .andExpect(jsonPath("$.code").value("forbidden"));
        }

        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/members/" + UUID.randomUUID())
                        .header("Authorization", "Bearer " + owner[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"role\":\"VIEWER\"}"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("user_not_found"));

        mockMvc.perform(put("/api/v1/workspaces/" + wsId + "/members/" + editor[0])
                        .header("Authorization", "Bearer " + owner[1])
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"role\":\"SUPREME\"}"))
                .andExpect(status().isBadRequest());
    }

    // ---- DELETE members（规格 §3.2 + 裁定 C）----

    /** ADMIN 可移除 ADMIN 及以下；被移除者立即失去工作区访问（403）。 */
    @Test
    void adminRemovesMemberAndAccessRevoked() throws Exception {
        String[] owner = newUser("m-uma");
        String[] admin = newUser("m-victor");
        String[] member = newUser("m-wendy");
        String wsId = createWorkspace(owner[1], "移除成员");
        putMember(owner[1], wsId, admin[0], "ADMIN");
        putMember(owner[1], wsId, member[0], "VIEWER");

        mockMvc.perform(delete("/api/v1/workspaces/" + wsId + "/members/" + member[0])
                        .header("Authorization", "Bearer " + admin[1]))
                .andExpect(status().isNoContent());

        // 移除对「正在使用的 token」无即时失效（MVP 简化），但工作区面立即 403
        mockMvc.perform(get("/api/v1/workspaces/" + wsId).header("Authorization", "Bearer " + member[1]))
                .andExpect(status().isForbidden());

        mockMvc.perform(get("/api/v1/workspaces/" + wsId + "/members")
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(jsonPath("$.length()").value(2));
    }

    /** OWNER 不可移除 → 403 owner_immutable（ADMIN 或 OWNER 自己发起皆然）。 */
    @Test
    void ownerCannotBeRemoved() throws Exception {
        String[] owner = newUser("m-xavier");
        String[] admin = newUser("m-yuri");
        String wsId = createWorkspace(owner[1], "OWNER不可移除");
        putMember(owner[1], wsId, admin[0], "ADMIN");

        mockMvc.perform(delete("/api/v1/workspaces/" + wsId + "/members/" + owner[0])
                        .header("Authorization", "Bearer " + admin[1]))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("owner_immutable"));

        mockMvc.perform(delete("/api/v1/workspaces/" + wsId + "/members/" + owner[0])
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("owner_immutable"));
    }

    /** 非成员目标 → 404 member_not_found；EDITOR/VIEWER/非成员调 DELETE → 403 forbidden。 */
    @Test
    void deleteMemberAuthorizationAndTargetValidation() throws Exception {
        String[] owner = newUser("m-zoe");
        String[] editor = newUser("m-aa");
        String[] viewer = newUser("m-bb");
        String outsider = newUser("m-outsider3")[1];
        String wsId = createWorkspace(owner[1], "DELETE校验");
        putMember(owner[1], wsId, editor[0], "EDITOR");
        putMember(owner[1], wsId, viewer[0], "VIEWER");

        mockMvc.perform(delete("/api/v1/workspaces/" + wsId + "/members/" + viewer[0])
                        .header("Authorization", "Bearer " + editor[1]))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("forbidden"));

        mockMvc.perform(delete("/api/v1/workspaces/" + wsId + "/members/" + viewer[0])
                        .header("Authorization", "Bearer " + outsider))
                .andExpect(status().isForbidden());

        mockMvc.perform(delete("/api/v1/workspaces/" + wsId + "/members/" + outsider)
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("member_not_found"));

        // ADMIN 移除 EDITOR 成功（ADMIN 及以下皆可移）
        putMember(owner[1], wsId, editor[0], "ADMIN");
        mockMvc.perform(delete("/api/v1/workspaces/" + wsId + "/members/" + editor[0])
                        .header("Authorization", "Bearer " + owner[1]))
                .andExpect(status().isNoContent());
    }
}
