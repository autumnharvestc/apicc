package com.autumnharvestc.server.execution;

import com.autumnharvestc.server.ApiccServerApplication;
import com.autumnharvestc.server.execution.agent.AgentService;
import com.autumnharvestc.server.execution.config.ExecutionConfigService;
import com.autumnharvestc.server.store.UserRepo;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.core.env.SystemEnvironmentPropertySource;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ExecutionDeploymentRestartTest {
    @TempDir Path root;

    // Catches deployment defaults changing effective values while a persisted applied version stays unchanged.
    @Test void environmentDefaultsAreVersionedAcrossRealBinderAndDatabaseRestart() {
        String agentId;
        String originalPolicyVersion;
        try (var context = start(Map.of())) {
            var admin = context.getBean(UserRepo.class).findByUsername("restart-admin").orElseThrow();
            agentId = String.valueOf(context.getBean(AgentService.class).create(admin, "restart-synthetic").id());
            var configs = context.getBean(ExecutionConfigService.class);
            configs.saveAgent(admin, agentId, "0", Map.of("maxConcurrentJobs", 2));
            configs.acknowledge(Long.parseLong(agentId), "1", "1", List.of(), List.of());
            assertThat(configs.agentState(Long.parseLong(agentId))).containsEntry("status", "applied");
            originalPolicyVersion = configs.policyVersion();
        }
        String changedVersion;
        String changedPolicyVersion;
        var changedEnvironment = Map.<String,Object>of("APICC_EXECUTION_AGENT_CHILDMAXOLDSPACEMIB", "128", "APICC_EXECUTION_AGENT_MAXCONCURRENTJOBS", "3", "APICC_EXECUTION_POLICY_SCRIPTTIMEOUTMS", "2500");
        try (var context = start(changedEnvironment)) {
            var configs = context.getBean(ExecutionConfigService.class);
            var actual = configs.agentState(Long.parseLong(agentId));
            assertThat(((Number)((Map<?,?>)actual.get("config")).get("childMaxOldSpaceMiB")).intValue()).isEqualTo(128);
            assertThat(((Number)((Map<?,?>)actual.get("config")).get("maxConcurrentJobs")).intValue()).isEqualTo(2);
            changedVersion = actual.get("configVersion").toString();
            changedPolicyVersion = configs.policyVersion();
            assertThat(context.getBean(ExecutionProperties.class).getPolicy().getScriptTimeoutMs()).isEqualTo(2500);
            org.assertj.core.api.SoftAssertions.assertSoftly(softly -> {
                softly.assertThat(actual.get("configVersion")).isNotEqualTo("1");
                softly.assertThat(configs.policyVersion()).isNotEqualTo(originalPolicyVersion);
            });
            assertThat(actual).containsEntry("appliedConfigVersion", "1").containsEntry("status", "pending");
            assertThat(((List<?>)actual.get("pendingFields")).contains("childMaxOldSpaceMiB")).isTrue();
            var delivery = configs.configurationForDelivery(Long.parseLong(agentId));
            assertThat(delivery).containsEntry("configVersion", changedVersion);
            assertThat(((Number)((Map<?,?>)delivery.get("config")).get("childMaxOldSpaceMiB")).intValue()).isEqualTo(128);
            configs.acknowledge(Long.parseLong(agentId), changedVersion, changedVersion, List.of(), List.of());
        }
        try (var context = start(changedEnvironment)) {
            var configs = context.getBean(ExecutionConfigService.class);
            assertThat(configs.agentState(Long.parseLong(agentId)))
                .containsEntry("configVersion", changedVersion).containsEntry("appliedConfigVersion", changedVersion).containsEntry("status", "applied");
            assertThat(configs.policyVersion()).isEqualTo(changedPolicyVersion);
        }
    }

    // A lower deployment ceiling must restrict new intake, not prevent recovery of the control service.
    @Test void loweredDeploymentCeilingPreservesExplicitConfigurationAndControlDelivery() {
        String agentId;
        try (var context = start(Map.of("APICC_EXECUTION_DEPLOYMENT_MAXAGENTCONCURRENTJOBS", "32"))) {
            assertThat(context.getBean(ExecutionProperties.class).getDeployment().getMaxAgentConcurrentJobs()).isEqualTo(32);
            var admin = context.getBean(UserRepo.class).findByUsername("restart-admin").orElseThrow();
            agentId = String.valueOf(context.getBean(AgentService.class).create(admin, "ceiling-synthetic").id());
            var configs = context.getBean(ExecutionConfigService.class);
            configs.saveAgent(admin, agentId, "0", Map.of("maxConcurrentJobs", 2));
            configs.acknowledge(Long.parseLong(agentId), "1", "1", List.of(), List.of());
        }
        assertThatCode(() -> {
            try (var context = start(Map.of("APICC_EXECUTION_DEPLOYMENT_MAXAGENTCONCURRENTJOBS", "1"))) {
                assertThat(context.getBean(ExecutionProperties.class).getDeployment().getMaxAgentConcurrentJobs()).isEqualTo(1);
                var configs = context.getBean(ExecutionConfigService.class);
                var state = configs.agentState(Long.parseLong(agentId));
                assertThat(((Map<?,?>)state.get("explicit")).get("maxConcurrentJobs")).isEqualTo(2);
                assertThat(((Number)((Map<?,?>)state.get("config")).get("maxConcurrentJobs")).intValue()).isEqualTo(1);
                assertThat((List<?>)state.get("restrictions")).anySatisfy(value -> {
                    assertThat(((Map<?,?>)value).get("field")).isEqualTo("agent.maxConcurrentJobs");
                    assertThat(((Map<?,?>)value).get("reason")).isEqualTo("deployment.maxAgentConcurrentJobs");
                });
                var delivery = configs.configurationForDelivery(Long.parseLong(agentId));
                assertThat(((Number)((Map<?,?>)delivery.get("config")).get("maxConcurrentJobs")).intValue()).isEqualTo(1);
                assertThat(delivery.get("configVersion")).isNotEqualTo("1");
                assertThat(state).containsEntry("appliedConfigVersion", "1").containsEntry("status", "pending");
                assertThat(context.getBean(com.autumnharvestc.server.execution.jobs.RunnerControlService.class).pollWaitMs(Long.parseLong(agentId))).isPositive();
                var admin = context.getBean(UserRepo.class).findByUsername("restart-admin").orElseThrow();
                assertThatThrownBy(() -> configs.saveAgent(admin, agentId, delivery.get("configVersion").toString(), Map.of("maxConcurrentJobs", 2)))
                    .isInstanceOf(com.autumnharvestc.server.core.ApiException.class);
            }
        }).doesNotThrowAnyException();
    }

    private ConfigurableApplicationContext start(Map<String,Object> variables) {
        var environment = new StandardEnvironment();
        environment.getPropertySources().replace(StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME,
            new SystemEnvironmentPropertySource(StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME, variables));
        return new SpringApplicationBuilder(ApiccServerApplication.class).environment(environment).web(WebApplicationType.NONE).run(
            "--spring.datasource.url=jdbc:h2:file:" + root.resolve("metadata").toString().replace('\\','/'),
            "--apicc.server.data-dir=" + root.resolve("data"),
            "--apicc.server.admin-username=restart-admin", "--apicc.server.admin-password=synthetic-password8",
            "--logging.level.root=WARN", "--spring.main.banner-mode=off");
    }
}
