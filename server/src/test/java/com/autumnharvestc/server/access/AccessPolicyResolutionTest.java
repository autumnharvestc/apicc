package com.autumnharvestc.server.access;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** Independent real stored-policy inputs reach each resolver branch without an earlier failed write. */
class AccessPolicyResolutionTest extends AccessHttpFixture {
    @Autowired JdbcTemplate jdbc;
    @BeforeEach void storageFixture() {
        jdbc.execute("CREATE TABLE IF NOT EXISTS access_capability_defaults(workspace_id BIGINT NOT NULL,project_id BIGINT NOT NULL,code VARCHAR(64) NOT NULL,mode VARCHAR(16) NOT NULL,PRIMARY KEY(workspace_id,project_id,code))");
        jdbc.execute("CREATE TABLE IF NOT EXISTS access_member_capabilities(workspace_id BIGINT NOT NULL,project_id BIGINT NOT NULL,user_id BIGINT NOT NULL,code VARCHAR(64) NOT NULL,mode VARCHAR(16) NOT NULL,PRIMARY KEY(workspace_id,project_id,user_id,code))");
    }

    // Expected values are literal approved policy precedence; the fixture does not call the resolver to derive them.
    @ParameterizedTest
    @CsvSource({
            "publication.manage,deny,allow,none,none,true",
            "task.execute,allow,deny,none,none,false",
            "task.execute,deny,inherit,none,none,false",
            "publication.manage,deny,none,allow,none,true",
            "publication.manage,deny,deny,none,allow,true",
            "task.execute,allow,allow,allow,deny,false",
            "task.execute,allow,allow,deny,allow,false"
    })
    void independentlyResolvesDefaultAndMemberPrecedence(String code, String workspaceDefault, String projectDefault,
                                                          String workspaceMember, String projectMember, boolean granted) throws Exception {
        Scope f = scope(); member(f, "EDITOR", 0).andExpect(status().isOk());
        long ws = Long.parseLong(f.workspace()), project = Long.parseLong(f.project()), user = Long.parseLong(f.target().id());
        jdbc.update("INSERT INTO access_capability_defaults VALUES(?,?,?,?)", ws, 0, code, workspaceDefault);
        if (!projectDefault.equals("none")) jdbc.update("INSERT INTO access_capability_defaults VALUES(?,?,?,?)", ws, project, code, projectDefault);
        if (!workspaceMember.equals("none")) jdbc.update("INSERT INTO access_member_capabilities VALUES(?,?,?,?,?)", ws, 0, user, code, workspaceMember);
        if (!projectMember.equals("none")) jdbc.update("INSERT INTO access_member_capabilities VALUES(?,?,?,?,?)", ws, project, user, code, projectMember);
        assertThat(access.resolve(user, ws, project).capabilities().stream().map(Capability::code).anyMatch(code::equals))
                .as("effective capability for exact stored policy input").isEqualTo(granted);
    }

    // New role-floor protection is tested after the separately authorized allow resolver exists.
    @ParameterizedTest
    @CsvSource({"default,workspace", "default,project", "member,workspace", "member,project"})
    void explicitAllowCannotCrossEffectiveProjectRoleFloor(String kind, String scope) throws Exception {
        Scope f = scope(); member(f, "VIEWER", 0).andExpect(status().isOk());
        long ws = Long.parseLong(f.workspace()), project = Long.parseLong(f.project()), user = Long.parseLong(f.target().id());
        long policyScope = scope.equals("project") ? project : 0;
        if (kind.equals("default")) jdbc.update("INSERT INTO access_capability_defaults VALUES(?,?,?,?)", ws, policyScope, "publication.manage", "allow");
        else jdbc.update("INSERT INTO access_member_capabilities VALUES(?,?,?,?,?)", ws, policyScope, user, "publication.manage", "allow");
        assertThat(access.resolve(user,ws,project).capabilities()).doesNotContain(Capability.PUBLICATION_MANAGE);
    }
}
