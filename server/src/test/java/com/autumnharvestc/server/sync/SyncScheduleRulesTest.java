package com.autumnharvestc.server.sync;

import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class SyncScheduleRulesTest extends SyncScheduleHttpFixture {
    com.fasterxml.jackson.databind.node.ObjectNode scheduleRequest(com.fasterxml.jackson.databind.JsonNode source,String generation){
        var request=json.createObjectNode().put("formatVersion",1).put("expectedSourceRevision",source.path("revision").asText()).put("expectedGeneration",generation).put("enabled",true);
        request.set("rule",source.path("schedule").path("rule"));return request;
    }
    @Test void previewUsesExplicitUtcIanaDstAndTheActualBudget() throws Exception {
        var source=createUrlSource("/valid");checkToCandidate(source);
        var route="/sources/"+source.path("id").asText()+"/schedule/preview";
        var request=json.createObjectNode().put("formatVersion",1).put("afterUtc","2026-11-01T00:00:00Z");
        request.set("rule",json.createObjectNode().put("kind","cron").put("expression","0 30 1 * * *").put("timeZone","America/New_York").put("dstOverlap","both"));
        sourceRequest("POST",route,f.owner(),request).andExpect(status().isOk())
            .andExpect(jsonPath("$.candidates[0].plannedAtUtc").value("2026-11-01T05:30:00Z"))
            .andExpect(jsonPath("$.candidates[1].plannedAtUtc").value("2026-11-01T06:30:00Z"))
            .andExpect(jsonPath("$.limits.minIntervalMs").value(60000));
        ((com.fasterxml.jackson.databind.node.ObjectNode)request.path("rule")).put("expression","0 30 2 * * *").put("dstOverlap","first");request.put("afterUtc","2027-03-14T00:00:00Z");
        sourceRequest("POST",route,f.owner(),request).andExpect(status().isOk()).andExpect(jsonPath("$.notices[0]").value("dst-gap-skipped"));
    }
    @Test void defaultOffAndExplicitCurrentActorGrantUseHourlyUtc() throws Exception {
        var source=createUrlSource("/valid");
        assertThat(checkToCandidate(source).path("candidate").path("id").asText()).isNotBlank();
        var route="/sources/"+source.path("id").asText()+"/schedule";
        sourceRequest("GET",route,f.owner(),null).andExpect(status().isOk())
            .andExpect(jsonPath("$.enabled").value(false)).andExpect(jsonPath("$.generation").value("0"));
        var request=json.createObjectNode().put("formatVersion",1).put("expectedSourceRevision","1").put("expectedGeneration","0").put("enabled",true);
        request.set("rule",source.path("schedule").path("rule"));
        sourceRequest("PUT",route,f.owner(),request).andExpect(status().isOk())
            .andExpect(jsonPath("$.subjectUserId").value(f.owner().id())).andExpect(jsonPath("$.generation").value("1"))
            .andExpect(jsonPath("$.enabled").value(true)).andExpect(jsonPath("$.sourceRevision").value("2"));
    }
    @Test void rawSourceCannotEstablishAnImplicitBackgroundGrant() throws Exception {
        var source=createUrlSource("/valid");checkToCandidate(source);
        var request=sourceUpdateBody(source).put("expectedAssetVersion","2");
        ((com.fasterxml.jackson.databind.node.ObjectNode)request.path("source").path("schedule")).put("enabled",true);
        sourceRequest("PUT","/sources/"+source.path("id").asText(),f.owner(),request)
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("SYNC_SCHEDULE_GRANT_REQUIRED"));
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings={"source-cas","grant-cas","extra-subject","extra-field","bad-version","missing-enabled"})
    void grantMutationIsStrictAndVersioned(String variant) throws Exception {
        var source=createUrlSource("/valid");checkToCandidate(source);
        var route="/sources/"+source.path("id").asText()+"/schedule";
        sourceRequest("PUT",route,f.owner(),scheduleRequest(source,"0")).andExpect(status().isOk());
        var current=readSourceAsAdmin(source.path("id").asText());var request=scheduleRequest(current,"1");
        int expected=400;
        switch(variant){
            case "source-cas"->{request.put("expectedSourceRevision","1");expected=409;}
            case "grant-cas"->{request.put("expectedGeneration","0");expected=409;}
            case "extra-subject"->request.put("subjectUserId",editor().id());
            case "extra-field"->request.put("secret","not-accepted");
            case "bad-version"->request.put("formatVersion",4294967297L);
            case "missing-enabled"->request.remove("enabled");
        }
        sourceRequest("PUT",route,f.owner(),request).andExpect(status().is(expected));
        sourceRequest("GET",route,f.owner(),null).andExpect(status().isOk()).andExpect(jsonPath("$.generation").value("1"));
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings={"manage","check"})
    void backgroundGrantNeedsBothManagementAndCheckPermission(String variant) throws Exception {
        var source=createUrlSource("/valid");checkToCandidate(source);
        capabilities(null,java.util.Map.of("sync.manage","allow"));
        var route="/sources/"+source.path("id").asText()+"/schedule";
        sourceRequest("PUT",route,editor(),scheduleRequest(source,"0")).andExpect(status().isOk());
        var current=readSourceAsAdmin(source.path("id").asText());
        capabilities(null,java.util.Map.of("sync."+variant,"deny"));
        sourceRequest("PUT",route,editor(),scheduleRequest(current,"1")).andExpect(status().isForbidden());
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings={"frequency","zone","overlap","once","extra","utc"})
    void ruleGuardRunsOnAnOtherwiseLegalPreview(String variant) throws Exception {
        var source=createUrlSource("/valid");checkToCandidate(source);
        var route="/sources/"+source.path("id").asText()+"/schedule/preview";
        var request=json.createObjectNode().put("formatVersion",1).put("afterUtc","2026-11-01T00:00:00Z");
        request.set("rule",source.path("schedule").path("rule").deepCopy());
        sourceRequest("POST",route,f.owner(),request).andExpect(status().isOk());
        var rule=(com.fasterxml.jackson.databind.node.ObjectNode)request.path("rule");
        switch(variant){
            case "frequency"->rule.put("expression","* * * * * *");
            case "zone"->rule.put("timeZone","+08:00");
            case "overlap"->rule.remove("dstOverlap");
            case "once"->{rule.removeAll();rule.put("kind","once").put("atUtc","2026-11-01T01:00:00Z").put("timeZone","UTC");}
            case "extra"->rule.put("credential","not-accepted");
            case "utc"->request.put("afterUtc","2026-11-01T08:00:00+08:00");
        }
        sourceRequest("POST",route,f.owner(),request).andExpect(status().isBadRequest());
    }
    @Test void savingARuleRechecksTheSameMinimumInterval() throws Exception {
        var source=createUrlSource("/valid");checkToCandidate(source);var route="/sources/"+source.path("id").asText()+"/schedule";
        sourceRequest("PUT",route,f.owner(),scheduleRequest(source,"0")).andExpect(status().isOk());
        var request=scheduleRequest(readSourceAsAdmin(source.path("id").asText()),"1");
        ((com.fasterxml.jackson.databind.node.ObjectNode)request.path("rule")).put("expression","* * * * * *");
        sourceRequest("PUT",route,f.owner(),request).andExpect(status().isBadRequest());
    }
}
