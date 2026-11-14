package com.autumnharvestc.server.collaboration.runtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.DeserializationFeature;
import java.nio.file.*;
import java.net.*;
import java.net.http.*;
import java.util.UUID;
import java.time.Duration;
import java.io.ByteArrayOutputStream;
import org.springframework.stereotype.Component;

/** Private Core/source RPC only. No DB transaction or caller-selected runtime origin. */
@Component
public class CollaborationRuntimeClient {
    private final RuntimeProtocol protocol;
    private final ObjectMapper json;
    private final String secret;
    private final boolean enabled;
    private final URI endpoint;
    private final HttpClient http;
    private final int maxWireBytes,callTimeoutMs,mockTimeoutMs,sourceReadTimeoutMaxMs;
    private static final java.util.concurrent.ScheduledThreadPoolExecutor DEADLINES=new java.util.concurrent.ScheduledThreadPoolExecutor(1,Thread.ofPlatform().daemon().name("apicc-collaboration-deadline").factory());
    static { DEADLINES.setRemoveOnCancelPolicy(true); }
    public static final class Failure extends RuntimeException {
        public Failure(String code){super(code);}
        public String code(){return getMessage();}
    }
    public CollaborationRuntimeClient(RuntimeProperties properties, RuntimeProtocol protocol, ObjectMapper json) {
        properties.requireValid();this.protocol=protocol;this.json=json;enabled=properties.isEnabled();
        maxWireBytes=properties.getMaxWireBytes();callTimeoutMs=properties.getCallTimeoutMs();mockTimeoutMs=properties.getMockTimeoutMs();sourceReadTimeoutMaxMs=properties.getSourceReadTimeoutMaxMs();
        if(!enabled){secret="";endpoint=null;http=null;return;}
        try{
            var origin=URI.create(properties.getBaseUrl());
            if(!java.util.Set.of("http","https").contains(origin.getScheme())||origin.getHost()==null||origin.getUserInfo()!=null||origin.getQuery()!=null||origin.getFragment()!=null||!(origin.getPath().isEmpty()||origin.getPath().equals("/")))throw new IllegalArgumentException();
            endpoint=origin.resolve("/rpc");
        }catch(Exception problem){throw new Failure("RPC_CONFIGURATION_INVALID");}
        try{
            secret=Files.readString(Path.of(properties.getSecretFile())).replaceAll("^[\\x09-\\x0d\\x20]+|[\\x09-\\x0d\\x20]+$","");
            if(secret.length()<32||secret.chars().anyMatch(character->character<0x20||character>0x7e))throw new IllegalArgumentException();
        }catch(Exception problem){throw new Failure("RPC_SECRET_FILE_INVALID");}
        http=HttpClient.newBuilder().connectTimeout(Duration.ofMillis(properties.getConnectTimeoutMs())).followRedirects(HttpClient.Redirect.NEVER).build();
    }
    public JsonNode call(String operation,JsonNode payload,long deadlineEpochMs,int outputBudgetBytes) {
        if(!enabled)throw new Failure("RPC_UNAVAILABLE");
        long now=System.currentTimeMillis();
        long admissionDeadline=Math.min(deadlineEpochMs,now+(operation.equals("sync-read")?sourceReadTimeoutMaxMs:operation.equals("respond-mock")?mockTimeoutMs:callTimeoutMs));
        if(admissionDeadline<=now)throw new Failure("RPC_DEADLINE_EXCEEDED");
        try {
            var request=json.createObjectNode().put("protocolVersion",1).put("operation",operation).put("requestId",UUID.randomUUID().toString())
                .put("inputDigest",RuntimeProtocol.digestJson(payload)).put("deadlineEpochMs",admissionDeadline).put("outputBudgetBytes",outputBudgetBytes);
            request.set("payload",payload);
            if(!protocol.validRequest(request))throw new Failure("RPC_INVALID_REQUEST");
            // Read the deadline only after the generated finite payload schema accepts it.
            final long deadline=operation.equals("sync-read")?Math.min(admissionDeadline,payload.path("input").path("deadlineAtMs").asLong()):admissionDeadline;
            if(deadline<=now)throw new Failure("RPC_DEADLINE_EXCEEDED");request.put("deadlineEpochMs",deadline);
            byte[] requestBytes=json.writeValueAsBytes(request);
            if(requestBytes.length>maxWireBytes)throw new Failure("RPC_MESSAGE_TOO_LARGE");
            long remaining=deadline-System.currentTimeMillis();if(remaining<=0)throw new Failure("RPC_DEADLINE_EXCEEDED");
            var response=http.send(HttpRequest.newBuilder(endpoint).timeout(Duration.ofMillis(remaining))
                .header("X-Apicc-Collaboration-Key",secret).header("Content-Type","application/json")
                .POST(HttpRequest.BodyPublishers.ofByteArray(requestBytes)).build(),HttpResponse.BodyHandlers.ofInputStream());
            byte[] bytes;
            var stream=response.body();var expired=new java.util.concurrent.atomic.AtomicBoolean();
            var watchdog=DEADLINES.schedule(()->{expired.set(true);try{stream.close();}catch(java.io.IOException ignored){}},Math.max(0,deadline-System.currentTimeMillis()),java.util.concurrent.TimeUnit.MILLISECONDS);
            try(stream;var output=new ByteArrayOutputStream()){
                byte[] buffer=new byte[8192];int received=0,count;
                while((count=stream.read(buffer))!=-1){received+=count;if(received>maxWireBytes||received>outputBudgetBytes)throw new Failure("RPC_MESSAGE_TOO_LARGE");output.write(buffer,0,count);}
                bytes=output.toByteArray();
            }catch(java.io.IOException problem){if(expired.get()||System.currentTimeMillis()>=deadline)throw new Failure("RPC_DEADLINE_EXCEEDED");throw problem;}
            finally{watchdog.cancel(false);}
            if(System.currentTimeMillis()>deadline)throw new Failure("RPC_DEADLINE_EXCEEDED");
            JsonNode value;
            try{value=json.reader().with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).readTree(bytes);}
            catch(Exception problem){throw new Failure("RPC_RESPONSE_INVALID");}
            if(response.statusCode()==429&&value.path("code").asText().equals("RPC_BUSY")&&value.path("retryable").isBoolean()&&!value.path("retryable").asBoolean()&&value.path("requestId").asText().isEmpty())throw new Failure("RPC_BUSY");
            if(response.statusCode()!=200){
                String errorCode=value.path("code").asText();
                boolean expectedError=java.util.Set.of("sync-read","sync-plan","sync-resolve","sync-rollback").contains(operation)
                    || (response.statusCode()==400&&operation.equals("classify-asset-mutation")&&errorCode.equals("PUBLICATION_SOURCE_INVALID"));
                if(expectedError&&protocol.validError(value)&&request.path("requestId").equals(value.path("requestId")))throw new Failure(errorCode);
                throw new Failure("RPC_RESPONSE_INVALID");
            }
            if(!protocol.validResponse(value)||!value.path("coreBuildIdentity").asText().equals(protocol.coreBuildIdentity())
                ||value.path("wireBytes").asLong()!=bytes.length||value.path("outputBytes").asLong()!=RuntimeProtocol.payloadWireBytes(json,bytes)
                ||!value.path("outputDigest").asText().equals(RuntimeProtocol.digestJson(value.path("payload"))))throw new Failure("RPC_RESPONSE_INVALID");
            for(String field:new String[]{"protocolVersion","operation","requestId","inputDigest","deadlineEpochMs","outputBudgetBytes"})if(!request.get(field).equals(value.get(field)))throw new Failure("RPC_RESPONSE_INVALID");
            if(System.currentTimeMillis()>deadline)throw new Failure("RPC_DEADLINE_EXCEEDED");
            return value.get("payload");
        }catch(Failure failure){throw failure;}
        catch(HttpTimeoutException problem){throw new Failure("RPC_DEADLINE_EXCEEDED");}
        catch(InterruptedException problem){Thread.currentThread().interrupt();throw new Failure("RPC_CANCELLED");}
        catch(java.io.IOException problem){throw new Failure("RPC_UNAVAILABLE");}
        catch(RuntimeException problem){throw new Failure("RPC_INVALID_REQUEST");}
    }
    @jakarta.annotation.PreDestroy public void close(){if(http!=null)http.shutdownNow();}
}
