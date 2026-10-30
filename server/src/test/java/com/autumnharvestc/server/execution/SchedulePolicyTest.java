package com.autumnharvestc.server.execution;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import java.util.Map;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.test.context.TestConfiguration;
import com.autumnharvestc.server.execution.scheduling.*;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class SchedulePolicyTest extends ExecutionManagementFixture {
    @org.springframework.beans.factory.annotation.Autowired ScheduleTimeSource time;
    @org.springframework.beans.factory.annotation.Autowired SchedulerProperties scheduler;
    @org.springframework.beans.factory.annotation.Autowired NotificationProperties notification;
    @org.springframework.beans.factory.annotation.Autowired org.springframework.transaction.PlatformTransactionManager transactionManager;
    @Test void timeAuthorityUsesDatabaseStatementUtcInsideTheCurrentTransaction() {
        new org.springframework.transaction.support.TransactionTemplate(transactionManager).execute(status->{
            long before=jdbc.queryForObject("SELECT APICC_SCHEDULER_EPOCH_MILLIS()",Long.class);
            var first=time.now();var second=time.now();
            long after=jdbc.queryForObject("SELECT APICC_SCHEDULER_EPOCH_MILLIS()",Long.class);
            assertThat(first.toEpochMilli()).isBetween(before,after);assertThat(second).isAfterOrEqualTo(first);
            assertThat(second.toEpochMilli()).isBetween(before,after);assertThat(first.getNano()%1000000).isZero();return null;
        });
    }
    @ParameterizedTest @ValueSource(strings={
        "{\"refId\":\"token\",\"mode\":\"current-at-trigger\",\"version\":\"1\"}",
        "{\"refId\":\"token\",\"mode\":\"fixed-version\"}",
        "{\"refId\":\"token\",\"mode\":\"fixed-version\",\"version\":\"9223372036854775808\"}",
        "{\"refId\":\"../token\",\"mode\":\"current-at-trigger\"}"
    }) void credentialBindingsRejectMixedUnfixedOrUnsafeReferences(String input) throws Exception {
        var node=json.readTree(input);assertThatThrownBy(()->ExecutionDtos.decode(node,ScheduleDtos.CredentialBinding.class)).isInstanceOf(com.autumnharvestc.server.core.ApiException.class);
    }
    @Test void temporalPolicyContractRejectsInvalidEnumAndRange() throws Exception {
        var node=json.readTree("{\"lateToleranceMs\":999,\"misfire\":\"all\",\"catchupWindowMs\":300000,\"overlap\":\"skip\",\"queueTimeoutMs\":300000}");
        assertThatThrownBy(()->ExecutionDtos.decode(node,ScheduleDtos.Policies.class)).isInstanceOf(com.autumnharvestc.server.core.ApiException.class);
    }
    @Test void temporalPolicyContractDoesNotTruncateFractionalMilliseconds() throws Exception {
        var node=json.readTree("{\"lateToleranceMs\":10000.5,\"misfire\":\"skip\",\"catchupWindowMs\":300000,\"overlap\":\"skip\",\"queueTimeoutMs\":300000}");
        assertThatThrownBy(()->ExecutionDtos.decode(node,ScheduleDtos.Policies.class)).isInstanceOf(com.autumnharvestc.server.core.ApiException.class);
    }
    @ParameterizedTest @ValueSource(strings={
        "apicc.scheduler.mode=external", "apicc.scheduler.scan-interval-ms=20000", "apicc.scheduler.batch-size=0",
        "apicc.scheduler.evaluation-max-candidates=9", "apicc.scheduler.unknown=1",
        "apicc.notification.request-timeout-ms=30000", "apicc.notification.retry-min-ms=400000",
        "apicc.notification.concurrency=17", "apicc.notification.jitter-ratio=NaN", "apicc.notification.unknown=1"
    }) void deploymentRejectsUnknownModesFieldsAndUnsafeRelations(String property) {
        new ApplicationContextRunner().withUserConfiguration(SchedulePropertiesOnly.class).withPropertyValues(property)
            .run(context->assertThat(context).hasFailed());
    }
    @BeforeEach @org.junit.jupiter.api.AfterEach void resetPolicies(){jdbc.update("DELETE FROM execution_configs WHERE scope_type IN ('schedule-ws','schedule-project')");}
    @Test void policyIsVersionedPersistentAndInheritsWorkspaceRestrictions() throws Exception {
        var f=fixture();String ws="/api/v1/workspaces/"+f.ws()+"/schedule-policy";
        mvc.perform(get(ws).header("Authorization","Bearer "+f.token())).andExpect(status().isOk())
            .andExpect(jsonPath("$.version").value("0")).andExpect(jsonPath("$.effective.maxSchedules").value(1000));
        mvc.perform(put(ws).header("Authorization","Bearer "+f.token()).contentType("application/json")
            .content("{\"expectedVersion\":\"0\",\"policy\":{\"maxSchedules\":40,\"minIntervalMs\":120000}}"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.version").value("1"));
        mvc.perform(get(f.url()+"/schedule-policy").header("Authorization","Bearer "+f.token())).andExpect(status().isOk())
            .andExpect(jsonPath("$.effective.maxSchedules").value(40)).andExpect(jsonPath("$.effective.minIntervalMs").value(120000))
            .andExpect(jsonPath("$.source.minIntervalMs").value("workspace"));
    }
    @ParameterizedTest @ValueSource(strings={"{\"maxSchedules\":10001}","{\"minIntervalMs\":999}","{\"maxQueueTimeoutMs\":1000}","{\"lateToleranceMs\":1000}","{\"misfire\":\"all\"}","{\"maxPendingDeliveries\":10001}","{\"unknown\":1}"})
    void workspaceRejectsRangesUnknownFieldsAndCrossFieldViolations(String policy) throws Exception {
        var f=fixture();mvc.perform(put("/api/v1/workspaces/"+f.ws()+"/schedule-policy").header("Authorization","Bearer "+f.token())
            .contentType("application/json").content("{\"expectedVersion\":\"0\",\"policy\":"+policy+"}"))
            .andExpect(status().isBadRequest());
    }
    @ParameterizedTest @ValueSource(strings={"{\"maxSchedules\":1001}","{\"minIntervalMs\":1000}","{\"maxQueueTimeoutMs\":3600001}","{\"maxPendingDeliveries\":1001}"})
    void projectCannotRelaxInheritedBounds(String policy) throws Exception {
        var f=fixture();mvc.perform(put(f.url()+"/schedule-policy").header("Authorization","Bearer "+f.token())
            .contentType("application/json").content("{\"expectedVersion\":\"0\",\"policy\":"+policy+"}"))
            .andExpect(status().isBadRequest());
    }
    @Test void previewUsesTheInheritedMinimumInterval() throws Exception {
        var f=fixture();mvc.perform(put(f.url()+"/schedule-policy").header("Authorization","Bearer "+f.token()).contentType("application/json")
            .content("{\"expectedVersion\":\"0\",\"policy\":{\"minIntervalMs\":120000}}" )).andExpect(status().isOk());
        mvc.perform(post(f.url()+"/schedules/preview").header("Authorization","Bearer "+f.token()).contentType("application/json")
            .content("{\"rule\":{\"kind\":\"cron\",\"expression\":\"0 * * * * *\",\"timeZone\":\"UTC\",\"dstOverlap\":\"first\"},\"afterUtc\":\"2026-10-29T00:00:00Z\"}"))
            .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("schedule-interval-too-short"));
    }
    @Test void loweredDeploymentBoundsClampPersistedPolicies() throws Exception {
        var f=fixture();String url="/api/v1/workspaces/"+f.ws()+"/schedule-policy";
        mvc.perform(put(url).header("Authorization","Bearer "+f.token()).contentType("application/json")
            .content("{\"expectedVersion\":\"0\",\"policy\":{\"maxSchedules\":500,\"maxPendingDeliveries\":500}}" )).andExpect(status().isOk());
        mvc.perform(put(f.url()+"/schedule-policy").header("Authorization","Bearer "+f.token()).contentType("application/json")
            .content("{\"expectedVersion\":\"0\",\"policy\":{\"lateToleranceMs\":2000}}" )).andExpect(status().isOk());
        long oldSchedules=scheduler.getMaxSchedules(),oldPending=notification.getMaxPendingDeliveries();
        long oldScan=scheduler.getScanIntervalMs();
        try {
            scheduler.setMaxSchedules(50);notification.setMaxPendingDeliveries(20);scheduler.setScanIntervalMs(6000);
            mvc.perform(get(f.url()+"/schedule-policy").header("Authorization","Bearer "+f.token())).andExpect(status().isOk())
                .andExpect(jsonPath("$.effective.maxSchedules").value(50)).andExpect(jsonPath("$.effective.maxPendingDeliveries").value(20))
                .andExpect(jsonPath("$.effective.lateToleranceMs").value(12000))
                .andExpect(jsonPath("$.source.maxSchedules").value("deployment"));
        }finally{scheduler.setMaxSchedules(oldSchedules);notification.setMaxPendingDeliveries(oldPending);scheduler.setScanIntervalMs(oldScan);}
    }
    @ParameterizedTest @ValueSource(strings={"null","{\"misfire\":null}","{\"overlap\":null}"})
    void rejectsNullPolicyInsteadOfServerError(String input) throws Exception {
        var f=fixture();mvc.perform(put(f.url()+"/schedule-policy").header("Authorization","Bearer "+f.token()).contentType("application/json")
            .content("{\"expectedVersion\":\"0\",\"policy\":"+input+"}" )).andExpect(status().isBadRequest());
    }
    String token(com.autumnharvestc.server.store.UserAccount user) throws Exception {
        return body(mvc.perform(post("/api/v1/auth/login").contentType("application/json").content(json.writeValueAsString(Map.of("username",user.username(),"password","password123")))).andExpect(status().isOk())).get("token").asText();
    }
    @Test void readonlyCanPreviewButOnlyEffectiveAdminsCanManagePolicyAndScopeIsChecked() throws Exception {
        var f=fixture();var viewer=member(f,"VIEWER");var editor=member(f,"EDITOR");String viewerToken=token(viewer),editorToken=token(editor);
        String rule="{\"rule\":{\"kind\":\"cron\",\"expression\":\"0 0 9 * * *\",\"timeZone\":\"Asia/Shanghai\",\"dstOverlap\":\"first\"},\"afterUtc\":\"2026-10-29T00:00:00Z\"}";
        long jobs=jdbc.queryForObject("SELECT COUNT(*) FROM execution_jobs",Long.class),configs=jdbc.queryForObject("SELECT COUNT(*) FROM execution_configs",Long.class);
        mvc.perform(post(f.url()+"/schedules/preview").header("Authorization","Bearer "+viewerToken).contentType("application/json").content(rule)).andExpect(status().isOk());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_jobs",Long.class)).isEqualTo(jobs);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_configs",Long.class)).isEqualTo(configs);
        for(String token:java.util.List.of(viewerToken,editorToken)) {
            mvc.perform(get(f.url()+"/schedule-policy").header("Authorization","Bearer "+token)).andExpect(status().isForbidden());
            mvc.perform(put(f.url()+"/schedule-policy").header("Authorization","Bearer "+token).contentType("application/json").content("{\"expectedVersion\":\"0\",\"policy\":{}}" )).andExpect(status().isForbidden());
        }
        jdbc.update("INSERT INTO project_acl(workspace_id,project_id,user_id,role,updated_at) VALUES (?,?,?,'ADMIN',CURRENT_TIMESTAMP)",Long.valueOf(f.ws()),Long.valueOf(f.project()),viewer.id());
        mvc.perform(get(f.url()+"/schedule-policy").header("Authorization","Bearer "+viewerToken)).andExpect(status().isOk());
        mvc.perform(get("/api/v1/workspaces/"+f.ws()+"/schedule-policy").header("Authorization","Bearer "+viewerToken)).andExpect(status().isForbidden());
        String other=body(mvc.perform(post("/api/v1/workspaces").header("Authorization","Bearer "+f.token()).contentType("application/json").content("{\"name\":\"other-schedule-scope\"}" )).andExpect(status().isCreated())).get("id").asText();
        mvc.perform(post("/api/v1/workspaces/"+other+"/projects/"+f.project()+"/schedules/preview").header("Authorization","Bearer "+f.token()).contentType("application/json").content(rule)).andExpect(status().isNotFound());
    }
    @Test void expectedVersionConflictAndParentTighteningPreserveTheEffectiveBounds() throws Exception {
        var f=fixture();String ws="/api/v1/workspaces/"+f.ws()+"/schedule-policy";
        mvc.perform(put(f.url()+"/schedule-policy").header("Authorization","Bearer "+f.token()).contentType("application/json")
            .content("{\"expectedVersion\":\"0\",\"policy\":{\"maxSchedules\":400,\"minIntervalMs\":120000}}" )).andExpect(status().isOk());
        mvc.perform(put(f.url()+"/schedule-policy").header("Authorization","Bearer "+f.token()).contentType("application/json")
            .content("{\"expectedVersion\":\"0\",\"policy\":{\"maxSchedules\":300}}" )).andExpect(status().isConflict());
        mvc.perform(put(ws).header("Authorization","Bearer "+f.token()).contentType("application/json")
            .content("{\"expectedVersion\":\"0\",\"policy\":{\"maxSchedules\":40,\"minIntervalMs\":180000}}" )).andExpect(status().isOk());
        mvc.perform(get(f.url()+"/schedule-policy").header("Authorization","Bearer "+f.token())).andExpect(status().isOk())
            .andExpect(jsonPath("$.effective.maxSchedules").value(40)).andExpect(jsonPath("$.effective.minIntervalMs").value(180000))
            .andExpect(jsonPath("$.explicit.maxSchedules").value(400)).andExpect(jsonPath("$.version").value("1"))
            .andExpect(jsonPath("$.versions.workspace").value("1"));
    }
}

@TestConfiguration(proxyBeanMethods=false)
@EnableConfigurationProperties({SchedulerProperties.class,NotificationProperties.class})
class SchedulePropertiesOnly {}
