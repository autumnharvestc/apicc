package com.autumnharvestc.server.execution.scheduling;

import com.fasterxml.jackson.databind.JsonNode;
import com.autumnharvestc.server.execution.ExecutionDtos.AttachmentSelection;
import org.springframework.stereotype.Component;
import org.springframework.web.util.UriComponentsBuilder;
import java.util.*;
import static com.autumnharvestc.server.execution.agent.AgentRepo.error;
import static org.springframework.http.HttpStatus.BAD_REQUEST;

/** Schedule persistence boundary for Core's network declaration, never a transport or secret resolver. */
@Component
public class ScheduleNetworkValidator {
    public void validate(JsonNode network,Map<String,AttachmentSelection> paths){
        fields(network,Set.of("revision","configuration"),Set.of("selection"));text(network.get("revision"),512);
        var configuration=network.get("configuration");fields(configuration,Set.of("formatVersion","profiles","environmentSelections"),Set.of("projectSelection"));
        if(!configuration.get("formatVersion").isIntegralNumber()||!configuration.get("formatVersion").canConvertToInt()||configuration.get("formatVersion").intValue()!=1)bad();
        array(configuration.get("profiles"));var profiles=new HashSet<String>();
        for(var profile:configuration.get("profiles")){
            String kind=text(profile.get("kind"),16);boolean proxy=kind.equals("proxy");if(!proxy&&!kind.equals("direct"))bad();
            fields(profile,Set.of("id","name","kind","targetTlsBindings"),proxy?Set.of("proxyUrl","username","passwordRef","proxyTLS"):Set.of());
            if(!profiles.add(text(profile.get("id"),256))||text(profile.get("name"),256).isBlank())bad();
            array(profile.get("targetTlsBindings"));var origins=new HashSet<String>();
            for(var binding:profile.get("targetTlsBindings")){fields(binding,Set.of("origin","tls"),Set.of());String origin=origin(binding.get("origin"),Set.of("https","wss"));if(!origins.add(origin))bad();tls(binding.get("tls"),paths);}
            if(proxy){String proxyOrigin=origin(profile.get("proxyUrl"),Set.of("http","https"));if(profile.has("username")!=profile.has("passwordRef"))bad();if(profile.has("username")){if(!profile.get("username").isTextual())bad();secretRef(profile.get("passwordRef"));}if(profile.has("proxyTLS")){if(!proxyOrigin.startsWith("https://"))bad();tls(profile.get("proxyTLS"),paths);}}
        }
        if(configuration.has("projectSelection"))selection(configuration.get("projectSelection"),profiles);
        if(network.has("selection"))selection(network.get("selection"),profiles);
        array(configuration.get("environmentSelections"));var environments=new HashSet<String>();
        for(var entry:configuration.get("environmentSelections")){fields(entry,Set.of("environmentId","selection"),Set.of());if(!environments.add(text(entry.get("environmentId"),256)))bad();selection(entry.get("selection"),profiles);}
    }
    private static void selection(JsonNode value,Set<String> profiles){
        String kind=text(value==null?null:value.get("kind"),16);
        if(kind.equals("direct"))fields(value,Set.of("kind"),Set.of());
        else if(kind.equals("profile")){fields(value,Set.of("kind","profileId"),Set.of());if(!profiles.contains(text(value.get("profileId"),256)))bad();}else bad();
    }
    private static void tls(JsonNode value,Map<String,AttachmentSelection> paths){
        fields(value,Set.of(),Set.of("verify","caCertificatePaths","clientCertificatePaths","clientPrivateKeyRef","clientKeyPassphraseRef"));
        if(value.has("verify")&&!value.get("verify").isBoolean())bad();
        int certificates=0;
        for(String field:List.of("caCertificatePaths","clientCertificatePaths"))if(value.has(field)){
            array(value.get(field));if(field.equals("clientCertificatePaths"))certificates=value.get(field).size();
            for(var path:value.get(field)){String encoded=text(path,Integer.MAX_VALUE);if(!encoded.startsWith("/apicc-declared/")||!paths.containsKey(encoded.substring("/apicc-declared/".length())))bad();}
        }
        if((certificates>0)!=value.has("clientPrivateKeyRef")||value.has("clientKeyPassphraseRef")&&!value.has("clientPrivateKeyRef"))bad();
        if(value.has("clientPrivateKeyRef"))secretRef(value.get("clientPrivateKeyRef"));if(value.has("clientKeyPassphraseRef"))secretRef(value.get("clientKeyPassphraseRef"));
    }
    private static void secretRef(JsonNode value){fields(value,Set.of("id","policy"),Set.of());if(!text(value.get("id"),256).matches("[A-Za-z0-9][A-Za-z0-9._-]{0,255}")||!text(value.get("policy"),32).equals("test-auto"))bad();}
    private static String origin(JsonNode value,Set<String> schemes){
        String input=text(value,Integer.MAX_VALUE);
        try{
            // Core compares WHATWG URL.origin to the complete declaration. Parsing is pure:
            // numeric IPv4 and IPv6 are normalized without DNS or a network connection.
            var parsed=UriComponentsBuilder.fromUriString(input,UriComponentsBuilder.ParserType.WHAT_WG).build();
            if(!schemes.contains(parsed.getScheme())||parsed.getHost()==null)bad();
            String canonical=parsed.getScheme()+"://"+parsed.getHost()+(parsed.getPort()<0?"":":"+parsed.getPort());
            if(!input.equals(canonical))bad();return input;
        }catch(Exception ignored){bad();return null;}
    }
    private static String text(JsonNode value,int max){if(value==null||!value.isTextual()||value.textValue().isEmpty()||value.textValue().length()>max)bad();return value.textValue();}
    private static void array(JsonNode value){if(value==null||!value.isArray())bad();}
    private static void fields(JsonNode value,Set<String> required,Set<String> optional){
        if(value==null||!value.isObject())bad();for(String key:required)if(!value.hasNonNull(key))bad();value.fieldNames().forEachRemaining(key->{if(!required.contains(key)&&!optional.contains(key)||value.get(key).isNull())bad();});
    }
    private static void bad(){throw error(BAD_REQUEST,"validation_failed","网络声明必须符合固定 Core 配置，仅允许项目凭据引用及已上传附件的逻辑路径");}
}
