package com.autumnharvestc.server.execution;

import com.autumnharvestc.server.core.ApiException;
import com.autumnharvestc.server.execution.config.ExecutionConfigService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import java.util.Map;
import static org.assertj.core.api.Assertions.*;

class ExecutionConfigTest extends ExecutionManagementFixture {
    @Autowired ExecutionConfigService configs;
    @Autowired ExecutionProperties properties;
    @Autowired com.autumnharvestc.server.execution.agent.AgentService agents;
    @org.springframework.test.context.bean.override.mockito.MockitoSpyBean
    com.autumnharvestc.server.execution.agent.AgentRepo observedAgents;
    @Test void persistsTwoTaskSlotsWithoutClaimingAgentAppliedThem() throws Exception {
        var f=fixture();
        configs.saveAgent(f.admin(),f.agent(),"0",Map.of("maxConcurrentJobs",2));
        var saved=configs.agent(f.admin(),f.agent());
        assertThat(((Map<?,?>)saved.get("config")).get("maxConcurrentJobs")).isEqualTo(2);
        assertThat(saved).containsEntry("configVersion","1").containsEntry("appliedConfigVersion","0").containsEntry("status","pending");
    }
    @Test void sameVersionConflictCannotOverwriteAnotherAdministrator() throws Exception {
        var f=fixture();
        configs.saveAgent(f.admin(),f.agent(),"0",Map.of("maxConcurrentJobs",2));
        assertThatThrownBy(() -> configs.saveAgent(f.admin(),f.agent(),"0",Map.of("maxConcurrentJobs",3)))
            .isInstanceOf(ApiException.class).hasMessageContaining("版本");
        assertThat(((Map<?,?>)configs.agent(f.admin(),f.agent()).get("config")).get("maxConcurrentJobs")).isEqualTo(2);
    }
    @Test void projectAdminCannotChangeGlobalNodeConcurrency() throws Exception {
        var f=fixture(); var member=member(f,"ADMIN");
        assertThatThrownBy(() -> configs.saveAgent(member,f.agent(),"0",Map.of("maxConcurrentJobs",2)))
            .isInstanceOf(ApiException.class).hasMessageContaining("超管");
    }
    @Test void rejectsInvalidHeartbeatAndControlTimeoutCombinations() throws Exception {
        var f=fixture();
        org.assertj.core.api.SoftAssertions.assertSoftly(softly -> {
            softly.assertThatThrownBy(() -> configs.saveAgent(f.admin(),f.agent(),"0",Map.of("heartbeatIntervalMs",30000,"offlineAfterMs",10000))).isInstanceOf(ApiException.class);
            softly.assertThatThrownBy(() -> configs.saveAgent(f.admin(),f.agent(),"0",Map.of("longPollWaitMs",40000,"controlRequestTimeoutMs",42000))).isInstanceOf(ApiException.class);
            softly.assertThatThrownBy(() -> configs.saveAgent(f.admin(),f.agent(),"0",Map.of("workerUnresponsiveAfterMs",11000))).isInstanceOf(ApiException.class);
            softly.assertThatThrownBy(() -> configs.saveAgent(f.admin(),f.agent(),"0",Map.of("maxConcurrentJobs",33))).isInstanceOf(ApiException.class);
            softly.assertThatThrownBy(() -> configs.saveAgent(f.admin(),f.agent(),"0",Map.of("inputCacheBytes",1))).isInstanceOf(ApiException.class);
            softly.assertThatThrownBy(() -> configs.saveAgent(f.admin(),f.agent(),"0",Map.of("pendingResultBytes",1048577))).isInstanceOf(ApiException.class);
            softly.assertThatThrownBy(() -> configs.saveAgent(f.admin(),f.agent(),"0",Map.of("heartbeatIntervalMs",2147483648L))).isInstanceOf(ApiException.class);
            softly.assertThatThrownBy(() -> configs.saveAgent(f.admin(),f.agent(),configs.agent(f.admin(),f.agent()).get("configVersion").toString(),Map.of("faultReserveBytes",1))).isInstanceOf(ApiException.class);
            softly.assertThatThrownBy(() -> configs.saveAgent(f.admin(),f.agent(),configs.agent(f.admin(),f.agent()).get("configVersion").toString(),Map.of("maxConcurrentJobs",2,"faultReserveBytes",2047))).isInstanceOf(ApiException.class);
        });
        configs.saveAgent(f.admin(),f.agent(),configs.agent(f.admin(),f.agent()).get("configVersion").toString(),Map.of("maxConcurrentJobs",2,"faultReserveBytes",2048));
    }
    @Test void projectCannotEnlargeInheritedExecutionBudgetOrInjectAgentFields() throws Exception {
        var f=fixture();
        org.assertj.core.api.SoftAssertions.assertSoftly(softly -> {
            softly.assertThatThrownBy(() -> configs.saveProject(f.admin(),f.ws(),f.project(),"0",Map.of("maxJobTimeoutMs",86400001))).isInstanceOf(ApiException.class);
            softly.assertThatThrownBy(() -> configs.saveProject(f.admin(),f.ws(),f.project(),"0",Map.of("maxConcurrentJobs",2))).isInstanceOf(ApiException.class);
            softly.assertThatThrownBy(() -> configs.saveProject(f.admin(),f.ws(),f.project(),"0",Map.of("reportBytes",1023,"bodyPreviewBytes",1,"valuePreviewBytes",1,"caseEvidenceBytes",1,"workflowMetadataBytes",1))).isInstanceOf(ApiException.class);
        });
    }
    @Test void appliedAcknowledgementIsPersistedSeparatelyAndCannotClaimFutureConfiguration() throws Exception {
        var f=fixture();configs.saveAgent(f.admin(),f.agent(),"0",Map.of("maxConcurrentJobs",2));
        configs.acknowledge(Long.parseLong(f.agent()),"1","1",java.util.List.of(),java.util.List.of());
        var acknowledged=configs.agent(f.admin(),f.agent());
        org.assertj.core.api.SoftAssertions.assertSoftly(softly -> {
            softly.assertThat(acknowledged).containsEntry("appliedConfigVersion","1").containsEntry("status","applied");
            softly.assertThatThrownBy(() -> configs.acknowledge(Long.parseLong(f.agent()),"2","2",java.util.List.of(),java.util.List.of())).isInstanceOf(ApiException.class);
        });
        configs.saveAgent(f.admin(),f.agent(),"1",Map.of("childMaxOldSpaceMiB",512));
        configs.acknowledge(Long.parseLong(f.agent()),"2","1",java.util.List.of("childMaxOldSpaceMiB"),java.util.List.of("childMaxOldSpaceMiB"));
        assertThat(configs.agent(f.admin(),f.agent())).containsEntry("status","restart-required").containsEntry("appliedConfigVersion","1");
        assertThat(configs.configurationForDelivery(Long.parseLong(f.agent())).get("configVersion")).isEqualTo("2");
        assertThat(configs.agent(f.admin(),f.agent()).get("appliedConfigVersion")).isEqualTo("1");
    }
    @Test void projectPolicyActuallyLimitsSnapshotCreation() throws Exception {
        var f=fixture();configs.saveProject(f.admin(),f.ws(),f.project(),"0",Map.of("snapshotBytes",1));
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put(f.url()+"/assets").header("Authorization","Bearer "+f.token()).contentType("application/json")
            .content("{\"format\":\"contract-files-v1\",\"contractProjectId\":\"00000000-0000-4000-8000-000000000018\",\"expectedVersion\":\"0\",\"changes\":[{\"path\":\"project.yaml\",\"content\":\"ab\"}],\"deletes\":[]}"))
            .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.status().isOk());
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post(f.url()+"/execution-snapshots").header("Authorization","Bearer "+f.token()).contentType("application/json").content("{\"expectedVersion\":\"1\"}"))
            .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.status().isBadRequest()).andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath("$.code").value("snapshot_size_limit"));
    }
    @Test void inheritedPolicyReturnsProtocolVersionAndDefaultSources() throws Exception {
        var f=fixture();configs.saveWorkspace(f.admin(),f.ws(),"0",Map.of("maxJobTimeoutMs",6000));
        var effective=configs.project(f.admin(),f.ws(),f.project(),null);
        org.assertj.core.api.SoftAssertions.assertSoftly(softly -> {
            softly.assertThat(effective.get("policyVersion").toString()).matches("0|[1-9][0-9]*");
            softly.assertThat(((Map<?,?>)effective.get("sources")).get("policy.maxQueuedJobs")).isEqualTo("default");
            softly.assertThat(((Number)((Map<?,?>)effective.get("policy")).get("defaultJobTimeoutMs")).longValue()).isEqualTo(6000L);
        });
    }
    @Test void perAgentQueueCeilingIsPersistedAndProjectCannotEnlargeIt() throws Exception {
        var f=fixture();configs.saveAgentPolicy(f.admin(),f.agent(),"0",Map.of("maxQueuedJobs",20));
        var effective=configs.effective(Long.parseLong(f.agent()),Long.parseLong(f.ws()),Long.parseLong(f.project()),Map.of());
        org.assertj.core.api.SoftAssertions.assertSoftly(softly -> {
            softly.assertThat(((Number)((Map<?,?>)effective.get("queueLimits")).get("agent")).longValue()).isEqualTo(20);
            softly.assertThatThrownBy(() -> { configs.saveProject(f.admin(),f.ws(),f.project(),"0",Map.of("maxQueuedJobs",30)); configs.effective(Long.parseLong(f.agent()),Long.parseLong(f.ws()),Long.parseLong(f.project()),Map.of()); }).isInstanceOf(ApiException.class);
        });
    }
    @Test void projectAssetChangePolicyActuallyLimitsAtomicPublication() throws Exception {
        var f=fixture();configs.saveProject(f.admin(),f.ws(),f.project(),"0",Map.of("maxAssetChangeFiles",1));
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put(f.url()+"/assets").header("Authorization","Bearer "+f.token()).contentType("application/json")
            .content("{\"format\":\"contract-files-v1\",\"contractProjectId\":\"00000000-0000-4000-8000-000000000018\",\"expectedVersion\":\"0\",\"changes\":[{\"path\":\"a\",\"content\":\"a\"},{\"path\":\"b\",\"content\":\"b\"}],\"deletes\":[]}"))
            .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.status().isBadRequest()).andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath("$.code").value("asset_change_limit"));
    }
    @Test void deploymentBootstrapAgentValuesAcceptConfigurationPropertyScalars() throws Exception {
        var f=fixture();
        // ConfigurationProperties Map<String,Object> receives textual environment/property values.
        properties.getAgent().put("max-concurrent-jobs","2");
        try { assertThatCode(() -> {
            var actual=configs.agent(f.admin(),f.agent());
            assertThat(((Number)((Map<?,?>)actual.get("config")).get("maxConcurrentJobs")).longValue()).isEqualTo(2);
            assertThat(((Map<?,?>)actual.get("sources")).get("maxConcurrentJobs")).isEqualTo("deployment");
        }).doesNotThrowAnyException(); } finally {properties.getAgent().remove("max-concurrent-jobs");}
    }
    @Test void projectQueueCanUsePersistedAgentCeilingAboveInitialDefault() throws Exception {
        var f=fixture();
        agents.grantWorkspaces(f.admin(),f.agent(),java.util.List.of(f.ws()));
        agents.allocate(f.admin(),f.ws(),f.agent(),java.util.List.of(f.project()));
        agents.associate(f.admin(),f.ws(),f.project(),java.util.List.of(f.agent()),f.agent());
        configs.saveAgentPolicy(f.admin(),f.agent(),"0",Map.of("maxQueuedJobs",200));
        assertThatCode(() -> configs.saveProject(f.admin(),f.ws(),f.project(),"0",Map.of("maxQueuedJobs",150)))
            .doesNotThrowAnyException();
        assertThat(((Number)((Map<?,?>)configs.project(f.admin(),f.ws(),f.project(),null).get("policy")).get("maxQueuedJobs")).longValue()).isEqualTo(150);
        assertThat(((Number)configs.policyForProject(Long.parseLong(f.ws()),Long.parseLong(f.project())).get("maxQueuedJobs")).longValue()).isEqualTo(150);
        var selected=configs.effective(Long.parseLong(f.agent()),Long.parseLong(f.ws()),Long.parseLong(f.project()),Map.of());
        assertThat(((Number)((Map<?,?>)selected.get("queueLimits")).get("agent")).longValue()).isEqualTo(200);
    }
    @Test void deliveryAndManagementBindVersionAndValuesDuringConcurrentSave() throws Exception {
        var f=fixture();long agent=Long.parseLong(f.agent());
        configs.saveAgent(f.admin(),f.agent(),"0",Map.of("maxConcurrentJobs",2));
        org.assertj.core.api.SoftAssertions.assertSoftly(softly -> {
            for(int step=1;step<=2;step++) {
                String oldVersion=String.valueOf(step);int oldSlots=step+1;
                configs.acknowledge(agent,oldVersion,oldVersion,java.util.List.of(),java.util.List.of());
                var firstRead=new java.util.concurrent.CountDownLatch(1);
                var writerCommitted=new java.util.concurrent.CountDownLatch(1);
                var readerThread=new java.util.concurrent.atomic.AtomicReference<Thread>();
                var paused=new java.util.concurrent.atomic.AtomicBoolean();
                org.mockito.Mockito.doAnswer(invocation -> {
                    var actual=invocation.callRealMethod();
                    if(Thread.currentThread()==readerThread.get()&&paused.compareAndSet(false,true)) {
                        firstRead.countDown();
                        if(!writerCommitted.await(10,java.util.concurrent.TimeUnit.SECONDS))throw new AssertionError("concurrent save did not commit");
                    }
                    return actual;
                }).when(observedAgents).config("agent",agent);
                boolean management=step==2;
                try(var pool=java.util.concurrent.Executors.newFixedThreadPool(1)) {
                    var read=pool.submit(() -> {readerThread.set(Thread.currentThread());return management?configs.agent(f.admin(),f.agent()):configs.configurationForDelivery(agent);});
                    try {
                        assertThat(firstRead.await(10,java.util.concurrent.TimeUnit.SECONDS)).isTrue();
                        configs.saveAgent(f.admin(),f.agent(),oldVersion,Map.of("maxConcurrentJobs",oldSlots+1));
                    } finally {writerCommitted.countDown();}
                    var actual=read.get(10,java.util.concurrent.TimeUnit.SECONDS);
                    softly.assertThat(actual.get("configVersion")).isEqualTo(oldVersion);
                    softly.assertThat(((Number)((Map<?,?>)actual.get("config")).get("maxConcurrentJobs")).longValue()).isEqualTo(oldSlots);
                    if(management)softly.assertThat(actual).containsEntry("status","applied").containsEntry("appliedConfigVersion",oldVersion);
                } catch(Exception ex) {throw new RuntimeException(ex);}
                finally {org.mockito.Mockito.doCallRealMethod().when(observedAgents).config("agent",agent);}
            }
        });
    }
}
