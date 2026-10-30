package com.autumnharvestc.server.execution;

import java.util.*;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

abstract class ScheduleFixture extends JobsFixture {
    @org.springframework.beans.factory.annotation.Autowired com.autumnharvestc.server.execution.scheduling.ScheduleService schedules;
    @org.springframework.beans.factory.annotation.Autowired com.autumnharvestc.server.execution.scheduling.SchedulerProperties schedulerProperties;
    @org.springframework.beans.factory.annotation.Autowired com.autumnharvestc.server.store.UserRepo scheduleUsers;
    @SuppressWarnings("unchecked") Map<String,Object> execution(Map<String,Object> save){return (Map<String,Object>)save.get("execution");}
    Map<String,Object> save(F f) {
        var execution=submission(f,"unused");execution.remove("intentId");
        return new LinkedHashMap<>(Map.of("name","每日回归","rule",Map.of("kind","cron","expression","0 0 9 * * *","timeZone","Asia/Shanghai","dstOverlap","first"),"policies",Map.of("lateToleranceMs",10000,"misfire","skip","catchupWindowMs",300000,"overlap","skip","queueTimeoutMs",300000),"execution",execution,"notifications",Map.of("inApp",true,"eventKinds",List.of("failed","abnormal","expired","paused"),"channelIds",List.of())));
    }
}

