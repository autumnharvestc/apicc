package com.autumnharvestc.server.access;

import com.autumnharvestc.server.ApiccServerApplication;
import java.nio.file.Path;
import java.sql.DriverManager;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.init.ScriptUtils;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertAll;

class AccessSchemaUpgradeTest {
    @TempDir Path root;
    private String url(){return "jdbc:h2:file:"+root.resolve("old").toString().replace('\\','/')+";WRITE_DELAY=0";}
    private void oldDatabase() throws Exception {
        try(var connection=DriverManager.getConnection(url(),"sa","")) {
            ScriptUtils.executeSqlScript(connection,new ClassPathResource("access-old-schema.sql"));
        }
    }
    private ConfigurableApplicationContext start(){
        return new SpringApplicationBuilder(ApiccServerApplication.class).web(WebApplicationType.NONE).run(
                "--spring.datasource.url="+url(),"--spring.datasource.username=sa","--spring.datasource.password=",
                "--apicc.server.admin-username=access-old-owner","--apicc.server.admin-password=synthetic-password8",
                "--apicc.server.data-dir="+root.resolve("data"),"--logging.level.root=WARN","--spring.main.banner-mode=off");
    }

    @Test void upgradesOldSchemaWithoutActivatingNonmemberPresetOrDestroyingRows() throws Exception {
        oldDatabase();
        try(var context=start()) {
            var access=context.getBean(ProjectAccessService.class);var jdbc=context.getBean(JdbcTemplate.class);
            assertAll(
                    ()->assertThat(access.resolve(2L,7L,13L).effectiveRole()).contains(com.autumnharvestc.server.core.Role.ADMIN),
                    ()->assertThat(access.resolve(3L,7L,13L).overrideState()).isEqualTo("pending-confirmation"),
                    ()->assertThat(access.resolve(2L,7L,14L).effectiveRole()).isEmpty(),
                    ()->assertThat(jdbc.queryForObject("SELECT name FROM projects WHERE id=13",String.class)).isEqualTo("preserved project"),
                    ()->assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM project_acl WHERE workspace_id=7",Integer.class)).isEqualTo(3));
        }
    }

    @Test void restartNeverResetsPendingRevisionOrPersistentEpoch() throws Exception {
        oldDatabase(); long epoch; long revision;
        try(var context=start()) {
            var member=context.getBean(com.autumnharvestc.server.workspace.MemberService.class);
            var users=context.getBean(com.autumnharvestc.server.store.UserRepo.class);
            var access=context.getBean(ProjectAccessService.class);
            member.delete(users.findById(1L).orElseThrow(),"7","2","1");
            var decision=access.resolve(2L,7L,13L);
            epoch=decision.membershipEpoch();revision=decision.accessRevision();
            assertThat(epoch).as("actual mutation must persist an epoch before restart is meaningful").isGreaterThan(0);
        }
        try(var context=start()) {
            var decision=context.getBean(ProjectAccessService.class).resolve(2L,7L,13L);
            assertThat(decision.overrideState()).isEqualTo("pending-confirmation");
            assertThat(decision.membershipEpoch()).isEqualTo(epoch);
            assertThat(decision.accessRevision()).isEqualTo(revision);
            assertThat(decision.effectiveRole()).isEmpty();
        }
    }
}
