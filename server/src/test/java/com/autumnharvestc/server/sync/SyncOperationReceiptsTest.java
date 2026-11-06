package com.autumnharvestc.server.sync;
import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.beans.factory.config.BeanFactoryPostProcessor;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;
@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT)
@Import(SyncOperationReceiptsTest.ReceiptDatabaseConfiguration.class)
class SyncOperationReceiptsTest extends SyncApplicationHttpFixture {
    @TestConfiguration(proxyBeanMethods=false) static class ReceiptDatabaseConfiguration {
        // The random-port context has its own workers and must not consume the mock context's queue.
        // Apply before web-server refresh can initialize the authentication filter's DataSource.
        @Bean static BeanFactoryPostProcessor receiptDatabase(ConfigurableEnvironment environment){
            return beans->environment.getPropertySources().addFirst(new MapPropertySource("receipt-test-database",java.util.Map.of("spring.datasource.url","jdbc:h2:mem:apicc-sync-operation-receipts;DB_CLOSE_DELAY=-1")));
        }
    }
    @LocalServerPort int port;
    @Test void sameIntentReplaysExactlyOnceAndDifferentActorBodyCannotReuseIt() throws Exception {
        var request=application(checkToCandidate(createUrlSource("/fast")));var first=body(sourceRequest("POST","/applications",editor(),request).andExpect(status().isOk()));assertThat(body(sourceRequest("POST","/applications",editor(),request).andExpect(status().isOk()))).isEqualTo(first);assertThat(applicationMutationCount(request.path("intentId").asText())).isEqualTo(1);
        sourceRequest("POST","/applications",editor(),request.deepCopy().put("decisionsDigest","f".repeat(64))).andExpect(status().isConflict());sourceRequest("POST","/applications",f.owner(),request).andExpect(status().isForbidden());sourceRequest("GET","/operations/"+request.path("intentId").asText(),f.owner(),null).andExpect(status().isNotFound());assertThat(currentVersion()).isEqualTo("3");
    }
    @Test void storedReceiptIntegrityIsVerifiedBeforeRecovery() throws Exception {
        var request=application(checkToCandidate(createUrlSource("/fast")));sourceRequest("POST","/applications",editor(),request).andExpect(status().isOk());String intent=request.path("intentId").asText();var corrupted=(com.fasterxml.jackson.databind.node.ObjectNode)readOwnOperation(intent);corrupted.put("completedAtMs",0);jdbc.update("UPDATE sync_operations SET response_json=? WHERE project_id=? AND intent_id=?",corrupted.toString(),Long.parseLong(f.project()),intent);sourceRequest("GET","/operations/"+intent,editor(),null).andExpect(status().isConflict());assertThat(currentVersion()).isEqualTo("3");
    }
    @Test void lostApplyResponseIsReconciledWithoutASecondMutation() throws Exception {
        var view=checkToCandidate(createUrlSource("/fast"));var intent=newIntent();var request=application(view).put("intentId",intent);var committed=new java.util.concurrent.CompletableFuture<Integer>();
        var proxy=com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1",0),0);
        proxy.createContext("/",exchange->{try{var bytes=exchange.getRequestBody().readAllBytes();assertThat(json.readTree(bytes).path("intentId").asText()).isEqualTo(intent);var actual=java.net.http.HttpClient.newHttpClient().send(java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://127.0.0.1:"+port+f.projectUrl()+"/sync/applications")).header("Authorization","Bearer "+editor().token()).header("Content-Type","application/json").POST(java.net.http.HttpRequest.BodyPublishers.ofByteArray(bytes)).build(),java.net.http.HttpResponse.BodyHandlers.ofString());assertThat(actual.statusCode()).isEqualTo(200);assertThat(json.readTree(actual.body()).path("status").asText()).isEqualTo("committed");committed.complete(applicationMutationCount(intent));}catch(Throwable e){committed.completeExceptionally(e);}finally{exchange.close();}});proxy.start();
        try{assertThatThrownBy(()->submitApplication(proxy.getAddress().getPort(),request)).isInstanceOf(java.io.IOException.class);assertThat(committed.get(10,java.util.concurrent.TimeUnit.SECONDS)).isEqualTo(1);}finally{proxy.stop(0);}
        var receipt=readOwnOperation(intent);assertThat(receipt.path("status").asText()).isEqualTo("committed");assertThat(applicationMutationCount(intent)).isEqualTo(1);assertThat(currentVersion()).isEqualTo("3");System.out.println("T10_RESPONSE_LOSS "+json.createObjectNode().put("intentId",intent).put("assetVersion",currentVersion()).put("historyMutations",applicationMutationCount(intent)).put("receiptStatus",receipt.path("status").asText()));assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_management_audit WHERE scope_type='project' AND scope_id=? AND action='asset.change' AND version=3",Integer.class,Long.parseLong(f.project()))).isEqualTo(1);
    }
    void submitApplication(int proxyPort,JsonNode body) throws java.io.IOException {
        byte[] bytes=body.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
        try(var socket=new java.net.Socket("127.0.0.1",proxyPort)){socket.setSoTimeout(15000);var output=socket.getOutputStream();output.write(("POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: "+bytes.length+"\r\n\r\n").getBytes(java.nio.charset.StandardCharsets.US_ASCII));output.write(bytes);output.flush();if(socket.getInputStream().read()==-1)throw new java.io.EOFException("Committed apply response was severed on the real transport");throw new AssertionError("Expected only this successful response to be dropped");}
    }
}
