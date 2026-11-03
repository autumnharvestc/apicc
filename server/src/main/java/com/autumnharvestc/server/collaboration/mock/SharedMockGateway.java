package com.autumnharvestc.server.collaboration.mock;

import com.autumnharvestc.server.collaboration.grants.GrantService;
import com.autumnharvestc.server.collaboration.policy.PolicyReadView;
import com.autumnharvestc.server.collaboration.runtime.CollaborationRuntimeClient;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import org.springframework.stereotype.Component;
import static com.autumnharvestc.server.collaboration.artifacts.CollaborationStorage.number;
import static com.autumnharvestc.server.collaboration.policy.PolicyReadView.Code.*;

/** Fixed-plan execution only; authority remains the per-request Java admission. */
@Component
public class SharedMockGateway {
    private final CollaborationRuntimeClient runtime;
    private final ObjectMapper json;
    private final MockLimiter limits;
    private final com.autumnharvestc.server.collaboration.audit.MockLogs logs;
    private static final java.util.concurrent.ScheduledThreadPoolExecutor DEADLINES=new java.util.concurrent.ScheduledThreadPoolExecutor(1,Thread.ofPlatform().daemon().name("apicc-mock-deadline").factory());
    static{DEADLINES.setRemoveOnCancelPolicy(true);}
    public SharedMockGateway(CollaborationRuntimeClient runtime,ObjectMapper json,MockLimiter limits,com.autumnharvestc.server.collaboration.audit.MockLogs logs){this.runtime=runtime;this.json=json;this.limits=limits;this.logs=logs;}
    public void serve(HttpExchange exchange,String id,GrantService.Admission admission)throws Exception {
        long started=System.nanoTime();
        com.fasterxml.jackson.databind.JsonNode matched=null;int observedStatus=0;String observedReason="CANCELLED";
        try{
        try(var lease=limits.acquire(admission.publicationId(),admission.projectId(),admission.policy())){
        var expired=new java.util.concurrent.atomic.AtomicBoolean();Thread owner=Thread.currentThread();long deadline=System.currentTimeMillis()+number(admission.policy(),MOCK_CALL_TIMEOUT_MS);
        var timeout=DEADLINES.schedule(()->{expired.set(true);owner.interrupt();},number(admission.policy(),MOCK_CALL_TIMEOUT_MS),java.util.concurrent.TimeUnit.MILLISECONDS);
        try{
        var policy=admission.policy();var payload=json.createObjectNode();payload.set("plan",json.readTree(admission.body()));payload.set("policy",policy(policy));
        String origin=exchange.getRequestHeaders().getFirst("Origin");if(origin!=null){if(!strings(policy,CORS_ALLOWED_ORIGINS).contains(origin))throw new com.autumnharvestc.server.core.ApiException(org.springframework.http.HttpStatus.FORBIDDEN,"mock_origin_forbidden","当前项目不允许此调用来源");exchange.getResponseHeaders().set("Access-Control-Allow-Origin",origin);exchange.getResponseHeaders().set("Vary","Origin");}
        String raw=exchange.getRequestURI().getRawPath();String prefix="/mock/"+id;
        String target=raw.substring(prefix.length());if(target.isEmpty())target="/";
        if(Boolean.TRUE.equals(exchange.getAttribute("absoluteRequestTarget"))||exchange.getRequestMethod().equals("CONNECT")||target.startsWith("//"))throw invalidTarget();
        for(String segment:target.split("/",-1)){
            String dots=segment.replaceAll("(?i)%2e",".");
            if(dots.equals(".")||dots.equals("..")||segment.matches("(?i).*(%2f|%5c).*"))throw invalidTarget();
        }
        if(exchange.getRequestURI().getRawQuery()!=null)target+="?"+exchange.getRequestURI().getRawQuery();
        var input=payload.putObject("input").put("method",exchange.getRequestMethod()).put("target",target);
        var headers=input.putObject("headers");exchange.getRequestHeaders().forEach((name,values)->{
            String lower=name.toLowerCase(java.util.Locale.ROOT);
            if(!java.util.Set.of("authorization","cookie","proxy-authorization").contains(lower)&&!lower.startsWith("x-apicc-")&&strings(policy,EXTRA_SENSITIVE_HEADERS).stream().noneMatch(lower::equalsIgnoreCase))headers.put(lower,String.join(",",values));
        });
        var body=input.putArray("body");long maximum=number(policy,MAX_MOCK_REQUEST_BYTES),received=exchange.getRequestHeaders().entrySet().stream().mapToLong(field->field.getKey().getBytes(java.nio.charset.StandardCharsets.UTF_8).length+field.getValue().stream().mapToLong(value->value.getBytes(java.nio.charset.StandardCharsets.UTF_8).length).sum()).sum();byte[] buffer=new byte[8192];int count;
        if(received>maximum)throw requestSize();
        while((count=exchange.getRequestBody().read(buffer))!=-1){received+=count;if(received>maximum)throw requestSize();for(int i=0;i<count;i++)body.add(Byte.toUnsignedInt(buffer[i]));}
        var output=runtime.call("respond-mock",payload,deadline,Math.toIntExact(number(policy,RPC_MAX_MESSAGE_BYTES)));
        matched=output;
        long responseBytes=output.path("body").size()+output.path("mediaType").asText().getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
        for(var iterator=output.path("headers").fields();iterator.hasNext();){var field=iterator.next();String name=field.getKey().toLowerCase(java.util.Locale.ROOT);if(java.util.Set.of("set-cookie","location","connection","keep-alive","proxy-authenticate","proxy-authorization","te","trailer","transfer-encoding","upgrade","content-length","content-security-policy","strict-transport-security","x-frame-options","x-content-type-options","referrer-policy","permissions-policy").contains(name)||name.startsWith("access-control-")||name.startsWith("cross-origin-"))throw new com.autumnharvestc.server.core.ApiException(org.springframework.http.HttpStatus.SERVICE_UNAVAILABLE,"mock_response_header_forbidden","Mock 响应包含禁止覆盖的平台控制头");responseBytes+=field.getKey().getBytes(java.nio.charset.StandardCharsets.UTF_8).length+field.getValue().asText().getBytes(java.nio.charset.StandardCharsets.UTF_8).length;}
        if(responseBytes>number(policy,MAX_MOCK_RESPONSE_BYTES))throw new com.autumnharvestc.server.core.ApiException(org.springframework.http.HttpStatus.SERVICE_UNAVAILABLE,"mock_response_size_limit","固定 Mock 响应超过当前响应字节上限");
        output.path("headers").fields().forEachRemaining(field->exchange.getResponseHeaders().set(field.getKey(),field.getValue().asText()));
        exchange.getResponseHeaders().set("Content-Type",output.path("mediaType").asText());byte[] bytes=new byte[output.path("body").size()];for(int i=0;i<bytes.length;i++)bytes[i]=(byte)output.path("body").get(i).asInt();
        exchange.sendResponseHeaders(output.path("status").asInt(),bytes.length);exchange.getResponseBody().write(bytes);
        observedStatus=output.path("status").asInt();observedReason=output.path("reason").asText();
        }catch(Exception failure){if(expired.get()){Thread.interrupted();throw new com.autumnharvestc.server.core.ApiException(org.springframework.http.HttpStatus.REQUEST_TIMEOUT,"mock_deadline_exceeded","Mock 调用已超过期限");}if(failure instanceof CollaborationRuntimeClient.Failure rpc){if(rpc.code().equals("RPC_BUSY"))throw new com.autumnharvestc.server.core.ApiException(org.springframework.http.HttpStatus.TOO_MANY_REQUESTS,"mock_capacity_exceeded","Mock 运行服务容量已满");throw new com.autumnharvestc.server.core.ApiException(org.springframework.http.HttpStatus.SERVICE_UNAVAILABLE,"collaboration_mock_unavailable","Mock 运行服务或当前固定计划不可用");}throw failure;}finally{timeout.cancel(false);}
        }
        }catch(Exception failure){if(failure instanceof com.autumnharvestc.server.core.ApiException api){observedStatus=api.getStatus().value();observedReason=switch(api.getCode()){case "mock_capacity_exceeded"->"CAPACITY_LIMIT";case "mock_deadline_exceeded"->"DEADLINE_EXCEEDED";default->api.getCode();};}throw failure;}
        finally{logs.record(admission.workspaceId(),admission.projectId(),admission.publicationId(),new com.autumnharvestc.server.collaboration.audit.MockLogEntry(String.valueOf(admission.publicationId()),admission.version(),java.time.Instant.now().toString(),exchange.getRequestMethod(),matched==null||matched.path("routeTemplate").isMissingNode()?null:matched.path("routeTemplate").asText(),matched==null||matched.path("ruleId").isMissingNode()?null:matched.path("ruleId").asText(),observedStatus,(System.nanoTime()-started)/1_000_000,observedReason,java.util.UUID.randomUUID().toString(),id));}
    }
    private static com.autumnharvestc.server.core.ApiException invalidTarget(){return new com.autumnharvestc.server.core.ApiException(org.springframework.http.HttpStatus.BAD_REQUEST,"mock_request_target_invalid","Mock 业务路径或方法无效");}
    private static com.autumnharvestc.server.core.ApiException requestSize(){return new com.autumnharvestc.server.core.ApiException(org.springframework.http.HttpStatus.PAYLOAD_TOO_LARGE,"mock_request_size_limit","Mock 请求超过字节上限");}
    private java.util.List<String> strings(PolicyReadView policy,PolicyReadView.Code code){return ((PolicyReadView.StringListSetting)policy.settings().stream().filter(setting->setting.code()==code).findFirst().orElseThrow()).effective();}
    private ObjectNode policy(PolicyReadView policy){
        var result=json.createObjectNode().put("maxResponseBytes",number(policy,MAX_MOCK_RESPONSE_BYTES)).put("maxDelayMs",number(policy,MAX_MOCK_DELAY_MS)).put("requestDeadlineMs",number(policy,MOCK_CALL_TIMEOUT_MS));
        for(var setting:policy.settings())if(setting instanceof PolicyReadView.StringListSetting list&&java.util.Set.of(EXTRA_SENSITIVE_HEADERS,EXTRA_SENSITIVE_QUERY,EXTRA_SENSITIVE_FIELDS,EXTRA_SENSITIVE_POINTERS).contains(setting.code()))result.set(switch(setting.code()){case EXTRA_SENSITIVE_HEADERS->"extraSensitiveHeaders";case EXTRA_SENSITIVE_QUERY->"extraSensitiveQuery";case EXTRA_SENSITIVE_FIELDS->"extraSensitiveFields";default->"extraSensitivePointers";},json.valueToTree(list.effective()));
        return result;
    }
}
