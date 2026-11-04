package com.autumnharvestc.server.collaboration;

import com.autumnharvestc.server.ApiccServerApplication;
import com.autumnharvestc.server.collaboration.publicapi.*;
import java.net.*;
import java.net.http.*;
import java.sql.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.test.context.TestPropertySource;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertAll;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@TestPropertySource(properties={"spring.datasource.url=jdbc:h2:mem:apicc-collaboration-t7-race;DB_CLOSE_DELAY=-1",
    "apicc.collaboration.policy.defaults.external-sharing-allowed=true",
    "apicc.collaboration.public-access.enabled=true", "apicc.collaboration.public-access.port=0",
    "apicc.collaboration.public-access.base-url=http://127.0.0.1:18794"})
class PublicAdmissionRaceTest extends GrantHttpFixture {
    static final int PUBLIC_PORT=loopbackPort();
    @org.springframework.test.context.DynamicPropertySource static void publicOrigin(org.springframework.test.context.DynamicPropertyRegistry registry){registry.add("apicc.collaboration.public-access.port",()->PUBLIC_PORT);registry.add("apicc.collaboration.public-access.base-url",()->"http://127.0.0.1:"+PUBLIC_PORT);}
    @Autowired PlatformTransactionManager manager;
    @BeforeEach void defaults(){deployment.setDefaults(json.convertValue(Map.of("externalSharingAllowed",true),com.autumnharvestc.server.collaboration.policy.DeploymentPolicyProperties.Defaults.class));}
    @AfterEach void barriers(){GateSignal.armed.set(false);GateSignal.proceed.countDown();GateSignal.ownStartupOnly=false;jdbc.execute("DROP TRIGGER IF EXISTS t7_gate_signal");}
    static int freePort()throws Exception {try(var socket=new java.net.ServerSocket(0,0,InetAddress.getByName("127.0.0.1"))){return socket.getLocalPort();}}
    ConfigurableApplicationContext restart(boolean external,boolean publicEnabled,int port){
        int publicPort=port==0?loopbackPort():port;
        return new SpringApplicationBuilder(ApiccServerApplication.class).run(
            "--server.address=127.0.0.1","--server.port=0","--spring.datasource.url=jdbc:h2:mem:apicc-collaboration-t7-race;DB_CLOSE_DELAY=-1",
            "--apicc.server.admin-username=admin","--apicc.server.admin-password=admin-pass-2026",
            "--apicc.collaboration.policy.defaults.external-sharing-allowed="+external,
            "--apicc.collaboration.public-access.enabled="+publicEnabled,"--apicc.collaboration.public-access.port="+publicPort,
            "--apicc.collaboration.public-access.base-url=http://127.0.0.1:"+publicPort);
    }
    @Test void publicListenerRebindsTheSamePortAfterACompletedConnection()throws Exception {
        int port=freePort();
        for(int cycle=0;cycle<2;cycle++){
            try(var running=org.junit.jupiter.api.Assertions.assertDoesNotThrow(()->restart(true,true,port))){
                assertThat(running.getBean(PublicListener.class).boundPort()).isEqualTo(port);
                if(cycle==0){
                    var conflict=org.junit.jupiter.api.Assertions.assertThrows(Exception.class,()->restart(true,true,port));
                    assertThat(conflict).hasRootCauseInstanceOf(java.net.BindException.class);
                }
                try(var socket=new Socket("127.0.0.1",port)){
                    socket.setSoTimeout(5000);
                    socket.getOutputStream().write("GET /restart-probe HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n".getBytes(java.nio.charset.StandardCharsets.US_ASCII));
                    socket.getOutputStream().flush();
                    assertThat(new String(socket.getInputStream().readAllBytes(),java.nio.charset.StandardCharsets.US_ASCII)).startsWith("HTTP/1.1 404");
                }
            }
        }
    }
    @Test void perGrantReadRateHasNoAccumulatedBurstAndRecoversByClock()throws Exception {
        var f=fixture();var publication=fixedDocument(f);policy(f,false,Map.of("publicReadRps",1));var grant=createGrant(f,publication,grantCommand("view","external"));readable(grant);
        var rejected=read(grant,grant.path("key").asText());artifactTime.advance(1000);var recovered=read(grant,grant.path("key").asText());
        assertAll(()->result(rejected,429,"share_capacity_exceeded"),()->assertThat(recovered.statusCode()).isEqualTo(200));
    }
    @Test void inFlightLeaseCoversResponseAndReleasesOnce()throws Exception {
        var f=fixture();var publication=fixedDocument(f);policy(f,false,Map.of("publicReadInFlight",1));var grant=createGrant(f,publication,grantCommand("view","external"));
        // A client receiving a warm-up response does not mean its server handler has released
        // the lease: access observation may still be running. Own the first lease directly.
        try(var admission=grants.admit(grant.path("publicId").asText(),grant.path("key").asText(),"view",false,null)){
            assertThat(json.readTree(admission.body()).path("kind").asText()).isEqualTo("document");
            result(read(grant,grant.path("key").asText()),429,"share_capacity_exceeded");
            admission.close();admission.close();
            try(var next=grants.admit(grant.path("publicId").asText(),grant.path("key").asText(),"view",false,null)){
                assertThat(next.body()).isEqualTo(admission.body());
                // Duplicate close must not create a spare slot while the new lease is held.
                result(read(grant,grant.path("key").asText()),429,"share_capacity_exceeded");
            }
        }
        readable(grant);
    }
    @Test void deploymentAppliedAcrossRestartCannotReviveSecretWhenOriginalDigestReturns()throws Exception {
        var f=fixture();var publication=fixedDocument(f);var grant=createGrant(f,publication,grantCommand("view","external"));readable(grant);
        String durable;
        // Restriction is actually applied at startup with the public listener disabled: no intervening public read.
        try(var restrictive=restart(false,false,0)){
            assertThat(restrictive.getBean(PublicListener.class).running()).isFalse();
            durable=jdbc.queryForObject("SELECT reason FROM collaboration_grants WHERE id=?",String.class,grant.path("id").asLong());
        }
        HttpResponse<String> restored;
        try(var original=restart(true,true,0)){
            String origin=original.getBean(PublicListener.class).origin();
            restored=http.send(HttpRequest.newBuilder(URI.create(origin+"/share-api/"+grant.path("publicId").asText())).header("X-Apicc-Share-Key",grant.path("key").asText()).GET().build(),HttpResponse.BodyHandlers.ofString());
        }
        assertAll(()->assertThat(durable).isEqualTo("policy_changed"),()->inactive(restored,"policy_changed"));
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"delete","cleanup"})
    void startupReconcilesAfterUnreadExpiredGrantArtifactRemoval(String removal)throws Exception {
        var f=fixture();var publication=fixedDocument(f);long expiry=artifactTime.now().toEpochMilli()+60000;
        var grant=createGrant(f,publication,grantCommand("view","external").put("expiresAt",expiry));readable(grant);
        artifactTime.advance(60000);
        if(removal.equals("delete"))request(f.owner().token(),delete(collaboration(f)+"/publications/"+publication.path("id").asText()),Map.of("expectedRevision",1)).andExpect(status().isNoContent());
        else{artifactTime.advance(31L*86400000);for(int batch=0;batch<3;batch++)storage.cleanup(Long.parseLong(f.workspace()),Long.parseLong(f.project()));}
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_publications WHERE id=?",Long.class,publication.path("id").asLong())).isZero();
        // Actual fresh Spring startup runs its own durable reconciliation; no expired-key GET.
        try(var restarted=org.junit.jupiter.api.Assertions.assertDoesNotThrow(()->restart(true,false,0))){
            assertThat(restarted.getBean(PublicAdmissionState.class).ready()).isTrue();
        }
        assertThat(jdbc.queryForObject("SELECT reason FROM collaboration_grants WHERE id=?",String.class,grant.path("id").asLong())).isEqualTo("expired");
        assertThat(jdbc.queryForObject("SELECT ended_at FROM collaboration_grants WHERE id=?",Long.class,grant.path("id").asLong())).isEqualTo(expiry);
    }
    public static class GateSignal implements org.h2.api.Trigger {
        static final AtomicBoolean armed=new AtomicBoolean();static volatile CountDownLatch entered=new CountDownLatch(1);
        static volatile boolean ownStartupOnly;
        static volatile CountDownLatch proceed=new CountDownLatch(0);
        @Override public void fire(Connection connection,Object[] oldRow,Object[] newRow)throws SQLException{
            if(connection.getAutoCommit())return;
            if(ownStartupOnly&&!StackWalker.getInstance().walk(frames->frames.anyMatch(frame->frame.getClassName().equals(GrantStartupReconciler.class.getName())&&frame.getMethodName().equals("run"))))return;
            if(armed.compareAndSet(true,false)){
                entered.countDown();
                if(ownStartupOnly)try{
                    if(!proceed.await(15,TimeUnit.SECONDS))throw new SQLException("Own reconciliation SQL barrier timed out");
                }catch(InterruptedException interrupted){Thread.currentThread().interrupt();throw new SQLException("Own reconciliation SQL barrier interrupted",interrupted);}
            }
        }
    }
    void installGate(){jdbc.execute("CREATE TRIGGER t7_gate_signal BEFORE SELECT ON collaboration_policy_gate CALL '"+GateSignal.class.getName()+"'");}
    void armGate(){GateSignal.entered=new CountDownLatch(1);GateSignal.armed.set(true);}
    @Test void ownStartupReconciliationClosesPublicAdmissionBeforeItCanSucceed()throws Exception {
        var f=fixture();var publication=fixedDocument(f);var grant=createGrant(f,publication,grantCommand("view","external"));readable(grant);
        int port=freePort();installGate();armGate();GateSignal.ownStartupOnly=true;GateSignal.proceed=new CountDownLatch(1);
        try(var workers=Executors.newVirtualThreadPerTaskExecutor()){
            var future=CompletableFuture.supplyAsync(()->restart(true,true,port),workers);
            try{
                assertThat(GateSignal.entered.await(15,TimeUnit.SECONDS)).as("own GrantStartupReconciler reached its real transactional SQL after listener startup").isTrue();
                var premature=http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+"/s/"+grant.path("publicId").asText())).GET().build(),HttpResponse.BodyHandlers.ofString());
                GateSignal.proceed.countDown();
                try(var ready=future.get(20,TimeUnit.SECONDS)){
                    var admitted=http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+"/share-api/"+grant.path("publicId").asText())).header("X-Apicc-Share-Key",grant.path("key").asText()).GET().build(),HttpResponse.BodyHandlers.ofString());
                    assertAll(()->result(premature,503,"public_origin_unavailable"),()->assertThat(admitted.statusCode()).isEqualTo(200));
                }
            }finally{
                GateSignal.proceed.countDown();
                // A failed assertion/HTTP call must still close this owned restart.
                future.whenComplete((context,failure)->{if(context!=null)context.close();});
            }
        }
    }
    @Test void revokeCommittedBeforeWaitingAdmissionRejectsButAlreadyAdmittedBytesMayFinish()throws Exception {
        var f=fixture();var publication=fixedDocument(f);var grant=createGrant(f,publication,grantCommand("view","external"));readable(grant);
        installGate();try(var admitted=grants.admit(grant.path("publicId").asText(),grant.path("key").asText(),"view",false,null);var workers=Executors.newVirtualThreadPerTaskExecutor()){
            @SuppressWarnings("unchecked") CompletableFuture<HttpResponse<String>>[] pending=new CompletableFuture[1];
            new TransactionTemplate(manager).executeWithoutResult(status->{
                jdbc.queryForList("SELECT id FROM collaboration_policy_gate WHERE id=1 FOR UPDATE");armGate();
                pending[0]=CompletableFuture.supplyAsync(()->{try{return read(grant,grant.path("key").asText());}catch(Exception failure){throw new RuntimeException(failure);}},workers);
                try{assertThat(GateSignal.entered.await(10,TimeUnit.SECONDS)).isTrue();grants.revoke(f.owner().account(),f.workspace(),f.project(),grant.path("id").asText(),json.valueToTree(Map.of("expectedRevision",1)));}catch(Exception failure){throw new RuntimeException(failure);}
            });
            inactive(pending[0].get(10,TimeUnit.SECONDS),"revoked");
            artifactTime.advance(31L*86400000);storage.cleanup(Long.parseLong(f.workspace()),Long.parseLong(f.project()));
            assertThat(json.readTree(admitted.body()).path("kind").asText()).isEqualTo("document");
            assertThat(admitted.body()).isNotEmpty();
        }
    }
    @Test void publicDataMethodsCannotBecomeAnUnintendedWriteOrAdminFallback()throws Exception {
        var f=fixture();var publication=fixedDocument(f);var grant=createGrant(f,publication,grantCommand("view","external"));readable(grant);
        var response=http.send(HttpRequest.newBuilder(URI.create(listener.origin()+"/share-api/"+grant.path("publicId").asText())).header("X-Apicc-Share-Key",grant.path("key").asText()).POST(HttpRequest.BodyPublishers.noBody()).build(),HttpResponse.BodyHandlers.ofString());
        result(response,404,"share_unavailable");
    }
    @Test void projectDeleteRemovesGrantReceiptAndReferenceInOriginalTransaction()throws Exception {
        var f=fixture();var publication=fixedDocument(f);var grant=createGrant(f,publication,grantCommand("view","external"));readable(grant);
        mvc.perform(delete(f.url()).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isNoContent());
        assertAll(()->assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_grants WHERE id=?",Long.class,grant.path("id").asLong())).isZero(),
            ()->assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_grant_operations WHERE grant_id=?",Long.class,grant.path("id").asLong())).isZero(),
            ()->result(read(grant,grant.path("key").asText()),404,"share_unavailable"));
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"rps","inflight"})
    void globalReadCeilingIntersectsIndependentGrantBudgets(String branch)throws Exception {
        var f=fixture();var publication=fixedDocument(f);var first=createGrant(f,publication,grantCommand("view","external"));var second=createGrant(f,publication,grantCommand("view","external"));
        var original=deployment.getDeployment();
        try{
            deployment.setDeployment(json.convertValue(Map.of(branch.equals("rps")?"deploymentPublicReadRps":"deploymentPublicReadInFlight",1),com.autumnharvestc.server.collaboration.policy.DeploymentPolicyProperties.Deployment.class));
            artifactTime.advance(60000);
            var held=grants.admit(first.path("publicId").asText(),first.path("key").asText(),"view",false,null);assertThat(held.body()).isNotEmpty();
            if(branch.equals("rps"))held.close();
            var rejected=read(second,second.path("key").asText());held.close();artifactTime.advance(1000);var recovered=read(second,second.path("key").asText());
            assertAll(()->result(rejected,429,"share_capacity_exceeded"),()->assertThat(recovered.statusCode()).isEqualTo(200));
        }finally{deployment.setDeployment(original);}
    }
}
