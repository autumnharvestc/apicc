package com.autumnharvestc.server.workspace;

import com.autumnharvestc.server.store.GroupRecord;
import com.autumnharvestc.server.store.GroupRepo;
import com.autumnharvestc.server.store.MembershipRepo;
import com.autumnharvestc.server.store.WorkspaceRepo;
import com.jayway.jsonpath.JsonPath;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * create 事务原子性测试（审查修复验证：计划「事务内建区 + 默认分组行」）。
 * 手法：@MockitoSpyBean 令 GroupRepo.insert 抛 RuntimeException（模拟第三次 DB 写的基础设施错误），
 * 真实库走真实 SQL——断言前两次写（工作区行/OWNER 成员行）被事务一并回滚，不残留「有工作区、无默认分组」半状态。
 * 独立内存库名，不触碰其他测试类上下文。
 */
@SpringBootTest
@AutoConfigureMockMvc
@TestPropertySource(properties = {
        "apicc.server.allow-registration=true",
        "spring.datasource.url=jdbc:h2:mem:apicc-ws-tx-test;DB_CLOSE_DELAY=-1"
})
class WorkspaceCreateTransactionTest {

    @Autowired
    private MockMvc mockMvc;

    @MockitoSpyBean
    private GroupRepo groupRepo;

    @Autowired
    private WorkspaceRepo workspaces;

    @Autowired
    private MembershipRepo memberships;

    private String registerAndLogin(String username) throws Exception {
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
        return JsonPath.read(result.getResponse().getContentAsString(), "$.token");
    }

    /** 默认分组落库失败 → create 三行同事务：工作区行与成员行一并回滚（500 internal_error）。 */
    @Test
    void createRollsBackAllRowsWhenGroupInsertFails() throws Exception {
        String token = registerAndLogin("ws-tx-owner");
        // 经 doAnswer 捕获本次注入路径上的默认分组行再抛错（打桩前的 seeder 启动调用不入捕获）
        AtomicReference<GroupRecord> attempted = new AtomicReference<>();
        doAnswer(invocation -> {
            attempted.set(invocation.getArgument(0, GroupRecord.class));
            throw new RuntimeException("模拟默认分组落库失败（基础设施错误）");
        }).when(groupRepo).insert(any());

        mockMvc.perform(post("/api/v1/workspaces")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"tx-ws\"}"))
                .andExpect(status().isInternalServerError())
                .andExpect(jsonPath("$.code").value("internal_error"));

        long wsId = attempted.get().workspaceId();
        assertThat(workspaces.findById(wsId)).isEmpty();
        assertThat(memberships.countByWorkspace(wsId)).isZero();
        assertThat(groupRepo.listByWorkspace(wsId)).isEmpty();
    }
}
