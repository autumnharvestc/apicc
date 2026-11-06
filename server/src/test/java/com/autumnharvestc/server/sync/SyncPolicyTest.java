package com.autumnharvestc.server.sync;
import org.junit.jupiter.api.Test;
import com.fasterxml.jackson.databind.node.ObjectNode;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
class SyncPolicyTest extends SyncHttpFixture {
    @org.springframework.beans.factory.annotation.Autowired com.autumnharvestc.server.collaboration.runtime.RuntimeProperties runtime;
    @Test void emitsActualLargeAndSubminimumDeploymentMetadataForBothScopes() throws Exception {
        int original=runtime.getSourceReadTimeoutMaxMs();var fixture=json.createObjectNode();
        try {
            for(int maximum:new int[]{1800000,300000,1000}) {
                runtime.setSourceReadTimeoutMaxMs(maximum);
                for(String scope:new String[]{"workspace","project"}) {
                    var path=scope.equals("workspace")?f.workspaceUrl()+"/sync/policy":f.projectUrl()+"/sync/policy";
                    var value=body(mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get(path).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk()));
                    assertThat(value.path("deploymentCeilings").path("urlDeadlineMs").asLong()).isEqualTo(maximum);
                    assertThat(value.path("deploymentCeilings").path("gitDeadlineMs").asLong()).isEqualTo(maximum);
                    assertThat(value.path("status").asText()).isEqualTo(maximum==1000?"invalid":"valid");
                    if(maximum==1000){assertThat(value.path("effective").isNull()).isTrue();assertThat(value.path("reasonCode").asText()).isEqualTo("SYNC_POLICY_INVALID");}
                    fixture.set(scope+(maximum==1000?"Low":maximum==300000?"Mid":"High"),value);
                    if(maximum==1800000) {
                        var request=writePolicy(policy(scope,"1").put("gitDeadlineMs",60000));
                        var saved=body(mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put(path).header("Authorization","Bearer "+f.owner().token()).contentType("application/json").content(json.writeValueAsString(request))).andExpect(status().isOk()));
                        assertThat(saved.path("saved").path("revision").asText()).isEqualTo("1");
                        assertThat(saved.path("deploymentCeilings").path("urlDeadlineMs").asLong()).isEqualTo(1800000);
                        fixture.set(scope+"Saved",saved);
                    }
                }
            }
            System.out.println("T14_POLICY_METADATA_FIXTURE "+json.writeValueAsString(fixture));
        } finally {runtime.setSourceReadTimeoutMaxMs(original);}
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"builtin","deny"})
    void editorNeedsManageAndExplicitDenyWins(String kind) throws Exception {
        var request=writePolicy(policy("project","1").put("maxNormalizeDepth",64));
        if(kind.equals("deny")){capabilities(null,java.util.Map.of("sync.manage","allow"));sourceRequest("PUT","/policy",editor(),request).andExpect(status().isOk());capabilities(null,java.util.Map.of("sync.manage","deny"));request=writePolicy(policy("project","2")).put("expectedRevision","1");}
        sourceRequest("PUT","/policy",editor(),request).andExpect(status().isForbidden());
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"stale","intent"})
    void policyCasAndIntentHaveIndependentPersistentIdentity(String kind) throws Exception {
        var request=writePolicy(policy("project","1").put("maxNormalizeDepth",64));
        var first=body(sourceRequest("PUT","/policy",f.owner(),request).andExpect(status().isOk()));
        assertThat(body(sourceRequest("PUT","/policy",f.owner(),request).andExpect(status().isOk()))).isEqualTo(first);
        if(kind.equals("stale"))request=writePolicy(policy("project","1").put("maxNormalizeDepth",32));else ((ObjectNode)request.path("policy")).put("maxNormalizeDepth",32);
        sourceRequest("PUT","/policy",f.owner(),request).andExpect(status().isConflict());
    }
    @Test void trustedScopeCannotBeSelectedInBody() throws Exception {
        sourceRequest("PUT","/policy",f.owner(),writePolicy(policy("workspace","1"))).andExpect(status().isBadRequest());
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"source-input","deadline","git-deadline","concurrency","wire","output-wire"})
    void refusesInvalidCombinedBudgetWithOtherwiseLegalFields(String kind) throws Exception {
        var value=policy("project","1");
        switch(kind){case "source-input"->value.put("maxSourceBytes",5242880).put("maxCompareInputBytes",1048576);case "deadline"->value.put("connectTimeoutMs",10000).put("urlDeadlineMs",5000);case "git-deadline"->value.put("connectTimeoutMs",20000).put("gitDeadlineMs",10000);case "output-wire"->value.put("maxCompareOutputBytes",33554432);case "concurrency"->value.put("projectConcurrency",1).put("hostConcurrency",1);default->value.put("maxCompareInputBytes",33554432);}
        // Give project concurrency a legal upper layer before testing only its cross-field relation.
        if(kind.equals("concurrency")){var upper=writePolicy(policy("workspace","1").put("projectConcurrency",2));mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put(f.workspaceUrl()+"/sync/policy").header("Authorization","Bearer "+f.owner().token()).contentType("application/json").content(json.writeValueAsString(upper))).andExpect(status().isOk());value.put("projectConcurrency",2);}
        if(kind.equals("wire")||kind.equals("output-wire")||kind.equals("git-deadline")){value.put("scope","workspace");mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put(f.workspaceUrl()+"/sync/policy").header("Authorization","Bearer "+f.owner().token()).contentType("application/json").content(json.writeValueAsString(writePolicy(value)))).andExpect(status().isBadRequest());}else sourceRequest("PUT","/policy",f.owner(),writePolicy(value)).andExpect(status().isBadRequest());
    }
    @Test void workspaceCeilingAndExplicitDefaultProvenanceArePreserved() throws Exception {
        var workspace=writePolicy(policy("workspace","1").put("maxNormalizeDepth",64));
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put(f.workspaceUrl()+"/sync/policy").header("Authorization","Bearer "+f.owner().token()).contentType("application/json").content(json.writeValueAsString(workspace))).andExpect(status().isOk());
        sourceRequest("PUT","/policy",f.owner(),writePolicy(policy("project","1").put("maxNormalizeDepth",128))).andExpect(status().isBadRequest());
        var saved=body(sourceRequest("PUT","/policy",f.owner(),writePolicy(policy("project","1").put("maxNormalizeNodes",100000))).andExpect(status().isOk()));
        assertThat(saved.path("effective").path("policy").path("maxNormalizeDepth").asInt()).isEqualTo(64);
        assertThat(saved.path("effective").path("sources").path("maxNormalizeDepth").asText()).isEqualTo("workspace");
        assertThat(saved.path("effective").path("sources").path("maxNormalizeNodes").asText()).isEqualTo("project");
    }
    @Test void policySaveHasARealCallableEntry() throws Exception {
        sourceRequest("PUT","/policy",f.owner(),writePolicy(policy("project","1").put("maxNormalizeDepth",64))).andExpect(status().isOk()).andExpect(jsonPath("$.saved.revision").value("1"));
    }

    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"none","removed","workspace-editor"})
    void policyUsesTheCurrentScopeAuthority(String kind) throws Exception {
        sourceRequest("GET","/policy",editor(),null).andExpect(status().isOk());
        if(kind.equals("workspace-editor")){
            mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put(f.workspaceUrl()+"/access-members/"+editor().id()).header("Authorization","Bearer "+f.owner().token()).contentType("application/json").content("{\"expectedRevision\":1,\"capabilities\":{\"sync.manage\":\"allow\"}}")).andExpect(status().isOk());
            mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put(f.workspaceUrl()+"/sync/policy").header("Authorization","Bearer "+editor().token()).contentType("application/json").content(json.writeValueAsString(writePolicy(policy("workspace","1"))))).andExpect(status().isForbidden());
        }else{
            if(kind.equals("none"))capabilities("NONE",java.util.Map.of("sync.manage","inherit"));
            else mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete(f.workspaceUrl()+"/members/"+editor().id()).param("expectedRevision","1").header("Authorization","Bearer "+f.owner().token())).andExpect(status().isNoContent());
            sourceRequest("GET","/policy",editor(),null).andExpect(status().isForbidden());
        }
    }

    @org.springframework.beans.factory.annotation.Autowired SyncPolicyService policies;
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"view","admission"})
    void laterUpperTighteningPreservesSavedValuesAndRequiresRepair(String kind) throws Exception {
        var upper=writePolicy(policy("workspace","1").put("maxNormalizeDepth",128));
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put(f.workspaceUrl()+"/sync/policy").header("Authorization","Bearer "+f.owner().token()).contentType("application/json").content(json.writeValueAsString(upper))).andExpect(status().isOk());
        var child=policy("project","1").put("maxNormalizeDepth",128);
        sourceRequest("PUT","/policy",f.owner(),writePolicy(child)).andExpect(status().isOk());
        upper=writePolicy(policy("workspace","2").put("maxNormalizeDepth",64)).put("expectedRevision","1");
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put(f.workspaceUrl()+"/sync/policy").header("Authorization","Bearer "+f.owner().token()).contentType("application/json").content(json.writeValueAsString(upper))).andExpect(status().isOk());
        if(kind.equals("admission")){
            org.assertj.core.api.Assertions.assertThatThrownBy(()->policies.requireEffective(Long.parseLong(f.workspace()),Long.parseLong(f.project()))).isInstanceOfSatisfying(com.autumnharvestc.server.core.ApiException.class,e->{assertThat(e.getCode()).isEqualTo("SYNC_POLICY_INVALID");assertThat(e.getStatus().value()).isEqualTo(409);});
        }else{
            var invalid=body(sourceRequest("GET","/policy",f.owner(),null).andExpect(status().isOk()));
            assertThat(invalid.path("saved")).isEqualTo(child);assertThat(invalid.path("status").asText()).isEqualTo("invalid");assertThat(invalid.path("reasonCode").asText()).isEqualTo("SYNC_POLICY_INVALID");assertThat(invalid.path("effective").isNull()).isTrue();assertThat(invalid.path("inherited").path("maxNormalizeDepth").asInt()).isEqualTo(64);assertThat(invalid.path("workspaceRevision").asText()).isEqualTo("2");
            var repaired=body(sourceRequest("PUT","/policy",f.owner(),writePolicy(policy("project","2").put("maxNormalizeDepth",64)).put("expectedRevision","1")).andExpect(status().isOk()));
            assertThat(repaired.path("status").asText()).isEqualTo("valid");assertThat(repaired.path("effective").path("policy").path("maxNormalizeDepth").asInt()).isEqualTo(64);
        }
    }
    @org.springframework.beans.factory.annotation.Autowired org.springframework.jdbc.core.JdbcTemplate jdbc;
    @Test void policyIntentCannotBeReplayedByAnotherOtherwiseAuthorizedActor() throws Exception {
        var request=writePolicy(policy("project","1").put("maxNormalizeDepth",64));sourceRequest("PUT","/policy",f.owner(),request).andExpect(status().isOk());
        capabilities(null,java.util.Map.of("sync.manage","allow"));sourceRequest("PUT","/policy",editor(),request).andExpect(status().isForbidden());
    }
    @Test void concurrentPolicyWritesHaveOneWinner() throws Exception {
        var left=writePolicy(policy("project","1").put("maxNormalizeDepth",64));var right=writePolicy(policy("project","1").put("maxNormalizeDepth",32));
        try(var pool=java.util.concurrent.Executors.newFixedThreadPool(2)){
            var start=new java.util.concurrent.CountDownLatch(1);
            var a=pool.submit(()->{start.await();return sourceRequest("PUT","/policy",f.owner(),left).andReturn().getResponse().getStatus();});
            var b=pool.submit(()->{start.await();return sourceRequest("PUT","/policy",f.owner(),right).andReturn().getResponse().getStatus();});
            start.countDown();assertThat(java.util.List.of(a.get(10,java.util.concurrent.TimeUnit.SECONDS),b.get(10,java.util.concurrent.TimeUnit.SECONDS))).containsExactlyInAnyOrder(200,409);
        }
    }
    @Test void policyMutationIsAuditedOnceWithoutCopyingOverrides() throws Exception {
        var request=writePolicy(policy("project","1").put("maxNormalizeDepth",64));sourceRequest("PUT","/policy",f.owner(),request).andExpect(status().isOk());sourceRequest("PUT","/policy",f.owner(),request).andExpect(status().isOk());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_management_audit WHERE actor_id=? AND scope_type='project' AND scope_id=? AND action='sync.policy.save'",Integer.class,Long.parseLong(f.owner().id()),Long.parseLong(f.project()))).isEqualTo(1);
    }
    @Test void policyNextRevisionMustMatchTheExpectedRevision() throws Exception {
        sourceRequest("PUT","/policy",f.owner(),writePolicy(policy("project","1"))).andExpect(status().isOk());
        sourceRequest("PUT","/policy",f.owner(),writePolicy(policy("project","3")).put("expectedRevision","1")).andExpect(status().isConflict());
    }
    ObjectNode policy(String scope,String revision){return json.createObjectNode().put("formatVersion",1).put("revision",revision).put("scope",scope);}
    ObjectNode writePolicy(ObjectNode value){var request=json.createObjectNode().put("formatVersion",1).put("intentId",java.util.UUID.randomUUID().toString()).put("expectedRevision","0");request.set("policy",value);return request;}
    @Test void exposesDefaultsAndPersistsSparseProjectOverrideWithProvenance() throws Exception {
        var before=body(sourceRequest("GET","/policy",editor(),null).andExpect(status().isOk()));
        assertThat(before.path("effective").path("policy").path("gitDeadlineMs").asLong()).isEqualTo(120000);
        var value=policy("project","1").put("maxNormalizeDepth",64);
        var saved=body(sourceRequest("PUT","/policy",f.owner(),writePolicy(value)).andExpect(status().isOk()));
        assertThat(saved.path("saved")).isEqualTo(value);
        assertThat(saved.path("effective").path("sources").path("maxNormalizeDepth").asText()).isEqualTo("project");
        assertThat(saved.path("effective").path("policy").path("maxNormalizeNodes").asLong()).isEqualTo(100000);
    }
}

