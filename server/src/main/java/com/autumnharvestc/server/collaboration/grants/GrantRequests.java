package com.autumnharvestc.server.collaboration.grants;

import com.autumnharvestc.server.access.AccessRequests;
import com.autumnharvestc.server.core.ApiException;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.Set;
import static org.springframework.http.HttpStatus.BAD_REQUEST;

final class GrantRequests {
    private GrantRequests(){}
    record Create(String intent,String purpose,String audience,boolean download,Long expiresAt,long expectedRevision,Long durationMs){
        @Override public String toString(){
            String old="Create[intent="+intent+", purpose="+purpose+", audience="+audience+", download="+download+", expiresAt="+expiresAt+", expectedRevision="+expectedRevision;
            return old+(durationMs==null?"":", durationMs="+durationMs)+"]";
        }
    }
    static Create create(JsonNode body){
        fields(body,Set.of("operationIntent","purpose","audience","downloadAllowed","expiresAt","durationMs","expectedRevision"));
        String purpose=text(body,"purpose"),audience=text(body,"audience");
        if(!Set.of("view","call").contains(purpose)||!Set.of("members","external").contains(audience))throw invalid();
        if(body.has("downloadAllowed")&&!body.path("downloadAllowed").isBoolean())throw invalid();
        if(body.has("expiresAt")&&body.has("durationMs"))throw invalid();
        return new Create(intent(body),purpose,audience,body.path("downloadAllowed").asBoolean(),body.has("expiresAt")?integer(body.get("expiresAt")):null,revision(body),body.has("durationMs")?integer(body.get("durationMs")):null);
    }
    static String intent(JsonNode body){String value=text(body,"operationIntent");if(!value.matches("[A-Za-z0-9_-]{1,128}"))throw invalid();return value;}
    static long revision(JsonNode body){try{return AccessRequests.revision(body.get("expectedRevision"));}catch(ApiException failure){throw invalid();}}
    static void fields(JsonNode body,Set<String> allowed){try{AccessRequests.fields(body,allowed);}catch(ApiException failure){throw invalid();}}
    private static long integer(JsonNode value){if(value==null||!value.isIntegralNumber()||!value.canConvertToLong()||value.longValue()<0||value.longValue()>AccessRequests.MAX_REVISION)throw invalid();return value.longValue();}
    private static String text(JsonNode body,String name){var value=body.get(name);if(value==null||!value.isTextual())throw invalid();return value.textValue();}
    static ApiException invalid(){return new ApiException(BAD_REQUEST,"invalid_request","授权参数无效，请核对用途、受众、期限及期望修订");}
}
