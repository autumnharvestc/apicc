package com.autumnharvestc.server.collaboration;

import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import static org.junit.jupiter.api.Assertions.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class ArtifactConcurrencyTest extends ArtifactHttpFixture {
    @Autowired PlatformTransactionManager transactions;
    @ParameterizedTest @ValueSource(strings={"source","policy","purpose"})
    void publicationRpcDoesNotHoldLocksAndLateStateIsRechecked(String change)throws Exception {
        var f=fixture();preview(f,f.owner(),documentRequest(f));long before=previewCount(f);rpc.block();
        try(var pool=Executors.newFixedThreadPool(2)){
            var future=pool.submit(()->request(f.owner().token(),post(collaboration(f)+"/previews"),documentRequest(f)).andReturn().getResponse());
            assertTrue(rpc.entered.await(5,TimeUnit.SECONDS),"actual private HTTP RPC reached");
            String code=change.equals("source")?"source_revision_conflict":change.equals("policy")?"publication_policy_changed":"forbidden";int expected=change.equals("purpose")?403:409;
            try{var mutation=pool.submit(()->{if(change.equals("source"))save(f.owner(),f.workspace(),f.project(),"1",List.of(Map.of("path","notes.md","content","Changed during RPC")));else if(change.equals("policy"))policy(f,true,Map.of("maxProjectVersions",900));else capability(f,f.owner(),"publication.manage","deny");return true;});assertTrue(mutation.get(5,TimeUnit.SECONDS),"real mutation commits while HTTP projection is blocked");}finally{rpc.release.countDown();}
            var response=future.get(5,TimeUnit.SECONDS);var result=json.readTree(response.getContentAsByteArray());
            assertAll(()->assertEquals(expected,response.getStatus()),()->assertEquals(code,result.path("code").asText("missing")),()->assertEquals(before,previewCount(f),"stale RPC result cannot become candidate"));
        }finally{rpc.release.countDown();}
    }
    @Test void publicationConcurrentIntentHasOneDurableResult()throws Exception {
        var f=fixture();var candidate=preview(f,f.owner(),documentRequest(f));String intent=UUID.randomUUID().toString();var start=new CountDownLatch(1);
        try(var pool=Executors.newFixedThreadPool(2)){
            var left=pool.submit(()->{start.await();return request(f.owner().token(),post(collaboration(f)+"/publications"),confirmation(candidate,intent)).andReturn().getResponse();});
            var right=pool.submit(()->{start.await();return request(f.owner().token(),post(collaboration(f)+"/publications"),confirmation(candidate,intent)).andReturn().getResponse();});start.countDown();
            var a=left.get(10,TimeUnit.SECONDS);var b=right.get(10,TimeUnit.SECONDS);var first=json.readTree(a.getContentAsByteArray());var second=json.readTree(b.getContentAsByteArray());
            assertAll(()->assertThat(List.of(a.getStatus(),b.getStatus())).containsExactlyInAnyOrder(201,200),()->assertEquals(first.path("id").asText(),second.path("id").asText()),()->assertEquals(first.path("digest").asText(),second.path("digest").asText()),()->assertEquals(1,publicationCount(f)),()->assertEquals(1,rpc.requests.size()));
        }
    }
    @ParameterizedTest @ValueSource(strings={"deadline","disabled"})
    void publicationCommitRechecksAfterActualPolicyGateWait(String change)throws Exception {
        var f=fixture();var candidate=preview(f,f.owner(),documentRequest(f));String platform=login("admin","admin-pass-2026");long accountRevision=users.stateRevision(Long.parseLong(f.owner().id()));
        var held=new CountDownLatch(1);var release=new CountDownLatch(1);
        try(var pool=Executors.newFixedThreadPool(2)){
            var blocker=pool.submit(()->new TransactionTemplate(transactions).execute(tx->{
                jdbc.queryForObject("SELECT id FROM collaboration_policy_gate WHERE id=1 FOR UPDATE",Long.class);held.countDown();
                try{
                    if(!release.await(10,TimeUnit.SECONDS))throw new IllegalStateException("Publication SQL barrier timed out");
                    // The real mutation joins the holder; its commit also releases the gate.
                    if(change.equals("disabled"))request(platform,post("/api/v1/admin/users/"+f.owner().id()+"/disable"),Map.of("expectedRevision",accountRevision)).andExpect(status().isNoContent());
                }catch(InterruptedException interrupted){Thread.currentThread().interrupt();throw new RuntimeException(interrupted);}
                catch(Exception failure){throw new RuntimeException(failure);}return null;
            }));
            assertTrue(held.await(5,TimeUnit.SECONDS));var writer=pool.submit(()->request(f.owner().token(),post(collaboration(f)+"/publications"),confirmation(candidate,UUID.randomUUID().toString())).andReturn().getResponse());
            boolean blocked=false;long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);while(System.nanoTime()<deadline){if(jdbc.queryForObject("SELECT COUNT(*) FROM INFORMATION_SCHEMA.SESSIONS WHERE BLOCKER_ID IS NOT NULL",Integer.class)>0){blocked=true;break;}Thread.sleep(10);}
            try{assertTrue(blocked,"confirm reached actual blocked policy SQL");if(change.equals("deadline"))artifactTime.advance(60001);}finally{release.countDown();}
            blocker.get(5,TimeUnit.SECONDS);
            if(change.equals("disabled"))assertTrue(users.findById(Long.parseLong(f.owner().id())).orElseThrow().disabled(),"holder committed real account revocation before confirm can acquire its gate");
            var response=writer.get(5,TimeUnit.SECONDS);var result=json.readTree(response.getContentAsByteArray());
            int expected=change.equals("deadline")?408:403;String code=change.equals("deadline")?"publication_deadline_exceeded":"forbidden";
            assertAll(()->assertEquals(expected,response.getStatus()),()->assertEquals(code,result.path("code").asText("missing")),()->assertEquals(0,publicationCount(f)));
        }finally{release.countDown();}
    }
}
