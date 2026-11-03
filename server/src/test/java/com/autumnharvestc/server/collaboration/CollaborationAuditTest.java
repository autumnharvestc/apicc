package com.autumnharvestc.server.collaboration;

import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT)
@TestPropertySource(properties={"spring.datasource.url=jdbc:h2:mem:apicc-t8-audit;DB_CLOSE_DELAY=-1", "server.address=127.0.0.1", "apicc.collaboration.policy.defaults.external-sharing-allowed=true", "apicc.collaboration.policy.defaults.shared-mock-allowed=true", "apicc.collaboration.public-access.enabled=true"})
@Import(SharedMockApiTest.RealRuntime.class)
class CollaborationAuditTest extends SharedMockFixture {
    static final int PUBLIC_PORT=port();
    @DynamicPropertySource static void properties(DynamicPropertyRegistry properties){properties.add("apicc.collaboration.public-access.port",()->PUBLIC_PORT);properties.add("apicc.collaboration.public-access.base-url",()->"http://127.0.0.1:"+PUBLIC_PORT);}
    @org.springframework.beans.factory.annotation.Autowired com.autumnharvestc.server.execution.agent.AgentRepo agents;
    @org.springframework.beans.factory.annotation.Autowired com.autumnharvestc.server.collaboration.artifacts.CollaborationStorage storage;
    @Test void extremeLegalInstantOverflowIsTheExistingQuery400()throws Exception {
        var f=fixture();
        mvc.perform(get(collaboration(f)+"/audit").param("time","2026-01-01T00:00:00Z/2027-01-01T00:00:00Z").header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk());
        String extreme="+1000000000-12-31T23:59:59.999999999Z";
        org.junit.jupiter.api.Assertions.assertDoesNotThrow(()->java.time.Instant.parse(extreme));
        mvc.perform(get(collaboration(f)+"/audit").param("time","2026-01-01T00:00:00Z/"+extreme).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("collaboration_query_invalid"));
    }
    @Test void auditEntityIdsAreTextAndExistingOptionalAgentIdentityIsPreserved()throws Exception {
        var f=fixture();mock(f);capability(f,f.viewer(),"audit.read","allow");
        agents.audit(f.owner().account().id(),"id-legacy","project",Long.parseLong(f.project()),9100L);
        agents.auditScriptGrant(f.owner().account().id(),"id-agent",Long.parseLong(f.project()),Long.parseLong(f.agent()),9101L);
        var audit=body(mvc.perform(get(collaboration(f)+"/audit").header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk()));
        var checks=new ArrayList<org.junit.jupiter.api.function.Executable>();
        for(String domain:List.of("access","execution","collaboration")){assertThat(audit.path(domain)).isNotEmpty();for(var item:audit.path(domain)){
            for(String field:List.of("id","actorId","objectId"))checks.add(()->assertThat(item.path(field).isNull()||item.path(field).isTextual()).as(domain+" "+field+" is text or actual null").isTrue());
            checks.add(()->assertThat(item.path("revision").isNull()||item.path("revision").isIntegralNumber()).as("revision stays numeric").isTrue());
        }}
        var byRevision=new HashMap<Long,com.fasterxml.jackson.databind.JsonNode>();for(var item:audit.path("execution"))byRevision.put(item.path("revision").asLong(),item);
        checks.add(()->assertThat(byRevision.get(9100L).path("agentId").isNull()).as("actual absent agent remains null").isTrue());
        checks.add(()->assertThat(byRevision.get(9101L).path("agentId").isTextual()).as("actual agent entity id is text").isTrue());
        checks.add(()->assertThat(byRevision.get(9101L).path("agentId").asText()).isEqualTo(f.agent()));
        org.junit.jupiter.api.Assertions.assertAll(checks);
    }
    @Test void logAndAuditPermissionsAreIndependentAndMockKeyIsNotManagementAuthority()throws Exception {
        var f=fixture();var publication=mock(f);var grant=grant(f,publication);assertThat(call(grant,"/items/item-7").statusCode()).isEqualTo(200);
        mvc.perform(get(logs(f,publication)).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk());mvc.perform(get(collaboration(f)+"/audit").header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk());
        capability(f,f.viewer(),"mock.logs.read","allow");capability(f,f.viewer(),"audit.read","deny");
        mvc.perform(get(logs(f,publication)).header("Authorization","Bearer "+f.viewer().token())).andExpect(status().isOk());
        mvc.perform(get(collaboration(f)+"/audit").header("Authorization","Bearer "+f.viewer().token())).andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("forbidden"));
    }
    @Test void auditReadDoesNotGrantLogReadOrBypassScope()throws Exception {
        var f=fixture();var publication=mock(f);capability(f,f.viewer(),"audit.read","allow");capability(f,f.viewer(),"mock.logs.read","deny");
        mvc.perform(get(collaboration(f)+"/audit").header("Authorization","Bearer "+f.viewer().token())).andExpect(status().isOk());
        mvc.perform(get(logs(f,publication)).header("Authorization","Bearer "+f.viewer().token())).andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("forbidden"));
    }
    @Test void typedAssetLocationsPreserveNullEmptyAndLegalCrLfBackslash()throws Exception {
        var f=fixture();mock(f);String digest=f.assets().path("manifestHash").asText();String location="collection\r\n业务\\api";
        agents.audit(f.owner().account().id(),"legacy-assets","project",Long.parseLong(f.project()),9000L);
        agents.auditAssets(f.owner().account().id(),Long.parseLong(f.project()),9001,"script-unchanged","[]",digest,digest);
        agents.auditAssets(f.owner().account().id(),Long.parseLong(f.project()),9002,"script-changed",json.writeValueAsString(List.of(location)),digest,digest);
        var audit=body(mvc.perform(get(collaboration(f)+"/audit").header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk()));
        var byRevision=new HashMap<Long,com.fasterxml.jackson.databind.JsonNode>();for(var item:audit.path("execution"))byRevision.put(item.path("revision").asLong(),item);
        assertThat(byRevision.get(9000L).path("locations").isNull()).isTrue();assertThat(byRevision.get(9000L).path("locationLabel").asText()).isEqualTo("未采集");
        assertThat(byRevision.get(9001L).path("locations")).isEmpty();assertThat(byRevision.get(9001L).path("locationLabel").asText()).isEqualTo("无变更位置");
        assertThat(byRevision.get(9002L).at("/locations/0").asText()).isEqualTo(location);assertThat(byRevision.get(9002L).path("summaryLabel").asText()).isEqualTo("脚本已变更");assertThat(byRevision.get(9002L).path("beforeRevision").asText()).isEqualTo(digest);
    }
    @Test void failedLogRetentionDoesNotChangeSuccessfulBusinessResponseAndShowsObservationGap()throws Exception {
        var f=fixture();var publication=mock(f);var grant=grant(f,publication);assertThat(call(grant,"/items/item-7").statusCode()).isEqualTo(200);
        AuditFault.attempts.set(0);jdbc.execute("CREATE TRIGGER t8_mock_log_fault BEFORE INSERT ON collaboration_mock_logs FOR EACH ROW CALL '"+AuditFault.class.getName()+"'");
        try{var response=call(grant,"/items/item-8");assertThat(response.statusCode()).isEqualTo(200);assertThat(response.body()).isEqualTo("{\"id\":\"item-7\"}");waitFor(()->AuditFault.attempts.get()>0);var logs=body(mvc.perform(get(logs(f,publication)).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk()));assertThat(logs.path("state").asText()).isEqualTo("observations-missing");assertThat(logs.path("integrityLabel").asText()).contains("观测缺失");}finally{jdbc.execute("DROP TRIGGER t8_mock_log_fault");}
    }
    public static class AuditFault implements org.h2.api.Trigger {static final java.util.concurrent.atomic.AtomicInteger attempts=new java.util.concurrent.atomic.AtomicInteger();@Override public void fire(java.sql.Connection connection,Object[] before,Object[] after)throws java.sql.SQLException{attempts.incrementAndGet();throw new java.sql.SQLException("Synthetic finite log storage failure");}}
    @Test void successfulRealHitHasOnlyChargedFiniteMetadataAndBoundedRetention()throws Exception {
        var f=fixture();var publication=mock(f);var grant=grant(f,publication);policy(f,false,Map.of("mockLogMaxEntries",1));
        assertThat(call(grant,"/items/item-7?q=synthetic-query-secret").statusCode()).isEqualTo(200);
        var first=body(mvc.perform(get(logs(f,publication)).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk()));
        assertThat(first.path("items").size()).isEqualTo(1);
        var item=first.path("items").get(0);assertThat(item.path("ruleId").asText()).isEqualTo("10000000-0000-4000-8000-000000000015");assertThat(item.path("routeTemplate").asText()).isEqualTo("/items/{id}");assertThat(item.path("status").asInt()).isEqualTo(200);
        assertThat(first.toString()).doesNotContain(grant.path("key").asText(),f.owner().token(),"synthetic-query-secret","headers","body","item-7");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_storage_objects WHERE workspace_id=? AND project_id=? AND kind='LOG'",Long.class,Long.valueOf(f.workspace()),Long.valueOf(f.project()))).isGreaterThanOrEqualTo(1);
        assertThat(call(grant,"/items/item-8").statusCode()).isEqualTo(200);
        var second=body(mvc.perform(get(logs(f,publication)).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk()));assertThat(second.path("items").size()).isEqualTo(1);assertThat(second.path("discarded").asLong()).isEqualTo(1);assertThat(second.path("integrityLabel").asText()).contains("较旧");
        policy(f,false,Map.of("mockLogMaxEntries",0));var disabled=body(mvc.perform(get(logs(f,publication)).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk()));assertThat(disabled.path("state").asText()).isEqualTo("disabled");assertThat(disabled.path("items")).isEmpty();assertThat(disabled.path("integrityLabel").asText()).contains("关闭");
    }
    @Test void readsThreeActualAuditProvenanceDomainsWithoutManufacturingEvents()throws Exception {
        var f=fixture();mock(f);String path=f.url()+"/access-members/"+f.editor().id();long revision=body(mvc.perform(get(path).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk())).path("revision").asLong();request(f.owner().token(),put(path),Map.of("expectedRevision",revision,"capabilities",Map.of("mock.logs.read","allow"))).andExpect(status().isOk());
        var audit=body(mvc.perform(get(collaboration(f)+"/audit").header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk()));
        assertThat(audit.path("access").size()).isGreaterThan(0);assertThat(audit.path("execution").size()).isGreaterThan(0);assertThat(audit.path("collaboration").size()).isGreaterThan(0);
        assertThat(audit.toString()).doesNotContain(f.owner().token(),f.agentToken(),"scriptSource","source_json","policy_json","event_json");
    }
    @Test void auditPaginationAndActualObjectActorTimeFilters()throws Exception {
        var f=fixture();var publication=mock(f);
        var page=body(mvc.perform(get(collaboration(f)+"/audit").param("limit","1").header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk()));
        assertThat(page.path("access").size()+page.path("execution").size()+page.path("collaboration").size()).isEqualTo(1);assertThat(page.path("nextCursor").asText()).isNotEmpty();
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"object","actor","time"})
    void filtersAreAppliedToRealStoredAuditRecords(String filter)throws Exception {
        var f=fixture();var publication=mock(f);String value=filter.equals("object")?"ARTIFACT:"+publication.path("id").asText():filter.equals("actor")?f.viewer().id():"2100-01-01T00:00:00Z/2101-01-01T00:00:00Z";
        var result=body(mvc.perform(get(collaboration(f)+"/audit").param(filter,value).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk()));
        if(filter.equals("object")){assertThat(result.path("access")).isEmpty();assertThat(result.path("execution")).isEmpty();for(var entry:result.path("collaboration"))assertThat(entry.path("objectId").asText()).isEqualTo(publication.path("id").asText());}
        else if(filter.equals("time"))assertThat(result.path("access").size()+result.path("execution").size()+result.path("collaboration").size()).isZero();
        else for(String domain:List.of("access","execution","collaboration"))for(var entry:result.path(domain))assertThat(entry.path("actorId").asText()).isEqualTo(f.viewer().id());
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.CsvSource({"limit,0","limit,201","cursor,bogus","actor,not-an-id","object,PROJECT:9223372036854775807","time,2101-01-01T00:00:00Z/2100-01-01T00:00:00Z"})
    void rejectsInvalidOrOutOfScopeAuditQuery(String key,String value)throws Exception {
        var f=fixture();mock(f);mvc.perform(get(collaboration(f)+"/audit").param(key,value).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("collaboration_query_invalid"));
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"object","actor","time"})
    void filtersApplyToFiniteLogMetadata(String filter)throws Exception {
        var f=fixture();var publication=mock(f);assertThat(call(grant(f,publication),"/items/item-7").statusCode()).isEqualTo(200);String value=filter.equals("object")?"missing-rule":filter.equals("actor")?"A".repeat(22):"2100-01-01T00:00:00Z/2101-01-01T00:00:00Z";
        var result=body(mvc.perform(get(logs(f,publication)).param(filter,value).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk()));assertThat(result.path("items")).isEmpty();
    }
    @Test void expiredLogAndProjectDeletionReleaseRealChargesAndOwnedRows()throws Exception {
        var f=fixture();var publication=mock(f);var grant=grant(f,publication);assertThat(call(grant,"/items/item-7").statusCode()).isEqualTo(200);waitFor(()->logCount(f)>0);
        jdbc.update("UPDATE collaboration_mock_logs SET created_at_epoch_ms=? WHERE workspace_id=? AND project_id=?",1,Long.valueOf(f.workspace()),Long.valueOf(f.project()));
        var expired=body(mvc.perform(get(logs(f,publication)).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk()));assertThat(expired.path("items")).isEmpty();
        assertThat(logCount(f)).isZero();assertThat(call(grant,"/items/item-8").statusCode()).isEqualTo(200);waitFor(()->logCount(f)>0);
        mvc.perform(delete(f.url()).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isNoContent());assertThat(logCount(f)).isZero();assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_mock_log_state WHERE workspace_id=? AND project_id=?",Long.class,Long.valueOf(f.workspace()),Long.valueOf(f.project()))).isZero();assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_storage_objects WHERE workspace_id=? AND project_id=? AND kind='LOG'",Long.class,Long.valueOf(f.workspace()),Long.valueOf(f.project()))).isZero();
    }
    @Test void logObjectMustBeOwnedByCurrentProjectAndMockKeyCannotReadManagementLogs()throws Exception {
        var f=fixture();var publication=mock(f);var grant=grant(f,publication);
        mvc.perform(get(logs(f,publication)).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk());mvc.perform(get(logs(f,publication)).header("X-Apicc-Mock-Key",grant.path("key").asText())).andExpect(status().isUnauthorized());
        mvc.perform(get(collaboration(f)+"/publications/9223372036854775807/mock-logs").header("Authorization","Bearer "+f.owner().token())).andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("publication_not_found"));
    }
    long logCount(Fixture f){return jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_mock_logs WHERE workspace_id=? AND project_id=?",Long.class,Long.valueOf(f.workspace()),Long.valueOf(f.project()));}
    @Test void projectDeletionRemovesCompletedLogRowsAndRetainedCounter()throws Exception {
        var f=fixture();var publication=mock(f);var grant=grant(f,publication);policy(f,false,Map.of("mockLogMaxEntries",1));assertThat(call(grant,"/items/item-7").statusCode()).isEqualTo(200);assertThat(call(grant,"/items/item-8").statusCode()).isEqualTo(200);waitFor(()->logCount(f)>0);
        mvc.perform(delete(f.url()).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isNoContent());assertThat(logCount(f)).isZero();assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_mock_log_state WHERE workspace_id=? AND project_id=?",Long.class,Long.valueOf(f.workspace()),Long.valueOf(f.project()))).isZero();
    }
    @Test void completedCallCannotCreateOrphanLogsAfterOwningProjectWasDeleted()throws Exception {
        var f=fixture();var publication=mock(f,"slow");var grant=grant(f,publication);int before=node.records(http,json).path("calls").size();var pending=java.util.concurrent.CompletableFuture.supplyAsync(()->{try{return call(grant,"/items/item-7");}catch(Exception e){throw new RuntimeException(e);}});
        waitFor(()->node.records(http,json).path("calls").size()>before);mvc.perform(delete(f.url()).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isNoContent());pending.get();Thread.sleep(50);assertThat(logCount(f)).isZero();
    }
    String logs(Fixture f,com.fasterxml.jackson.databind.JsonNode publication){return collaboration(f)+"/publications/"+publication.path("id").asText()+"/mock-logs";}
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"capacity","deadline"})
    void legallyAdmittedFailuresRetainOnlyFiniteReasonMetadata(String branch)throws Exception {
        var f=fixture();var publication=mock(f,branch.equals("capacity")?"slow":"files");var grant=grant(f,publication);policy(f,false,Map.of("mockInFlight",1,"mockCallTimeoutMs",branch.equals("deadline")?1000:35000));
        if(branch.equals("capacity")){int index=node.records(http,json).path("calls").size();var pending=java.util.concurrent.CompletableFuture.supplyAsync(()->{try{return call(grant,"/items/item-7");}catch(Exception e){throw new RuntimeException(e);}});try{waitFor(()->node.records(http,json).path("calls").size()>index);assertThat(call(grant,"/items/item-7").statusCode()).isEqualTo(429);}finally{pending.get();}}
        else try(var socket=new java.net.Socket("127.0.0.1",PUBLIC_PORT)){socket.setSoTimeout(2000);socket.getOutputStream().write(("GET /mock/"+grant.path("publicId").asText()+"/items/item-7 HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Apicc-Mock-Key: "+grant.path("key").asText()+"\r\nContent-Length: 1\r\n\r\n").getBytes(java.nio.charset.StandardCharsets.US_ASCII));socket.getOutputStream().flush();assertThat(new java.io.BufferedReader(new java.io.InputStreamReader(socket.getInputStream())).readLine()).contains(" 408 ");}
        var records=body(mvc.perform(get(logs(f,publication)).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk()));boolean found=false;for(var entry:records.path("items"))if(entry.path("reason").asText().equals(branch.equals("capacity")?"CAPACITY_LIMIT":"DEADLINE_EXCEEDED"))found=true;assertThat(found).as("known granted failure has a finite metadata reason").isTrue();
    }
    // User-approved POSTHOC verification: internal cursor guards and unknown query rejection preceded their tests.
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"extra","missing","number","scope","unknown-query"})
    void posthocApprovedCursorShapeAndUnknownQueryBoundariesAtActualHttpEntrance(String branch)throws Exception {
        var f=fixture();mock(f);String url=collaboration(f)+"/audit";var first=body(mvc.perform(get(url).param("limit","1").header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk()));String cursor=first.path("nextCursor").asText();assertThat(cursor).isNotEmpty();mvc.perform(get(url).param("limit","1").param("cursor",cursor).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk());
        if(branch.equals("unknown-query")){mvc.perform(get(url).param("unexpected","value").header("Authorization","Bearer "+f.owner().token())).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("collaboration_query_invalid"));return;}
        var value=(com.fasterxml.jackson.databind.node.ObjectNode)json.readTree(Base64.getUrlDecoder().decode(cursor));switch(branch){case "extra"->value.put("extra",true);case "missing"->value.remove("lastId");case "number"->value.put("lastMs","not-a-number");case "scope"->value.put("project",Long.parseLong(f.other()));}
        String malformed=Base64.getUrlEncoder().withoutPadding().encodeToString(json.writeValueAsBytes(value));mvc.perform(get(url).param("limit","1").param("cursor",malformed).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("collaboration_query_invalid"));
    }
    @Test void actualAuditCursorHasStableSnapshotAndNoDuplicatesAcrossProvenanceDomains()throws Exception {
        var f=fixture();mock(f);String url=collaboration(f)+"/audit";var expected=body(mvc.perform(get(url).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk()));var wanted=new HashSet<String>();for(String domain:List.of("access","execution","collaboration"))for(var item:expected.path(domain))wanted.add(domain+":"+item.path("id").asText());
        var seen=new HashSet<String>();String cursor="";int pages=0;do{var request=get(url).param("limit","1").header("Authorization","Bearer "+f.owner().token());if(!cursor.isEmpty())request.param("cursor",cursor);var result=body(mvc.perform(request).andExpect(status().isOk()));for(String domain:List.of("access","execution","collaboration"))for(var item:result.path(domain))assertThat(seen.add(domain+":"+item.path("id").asText())).isTrue();cursor=result.path("nextCursor").asText();if(pages++==0)agents.audit(f.owner().account().id(),"after-cursor","project",Long.parseLong(f.project()),9999L);assertThat(pages).isLessThan(50);}while(!cursor.isEmpty());assertThat(seen).isEqualTo(wanted);
    }
    @Test void retentionCleanupAndPublicationDeletionOwnAllLogRowsAndCharges()throws Exception {
        var f=fixture();var publication=mock(f);var grant=grant(f,publication);assertThat(call(grant,"/items/item-7").statusCode()).isEqualTo(200);waitFor(()->logCount(f)>0);jdbc.update("UPDATE collaboration_mock_logs SET created_at_epoch_ms=1 WHERE workspace_id=? AND project_id=?",Long.valueOf(f.workspace()),Long.valueOf(f.project()));storage.cleanup(Long.parseLong(f.workspace()),Long.parseLong(f.project()));assertThat(logCount(f)).isZero();
    }
    @Test void publicationDeletionOwnsCompletedLogsAndTheirCounter()throws Exception {
        var f=fixture();var publication=mock(f);var grant=grant(f,publication);policy(f,false,Map.of("mockLogMaxEntries",1));assertThat(call(grant,"/items/item-7").statusCode()).isEqualTo(200);assertThat(call(grant,"/items/item-8").statusCode()).isEqualTo(200);waitFor(()->logCount(f)>0);request(f.owner().token(),delete(collaboration(f)+"/grants/"+grant.path("id").asText()),Map.of("expectedRevision",1)).andExpect(status().isNoContent());request(f.owner().token(),delete(collaboration(f)+"/publications/"+publication.path("id").asText()),Map.of("expectedRevision",2)).andExpect(status().isNoContent());assertThat(logCount(f)).isZero();assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_mock_log_state WHERE publication_id=?",Long.class,publication.path("id").asLong())).isZero();
    }
}