@org.springframework.test.context.TestPropertySource(properties={"spring.datasource.url=jdbc:h2:mem:apicc-sync-t7-deployment;DB_CLOSE_DELAY=-1","apicc.sync.ceilings[maxNormalizeDepth]=64","apicc.sync.envelope-reserve-bytes=2097152"})
class SyncDeploymentPolicyTest extends SyncHttpFixture {
    @org.springframework.beans.factory.annotation.Autowired SyncPolicyService.Deployment deployment;
    @Test void deploymentConfigurationReachesEffectivePolicyWithUnitsAndProvenance() throws Exception {
        assertThat(deployment.getCeilings()).containsEntry("maxNormalizeDepth",64L);
        sourceRequest("GET","/policy",editor(),null).andExpect(status().isOk()).andExpect(jsonPath("$.effective.policy.maxNormalizeDepth").value(64)).andExpect(jsonPath("$.effective.sources.maxNormalizeDepth").value("deployment")).andExpect(jsonPath("$.effective.deploymentLimits.envelopeReserveBytes").value(2097152)).andExpect(jsonPath("$.units.maxSourceBytes").value("bytes"));
    }
    @Test void deploymentCeilingRefusesLargerOverride() throws Exception {
        assertThat(deployment.getCeilings()).containsEntry("maxNormalizeDepth",64L);
        var request=json.createObjectNode().put("formatVersion",1).put("intentId",java.util.UUID.randomUUID().toString()).put("expectedRevision","0");
        request.set("policy",json.createObjectNode().put("formatVersion",1).put("revision","1").put("scope","project").put("maxNormalizeDepth",128));
        sourceRequest("PUT","/policy",f.owner(),request).andExpect(status().isBadRequest());
    }
}
