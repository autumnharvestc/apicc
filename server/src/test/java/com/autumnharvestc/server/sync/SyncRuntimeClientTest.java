package com.autumnharvestc.server.sync;

import com.autumnharvestc.server.collaboration.runtime.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.TestPropertySource;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import java.nio.file.*;
import java.util.concurrent.*;
import com.fasterxml.jackson.databind.JsonNode;

/** Source-specific deployment budget through actual binding and policy routes. */
@TestPropertySource(properties={"spring.datasource.url=jdbc:h2:mem:apicc-sync-t8;DB_CLOSE_DELAY=-1", "apicc.collaboration.runtime.source-read-timeout-max-ms=60000"})
class SyncRuntimeClientTest extends SyncHttpFixture {
    @org.springframework.beans.factory.annotation.Autowired RuntimeProperties runtime;
    @org.springframework.beans.factory.annotation.Autowired SyncPolicyService policies;

    @Test void legalSourceCapReachesPolicyAdmissionWithDeploymentProvenance() throws Exception {
        var before=body(sourceRequest("GET","/policy",editor(),null).andExpect(status().isOk()));
        assertThat(before.path("effective").path("policy").path("urlDeadlineMs").asInt()).isEqualTo(60000);
        assertThat(before.path("effective").path("policy").path("gitDeadlineMs").asInt()).isEqualTo(60000);
        assertThat(before.path("effective").path("sources").path("gitDeadlineMs").asText()).isEqualTo("deployment");
        var request=policy(60000);
        sourceRequest("PUT","/policy",f.owner(),request).andExpect(status().isOk());
        assertThat(policies.requireEffective(Long.parseLong(f.workspace()),Long.parseLong(f.project())).path("policy").path("gitDeadlineMs").asInt()).isEqualTo(60000);
    }
    @Test void otherwiseLegalSourceDeadlineAboveCapCannotSave() throws Exception {
        sourceRequest("PUT","/policy",f.owner(),policy(60000)).andExpect(status().isOk());
        var request=policy(60001).put("expectedRevision","1");((ObjectNode)request.path("policy")).put("revision","2");
        sourceRequest("PUT","/policy",f.owner(),request).andExpect(status().isBadRequest());
        assertThat(body(sourceRequest("GET","/policy",f.owner(),null).andExpect(status().isOk())).path("saved").path("revision").asText()).isEqualTo("1");
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(ints={999,1800001}) void invalidDeploymentSourceCapFailsRealBinding(int value) {
        new org.springframework.boot.test.context.runner.ApplicationContextRunner()
            .withConfiguration(org.springframework.boot.autoconfigure.AutoConfigurations.of(org.springframework.boot.autoconfigure.context.ConfigurationPropertiesAutoConfiguration.class))
            .withBean(com.fasterxml.jackson.databind.ObjectMapper.class,com.fasterxml.jackson.databind.ObjectMapper::new)
            .withBean(RuntimeProperties.class).withBean(RuntimeProtocol.class).withBean(CollaborationRuntimeClient.class)
            .withPropertyValues("apicc.collaboration.runtime.source-read-timeout-max-ms="+value)
            .run(context->{assertThat(context).hasFailed();assertThat(context.getStartupFailure()).hasRootCauseMessage("RPC_CONFIGURATION_INVALID");});
    }
    private ObjectNode policy(int milliseconds) {
        var request=json.createObjectNode().put("formatVersion",1).put("intentId",java.util.UUID.randomUUID().toString()).put("expectedRevision","0");
        request.set("policy",json.createObjectNode().put("formatVersion",1).put("scope","project").put("revision","1").put("gitDeadlineMs",milliseconds));return request;
    }
    @Test void generatedFiniteErrorBoundaryRejectsUnknownNativeCodes() throws Exception {
        var protocol=new RuntimeProtocol(json);
        assertThat(protocol.validError(json.readTree("{\"code\":\"SYNC_MATERIAL_INVALID\",\"requestId\":\"owned\",\"retryable\":false}"))).isTrue();
        assertThat(protocol.validError(json.readTree("{\"code\":\"SYNC_ARBITRARY_NATIVE_DETAIL\",\"requestId\":\"owned\",\"retryable\":false}"))).isFalse();
    }
    @Test void actualProductionSourceReadBeyondOrdinaryTenSecondsUsesItsOwnCap() throws Exception {
        try(var fixture=new RuntimeFixture()) {
            var client=fixture.client(30000);
            assertThat(client.call("sync-read",fixture.payload("/fast"),System.currentTimeMillis()+20000,1048576).path("rawText").asText()).isEqualTo(fixture.info.path("rawText").asText());
            long started=System.nanoTime();
            var slow=fixture.payload("/slow");((ObjectNode)slow.path("input")).put("deadlineAtMs",System.currentTimeMillis()+45000);
            var result=org.junit.jupiter.api.Assertions.assertDoesNotThrow(()->client.call("sync-read",slow,System.currentTimeMillis()+45000,1048576));
            assertThat(TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-started)).isGreaterThan(10000);
            assertThat(result.path("status").asText()).isEqualTo("read");assertThat(result.path("rawText").asText()).isEqualTo(fixture.info.path("rawText").asText());
            client.close();
        }
    }
    @Test void sourceClientReturnsFiniteBoundFailureWithoutAutomaticRetry() throws Exception {
        try(var fixture=new RuntimeFixture()) {
            var client=fixture.client(15000);var payload=fixture.payload("/fast");
            assertThat(client.call("sync-read",payload,System.currentTimeMillis()+5000,1048576).path("status").asText()).isEqualTo("read");
            ((ObjectNode)payload.path("material")).set("httpHeaders",json.createArrayNode().add(json.createObjectNode().put("name","Host").put("value","synthetic-private-value")));
            org.assertj.core.api.Assertions.assertThatThrownBy(()->client.call("sync-read",payload,System.currentTimeMillis()+5000,1048576)).isInstanceOfSatisfying(CollaborationRuntimeClient.Failure.class,error->assertThat(error.code()).isEqualTo("SYNC_MATERIAL_INVALID"));client.close();
        }
    }
    @Test void interruptedRealJavaTransportCancelsActualSourceSocket() throws Exception {
        try(var fixture=new RuntimeFixture()) {
            var client=fixture.client(15000);var failure=new java.util.concurrent.atomic.AtomicReference<Throwable>();
            var thread=new Thread(()->{try{client.call("sync-read",fixture.payload("/blocked"),System.currentTimeMillis()+20000,1048576);}catch(Throwable error){failure.set(error);}});
            thread.start();assertThat(fixture.awaitFile("source-received",5000)).isTrue();thread.interrupt();thread.join(5000);
            assertThat(thread.isAlive()).isFalse();assertThat(failure.get()).isInstanceOfSatisfying(CollaborationRuntimeClient.Failure.class,error->assertThat(error.code()).isEqualTo("RPC_CANCELLED"));
            assertThat(fixture.awaitFile("source-collected",5000)).isTrue();client.close();
        }
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"deployment-cap","source-deadline"})
    void actualSourceReadUsesMinimumRemainingDeadline(String kind) throws Exception {
        try(var fixture=new RuntimeFixture()) {
            var client=fixture.client(kind.equals("deployment-cap")?1000:15000);var payload=fixture.payload("/blocked");
            assertThat(client.call("sync-read",fixture.payload("/fast"),System.currentTimeMillis()+5000,1048576).path("status").asText()).isEqualTo("read");
            long expected=kind.equals("deployment-cap")?1000:1500;
            ((ObjectNode)payload.path("input")).put("deadlineAtMs",System.currentTimeMillis()+(kind.equals("deployment-cap")?5000:1500));
            long start=System.nanoTime();
            org.assertj.core.api.Assertions.assertThatThrownBy(()->client.call("sync-read",payload,System.currentTimeMillis()+8000,1048576)).isInstanceOfSatisfying(CollaborationRuntimeClient.Failure.class,error->assertThat(error.code()).isEqualTo("RPC_DEADLINE_EXCEEDED"));
            assertThat(fixture.awaitFile("source-received",5000)).isTrue();assertThat(fixture.awaitFile("source-collected",5000)).isTrue();
            assertThat(TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-start)).isBetween(expected-250,expected+2000);client.close();
        }
    }
    final class RuntimeFixture implements AutoCloseable {
        final Path directory=Files.createTempDirectory("apicc-t8-java-");final Process process;final JsonNode info;
        RuntimeFixture() throws Exception {
            var current=Path.of("").toAbsolutePath();var root=Files.isDirectory(current.resolve("apps"))?current:current.getParent();
            process=new ProcessBuilder(System.getenv().getOrDefault("APICC_TEST_NODE","node"),root.resolve("server/src/test/resources/sync-runtime-process.mjs").toString(),directory.toString()).directory(root.toFile()).redirectError(directory.resolve("node-stderr.log").toFile()).start();
            try { String line=CompletableFuture.supplyAsync(()->{try{return process.inputReader().readLine();}catch(Exception e){throw new RuntimeException(e);}}).get(10,TimeUnit.SECONDS);if(line==null)throw new IllegalStateException("Actual Node source fixture prerequisite failed; "+directory.resolve("node-stderr.log"));info=json.readTree(line); }
            catch(Exception failure){process.destroyForcibly().waitFor();throw failure;}
        }
        CollaborationRuntimeClient client(int cap) {
            var p=new RuntimeProperties();p.setEnabled(true);p.setBaseUrl(info.path("url").asText());p.setSecretFile(info.path("secretFile").asText());p.setSourceReadTimeoutMaxMs(cap);
            return new CollaborationRuntimeClient(p,new RuntimeProtocol(json),json);
        }
        ObjectNode payload(String path) {
            var input=json.createObjectNode().put("formatVersion",1).put("deadlineAtMs",System.currentTimeMillis()+20000);
            input.set("source",json.createObjectNode().put("formatVersion",1).put("id","00000000-0000-4000-8000-000000000001").put("revision","1").put("moduleId","00000000-0000-4000-8000-000000000002").put("kind","url").put("url",info.path("origin").asText()+path));
            input.set("budget",json.createObjectNode().put("connectTimeoutMs",1000).put("maxAttempts",1).put("maxSourceBytes",65536).put("gitDiskThresholdBytes",33554432));
            var value=json.createObjectNode();value.set("input",input);value.set("context",json.createObjectNode().put("workspaceId","71").put("projectId","72").put("sourceRevision","1").put("authorizationGeneration","1").put("invocationId",java.util.UUID.randomUUID().toString()).put("projectConcurrency",1).put("hostConcurrency",4));
            value.set("material",json.createObjectNode().put("leaseId",java.util.UUID.randomUUID().toString()).put("identity","a".repeat(64)));value.set("network",json.createObjectNode().put("kind","direct").put("revision","1"));return value;
        }
        boolean awaitFile(String name,long milliseconds) throws Exception {long until=System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(milliseconds);while(System.nanoTime()<until){if(Files.exists(directory.resolve(name)))return true;Thread.sleep(10);}return false;}
        public void close() throws Exception {process.getOutputStream().write(1);process.getOutputStream().flush();if(!process.waitFor(10,TimeUnit.SECONDS)){process.destroyForcibly().waitFor();throw new IllegalStateException("Owned Node fixture failed actual shutdown: "+directory);}assertThat(process.exitValue()).isZero();}
    }
}
