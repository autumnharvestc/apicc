package com.autumnharvestc.server.collaboration;

import com.autumnharvestc.server.collaboration.publicapi.*;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.net.URI;
import java.net.http.*;
import java.util.*;
import org.springframework.beans.factory.annotation.Autowired;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

abstract class GrantHttpFixture extends ArtifactHttpFixture {
    @Autowired PublicListener listener;
    @Autowired PublicAccessProperties publicSettings;
    @Autowired com.autumnharvestc.server.collaboration.policy.DeploymentPolicyProperties deployment;
    @Autowired com.autumnharvestc.server.collaboration.artifacts.CollaborationStorage storage;
    @Autowired com.autumnharvestc.server.collaboration.grants.GrantService grants;
    final HttpClient http=HttpClient.newHttpClient();
    static int loopbackPort(){try(var socket=new java.net.ServerSocket(0,0,java.net.InetAddress.getByName("127.0.0.1"))){return socket.getLocalPort();}catch(Exception failure){throw new IllegalStateException("Cannot reserve synthetic loopback port",failure);}}
    ObjectNode grantCommand(String purpose,String audience){return json.createObjectNode().put("operationIntent",UUID.randomUUID().toString()).put("purpose",purpose).put("audience",audience).put("expectedRevision",1);}
    String createPath(Fixture f,JsonNode publication){return collaboration(f)+"/publications/"+publication.path("id").asText()+"/grants";}
    JsonNode fixedDocument(Fixture f)throws Exception {
        policy(f,true,Map.of("externalSharingAllowed",true));policy(f,false,Map.of("externalSharingAllowed",true));
        return publish(f,preview(f,f.owner(),documentRequest(f)),UUID.randomUUID().toString());
    }
    JsonNode createGrant(Fixture f,JsonNode publication,ObjectNode command)throws Exception {
        return body(request(f.owner().token(),post(createPath(f,publication)),command).andExpect(status().isCreated()));
    }
    JsonNode fixedMock(Fixture f)throws Exception {
        var original=deployment.getDefaults();var settings=json.valueToTree(original);
        ObjectNode mutable=settings==null||settings.isNull()?json.createObjectNode():(ObjectNode)settings;
        mutable.put("externalSharingAllowed",true).put("sharedMockAllowed",true);
        deployment.setDefaults(json.convertValue(mutable,com.autumnharvestc.server.collaboration.policy.DeploymentPolicyProperties.Defaults.class));
        policy(f,true,Map.of("externalSharingAllowed",true,"sharedMockAllowed",true));policy(f,false,Map.of("externalSharingAllowed",true,"sharedMockAllowed",true));
        var input=documentRequest(f);((ObjectNode)input.path("source")).put("kind","mock");
        var publication=publish(f,preview(f,f.owner(),input),UUID.randomUUID().toString());
        return body(request(f.owner().token(),patch(collaboration(f)+"/publications/"+publication.path("id").asText()),Map.of("expectedRevision",1,"enabled",true)).andExpect(status().isOk()));
    }
    HttpResponse<String> read(JsonNode grant,String key)throws Exception {
        return read(grant,key,()->{});
    }
    HttpResponse<String> read(JsonNode grant,String key,Runnable bodyReceived)throws Exception {
        String url=grant.path("publicUrl").asText().replace("/s/","/share-api/");
        var builder=HttpRequest.newBuilder(URI.create(url)).GET();if(key!=null)builder.header("X-Apicc-Share-Key",key);
        return settledPublicRead(builder,bodyReceived);
    }
    HttpResponse<String> readPath(String path,String header,String key,String token)throws Exception {
        var builder=HttpRequest.newBuilder(URI.create(listener.origin()+path)).GET();if(key!=null)builder.header(header,key);if(token!=null)builder.header("Authorization","Bearer "+token);
        if(path.startsWith("/share-api/"))return settledPublicRead(builder,()->{});
        return http.send(builder.build(),HttpResponse.BodyHandlers.ofString());
    }
    private HttpResponse<String> settledPublicRead(HttpRequest.Builder builder,Runnable bodyReceived)throws Exception {
        String marker=UUID.randomUUID().toString();builder.header("X-Apicc-Test-Read",marker);
        var response=http.send(builder.build(),HttpResponse.BodyHandlers.ofString());
        bodyReceived.run();
        // Body arrival precedes the listener's best-effort audit and lease close.
        // Wait for this request's actual collection, including failed/disabled audit,
        // without waiting for unrelated Mock requests or requiring an audit row.
        Object field=org.springframework.test.util.ReflectionTestUtils.getField(listener,"active");
        assertThat(field).isInstanceOf(Set.class);var active=(Set<?>)field;
        java.util.function.BooleanSupplier pending=()->active.stream().map(com.sun.net.httpserver.HttpExchange.class::cast)
            .anyMatch(exchange->marker.equals(exchange.getRequestHeaders().getFirst("X-Apicc-Test-Read")));
        long deadline=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(5);
        while(pending.getAsBoolean()&&System.nanoTime()<deadline)Thread.sleep(10);
        assertThat(pending.getAsBoolean()).as("public read server handler collected its audit and lease").isFalse();
        return response;
    }
    void result(HttpResponse<String> response,int status,String code)throws Exception {assertThat(response.statusCode()).isEqualTo(status);assertThat(json.readTree(response.body()).path("code").asText()).isEqualTo(code);}
    void inactive(HttpResponse<String> response,String reason)throws Exception {result(response,410,"share_inactive");assertThat(json.readTree(response.body()).path("reason").asText()).isEqualTo(reason);}
    void readable(JsonNode grant)throws Exception {var response=read(grant,grant.path("key").asText());assertThat(response.statusCode()).isEqualTo(200);assertThat(json.readTree(response.body()).path("kind").asText()).isEqualTo("document");}
}
