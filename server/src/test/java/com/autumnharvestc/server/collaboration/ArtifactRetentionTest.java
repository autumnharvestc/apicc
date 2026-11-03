package com.autumnharvestc.server.collaboration;

import com.autumnharvestc.server.collaboration.artifacts.CollaborationStorage;
import com.autumnharvestc.server.collaboration.artifacts.StorageTypes.*;
import com.autumnharvestc.server.collaboration.policy.DeploymentPolicyProperties;
import com.autumnharvestc.server.core.Hashes;
import com.fasterxml.jackson.databind.JsonNode;
import java.nio.charset.StandardCharsets;
import java.sql.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.TestPropertySource;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import static org.junit.jupiter.api.Assertions.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** Real storage/HTTP/transactions. The only double is the existing private external Core RPC. */
@TestPropertySource(properties="spring.datasource.url=jdbc:h2:mem:apicc-collaboration-t6-storage;DB_CLOSE_DELAY=-1")
class ArtifactRetentionTest extends ArtifactHttpFixture {
    @Autowired CollaborationStorage storage;
    @Autowired DeploymentPolicyProperties deployment;
    @Autowired PlatformTransactionManager transactionManager;
    final Map<String,Object> defaults=new LinkedHashMap<>(),limits=new LinkedHashMap<>();
    static final long MIB=1048576,DAY=86400000;
    // This class owns only its synthetic in-memory database, never evidence or external data.
    @BeforeEach void resetStorageFixture(){
        assertTrue(Boolean.TRUE.equals(jdbc.execute((org.springframework.jdbc.core.ConnectionCallback<Boolean>)connection->connection.getMetaData().getURL().startsWith("jdbc:h2:mem:apicc-collaboration-t6-storage"))),"test cleanup is restricted to this class's synthetic in-memory database");
        for(String trigger:List.of("t6_audit_fault","t6_read_barrier","t6_delete_barrier"))jdbc.execute("DROP TRIGGER IF EXISTS "+trigger);AuditFault.attempts.set(0);ReadBarrier.armed=false;DeleteBarrier.armed=false;
        for(String table:List.of("collaboration_storage_references","collaboration_storage_objects","collaboration_storage_accounts","collaboration_management_audit","collaboration_previews","collaboration_publications","collaboration_publication_versions","collaboration_policy"))jdbc.update("DELETE FROM "+table);
        defaults.clear();limits.clear();deployment.setDefaults(null);deployment.setDeployment(null);deployment.setResources(null);
    }
    @AfterEach void removeFault(){ReadBarrier.release.countDown();DeleteBarrier.release.countDown();for(String trigger:List.of("t6_audit_fault","t6_read_barrier","t6_delete_barrier"))jdbc.execute("DROP TRIGGER IF EXISTS "+trigger);deployment.setDefaults(null);deployment.setDeployment(null);deployment.setResources(null);}
    void defaults(Map<String,?> changes){defaults.putAll(changes);deployment.setDefaults(json.convertValue(defaults,DeploymentPolicyProperties.Defaults.class));}
    void limits(Map<String,?> changes){limits.putAll(changes);deployment.setDeployment(json.convertValue(limits,DeploymentPolicyProperties.Deployment.class));}
    StoredKey key(JsonNode publication){return new StoredKey(Kind.ARTIFACT,Long.parseLong(publication.path("id").asText()));}
    Usage usage(Fixture f){return storage.usage(Long.parseLong(f.workspace()),Long.parseLong(f.project()));}
    JsonNode fixed(Fixture f)throws Exception{return publish(f,preview(f,f.owner(),documentRequest(f)),UUID.randomUUID().toString());}
    JsonNode sized(Fixture f,int bytes)throws Exception{
        var input=documentRequest(f).put("title","");var control=preview(f,f.owner(),input);
        int overhead=json.writeValueAsBytes(control.path("artifact")).length;
        return preview(f,f.owner(),documentRequest(f).put("title","x".repeat(bytes-overhead)));
    }
    void response(org.springframework.mock.web.MockHttpServletResponse value,int status,String code)throws Exception{
        var result=value.getContentAsByteArray().length==0?json.createObjectNode():json.readTree(value.getContentAsByteArray());
        assertAll(()->assertEquals(status,value.getStatus()),()->assertEquals(code,result.path("code").asText("missing")));
    }
    Map<String,Object> snapshot(Fixture f){
        long ws=Long.parseLong(f.workspace()),project=Long.parseLong(f.project());var result=new TreeMap<String,Object>();
        for(String table:List.of("collaboration_previews","collaboration_publications","collaboration_storage_objects","collaboration_storage_references","collaboration_management_audit"))result.put(table,jdbc.queryForObject("SELECT COUNT(*) FROM "+table+" WHERE workspace_id=? AND project_id=?",Long.class,ws,project));
        result.put("usage",usage(f));result.put("global",storage.usage(0,0));
        result.put("preview-states",jdbc.queryForList("SELECT id,state FROM collaboration_previews WHERE workspace_id=? AND project_id=? ORDER BY id",ws,project));
        result.put("policy",jdbc.queryForList("SELECT revision,projection_revision FROM collaboration_policy WHERE workspace_id=? AND project_id=?",ws,project));
        result.put("project-count",jdbc.queryForObject("SELECT COUNT(*) FROM projects WHERE id=?",Long.class,project));
        result.put("source-count",jdbc.queryForObject("SELECT COUNT(*) FROM file_versions WHERE workspace_id=? AND path LIKE ?",Long.class,ws,project+"/%"));return result;
    }
    public static class AuditFault implements org.h2.api.Trigger {
        static final AtomicInteger attempts=new AtomicInteger();
        @Override public void fire(Connection connection,Object[] oldRow,Object[] newRow)throws SQLException{attempts.incrementAndGet();throw new SQLException("Synthetic reached collaboration audit insertion fault","45000");}
    }
    void auditFault(){AuditFault.attempts.set(0);jdbc.execute("CREATE TRIGGER t6_audit_fault BEFORE INSERT ON collaboration_management_audit FOR EACH ROW CALL '"+AuditFault.class.getName()+"'");}
    public static class ReadBarrier implements org.h2.api.Trigger {
        static volatile boolean armed;static volatile long project;static volatile CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1);
        @Override public void fire(Connection connection,Object[] oldRow,Object[] newRow)throws SQLException{
            if(!armed)return;armed=false;try(var statement=connection.prepareStatement("SELECT id FROM projects WHERE id=? FOR UPDATE")){statement.setLong(1,project);try(var rows=statement.executeQuery()){if(!rows.next())throw new SQLException("Synthetic reader project missing");}}
            entered.countDown();try{if(!release.await(20,TimeUnit.SECONDS))throw new SQLException("Synthetic actual reader SQL barrier timed out");}catch(InterruptedException interrupted){Thread.currentThread().interrupt();throw new SQLException(interrupted);}
        }
    }
    public static class DeleteBarrier implements org.h2.api.Trigger {
        static volatile boolean armed,hold;static volatile CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1);
        @Override public void fire(Connection connection,Object[] oldRow,Object[] newRow)throws SQLException{
            if(!armed)return;armed=false;entered.countDown();if(hold)try{if(!release.await(20,TimeUnit.SECONDS))throw new SQLException("Synthetic actual DELETE SQL barrier timed out");}catch(InterruptedException interrupted){Thread.currentThread().interrupt();throw new SQLException(interrupted);}
        }
    }
    boolean observedWaitOrCompletion(Future<?> operation,CountDownLatch progressed,boolean gatesOnly)throws Exception{
        long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
        while(System.nanoTime()<end){String filter=gatesOnly?" AND (LOWER(EXECUTING_STATEMENT) LIKE '%access_mutation_gate%' OR LOWER(EXECUTING_STATEMENT) LIKE '%collaboration_policy_gate%')":"";
            if(jdbc.queryForObject("SELECT COUNT(*) FROM INFORMATION_SCHEMA.SESSIONS WHERE BLOCKER_ID IS NOT NULL"+filter,Integer.class)>0)return true;
            if(operation.isDone()||progressed.getCount()==0)return false;Thread.sleep(10); // Poll observed SQL/trigger state, never infer ordering from elapsed sleep.
        }return false;
    }
    long reservationWitness()throws Exception{
        long maximum=0;for(Action action:List.of(Action.PREVIEW_CANCELLED,Action.PREVIEW_RECLAIMED))for(Reason reason:Reason.values())maximum=Math.max(maximum,json.writeValueAsBytes(new AuditEvent(action,reason,Long.MIN_VALUE,Long.MIN_VALUE,Long.MIN_VALUE,Kind.PREVIEW,Long.MIN_VALUE,Long.MIN_VALUE,Long.MIN_VALUE)).length);return 2*maximum;
    }
    void assignReservation(Fixture f,long id,long amount){
        new TransactionTemplate(transactionManager).executeWithoutResult(tx->{long previous=jdbc.queryForObject("SELECT reserved_bytes FROM collaboration_storage_objects WHERE kind='PREVIEW' AND object_id=?",Long.class,id);jdbc.update("UPDATE collaboration_storage_objects SET reserved_bytes=? WHERE kind='PREVIEW' AND object_id=?",amount,id);jdbc.update("UPDATE collaboration_storage_accounts SET reserved_bytes=reserved_bytes+? WHERE (workspace_id=0 AND project_id=0) OR (workspace_id=? AND project_id=?)",amount-previous,Long.parseLong(f.workspace()),Long.parseLong(f.project()));});
    }

    @Test void storageNormalCopiesAndAliasesHaveExactActualCharges()throws Exception{
        var f=fixture();var candidate=preview(f,f.owner(),documentRequest(f));var publication=publish(f,candidate,UUID.randomUUID().toString());
        long candidateId=Long.parseLong(candidate.path("id").asText()),publicationId=Long.parseLong(publication.path("id").asText());
        byte[] first=jdbc.queryForObject("SELECT body FROM collaboration_previews WHERE id=?",byte[].class,candidateId),second=jdbc.queryForObject("SELECT body FROM collaboration_publications WHERE id=?",byte[].class,publicationId);
        assertTrue(Arrays.equals(first,second),"two complete real stored copies");var before=usage(f);long owner=Long.parseLong(preview(f,f.owner(),documentRequest(f)).path("id").asText());var withOwner=usage(f);
        storage.retain(Long.parseLong(f.owner().id()),Long.parseLong(f.workspace()),Long.parseLong(f.project()),key(publication),Owner.candidate(owner));
        var after=usage(f);long bodyBytes=jdbc.queryForObject("SELECT COALESCE(SUM(body_bytes),0) FROM collaboration_storage_objects WHERE workspace_id=? AND project_id=?",Long.class,Long.parseLong(f.workspace()),Long.parseLong(f.project()));
        long metadataBytes=jdbc.queryForObject("SELECT COALESCE(SUM(metadata_bytes),0) FROM collaboration_storage_objects WHERE workspace_id=? AND project_id=?",Long.class,Long.parseLong(f.workspace()),Long.parseLong(f.project()));
        long actualMetadata=jdbc.query("SELECT metadata_json FROM collaboration_storage_objects WHERE workspace_id=? AND project_id=?",(row,index)->(long)row.getString(1).getBytes(StandardCharsets.UTF_8).length,Long.parseLong(f.workspace()),Long.parseLong(f.project())).stream().mapToLong(Long::longValue).sum();
        assertAll(()->assertEquals(1,before.previewCount()),()->assertEquals(1,before.artifactCount()),()->assertEquals(0,before.pendingPreviews()),()->assertEquals(first.length+second.length,before.bodyBytes()),()->assertTrue(before.reservedAuditBytes()>0,"real finite release reservations"),()->assertEquals(withOwner.bodyBytes(),after.bodyBytes(),"alias is not another physical body"),()->assertEquals(bodyBytes,after.bodyBytes()),()->assertEquals(actualMetadata,metadataBytes,"actual canonical metadata UTF8, not declared sizes"),()->assertEquals(bodyBytes+metadataBytes,after.actualBytes()),()->assertEquals(after.actualBytes(),storage.usage(0,0).actualBytes()),()->assertEquals(after.reservedAuditBytes(),storage.usage(0,0).reservedAuditBytes()));
    }
    @ParameterizedTest @ValueSource(booleans={false,true}) void storagePendingCountsReleaseButRetainedBytesDoNot(boolean commit)throws Exception{
        var f=fixture();var candidate=preview(f,f.owner(),documentRequest(f));var before=usage(f);assertEquals(1,before.pendingPreviews());
        if(commit)publish(f,candidate,UUID.randomUUID().toString());else request(f.owner().token(),delete(collaboration(f)+"/previews/"+candidate.path("id").asText()),Map.of()).andExpect(status().isNoContent());
        var after=usage(f);assertAll(()->assertEquals(0,after.pendingPreviews()),()->assertEquals(1,after.previewCount()),()->assertTrue(after.bodyBytes()>=before.bodyBytes(),"retained real body stays charged"));
    }
    @Test void storageReleaseReservationCoversFiniteAuditDomain()throws Exception{
        var f=fixture();var candidate=preview(f,f.owner(),documentRequest(f));long id=Long.parseLong(candidate.path("id").asText());long actual=jdbc.queryForObject("SELECT reserved_bytes FROM collaboration_storage_objects WHERE kind='PREVIEW' AND object_id=?",Long.class,id);
        long maximum=0;for(Action action:List.of(Action.PREVIEW_CANCELLED,Action.PREVIEW_RECLAIMED))for(Reason reason:Reason.values()){
            var witness=new AuditEvent(action,reason,Long.MIN_VALUE,Long.MIN_VALUE,Long.MIN_VALUE,Kind.PREVIEW,Long.MIN_VALUE,Long.MIN_VALUE,Long.MIN_VALUE);maximum=Math.max(maximum,json.writeValueAsBytes(witness).length);
        }
        assertTrue(actual>=2*maximum,"two owner-bound finite UTF8 release frames cover full signed millisecond/numeric width, not guessed ISO length");
    }
    @Test void storageOwnedAuditReservationCannotBorrowAnotherOwner()throws Exception{
        var f=fixture();var control=preview(f,f.owner(),documentRequest(f));var target=preview(f,f.owner(),documentRequest(f));var side=preview(f,f.owner(),documentRequest(f));long controlId=Long.parseLong(control.path("id").asText()),targetId=Long.parseLong(target.path("id").asText()),sideId=Long.parseLong(side.path("id").asText());long frame=reservationWitness();
        assignReservation(f,controlId,frame);assignReservation(f,targetId,frame);assignReservation(f,sideId,frame);request(f.owner().token(),delete(collaboration(f)+"/previews/"+controlId),Map.of()).andExpect(status().isNoContent());
        assignReservation(f,targetId,0);long sideReserved=jdbc.queryForObject("SELECT reserved_bytes FROM collaboration_storage_objects WHERE kind='PREVIEW' AND object_id=?",Long.class,sideId);assertTrue(sideReserved>0,"other real owner has its own stored, counted reserve");var before=snapshot(f);
        var result=request(f.owner().token(),delete(collaboration(f)+"/previews/"+targetId),Map.of()).andReturn().getResponse();assertAll(()->response(result,409,"collaboration_audit_reservation_exhausted"),()->assertEquals(before,snapshot(f)),()->assertEquals(sideReserved,jdbc.queryForObject("SELECT reserved_bytes FROM collaboration_storage_objects WHERE kind='PREVIEW' AND object_id=?",Long.class,sideId)));
    }
    @Test void storageAuditRetentionReleasesOnlyItsOwnLedger()throws Exception{
        defaults(Map.of("managementAuditRetentionMs",7*DAY));var f=fixture();policy(f,false,Map.of("maxProjectVersions",900));long auditId=jdbc.queryForObject("SELECT id FROM collaboration_management_audit WHERE workspace_id=? AND project_id=?",Long.class,Long.parseLong(f.workspace()),Long.parseLong(f.project()));var before=usage(f);var revision=jdbc.queryForList("SELECT revision,projection_revision FROM collaboration_policy WHERE workspace_id=? AND project_id=?",Long.parseLong(f.workspace()),Long.parseLong(f.project()));assertEquals(0,before.previewCount());assertEquals(0,before.artifactCount());assertTrue(before.auditBytes()>0);
        artifactTime.advance(7*DAY-1);storage.cleanup(Long.parseLong(f.workspace()),Long.parseLong(f.project()));assertEquals(1,jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_management_audit WHERE id=?",Long.class,auditId),"not yet eligible actual policy audit remains");artifactTime.advance(1);storage.cleanup(Long.parseLong(f.workspace()),Long.parseLong(f.project()));var after=usage(f);
        assertAll(()->assertEquals(0,jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_management_audit WHERE id=?",Long.class,auditId)),()->assertEquals(0,jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_storage_objects WHERE kind='AUDIT' AND object_id=?",Long.class,auditId)),()->assertEquals(0,after.auditBytes()),()->assertEquals(before.actualBytes()-before.auditBytes(),after.actualBytes()),()->assertEquals(revision,jdbc.queryForList("SELECT revision,projection_revision FROM collaboration_policy WHERE workspace_id=? AND project_id=?",Long.parseLong(f.workspace()),Long.parseLong(f.project()))));
    }
    @ParameterizedTest @ValueSource(longs={599999,600000}) void storagePendingPreviewCleanupHonorsActualTtl(long elapsed)throws Exception{
        var f=fixture();var candidate=preview(f,f.owner(),documentRequest(f));artifactTime.advance(elapsed);storage.cleanup(Long.parseLong(f.workspace()),Long.parseLong(f.project()));
        var result=mvc.perform(get(collaboration(f)+"/previews/"+candidate.path("id").asText()).header("Authorization","Bearer "+f.owner().token())).andReturn().getResponse();
        if(elapsed==599999)assertAll(()->assertEquals(200,result.getStatus()),()->assertTrue(candidate.path("artifact").equals(json.readTree(result.getContentAsByteArray()).path("artifact"))));else response(result,410,"preview_expired");
    }
    @ParameterizedTest @ValueSource(strings={"person","project","global"}) void storagePreviewCapacityIsCurrentAndAtomic(String kind)throws Exception{
        defaults(Map.of(kind.equals("person")?"maxPreviewsPerPerson":"maxPreviewsPerProject",1));if(kind.equals("global")){defaults(Map.of("maxPreviewsPerProject",20));limits(Map.of("maxPreviewsGlobal",1));}
        var f=fixture();preview(f,f.owner(),documentRequest(f));Actor actor=f.owner();Fixture target=f;
        if(kind.equals("project")){capability(f,f.editor(),"publication.manage","allow");actor=f.editor();}if(kind.equals("global")){target=fixture();actor=target.owner();}
        var before=storage.usage(0,0);long count=previewCount(target);var result=request(actor.token(),post(collaboration(target)+"/previews"),documentRequest(target)).andReturn().getResponse();
        Fixture chosen=target;assertAll(()->response(result,409,"collaboration_preview_limit"),()->assertEquals(before,storage.usage(0,0)),()->assertEquals(count,previewCount(chosen)));
    }
    @Test void storageConcurrentLastPreviewSlotHasOneWinner()throws Exception{
        defaults(Map.of("maxPreviewsPerPerson",1));var f=fixture();var start=new CountDownLatch(1);
        try(var pool=Executors.newFixedThreadPool(2)){
            var a=pool.submit(()->{start.await();return request(f.owner().token(),post(collaboration(f)+"/previews"),documentRequest(f)).andReturn().getResponse().getStatus();});
            var b=pool.submit(()->{start.await();return request(f.owner().token(),post(collaboration(f)+"/previews"),documentRequest(f)).andReturn().getResponse().getStatus();});start.countDown();
            int left=a.get(10,TimeUnit.SECONDS),right=b.get(10,TimeUnit.SECONDS);assertAll(()->assertThat(List.of(left,right)).containsExactlyInAnyOrder(201,409),()->assertEquals(1,previewCount(f)),()->assertEquals(1,usage(f).pendingPreviews()));
        }
    }
    @Test void storageVersionLimitRejectsWithoutPartialWrite()throws Exception{
        defaults(Map.of("maxProjectVersions",1));var f=fixture();var first=fixed(f);var next=preview(f,f.owner(),documentRequest(f));var before=snapshot(f);
        var result=request(f.owner().token(),post(collaboration(f)+"/publications"),confirmation(next,UUID.randomUUID().toString())).andReturn().getResponse();
        assertAll(()->response(result,409,"collaboration_version_limit"),()->assertEquals(before,snapshot(f)),()->assertEquals(first.path("digest"),publication(f,f.viewer(),first.path("id").asText()).path("digest")));
    }
    @ParameterizedTest @ValueSource(strings={"project","deployment"}) void storageProjectAndDeploymentByteLimitsUseActualCopies(String scope)throws Exception{
        var f=fixture();if(scope.equals("project")){
            defaults(Map.of("maxProjectStorageBytes",8*MIB));var candidate=sized(f,5*(int)MIB);var before=snapshot(f);
            var result=request(f.owner().token(),post(collaboration(f)+"/publications"),confirmation(candidate,UUID.randomUUID().toString())).andReturn().getResponse();assertAll(()->response(result,409,"collaboration_storage_limit"),()->assertEquals(before,snapshot(f)));
        }else{
            defaults(Map.of("maxPreviewsPerPerson",20));for(int index=0;index<8;index++)sized(f,8*(int)MIB);
            var full=storage.usage(0,0);assertTrue(full.occupiedBytes()>=64*MIB,"actual body+metadata reaches legal deployment minimum");limits(Map.of("deploymentMaxStorageBytes",full.occupiedBytes()));
            var result=request(f.owner().token(),post(collaboration(f)+"/previews"),documentRequest(f)).andReturn().getResponse();assertAll(()->response(result,409,"collaboration_storage_limit"),()->assertEquals(full,storage.usage(0,0)));
        }
    }
    @Test void storageArtifactActualBytesExactAndPlusOne()throws Exception{
        defaults(Map.of("maxArtifactBytes",65536,"maxEvidenceBytes",4096,"maxFieldBytes",256));var f=fixture();var exact=sized(f,65536);assertEquals(65536,json.writeValueAsBytes(exact.path("artifact")).length);
        var input=documentRequest(f).put("title",exact.path("artifact").path("title").asText()+"x");long before=previewCount(f);var result=request(f.owner().token(),post(collaboration(f)+"/previews"),input).andReturn().getResponse();assertAll(()->response(result,409,"artifact_size_limit"),()->assertEquals(before,previewCount(f)));
    }
    @Test void storageReadRejectsActualOversizeBeforeReturningBody()throws Exception{
        defaults(Map.of("maxArtifactBytes",65536,"maxEvidenceBytes",4096,"maxFieldBytes",256));var f=fixture();var published=fixed(f);publication(f,f.viewer(),published.path("id").asText());var body=(com.fasterxml.jackson.databind.node.ObjectNode)published.path("artifact").deepCopy();body.put("title","x".repeat(65537));
        jdbc.update("UPDATE collaboration_publications SET body=? WHERE id=?",json.writeValueAsBytes(body),key(published).id());var result=mvc.perform(get(collaboration(f)+"/publications/"+published.path("id").asText()).header("Authorization","Bearer "+f.viewer().token())).andReturn().getResponse();response(result,409,"artifact_size_limit");
    }
    @ParameterizedTest @ValueSource(strings={"preview","confirm","cancel","policy","project-delete","cleanup","reference"}) void storageAuditFaultRollsBack(String action)throws Exception{
        var f=fixture();var published=fixed(f);var candidate=preview(f,f.owner(),documentRequest(f));
        if(action.equals("cleanup"))artifactTime.advance(31*DAY);var before=snapshot(f);auditFault();
        try{
            switch(action){case "preview"->request(f.owner().token(),post(collaboration(f)+"/previews"),documentRequest(f));case "confirm"->request(f.owner().token(),post(collaboration(f)+"/publications"),confirmation(candidate,UUID.randomUUID().toString()));case "cancel"->request(f.owner().token(),delete(collaboration(f)+"/previews/"+candidate.path("id").asText()),Map.of());
                case "policy"->request(f.owner().token(),put(collaboration(f)+"/policy"),Map.of("expectedRevision",0,"settings",Map.of("maxProjectVersions",900)));case "project-delete"->request(f.owner().token(),delete(f.url()),Map.of());
                case "cleanup"->storage.cleanup(Long.parseLong(f.workspace()),Long.parseLong(f.project()));case "reference"->storage.retain(Long.parseLong(f.owner().id()),Long.parseLong(f.workspace()),Long.parseLong(f.project()),key(published),Owner.candidate(Long.parseLong(candidate.path("id").asText())));}
        }catch(RuntimeException expected){/* The observed H2 trigger, not exception type, establishes the fault prerequisite. */}
        assertAll(()->assertTrue(AuditFault.attempts.get()>0,"real INSERT trigger reached before rollback assertions"),()->assertEquals(before,snapshot(f),"sameTX body/metadata/charge/reserve/state/policy/cascade/audit rollback"));
    }
    @Test void storageFullQuotaStillAllowsItsReservedRelease()throws Exception{
        defaults(Map.of("maxPreviewsPerPerson",20));var f=fixture();var candidate=sized(f,8*(int)MIB);var full=usage(f);assertTrue(full.occupiedBytes()>=8*MIB);defaults(Map.of("maxProjectStorageBytes",full.occupiedBytes()));
        var before=snapshot(f);var result=request(f.owner().token(),put(collaboration(f)+"/policy"),Map.of("expectedRevision",0,"settings",Map.of("maxProjectVersions",900))).andReturn().getResponse();
        var afterAttempt=snapshot(f);
        defaults(Map.of("maxProjectStorageBytes",256*MIB));var releaseFixture=fixture();var releaseCandidate=sized(releaseFixture,8*(int)MIB);var releaseFull=usage(releaseFixture);defaults(Map.of("maxProjectStorageBytes",releaseFull.occupiedBytes()));
        request(releaseFixture.owner().token(),delete(collaboration(releaseFixture)+"/previews/"+releaseCandidate.path("id").asText()),Map.of()).andExpect(status().isNoContent());var released=usage(releaseFixture);
        request(releaseFixture.owner().token(),delete(collaboration(releaseFixture)+"/previews/"+releaseCandidate.path("id").asText()),Map.of()).andExpect(status().isNoContent());var repeated=usage(releaseFixture);
        assertAll(()->response(result,409,"collaboration_storage_limit"),()->assertEquals(before,afterAttempt),()->assertTrue(released.occupiedBytes()<releaseFull.occupiedBytes(),"independent owner releases at exact true full quota"),()->assertTrue(released.reservedAuditBytes()<releaseFull.reservedAuditBytes()),()->assertEquals(releaseFull.bodyBytes(),released.bodyBytes(),"terminal count release is not body deletion"),()->assertEquals(released,repeated,"one-use reserved terminal event, retry adds no charge"));
    }
    @ParameterizedTest @ValueSource(strings={"unknown","cross-project"}) void storageReferenceRejectsUnknownOrCrossProjectOwner(String invalid)throws Exception{
        var f=fixture();var published=fixed(f);var candidate=preview(f,f.owner(),documentRequest(f));storage.retain(Long.parseLong(f.owner().id()),Long.parseLong(f.workspace()),Long.parseLong(f.project()),key(published),Owner.candidate(Long.parseLong(candidate.path("id").asText())));
        long bad=Long.MAX_VALUE-1;if(invalid.equals("cross-project")){var other=fixture();bad=Long.parseLong(preview(other,other.owner(),documentRequest(other)).path("id").asText());}var before=snapshot(f);long owner=bad;
        assertAll(()->assertThatThrownBy(()->storage.retain(Long.parseLong(f.owner().id()),Long.parseLong(f.workspace()),Long.parseLong(f.project()),key(published),Owner.candidate(owner))).isInstanceOfSatisfying(com.autumnharvestc.server.core.ApiException.class,error->assertEquals("collaboration_reference_owner_invalid",error.getCode())),()->assertEquals(before,snapshot(f)));
    }
    @ParameterizedTest @ValueSource(booleans={false,true}) void storageReferenceProtectsUntilReleaseOrRealExpiry(boolean expiry)throws Exception{
        defaults(Map.of("inactiveArtifactRetentionMs",DAY));var f=fixture();var published=fixed(f);long id=storage.retain(Long.parseLong(f.owner().id()),Long.parseLong(f.workspace()),Long.parseLong(f.project()),key(published),Owner.operation(123,artifactTime.now().plusMillis(2*DAY)));
        publication(f,f.viewer(),published.path("id").asText());artifactTime.advance(DAY);storage.cleanup(Long.parseLong(f.workspace()),Long.parseLong(f.project()));var protectedRead=mvc.perform(get(collaboration(f)+"/publications/"+published.path("id").asText()).header("Authorization","Bearer "+f.viewer().token())).andReturn().getResponse();
        if(expiry)artifactTime.advance(DAY);else storage.release(Long.parseLong(f.owner().id()),id);
        storage.cleanup(Long.parseLong(f.workspace()),Long.parseLong(f.project()));var justReleased=mvc.perform(get(collaboration(f)+"/publications/"+published.path("id").asText()).header("Authorization","Bearer "+f.viewer().token())).andReturn().getResponse();artifactTime.advance(DAY);
        storage.cleanup(Long.parseLong(f.workspace()),Long.parseLong(f.project()));var result=mvc.perform(get(collaboration(f)+"/publications/"+published.path("id").asText()).header("Authorization","Bearer "+f.viewer().token())).andReturn().getResponse();assertAll(()->assertEquals(200,protectedRead.getStatus(),"active ref protects complete saved body"),()->assertEquals(200,justReleased.getStatus(),"inactive clock starts after last protection"),()->response(result,404,"publication_not_found"));
    }
    @Test void storageCandidateOwnerExpiryComesFromActualRecord()throws Exception{
        defaults(Map.of("inactiveArtifactRetentionMs",DAY));var f=fixture();var published=fixed(f);var owner=preview(f,f.owner(),documentRequest(f));storage.retain(Long.parseLong(f.owner().id()),Long.parseLong(f.workspace()),Long.parseLong(f.project()),key(published),Owner.candidate(Long.parseLong(owner.path("id").asText())));
        publication(f,f.viewer(),published.path("id").asText());storage.cleanup(Long.parseLong(f.workspace()),Long.parseLong(f.project()));var protectedRead=mvc.perform(get(collaboration(f)+"/publications/"+published.path("id").asText()).header("Authorization","Bearer "+f.viewer().token())).andReturn().getResponse();artifactTime.advance(600000);storage.cleanup(Long.parseLong(f.workspace()),Long.parseLong(f.project()));var justExpired=mvc.perform(get(collaboration(f)+"/publications/"+published.path("id").asText()).header("Authorization","Bearer "+f.viewer().token())).andReturn().getResponse();artifactTime.advance(DAY);storage.cleanup(Long.parseLong(f.workspace()),Long.parseLong(f.project()));
        var result=mvc.perform(get(collaboration(f)+"/publications/"+published.path("id").asText()).header("Authorization","Bearer "+f.viewer().token())).andReturn().getResponse();assertAll(()->assertEquals(200,protectedRead.getStatus()),()->assertEquals(200,justExpired.getStatus()),()->response(result,404,"publication_not_found"));
    }
    @ParameterizedTest @ValueSource(strings={"release","operation-expiry","candidate-expiry"}) void storageInactiveClockStartsAtRealFinalReferenceEnd(String ending)throws Exception{
        defaults(Map.of("inactiveArtifactRetentionMs",DAY));var f=fixture();var published=fixed(f);long ownerId;
        if(ending.equals("candidate-expiry")){var owner=preview(f,f.owner(),documentRequest(f));ownerId=storage.retain(Long.parseLong(f.owner().id()),Long.parseLong(f.workspace()),Long.parseLong(f.project()),key(published),Owner.candidate(Long.parseLong(owner.path("id").asText())));artifactTime.advance(600000);}
        else{ownerId=storage.retain(Long.parseLong(f.owner().id()),Long.parseLong(f.workspace()),Long.parseLong(f.project()),key(published),Owner.operation(456,artifactTime.now().plusMillis(ending.equals("release")?3*DAY:2*DAY)));artifactTime.advance(2*DAY);if(ending.equals("release")){storage.release(Long.parseLong(f.owner().id()),ownerId);assertEquals(0,jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_storage_references WHERE id=?",Long.class,ownerId));}}
        if(!ending.equals("release"))assertTrue(jdbc.queryForObject("SELECT expires_at FROM collaboration_storage_references WHERE id=?",Long.class,ownerId)<=artifactTime.now().toEpochMilli(),"actual owner deadline reached before first cleanup");
        // No previous cleanup: actual complete object exists at the real final-owner boundary.
        publication(f,f.viewer(),published.path("id").asText());assertEquals(1,publicationCount(f));storage.cleanup(Long.parseLong(f.workspace()),Long.parseLong(f.project()));var immediate=mvc.perform(get(collaboration(f)+"/publications/"+published.path("id").asText()).header("Authorization","Bearer "+f.viewer().token())).andReturn().getResponse();
        artifactTime.advance(DAY);storage.cleanup(Long.parseLong(f.workspace()),Long.parseLong(f.project()));var after=mvc.perform(get(collaboration(f)+"/publications/"+published.path("id").asText()).header("Authorization","Bearer "+f.viewer().token())).andReturn().getResponse();assertAll(()->assertEquals(200,immediate.getStatus(),"retention starts from real owner end, not original publication time"),()->response(after,404,"publication_not_found"));
    }
    @Test void storageCleanupIsBoundedAndUsesCurrentRetention()throws Exception{
        defaults(Map.of("cleanupBatchSize",1,"inactiveArtifactRetentionMs",DAY));var f=fixture();fixed(f);fixed(f);artifactTime.advance(DAY);long before=jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_storage_objects WHERE workspace_id=? AND project_id=? AND kind IN ('PREVIEW','ARTIFACT')",Long.class,Long.parseLong(f.workspace()),Long.parseLong(f.project()));
        storage.cleanup(Long.parseLong(f.workspace()),Long.parseLong(f.project()));long after=jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_storage_objects WHERE workspace_id=? AND project_id=? AND kind IN ('PREVIEW','ARTIFACT')",Long.class,Long.parseLong(f.workspace()),Long.parseLong(f.project()));assertEquals(before-1,after,"one physical owner per effective batch");
    }
    Map<String,Object> reviewScopeOnly(Fixture f){
        var value=snapshot(f);
        value.remove("global");
        return value;
    }
    @Test void reviewBatchRetentionUsesLatestRealReferenceEnd()throws Exception{
        defaults(Map.of("cleanupBatchSize",2,"inactiveArtifactRetentionMs",DAY));
        var f=fixture();
        var a=fixed(f);
        var b=fixed(f);
        var other=fixture();
        var independent=fixed(other);
        long actor=Long.parseLong(f.owner().id()),ws=Long.parseLong(f.workspace()),project=Long.parseLong(f.project());
        var base=artifactTime.now();
        assertTrue(Long.parseLong(a.path("id").asText())<Long.parseLong(b.path("id").asText()));
        storage.retain(actor,ws,project,key(a),Owner.operation(9001,base.plusMillis(4*DAY)));
        storage.retain(actor,ws,project,key(b),Owner.operation(9002,base.plusMillis(DAY+DAY/10)));
        storage.retain(actor,ws,project,key(b),Owner.operation(9003,base.plusMillis(2*DAY)));
        artifactTime.advance(DAY+DAY/100); // Preview receipt retention elapsed; both B references still valid.
        assertEquals(2,storage.cleanup(ws,project));
        assertEquals(0,previewCount(f),"real earlier previews/receipts cannot consume the target body's later cleanup slot");
        assertEquals(3,jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_storage_references WHERE workspace_id=? AND project_id=?",Long.class,ws,project));
        var otherBefore=reviewScopeOnly(other);
        artifactTime.advance(DAY+DAY/2-DAY/100); // Exactly2.5days: r1/r2 ended at1.1/2days, A still active.
        publication(f,f.viewer(),b.path("id").asText());
        assertTrue(storage.cleanup(ws,project)<=2,"same actual batch2 budget");
        var retained=mvc.perform(get(collaboration(f)+"/publications/"+b.path("id").asText()).header("Authorization","Bearer "+f.viewer().token())).andReturn().getResponse();
        assertEquals(200,retained.getStatus(),"last actual ref end2days means body must survive until3days");
        var actual=json.readTree(retained.getContentAsByteArray());
        assertAll(()->assertEquals(b.path("artifact"),actual.path("artifact")),()->assertEquals(b.path("digest"),actual.path("digest")),()->assertEquals(otherBefore,reviewScopeOnly(other)));
        artifactTime.advance(DAY/2); // Exact final real end +1day retention.
        assertTrue(storage.cleanup(ws,project)<=2);
        var gone=mvc.perform(get(collaboration(f)+"/publications/"+b.path("id").asText()).header("Authorization","Bearer "+f.viewer().token())).andReturn().getResponse();
        response(gone,404,"publication_not_found");
        publication(f,f.viewer(),a.path("id").asText());
        publication(other,other.viewer(),independent.path("id").asText());
        assertEquals(otherBefore,reviewScopeOnly(other));
    }
    @ParameterizedTest @ValueSource(strings={"read-first","cleanup-first","project-delete"}) void storageReadDeleteCleanupInterleavingReturnsCompleteOrExplicitReason(String order)throws Exception{
        defaults(Map.of("inactiveArtifactRetentionMs",DAY));var f=fixture();var published=fixed(f);publication(f,f.viewer(),published.path("id").asText());long project=Long.parseLong(f.project());artifactTime.advance(31*DAY);
        var ready=new CountDownLatch(1);var releaseProject=new CountDownLatch(1);String path=collaboration(f)+"/publications/"+published.path("id").asText();
        ReadBarrier.entered=new CountDownLatch(1);ReadBarrier.release=new CountDownLatch(1);DeleteBarrier.entered=new CountDownLatch(1);DeleteBarrier.release=new CountDownLatch(1);
        try(var pool=Executors.newFixedThreadPool(3)){
            if(order.equals("read-first")){
                ReadBarrier.project=project;ReadBarrier.armed=true;DeleteBarrier.armed=true;DeleteBarrier.hold=false;
                jdbc.execute("CREATE TRIGGER t6_read_barrier BEFORE SELECT ON collaboration_publications CALL '"+ReadBarrier.class.getName()+"'");jdbc.execute("CREATE TRIGGER t6_delete_barrier BEFORE DELETE ON collaboration_publications FOR EACH ROW CALL '"+DeleteBarrier.class.getName()+"'");
                var reader=pool.submit(()->mvc.perform(get(path).header("Authorization","Bearer "+f.viewer().token())).andReturn().getResponse());assertTrue(ReadBarrier.entered.await(5,TimeUnit.SECONDS),"actual HTTP reader entered real SELECT transaction and holds original project row");
                var cleanup=pool.submit(()->storage.cleanup(Long.parseLong(f.workspace()),project));boolean waited=observedWaitOrCompletion(cleanup,DeleteBarrier.entered,false);ReadBarrier.release.countDown();var read=reader.get(10,TimeUnit.SECONDS);cleanup.get(10,TimeUnit.SECONDS);
                var result=json.readTree(read.getContentAsByteArray());assertAll(()->assertTrue(waited,"cleanup must actually serialize behind in-progress reader, not delete its body first"),()->assertEquals(200,read.getStatus()),()->assertTrue(published.path("artifact").equals(result.path("artifact")),"complete original bytes while cleanup overlaps"),()->assertEquals(published.path("digest"),result.path("digest")));
            }else if(order.equals("cleanup-first")){
                DeleteBarrier.armed=true;DeleteBarrier.hold=true;jdbc.execute("CREATE TRIGGER t6_delete_barrier BEFORE DELETE ON collaboration_publications FOR EACH ROW CALL '"+DeleteBarrier.class.getName()+"'");
                var cleanup=pool.submit(()->storage.cleanup(Long.parseLong(f.workspace()),project));assertTrue(DeleteBarrier.entered.await(5,TimeUnit.SECONDS),"real cleanup DELETE statement is held before commit");var reader=pool.submit(()->mvc.perform(get(path).header("Authorization","Bearer "+f.viewer().token())).andReturn().getResponse());
                observedWaitOrCompletion(reader,new CountDownLatch(1),true);DeleteBarrier.release.countDown();cleanup.get(10,TimeUnit.SECONDS);var read=reader.get(10,TimeUnit.SECONDS);
                if(read.getStatus()==200){var result=json.readTree(read.getContentAsByteArray());assertAll(()->assertTrue(published.path("artifact").equals(result.path("artifact")),"actual overlapping MVCC old snapshot is complete"),()->assertEquals(published.path("digest"),result.path("digest")));}else response(read,404,"publication_not_found");
            }else{
                var blocker=pool.submit(()->new TransactionTemplate(transactionManager).execute(tx->{jdbc.queryForObject("SELECT id FROM projects WHERE id=? FOR UPDATE",Long.class,project);ready.countDown();try{if(!releaseProject.await(20,TimeUnit.SECONDS))throw new IllegalStateException("Synthetic project SQL barrier timed out");}catch(InterruptedException interrupted){Thread.currentThread().interrupt();throw new RuntimeException(interrupted);}return null;}));assertTrue(ready.await(5,TimeUnit.SECONDS));
                var deletion=pool.submit(()->request(f.owner().token(),delete(f.url()),Map.of()).andReturn().getResponse());assertTrue(observedWaitOrCompletion(deletion,new CountDownLatch(1),false),"actual DELETE transaction waits on project SQL");
                var reader=pool.submit(()->mvc.perform(get(path).header("Authorization","Bearer "+f.viewer().token())).andReturn().getResponse());boolean readerWaited=observedWaitOrCompletion(reader,new CountDownLatch(1),true);releaseProject.countDown();blocker.get(5,TimeUnit.SECONDS);var removed=deletion.get(10,TimeUnit.SECONDS);var read=reader.get(10,TimeUnit.SECONDS);
                assertAll(()->assertTrue(readerWaited,"overlapping HTTP reader actually waits on policy/access SQL"),()->assertEquals(204,removed.getStatus()),()->response(read,403,"forbidden"));
            }
        }finally{ReadBarrier.release.countDown();DeleteBarrier.release.countDown();releaseProject.countDown();}
    }
    @Test void storageProjectDeleteReleasesOnlyItsOwnCollaborationRows()throws Exception{
        var f=fixture();fixed(f);var other=fixture();var retained=fixed(other);var otherBefore=usage(other);request(f.owner().token(),delete(f.url()),Map.of()).andExpect(status().isNoContent());
        var removed=usage(f);assertAll(()->assertEquals(0,removed.bodyBytes()),()->assertEquals(0,removed.previewCount()),()->assertEquals(0,removed.artifactCount()),()->assertEquals(0,removed.reservedAuditBytes()),()->assertTrue(removed.auditBytes()>0,"unexpired existing+deletion audit remains charged at project tombstone"),()->assertEquals(removed.auditBytes(),removed.actualBytes()),()->assertEquals(otherBefore,usage(other)),()->assertEquals(retained.path("digest"),publication(other,other.viewer(),retained.path("id").asText()).path("digest")));
    }
    @Test void storageCommittedIntentSurvivesPreviewBodyCleanup()throws Exception{
        var f=fixture();var candidate=preview(f,f.owner(),documentRequest(f));String intent=UUID.randomUUID().toString();var published=publish(f,candidate,intent);publication(f,f.viewer(),published.path("id").asText());artifactTime.advance(31*DAY);
        // Controlled post-reclamation state, not a claim that the unguarded cleanup entry is correct.
        new TransactionTemplate(transactionManager).executeWithoutResult(tx->{long ws=Long.parseLong(f.workspace()),project=Long.parseLong(f.project()),id=Long.parseLong(candidate.path("id").asText());var charge=jdbc.queryForMap("SELECT body_bytes+metadata_bytes AS actual,reserved_bytes FROM collaboration_storage_objects WHERE workspace_id=? AND project_id=? AND kind='PREVIEW' AND object_id=?",ws,project,id);
            jdbc.update("DELETE FROM collaboration_previews WHERE id=?",id);jdbc.update("DELETE FROM collaboration_storage_objects WHERE workspace_id=? AND project_id=? AND kind='PREVIEW' AND object_id=?",ws,project,id);jdbc.update("UPDATE collaboration_storage_accounts SET actual_bytes=actual_bytes-?,reserved_bytes=reserved_bytes-? WHERE (workspace_id=0 AND project_id=0) OR (workspace_id=? AND project_id=?)",charge.get("actual"),charge.get("reserved_bytes"),ws,project);});
        publication(f,f.viewer(),published.path("id").asText());assertEquals(1,publicationCount(f));
        var replay=request(f.owner().token(),post(collaboration(f)+"/publications"),confirmation(candidate,intent)).andReturn().getResponse();var body=json.readTree(replay.getContentAsByteArray());assertAll(()->assertEquals(200,replay.getStatus()),()->assertEquals(published.path("id"),body.path("id")),()->assertEquals(published.path("digest"),body.path("digest")),()->assertEquals(1,publicationCount(f)),()->assertEquals(1,rpc.requests.size()));
    }
    @Test void storagePreviewReceiptEventuallyReclaimsItsMetadata()throws Exception{
        defaults(Map.of("inactiveArtifactRetentionMs",DAY));var f=fixture();var candidate=preview(f,f.owner(),documentRequest(f));long id=Long.parseLong(candidate.path("id").asText());assertTrue(usage(f).actualBytes()>0);
        artifactTime.advance(600000);storage.cleanup(Long.parseLong(f.workspace()),Long.parseLong(f.project()));artifactTime.advance(DAY);storage.cleanup(Long.parseLong(f.workspace()),Long.parseLong(f.project()));
        var result=mvc.perform(get(collaboration(f)+"/previews/"+id).header("Authorization","Bearer "+f.owner().token())).andReturn().getResponse();assertAll(()->response(result,404,"preview_not_found"),()->assertEquals(0,jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_storage_objects WHERE kind='PREVIEW' AND object_id=?",Long.class,id),"terminal receipt metadata and its charge are not permanent"));
    }
}
