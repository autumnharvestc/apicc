package com.autumnharvestc.server.sync;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class SyncSourceApiTest extends SyncHttpFixture {
    @org.springframework.beans.factory.annotation.Autowired org.springframework.jdbc.core.JdbcTemplate jdbc;
    @Test void sourceCreationHasARealCallableEntry() throws Exception {
        sourceRequest("POST","/sources",f.owner(),write(sourceBody("url"))).andExpect(status().isCreated()).andExpect(jsonPath("$.revision").value("1"));
    }
    @Test void schemaAddsSixTablesIdempotentlyAndKeepsExistingAssets() throws Exception {
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='PUBLIC' AND table_name IN ('SYNC_SOURCES','SYNC_CHECKS','SYNC_CANDIDATES','SYNC_HISTORY','SYNC_OPERATIONS','SYNC_POLICIES')",Integer.class)).isEqualTo(6);
        try(var connection=jdbc.getDataSource().getConnection()) {
            var script=new org.springframework.core.io.ClassPathResource("schema.sql");
            org.springframework.jdbc.datasource.init.ScriptUtils.executeSqlScript(connection,script);
            org.springframework.jdbc.datasource.init.ScriptUtils.executeSqlScript(connection,script);
        }
        mvc.perform(get(f.projectUrl()+"/assets").header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk()).andExpect(jsonPath("$.version").value("1")).andExpect(jsonPath("$.files.length()").value(3));
    }
    @ParameterizedTest @ValueSource(strings={"url","git-https","git-ssh"})
    void savesStrictSourceAndListsExistingProjectWithoutExecuting(String kind) throws Exception {
        sourceRequest("GET","/sources",editor(),null).andExpect(status().isOk()).andExpect(content().json("[]"));
        var source=createSourceAsAdmin(kind);assertThat(source.path("revision").asText()).isEqualTo("1");
        assertThat(readSourceAsAdmin(source.path("id").asText())).isEqualTo(source);
        sourceRequest("GET","/sources",editor(),null).andExpect(status().isOk()).andExpect(jsonPath("$.length()").value(1));
        var updated=body(sourceRequest("PUT","/sources/"+source.path("id").asText(),f.owner(),sourceUpdateBody(source)).andExpect(status().isOk()).andExpect(jsonPath("$.revision").value("2")));
        assertThat(readSourceAsAdmin(source.path("id").asText())).isEqualTo(updated);
        mvc.perform(get(f.projectUrl()+"/assets").header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk()).andExpect(jsonPath("$.version").value("1")).andExpect(jsonPath("$.files.length()").value(3));
    }
    @Test void removedAndRejoinedMemberCannotRecoverDelegatedManage() throws Exception {
        var source=createSourceAsAdmin("url");capabilities("ADMIN",Map.of("sync.manage","allow"));
        sourceRequest("PUT","/sources/"+source.path("id").asText(),editor(),sourceUpdateBody(source)).andExpect(status().isOk());
        mvc.perform(delete(f.workspaceUrl()+"/members/"+editor().id()).param("expectedRevision","1").header("Authorization","Bearer "+f.owner().token())).andExpect(status().isNoContent());
        member(f,"EDITOR",2).andExpect(status().isOk());
        sourceRequest("GET","/sources",editor(),null).andExpect(status().isForbidden());
    }
    @ParameterizedTest @ValueSource(strings={"route","next"})
    void sourceIdentityMustMatchRouteAndNextRevision(String kind) throws Exception {
        var source=createSourceAsAdmin("url");var request=sourceUpdateBody(source);
        ((ObjectNode)request.get("source")).put(kind.equals("route")?"id":"revision",kind.equals("route")?UUID.randomUUID().toString():"3");
        sourceRequest("PUT","/sources/"+source.path("id").asText(),f.owner(),request).andExpect(kind.equals("route")?status().isBadRequest():status().isConflict());
    }
    @ParameterizedTest @ValueSource(strings={"secret","unknown"})
    void rejectsSecretBearingSourceAndUnknownControlFields(String kind) throws Exception {
        var request=write(sourceBody("url"));
        if(kind.equals("secret"))((ObjectNode)request.get("source")).put("password","synthetic-secret");else request.put("localPath","C:/private/key");
        sourceRequest("POST","/sources",f.owner(),request).andExpect(status().isBadRequest()).andExpect(content().string(org.hamcrest.Matchers.not(org.hamcrest.Matchers.containsString("synthetic-secret"))));
    }
    @Test void cannotOverwriteSameSourceIdUsingCreateRevisionZero() throws Exception {
        var source=createSourceAsAdmin("url");var fresh=sourceBody("url").put("id",source.path("id").asText()).put("url","https://other.test/spec");
        sourceRequest("POST","/sources",f.owner(),write(fresh)).andExpect(status().isConflict());
        assertThat(readSourceAsAdmin(source.path("id").asText())).isEqualTo(source);
    }
    @Test void editorWithoutDelegatedManageCannotChangeASource() throws Exception {
        var source=createSourceAsAdmin("git-ssh");
        sourceRequest("PUT","/sources/"+source.path("id").asText(),editor(),sourceUpdateBody(source)).andExpect(status().isForbidden());
        assertThat(readSourceAsAdmin(source.path("id").asText())).isEqualTo(source);
    }
    @Test void delegatedManageWorksAndExplicitDenyOverridesIt() throws Exception {
        var source=createSourceAsAdmin("url");capabilities(null,Map.of("sync.manage","allow"));
        var updated=body(sourceRequest("PUT","/sources/"+source.path("id").asText(),editor(),sourceUpdateBody(source)).andExpect(status().isOk()));
        assertThat(updated.path("revision").asText()).isEqualTo("2");capabilities(null,Map.of("sync.manage","deny"));
        sourceRequest("PUT","/sources/"+source.path("id").asText(),editor(),sourceUpdateBody(updated)).andExpect(status().isForbidden());
    }
    @ParameterizedTest @ValueSource(strings={"VIEWER","NONE"})
    void viewerCannotCrossRoleFloorAndNoneCannotRead(String role) throws Exception {
        var source=createSourceAsAdmin("url");capabilities(role,Map.of("sync.manage",role.equals("VIEWER")?"allow":"inherit"));
        if(role.equals("VIEWER")){sourceRequest("GET","/sources",editor(),null).andExpect(status().isOk());sourceRequest("PUT","/sources/"+source.path("id").asText(),editor(),sourceUpdateBody(source)).andExpect(status().isForbidden());}
        else sourceRequest("GET","/sources",editor(),null).andExpect(status().isForbidden());
    }
    @ParameterizedTest @ValueSource(strings={"source","project"})
    void staleSourceAndProjectRevisionCannotOverwrite(String kind) throws Exception {
        var source=createSourceAsAdmin("url");var updated=body(sourceRequest("PUT","/sources/"+source.path("id").asText(),f.owner(),sourceUpdateBody(source)).andExpect(status().isOk()));
        var stale=sourceUpdateBody(kind.equals("source")?source:updated);if(kind.equals("project"))stale.put("expectedAssetVersion","0");
        sourceRequest("PUT","/sources/"+source.path("id").asText(),f.owner(),stale).andExpect(status().isConflict());
        assertThat(readSourceAsAdmin(source.path("id").asText())).isEqualTo(updated);
    }
    @Test void validSecondModuleStillCannotRebindExistingIdentity() throws Exception {
        var source=createSourceAsAdmin("url");var request=sourceUpdateBody(source);((ObjectNode)request.get("source")).put("moduleId",secondModule);
        sourceRequest("PUT","/sources/"+source.path("id").asText(),f.owner(),request).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("SYNC_SOURCE_MODULE_CHANGE_UNSUPPORTED"));
    }
    @ParameterizedTest @ValueSource(strings={"duplicate","module"})
    void duplicateUpstreamAndAbsentModuleAreRejected(String kind) throws Exception {
        createSourceAsAdmin("url");var next=sourceBody("url");
        if(kind.equals("module"))next.put("url","https://other.test/spec").put("moduleId",UUID.randomUUID().toString());
        sourceRequest("POST","/sources",f.owner(),write(next)).andExpect(status().isConflict());
    }
    @ParameterizedTest @ValueSource(strings={"-1","01"})
    void rejectsNonCanonicalOrOutOfRangeSourceRevision(String revision) throws Exception {
        var source=createSourceAsAdmin("url");var request=sourceUpdateBody(source);((ObjectNode)request.get("source")).put("revision",revision);
        sourceRequest("PUT","/sources/"+source.path("id").asText(),f.owner(),request).andExpect(status().isBadRequest());
    }
    @Test void stableIntentReplaysOnceAndRejectsDifferentPayload() throws Exception {
        var request=write(sourceBody("url"));var first=body(sourceRequest("POST","/sources",f.owner(),request).andExpect(status().isCreated()));
        assertThat(body(sourceRequest("POST","/sources",f.owner(),request).andExpect(status().isCreated()))).isEqualTo(first);
        ((ObjectNode)request.get("source")).put("url","https://different.test/spec");sourceRequest("POST","/sources",f.owner(),request).andExpect(status().isConflict());
    }

    @Test void workspaceDenyOverridesProjectDelegation() throws Exception {
        var source=createSourceAsAdmin("url");capabilities(null,Map.of("sync.manage","allow"));
        mvc.perform(put(f.workspaceUrl()+"/access-members/"+editor().id()).header("Authorization","Bearer "+f.owner().token()).contentType("application/json").content("{\"expectedRevision\":1,\"capabilities\":{\"sync.manage\":\"deny\"}}")).andExpect(status().isOk());
        sourceRequest("PUT","/sources/"+source.path("id").asText(),editor(),sourceUpdateBody(source)).andExpect(status().isForbidden());
    }
    @ParameterizedTest @ValueSource(strings={"read","update"})
    void missingSourceReadHasExplicitFailure(String kind) throws Exception {
        createSourceAsAdmin("url");var source=sourceBody("url");
        sourceRequest(kind.equals("read")?"GET":"PUT","/sources/"+source.path("id").asText(),f.owner(),kind.equals("read")?null:write(source)).andExpect(status().isNotFound());
    }
    @Test void omittedScheduleReturnsTheAcceptedDisabledHourlyUtcDefault() throws Exception {
        var source=sourceBody("url");source.remove("schedule");
        sourceRequest("POST","/sources",f.owner(),write(source)).andExpect(status().isCreated()).andExpect(jsonPath("$.schedule.enabled").value(false)).andExpect(jsonPath("$.schedule.rule.expression").value("0 0 * * * *")).andExpect(jsonPath("$.schedule.rule.timeZone").value("UTC"));
    }
    @Test void revisionsBeyondLongRemainCanonicalDecimalStrings() throws Exception {
        var source=(ObjectNode)createSourceAsAdmin("url");source.put("revision","9223372036854775808");
        jdbc.update("UPDATE sync_sources SET source_revision=?,source_json=? WHERE workspace_id=? AND project_id=? AND id=?",source.path("revision").asText(),source.toString(),Long.parseLong(f.workspace()),Long.parseLong(f.project()),source.path("id").asText());
        sourceRequest("PUT","/sources/"+source.path("id").asText(),f.owner(),sourceUpdateBody(source)).andExpect(status().isOk()).andExpect(jsonPath("$.revision").value("9223372036854775809"));
    }

    @org.springframework.beans.factory.annotation.Autowired SyncSourceService sources;
    @org.springframework.beans.factory.annotation.Autowired com.autumnharvestc.server.store.UserRepo users;
    @Test void expectedAssetVersionPreservesTheExistingBigintUpperBound() throws Exception {
        var source=createSourceAsAdmin("url");
        sourceRequest("PUT","/sources/"+source.path("id").asText(),f.owner(),sourceUpdateBody(source).put("expectedAssetVersion","9223372036854775808")).andExpect(status().isBadRequest());
    }
    @Test void sourceIdentityDoesNotCrossAnOtherwiseAccessibleProject() throws Exception {
        var source=createSourceAsAdmin("url");String other=anotherProject();
        mvc.perform(get(f.workspaceUrl()+"/projects/"+other+"/sync/sources/"+source.path("id").asText()).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isNotFound());
        assertThat(readSourceAsAdmin(source.path("id").asText())).isEqualTo(source);
    }
    @Test void persistedDisabledIdentityIsDeniedEvenWithAPreviouslyCapturedActor() throws Exception {
        var source=createSourceAsAdmin("url");var actor=users.findById(Long.parseLong(editor().id())).orElseThrow();
        assertThat(sources.list(actor,f.workspace(),f.project())).hasSize(1);users.setDisabled(actor.id(),true);
        org.assertj.core.api.Assertions.assertThatThrownBy(()->sources.list(actor,f.workspace(),f.project())).isInstanceOfSatisfying(com.autumnharvestc.server.core.ApiException.class,e->assertThat(e.getStatus().value()).isEqualTo(403));
    }

    @Test void sourceIntentCannotBeReplayedByAnotherOtherwiseAuthorizedActor() throws Exception {
        var request=write(sourceBody("url"));sourceRequest("POST","/sources",f.owner(),request).andExpect(status().isCreated());
        capabilities(null,Map.of("sync.manage","allow"));sourceRequest("GET","/sources",editor(),null).andExpect(status().isOk());
        sourceRequest("POST","/sources",editor(),request).andExpect(status().isForbidden());
    }
    @Test void concurrentSourceWritesHaveOneWinner() throws Exception {
        var source=createSourceAsAdmin("url");var left=sourceUpdateBody(source);var right=sourceUpdateBody(source);
        ((ObjectNode)left.get("source")).put("url","https://left.test/spec");((ObjectNode)right.get("source")).put("url","https://right.test/spec");
        try(var pool=java.util.concurrent.Executors.newFixedThreadPool(2)){
            var start=new java.util.concurrent.CountDownLatch(1);
            var a=pool.submit(()->{start.await();return sourceRequest("PUT","/sources/"+source.path("id").asText(),f.owner(),left).andReturn().getResponse().getStatus();});
            var b=pool.submit(()->{start.await();return sourceRequest("PUT","/sources/"+source.path("id").asText(),f.owner(),right).andReturn().getResponse().getStatus();});
            start.countDown();assertThat(List.of(a.get(10,java.util.concurrent.TimeUnit.SECONDS),b.get(10,java.util.concurrent.TimeUnit.SECONDS))).containsExactlyInAnyOrder(200,409);
        }
    }
    @Test void sourceMutationIsAuditedOnceWithoutCopyingConfiguration() throws Exception {
        var request=write(sourceBody("url"));sourceRequest("POST","/sources",f.owner(),request).andExpect(status().isCreated());sourceRequest("POST","/sources",f.owner(),request).andExpect(status().isCreated());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_management_audit WHERE actor_id=? AND scope_type='project' AND scope_id=? AND action='sync.source.save'",Integer.class,Long.parseLong(f.owner().id()),Long.parseLong(f.project()))).isEqualTo(1);
    }
    @Test void sameUpstreamMayBindADifferentTargetModule() throws Exception {
        createSourceAsAdmin("url");
        sourceRequest("POST","/sources",f.owner(),write(sourceBody("url").put("moduleId",secondModule))).andExpect(status().isCreated());
        sourceRequest("GET","/sources",f.owner(),null).andExpect(status().isOk()).andExpect(jsonPath("$.length()").value(2));
    }}