class ScheduleApiTest extends ScheduleFixture {
    @org.springframework.beans.factory.annotation.Autowired ExecutionProperties scheduleExecutionProperties;
    @Test void savesFixedSnapshotPausedWithoutSubmittingAJob() throws Exception {
        var f=fixture();
        var result=body(member(f,post(f.url()+"/schedules"),save(f)).andExpect(status().isCreated()));
        assertThat(result.path("enabled").asBoolean()).isFalse();
        assertThat(result.path("version").asText()).isEqualTo("1");
        assertThat(result.path("revision").asText()).isEqualTo("1");
        assertThat(result.path("snapshotVersion").asText()).isEqualTo("1");
        assertThat(result.path("manifestHash").asText()).isEqualTo(f.assets().path("manifestHash").asText());
        assertThat(result.path("execution").has("intentId")).isFalse();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_jobs WHERE workspace_id=? AND project_id=?",Long.class,Long.valueOf(f.ws()),Long.valueOf(f.project()))).isZero();
    }
    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings={"name-empty","name-long","debug","stress-settings","shared","manifest","scope","digest","core","runtime","capability","agent","channel","late","queue","dense","local-path","missing-preparation"})
    void rejectsUnsafeOrStaleFixedPreparation(String invalid)throws Exception{
        var f=fixture();var input=save(f);var e=execution(input);var p=preparation(e);
        switch(invalid){
            case "name-empty"->input.put("name"," ");case "name-long"->input.put("name","x".repeat(129));
            case "debug"->e.put("target",debugSubmission(f,"unused").get("target"));
            case "stress-settings"->e.put("runConfig",Map.of("stress",Map.of("workerCount",1)));
            case "shared"->p.put("dispatchKind","shared-debug");
            case "manifest"->p.put("manifestHash","c".repeat(64));
            case "scope"->p.put("scope",Map.of("workspaceId",f.ws(),"groupId",f.group(),"projectId","9223372036854775807"));
            case "digest"->p.put("scriptPlanDigest","b".repeat(64));case "core"->p.put("requiredCoreBuildId","c".repeat(64));
            case "runtime"->p.put("runtimeCompatibilityId","other-runtime");case "capability"->p.put("requiredCapabilities",List.of("unsupported"));
            case "agent"->jdbc.update("DELETE FROM execution_project_agents WHERE project_id=?",Long.valueOf(f.project()));
            case "channel"->input.put("notifications",Map.of("inApp",true,"eventKinds",List.of("failed"),"channelIds",List.of("9223372036854775807")));
            case "late"->input.put("policies",Map.of("lateToleranceMs",1000,"misfire","skip","catchupWindowMs",300000,"overlap","skip","queueTimeoutMs",300000));
            case "queue"->input.put("policies",Map.of("lateToleranceMs",10000,"misfire","skip","catchupWindowMs",300000,"overlap","skip","queueTimeoutMs",3600001));
            case "dense"->input.put("rule",Map.of("kind","cron","expression","* * * * * *","timeZone","Asia/Shanghai","dstOverlap","first"));
            case "local-path"->e.put("materials",Map.of("projectId",f.project(),"credentials",List.of(),"attachments",List.of(),"attachmentPaths",Map.of("C:/private.pem",Map.of("refId","file","version","1","hash",HASH))));
            case "missing-preparation"->e.remove("preparation");
        }
        var response=member(f,post(f.url()+"/schedules"),input).andReturn().getResponse();
        assertThat(response.getStatus()).as(invalid).isBetween(400,499);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedules WHERE workspace_id=? AND project_id=?",Long.class,Long.valueOf(f.ws()),Long.valueOf(f.project()))).isZero();
    }
    @Test void updatesImmutableRevisionsAndPersistentCancellationBarrierWithoutRewindingWatermark()throws Exception{
        var f=fixture();String id=body(member(f,post(f.url()+"/schedules"),save(f)).andExpect(status().isCreated())).path("id").asText();String url=f.url()+"/schedules/"+id;
        jdbc.update("UPDATE execution_schedules SET evaluated_through_utc=TIMESTAMP WITH TIME ZONE '2030-01-01 00:00:00+00',last_admitted_planned_at_utc=TIMESTAMP WITH TIME ZONE '2029-12-31 01:00:00+00' WHERE workspace_id=? AND project_id=? AND id=?",Long.valueOf(f.ws()),Long.valueOf(f.project()),Long.valueOf(id));
        member(f,put(url),Map.of("expectedVersion","1","name","新名称","notifications",Map.of("inApp",false,"eventKinds",List.of("succeeded"),"channelIds",List.of()))).andExpect(status().isOk()).andExpect(jsonPath("$.revision").value("1")).andExpect(jsonPath("$.cancellationVersion").value("0"));
        member(f,put(url),Map.of("expectedVersion","2","rule",Map.of("kind","cron","expression","0 0 10 * * *","timeZone","Asia/Shanghai","dstOverlap","first"))).andExpect(status().isOk()).andExpect(jsonPath("$.revision").value("2")).andExpect(jsonPath("$.cancellationVersion").value("1")).andExpect(jsonPath("$.evaluatedThroughUtc").value("2030-01-01T00:00:00Z"));
        member(f,put(url),Map.of("expectedVersion","3","enabled",true)).andExpect(status().isOk()).andExpect(jsonPath("$.revision").value("2")).andExpect(jsonPath("$.cancellationVersion").value("1")).andExpect(jsonPath("$.nextPlannedAtUtc").value("2030-01-01T02:00:00Z"));
        member(f,put(url),Map.of("expectedVersion","4","enabled",false)).andExpect(status().isOk()).andExpect(jsonPath("$.cancellationVersion").value("2"));
        member(f,put(url),Map.of("expectedVersion","5","enabled",true)).andExpect(status().isOk()).andExpect(jsonPath("$.cancellationVersion").value("2"));
        member(f,put(url),Map.of("expectedVersion","5","name","过期修改")).andExpect(status().isConflict());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedule_revisions WHERE workspace_id=? AND project_id=? AND schedule_id=?",Long.class,Long.valueOf(f.ws()),Long.valueOf(f.project()),Long.valueOf(id))).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT rule_json FROM execution_schedule_revisions WHERE workspace_id=? AND project_id=? AND schedule_id=? AND revision=1",String.class,Long.valueOf(f.ws()),Long.valueOf(f.project()),Long.valueOf(id))).contains("0 0 9 * * *");
    }
    @Test void listsDetailsOptionsAndSoftDeletesWithoutCancellingAnExistingJob()throws Exception{
        var f=fixture();String job=seed(f,"running");String id=body(member(f,post(f.url()+"/schedules"),save(f)).andExpect(status().isCreated())).path("id").asText();
        member(f,get(f.url()+"/schedules?limit=1"),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.items[0].id").value(id));
        member(f,get(f.url()+"/schedules?limit=0"),Map.of()).andExpect(status().isBadRequest());
        member(f,get(f.url()+"/schedules/"+id),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.execution.snapshotId").value(f.snapshot()));
        member(f,get(f.url()+"/schedules/options"),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.canManageSchedules").value(true)).andExpect(jsonPath("$.policy.minIntervalMs").value(60000)).andExpect(jsonPath("$.channels").isArray());
        member(f,delete(f.url()+"/schedules/"+id+"?expectedVersion=0"),Map.of()).andExpect(status().isConflict());
        member(f,delete(f.url()+"/schedules/"+id+"?expectedVersion=1"),Map.of()).andExpect(status().isNoContent());
        member(f,get(f.url()+"/schedules/"+id),Map.of()).andExpect(status().isNotFound());
        assertThat(state(job)).isEqualTo("running");
        assertThat(jdbc.queryForObject("SELECT cancellation_version FROM execution_schedules WHERE workspace_id=? AND project_id=? AND id=?",Long.class,Long.valueOf(f.ws()),Long.valueOf(f.project()),Long.valueOf(id))).isEqualTo(1);
    }
    @Test void serializesGlobalCapacityAcrossDifferentProjectTransactions()throws Exception{
        var first=fixture();var second=fixture();long before=jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedules WHERE deleted=FALSE",Long.class);long original=schedulerProperties.getMaxSchedules();
        var gate=new java.util.concurrent.CyclicBarrier(2);var executor=java.util.concurrent.Executors.newFixedThreadPool(2);
        try{
            schedulerProperties.setMaxSchedules(before+1);
            var caller=scheduleUsers.findByUsername("admin").orElseThrow();
            var a=json.convertValue(save(first),com.autumnharvestc.server.execution.scheduling.ScheduleDtos.Save.class);var b=json.convertValue(save(second),com.autumnharvestc.server.execution.scheduling.ScheduleDtos.Save.class);
            java.util.concurrent.Callable<Boolean> one=()->{gate.await();try{schedules.create(caller,first.ws(),first.project(),a);return true;}catch(com.autumnharvestc.server.core.ApiException e){assertThat(e.getCode()).isEqualTo("schedule-capacity");return false;}};
            java.util.concurrent.Callable<Boolean> two=()->{gate.await();try{schedules.create(caller,second.ws(),second.project(),b);return true;}catch(com.autumnharvestc.server.core.ApiException e){assertThat(e.getCode()).isEqualTo("schedule-capacity");return false;}};
            var fa=executor.submit(one);var fb=executor.submit(two);
            assertThat(List.of(fa.get(20,java.util.concurrent.TimeUnit.SECONDS),fb.get(20,java.util.concurrent.TimeUnit.SECONDS))).containsExactlyInAnyOrder(true,false);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedules WHERE deleted=FALSE",Long.class)).isEqualTo(before+1);
        }finally{schedulerProperties.setMaxSchedules(original);executor.shutdownNow();}
    }
    @Test void pausedPlansConsumeProjectCapacityAndSoftDeleteReleasesIt()throws Exception{
        var f=fixture();member(f,put(f.url()+"/schedule-policy"),Map.of("expectedVersion","0","policy",Map.of("maxSchedules",1))).andExpect(status().isOk());
        String id=body(member(f,post(f.url()+"/schedules"),save(f)).andExpect(status().isCreated())).path("id").asText();
        member(f,post(f.url()+"/schedules"),save(f)).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("schedule-capacity"));
        member(f,delete(f.url()+"/schedules/"+id+"?expectedVersion=1"),Map.of()).andExpect(status().isNoContent());
        member(f,post(f.url()+"/schedules"),save(f)).andExpect(status().isCreated());
    }
    @Test void materialOptionsReturnsRegistrationsWithoutDecryptingAndTriggerSealsCurrentVersions()throws Exception{
        var f=fixture();member(f,put(f.url()+"/credentials/api"),Map.of("expectedVersion","0","value","NEVER-SAVE-THIS-SECRET")).andExpect(status().isOk());
        var metadata=body(member(f,get(f.url()+"/schedules/material-options"),Map.of()).andExpect(status().isOk()));
        assertThat(metadata.path("credentials").get(0).path("status").asText()).isEqualTo("registered");
        assertThat(metadata.toString()).doesNotContain("NEVER-SAVE-THIS-SECRET","value","contentBase64");
    }
    @Test void currentCredentialBindingSealsTheVersionObservedAtTrigger()throws Exception{
        var f=fixture();member(f,put(f.url()+"/credentials/api"),Map.of("expectedVersion","0","value","NEVER-SAVE-THIS-SECRET")).andExpect(status().isOk());
        var input=save(f);execution(input).put("materials",Map.of("projectId",f.project(),"credentials",List.of(Map.of("refId","api","mode","current-at-trigger")),"attachments",List.of()));
        String id=body(member(f,post(f.url()+"/schedules"),input).andExpect(status().isCreated())).path("id").asText();
        member(f,put(f.url()+"/credentials/api"),Map.of("expectedVersion","1","value","ROTATED-PRIVATE-VALUE")).andExpect(status().isOk());
        var view=schedules.detail(scheduleUsers.findByUsername("admin").orElseThrow(),f.ws(),f.project(),id);
        var sealed=schedules.sealMaterials(scheduleUsers.findByUsername("admin").orElseThrow(),Long.valueOf(f.ws()),Long.valueOf(f.project()),view.execution());
        assertThat(sealed).isNotNull();assertThat(sealed.credentials()).containsExactly(new ExecutionDtos.CredentialSelection("api","2"));
        assertThat(jdbc.queryForObject("SELECT execution_json FROM execution_schedule_revisions WHERE workspace_id=? AND project_id=? AND schedule_id=? AND revision=1",String.class,Long.valueOf(f.ws()),Long.valueOf(f.project()),Long.valueOf(id))).doesNotContain("NEVER-SAVE-THIS-SECRET","ROTATED-PRIVATE-VALUE");
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"missing","stale","attachment"})
    void rejectsMissingStaleAndUndeclaredMaterialsBeforeSaving(String invalid)throws Exception{
        var f=fixture();
        member(f,put(f.url()+"/credentials/api"),Map.of("expectedVersion","0","value","secret")).andExpect(status().isOk());
        var input=save(f);String code;
        if(invalid.equals("missing")){execution(input).put("materials",Map.of("projectId",f.project(),"credentials",List.of(Map.of("refId","missing","mode","current-at-trigger")),"attachments",List.of()));code="credential_missing";}
        else if(invalid.equals("stale")){execution(input).put("materials",Map.of("projectId",f.project(),"credentials",List.of(Map.of("refId","api","mode","fixed-version","version","2")),"attachments",List.of()));code="credential_version_conflict";}
        else{execution(input).put("materials",Map.of("projectId",f.project(),"credentials",List.of(),"attachments",List.of(Map.of("refId","file","version","1","hash",HASH))));code="attachment_missing";}
        member(f,post(f.url()+"/schedules"),input).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value(code));
    }
    @Test void fixedCredentialBindingRefusesRotationAtSealing()throws Exception{
        var f=fixture();member(f,put(f.url()+"/credentials/api"),Map.of("expectedVersion","0","value","secret")).andExpect(status().isOk());
        var input=save(f);execution(input).put("materials",Map.of("projectId",f.project(),"credentials",List.of(Map.of("refId","api","mode","fixed-version","version","1")),"attachments",List.of()));
        String id=body(member(f,post(f.url()+"/schedules"),input).andExpect(status().isCreated())).path("id").asText();
        member(f,put(f.url()+"/credentials/api"),Map.of("expectedVersion","1","value","new-secret")).andExpect(status().isOk());
        var caller=scheduleUsers.findByUsername("admin").orElseThrow();var execution=schedules.detail(caller,f.ws(),f.project(),id).execution();
        assertThatThrownBy(()->schedules.sealMaterials(caller,Long.valueOf(f.ws()),Long.valueOf(f.project()),execution)).isInstanceOfSatisfying(com.autumnharvestc.server.core.ApiException.class,e->assertThat(e.getCode()).isEqualTo("credential_version_conflict"));
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"name","rule","policies","execution","notifications","enabled","reauthorize","refreshExecution"})
    void omittedUpdateFieldsArePreservedButExplicitNullIsRejected(String field)throws Exception{
        var f=fixture();String id=body(member(f,post(f.url()+"/schedules"),save(f)).andExpect(status().isCreated())).path("id").asText();
        var input=new LinkedHashMap<String,Object>();input.put("expectedVersion","1");input.put(field,null);
        member(f,put(f.url()+"/schedules/"+id),input).andExpect(status().isBadRequest());
    }
    @Test void scheduleViewSerializesTheSameOptionalExecutionFieldsAcceptedByTheClient()throws Exception{
        var f=fixture();var view=body(member(f,post(f.url()+"/schedules"),save(f)).andExpect(status().isCreated()));
        assertThat(view.path("execution").path("runConfig").has("scriptTimeoutMs")).isFalse();
        assertThat(view.path("execution").path("preparation").has("scriptGrantVersion")).isFalse();
        assertThat(view.path("execution").path("materials").has("attachmentPaths")).isFalse();
        wire("t2-schedule-view",view);
    }
    @Test void rejectsMissingNotificationSwitchAndPersonalNetworkFilePaths()throws Exception{
        var f=fixture();var input=save(f);input.put("notifications",Map.of("eventKinds",List.of("failed"),"channelIds",List.of()));
        member(f,post(f.url()+"/schedules"),input).andExpect(status().isBadRequest());
    }
    @Test void rejectsPersonalNetworkFilePathsEvenInUnusedProfiles()throws Exception{
        var f=fixture();var input=save(f);execution(input).put("network",Map.of("revision","1","configuration",Map.of("formatVersion",1,"profiles",List.of(Map.of("id","local","name","local","kind","direct","targetTlsBindings",List.of(Map.of("origin","https://target.test","tls",Map.of("caCertificatePaths",List.of("C:/private.pem")))))),"environmentSelections",List.of(),"projectSelection",Map.of("kind","direct"))));
        member(f,post(f.url()+"/schedules"),input).andExpect(status().isBadRequest());
    }
    @Test void metadataOnlyPreparationDoesNotClaimCorruptCiphertextIsUsableAndOriginalJobGateStillRejectsIt()throws Exception{
        var f=fixture();member(f,put(f.url()+"/credentials/api"),Map.of("expectedVersion","0","value","NEVER-LOAD-THIS")).andExpect(status().isOk());
        jdbc.update("UPDATE execution_project_credentials SET ciphertext=? WHERE workspace_id=? AND project_id=? AND ref_id='api'",new byte[48],Long.valueOf(f.ws()),Long.valueOf(f.project()));
        member(f,get(f.url()+"/schedules/material-options"),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.credentials[0].status").value("registered")).andExpect(jsonPath("$.credentialValidation").value("metadata-only"));
        var input=save(f);execution(input).put("materials",Map.of("projectId",f.project(),"credentials",List.of(Map.of("refId","api","mode","current-at-trigger")),"attachments",List.of()));
        member(f,post(f.url()+"/schedules"),input).andExpect(status().isCreated());
        var job=submission(f,"corrupt-ciphertext-must-not-start");job.put("materials",Map.of("projectId",f.project(),"credentials",List.of(Map.of("refId","api","version","1")),"attachments",List.of()));
        member(f,post(f.url()+"/jobs"),job).andExpect(status().isServiceUnavailable()).andExpect(jsonPath("$.code").value("credential_unavailable"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_jobs WHERE workspace_id=? AND project_id=?",Long.class,Long.valueOf(f.ws()),Long.valueOf(f.project()))).isZero();
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"unknown-config","plain-password","secret-ref-value","embedded-url-secret","missing-profile","null-event","format-overflow"})
    void rejectsUnknownOrSecretNetworkDeclarationsAndNullEvents(String invalid)throws Exception{
        var f=fixture();var input=save(f);var config=new LinkedHashMap<String,Object>(Map.of("formatVersion",1,"profiles",List.of(),"environmentSelections",List.of()));
        if(invalid.equals("unknown-config"))config.put("privateValue","PRIVATE");
        if(invalid.equals("plain-password"))config.put("profiles",List.of(Map.of("kind","proxy","id","p","name","Proxy","targetTlsBindings",List.of(),"proxyUrl","https://proxy.test","password","PRIVATE")));
        if(invalid.equals("secret-ref-value"))config.put("profiles",List.of(Map.of("kind","proxy","id","p","name","Proxy","targetTlsBindings",List.of(),"proxyUrl","https://proxy.test","username","user","passwordRef",Map.of("id","pass","policy","test-auto","value","PRIVATE"))));
        if(invalid.equals("embedded-url-secret"))config.put("profiles",List.of(Map.of("kind","proxy","id","p","name","Proxy","targetTlsBindings",List.of(),"proxyUrl","https://user:PRIVATE@proxy.test")));
        if(invalid.equals("missing-profile"))config.put("projectSelection",Map.of("kind","profile","profileId","missing"));
        if(invalid.equals("format-overflow"))config.put("formatVersion",4294967297L);
        if(invalid.equals("null-event")){var events=new ArrayList<String>();events.add(null);input.put("notifications",Map.of("inApp",true,"eventKinds",events,"channelIds",List.of()));}
        else execution(input).put("network",Map.of("revision","1","configuration",config));
        member(f,post(f.url()+"/schedules"),input).andExpect(status().isBadRequest());
    }
    @Test void readsOnlyAuthorizedFixedSnapshotsWithinTheUrlProjectScope()throws Exception{
        var f=fixture();var other=fixture();
        member(f,get(f.url()+"/execution-snapshots/"+f.snapshot()),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.snapshotId").value(f.snapshot()));
        member(f,get(f.url()+"/execution-snapshots/"+other.snapshot()),Map.of()).andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("snapshot_scope_mismatch"));
    }
    @Test void acceptsTheSameProxyUsernameAndProjectSecretReferenceDeclarationAsCore()throws Exception{
        var f=fixture();member(f,put(f.url()+"/credentials/proxy-password"),Map.of("expectedVersion","0","value","PRIVATE-PROXY-PASSWORD")).andExpect(status().isOk());
        var input=save(f);execution(input).put("materials",Map.of("projectId",f.project(),"credentials",List.of(Map.of("refId","proxy-password","mode","current-at-trigger")),"attachments",List.of()));
        execution(input).put("network",Map.of("revision","network-1","configuration",Map.of("formatVersion",1,"profiles",List.of(Map.of("id","proxy","name","Proxy","kind","proxy","proxyUrl","https://proxy.test","username","user","passwordRef",Map.of("id","proxy-password","policy","test-auto"),"targetTlsBindings",List.of())),"projectSelection",Map.of("kind","profile","profileId","proxy"),"environmentSelections",List.of())));
        var view=body(member(f,post(f.url()+"/schedules"),input).andExpect(status().isCreated()));
        assertThat(view.path("execution").path("network").path("configuration").path("profiles").get(0).path("username").asText()).isEqualTo("user");assertThat(view.toString()).doesNotContain("PRIVATE-PROXY-PASSWORD");
    }
    @Test void rejectsNonCanonicalNumericProxyOriginsDuringAuthenticatedScheduleSave()throws Exception{
        var f=fixture();var input=save(f);
        execution(input).put("network",Map.of("revision","1","configuration",Map.of("formatVersion",1,"profiles",List.of(Map.of("id","p","name","Proxy","kind","proxy","proxyUrl","https://127.0.0.01","targetTlsBindings",List.of())),"projectSelection",Map.of("kind","profile","profileId","p"),"environmentSelections",List.of())));
        member(f,post(f.url()+"/schedules"),input).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("validation_failed"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedules WHERE workspace_id=? AND project_id=?",Long.class,Long.valueOf(f.ws()),Long.valueOf(f.project()))).isZero();
    }
    // Post-implementation coverage for the disclosed TDD sequencing exception; never RED evidence.
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"key-id","nonce","cipher-length","key-path","key-length","budget"})
    void postImplementationMetadataGuardsRejectUnavailableKeysEnvelopesAndInputBudgets(String invalid)throws Exception{
        var f=fixture();member(f,put(f.url()+"/credentials/api"),Map.of("expectedVersion","0","value","x".repeat(200))).andExpect(status().isOk());
        String original=scheduleExecutionProperties.getMaterials().getMasterKeyFile();java.nio.file.Path temporary=null;
        try{
            switch(invalid){
                case "key-id"->jdbc.update("UPDATE execution_project_credentials SET key_id='unknown-key' WHERE workspace_id=? AND project_id=? AND ref_id='api'",Long.valueOf(f.ws()),Long.valueOf(f.project()));
                case "nonce"->jdbc.update("UPDATE execution_project_credentials SET nonce=? WHERE workspace_id=? AND project_id=? AND ref_id='api'",new byte[11],Long.valueOf(f.ws()),Long.valueOf(f.project()));
                case "cipher-length"->jdbc.update("UPDATE execution_project_credentials SET ciphertext=? WHERE workspace_id=? AND project_id=? AND ref_id='api'",new byte[15],Long.valueOf(f.ws()),Long.valueOf(f.project()));
                case "key-path"->scheduleExecutionProperties.getMaterials().setMasterKeyFile(KEY.resolveSibling("absent-schedule-key-"+f.project()).toString());
                case "key-length"->{temporary=java.nio.file.Files.createTempFile("apicc-schedule-metadata-key-",".bin");java.nio.file.Files.write(temporary,new byte[31]);scheduleExecutionProperties.getMaterials().setMasterKeyFile(temporary.toString());}
                case "budget"->{String expected=jdbc.queryForObject("SELECT version FROM execution_configs WHERE scope_type='project' AND scope_id=?",String.class,Long.valueOf(f.project()));executionConfigs.saveProject(scheduleUsers.findByUsername("admin").orElseThrow(),f.ws(),f.project(),expected,Map.of("totalInputBytes",64,"snapshotBytes",64,"singleAttachmentBytes",64));}
            }
            var input=save(f);execution(input).put("materials",Map.of("projectId",f.project(),"credentials",List.of(Map.of("refId","api","mode","current-at-trigger")),"attachments",List.of()));
            var response=member(f,post(f.url()+"/schedules"),input);
            if(invalid.equals("budget"))response.andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("total_input_size_limit"));
            else response.andExpect(status().isServiceUnavailable()).andExpect(jsonPath("$.code").value("credential_unavailable"));
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedules WHERE workspace_id=? AND project_id=?",Long.class,Long.valueOf(f.ws()),Long.valueOf(f.project()))).isZero();
        }finally{scheduleExecutionProperties.getMaterials().setMasterKeyFile(original);if(temporary!=null)java.nio.file.Files.deleteIfExists(temporary);}
    }
}
