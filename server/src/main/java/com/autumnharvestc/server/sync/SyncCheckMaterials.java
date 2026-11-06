package com.autumnharvestc.server.sync;

import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.execution.ExecutionDtos.CredentialSelection;
import com.autumnharvestc.server.execution.materials.ProjectCredentialService;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.stereotype.Component;
import java.util.*;

/** Metadata capture under the project lock; bounded fixed-version decryption outside the snapshot transaction. */
@Component
public class SyncCheckMaterials {
    private final ProjectCredentialService credentials;private final SyncMaterialService materials;private final ObjectMapper json;private final SyncDtos dtos;
    public SyncCheckMaterials(ProjectCredentialService credentials,SyncMaterialService materials,ObjectMapper json,SyncDtos dtos){this.credentials=credentials;this.materials=materials;this.json=json;this.dtos=dtos;}
    Map<String,CredentialSelection> capture(long ws,long project,JsonNode source,long maximum){
        var selected=new LinkedHashMap<String,CredentialSelection>();long bytes=0;
        for(String field:List.of("authRef","networkProfileRef","privateKeyRef","knownHostsRef","passphraseRef"))if(source.has(field)){
            var registration=credentials.requireRegistrationAuthorized(ws,project,source.path(field).asText(),null);bytes=Math.addExact(bytes,registration.valueBytesUpperBound());if(bytes>maximum)throw new SyncCheckService.Invalidated("material-invalid");selected.put(field,registration.selection());
        }
        return Map.copyOf(selected);
    }
    void recheck(long ws,long project,Map<String,CredentialSelection> selected){for(var value:selected.values())credentials.requireRegistrationAuthorized(ws,project,value.refId(),value.version());}
    boolean current(long ws,long project,Map<String,CredentialSelection> selected){for(var value:selected.values())if(!credentials.registrationCurrentAuthorized(ws,project,value))return false;return true;}
    ObjectNode resolve(UserAccount actor,SyncCheckService.Snapshot snapshot){
        String ws=String.valueOf(snapshot.ws()),project=String.valueOf(snapshot.project());var source=snapshot.source();var payload=(ObjectNode)snapshot.readPayload().deepCopy();var material=(ObjectNode)payload.path("material");var ssh=json.createObjectNode();
        for(var entry:snapshot.materials().entrySet()){
            var selection=entry.getValue();var value=materials.resolve(actor,ws,project,source.path("id").asText(),source.path("revision").asText(),"source-check",selection).value();
            switch(entry.getKey()){
                case "authRef"->{var codec=codec("headerCredential",value);material.set("httpHeaders",codec.path("headers"));}
                case "networkProfileRef"->{var codec=codec("networkCredential",value);var profile=(ObjectNode)codec.path("profile").deepCopy();profile.put("id",selection.refId());var network=json.createObjectNode().put("kind","profile").put("revision",selection.version());network.set("profile",profile);payload.set("network",network);}
                case "privateKeyRef"->ssh.put("privateKeyPem",value);
                case "knownHostsRef"->ssh.put("knownHostsText",value);
                case "passphraseRef"->ssh.put("passphrase",value);
                default->throw new IllegalStateException("Unknown bound material field");
            }
        }
        if(!ssh.isEmpty())material.set("ssh",ssh);return payload;
    }
    private JsonNode codec(String name,String text){try{var value=json.reader().with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).readTree(text);if(!dtos.valid(name,value))throw new IllegalArgumentException();return value;}catch(Exception error){throw new SyncCheckService.Invalidated("material-invalid");}}
}
