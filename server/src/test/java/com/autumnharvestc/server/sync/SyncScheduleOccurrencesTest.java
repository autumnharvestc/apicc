package com.autumnharvestc.server.sync;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
class SyncScheduleOccurrencesTest extends SyncScheduleHttpFixture {
    @org.springframework.beans.factory.annotation.Autowired SyncScheduleProperties budgets;
    @Test void actualBackgroundTriggerOnlyCreatesACandidate() throws Exception {
        var source=enabledHourlySource();var version=currentVersion();int starts=sourceHostCalls();
        at("2026-11-05T01:00:00Z");driver.tick();
        assertThat(checkCountForTrigger(source)).isEqualTo(1);
        var completed=awaitOneCompletedCheck(source);assertThat(completed.path("candidateId").asText()).isNotBlank();
        assertThat(sourceHostCalls()).isEqualTo(starts+1);assertThat(currentVersion()).isEqualTo(version);assertThat(automaticApplicationCount()).isZero();
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(booleans={false,true})
    void duplicateTimerTicksDoNotMakeANewIntentEvenAfterAssetsChange(boolean editAssets) throws Exception {
        var source=enabledHourlySource();at("2026-11-05T01:00:00Z");driver.tick();assertThat(checkCountForTrigger(source)).isEqualTo(1);awaitOneCompletedCheck(source);int starts=sourceHostCalls();
        if(editAssets)editProjectWithCurrentVersion();String version=currentVersion();
        driver.tick();driver.tick();
        assertThat(checkCountForTrigger(source)).isEqualTo(1);assertThat(sourceHostCalls()).isEqualTo(starts);assertThat(currentVersion()).isEqualTo(version);assertThat(automaticApplicationCount()).isZero();
    }
    @Test void missedTriggersAreOneLatestSnapshotWithAnExplicitBoundedWindow() throws Exception {
        var source=enabledHourlySource();at("2026-11-07T03:00:00Z");driver.tick();assertThat(checkCountForTrigger(source)).isEqualTo(1);awaitOneCompletedCheck(source);
        var text=jdbc.queryForObject("SELECT details_json FROM sync_occurrences WHERE project_id=? AND source_id=?",String.class,Long.parseLong(f.project()),source.path("id").asText());var details=json.readTree(text);
        assertThat(details.path("coalescedDueCount").asInt()).isEqualTo(24);assertThat(details.path("missedBeforeWindow").asBoolean()).isTrue();
        assertThat(details.path("evaluatedAfterUtc").asText()).isEqualTo("2026-11-06T03:00:00Z");
        assertThat(jdbc.queryForObject("SELECT planned_at_utc FROM sync_occurrences WHERE project_id=?",String.class,Long.parseLong(f.project()))).isEqualTo("2026-11-07T03:00:00Z");
        sourceRequest("GET",scheduleRoute(source),f.owner(),null).andExpect(status().isOk())
            .andExpect(jsonPath("$.lastOccurrence.plannedAtUtc").value("2026-11-07T03:00:00Z"))
            .andExpect(jsonPath("$.lastOccurrence.coalescedDueCount").value(24)).andExpect(jsonPath("$.lastOccurrence.missedBeforeWindow").value(true))
            .andExpect(jsonPath("$.lastOccurrence.evaluatedAfterUtc").value("2026-11-06T03:00:00Z"))
            .andExpect(jsonPath("$.lastOccurrence.executedSubjectUserId").value(f.owner().id())).andExpect(jsonPath("$.lastOccurrence.state").value("succeeded"));
    }
    @Test void anActiveCompatibleManualCheckFulfillsTheOccurrenceWithItsActualActor() throws Exception {
        checkToCandidate(createUrlSource("/fast"));String barrier=java.util.UUID.randomUUID().toString();var source=createUrlSource("/blocked/"+barrier);authorize(source,"0",f.owner());source=readSourceAsAdmin(source.path("id").asText());
        var manual=submit(source,checkBody().put("expectedSourceRevision","2"));awaitNode("received-"+barrier);int starts=sourceHostCalls();
        try{at("2026-11-05T01:00:00Z");driver.tick();
            var row=jdbc.queryForMap("SELECT check_id,details_json FROM sync_occurrences WHERE project_id=? AND source_id=?",Long.parseLong(f.project()),source.path("id").asText());
            assertThat(row.get("CHECK_ID")).isEqualTo(manual.path("checkId").asText());
            assertThat(json.readTree(row.get("DETAILS_JSON").toString()).path("executedSubjectUserId").asText()).isEqualTo(editor().id());assertThat(sourceHostCalls()).isEqualTo(starts);
        }finally{var ids=jdbc.queryForList("SELECT id FROM sync_checks WHERE project_id=? AND source_id=? AND state IN ('queued','running','waiting','cancelling')",String.class,Long.parseLong(f.project()),source.path("id").asText());for(var id:ids)sourceRequest("POST","/checks/"+id+"/cancel",f.owner(),json.createObjectNode()).andExpect(status().isAccepted());release(barrier);awaitNode("collected-"+barrier);}
    }
    @Test void finiteOccurrenceRetentionKeepsTheCursorAsADuplicateFence() throws Exception {
        int old=budgets.getMaxOccurrencesPerProject();budgets.setMaxOccurrencesPerProject(1);
        try{var source=enabledHourlySource();at("2026-11-05T01:00:00Z");driver.tick();awaitOneCompletedCheck(source);at("2026-11-05T02:00:00Z");driver.tick();awaitOneCompletedCheck(source);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM sync_occurrences WHERE project_id=?",Integer.class,Long.parseLong(f.project()))).isEqualTo(1);
            int checks=checkCountForTrigger(source);at("2026-11-05T01:00:00Z");driver.tick();assertThat(checkCountForTrigger(source)).isEqualTo(checks);
        }finally{budgets.setMaxOccurrencesPerProject(old);}
    }
    @Test void staleManualAssetsAreNotCoalescedIntoTheBackgroundOccurrence() throws Exception {
        checkToCandidate(createUrlSource("/fast"));String barrier=java.util.UUID.randomUUID().toString();var source=createUrlSource("/blocked/"+barrier);authorize(source,"0",f.owner());source=readSourceAsAdmin(source.path("id").asText());
        var manual=submit(source,checkBody().put("expectedSourceRevision","2"));awaitNode("received-"+barrier);
        try{editProjectWithCurrentVersion();at("2026-11-05T01:00:00Z");driver.tick();var linked=jdbc.queryForObject("SELECT check_id FROM sync_occurrences WHERE project_id=? AND source_id=?",String.class,Long.parseLong(f.project()),source.path("id").asText());assertThat(linked).isNotEqualTo(manual.path("checkId").asText());assertThat(checkCountForTrigger(source)).isEqualTo(1);
        }finally{var ids=jdbc.queryForList("SELECT id FROM sync_checks WHERE project_id=? AND source_id=? AND state IN ('queued','running','waiting','cancelling')",String.class,Long.parseLong(f.project()),source.path("id").asText());for(var id:ids)sourceRequest("POST","/checks/"+id+"/cancel",f.owner(),json.createObjectNode()).andExpect(status().isAccepted());release(barrier);awaitNode("collected-"+barrier);}
    }
    @Test void finiteActiveOccurrencePausesRatherThanDiscardingItsOwner() throws Exception {
        checkToCandidate(createUrlSource("/fast"));int old=budgets.getMaxOccurrencesPerProject();budgets.setMaxOccurrencesPerProject(1);String barrier=java.util.UUID.randomUUID().toString();var source=createUrlSource("/blocked/"+barrier);authorize(source,"0",f.owner());source=readSourceAsAdmin(source.path("id").asText());
        try{at("2026-11-05T01:00:00Z");driver.tick();awaitNode("received-"+barrier);at("2026-11-05T02:00:00Z");driver.tick();
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM sync_occurrences WHERE project_id=?",Integer.class,Long.parseLong(f.project()))).isEqualTo(1);
            sourceRequest("GET",scheduleRoute(source),f.owner(),null).andExpect(status().isOk()).andExpect(jsonPath("$.enabled").value(false)).andExpect(jsonPath("$.pausedReasonCode").value("occurrence-capacity"));
        }finally{budgets.setMaxOccurrencesPerProject(old);for(var id:jdbc.queryForList("SELECT id FROM sync_checks WHERE project_id=? AND state IN ('queued','running','waiting','cancelling')",String.class,Long.parseLong(f.project())))sourceRequest("POST","/checks/"+id+"/cancel",f.owner(),json.createObjectNode()).andExpect(status().isAccepted());release(barrier);awaitNode("collected-"+barrier);}
    }
}
