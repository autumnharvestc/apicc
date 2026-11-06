package com.autumnharvestc.server.sync;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
abstract class SyncApplicationHttpFixture extends SyncCheckHttpFixture {
    ObjectNode application(JsonNode view){
        var candidate=view.path("candidate");var decisions=json.createObjectNode().put("formatVersion",1).put("candidateDigest",candidate.path("candidateDigest").asText());var entries=decisions.putArray("entries");candidate.path("changes").forEach(change->entries.addObject().put("changeId",change.path("changeId").asText()).put("decision","take-source"));
        var fixed=jdbc.queryForObject("SELECT fixed_json FROM sync_candidates WHERE project_id=? AND id=?",String.class,Long.parseLong(f.project()),candidate.path("id").asText());
        JsonNode saved;try{saved=json.readTree(fixed);}catch(Exception e){throw new IllegalStateException(e);}var resolve=json.createObjectNode();resolve.set("candidate",candidate);resolve.set("planInput",saved.path("planInput"));resolve.set("decisions",decisions);
        var plan=core.call("sync-resolve",resolve,System.currentTimeMillis()+10000,32000000);
        var input=json.createObjectNode().put("formatVersion",1).put("intentId",java.util.UUID.randomUUID().toString()).put("sourceId",candidate.path("sourceId").asText()).put("candidateId",candidate.path("id").asText()).put("candidateDigest",candidate.path("candidateDigest").asText()).put("expectedAssetVersion",candidate.path("stamp").path("assetVersion").asText()).put("expectedSourceRevision",candidate.path("stamp").path("sourceRevision").asText()).put("decisionsDigest",plan.path("decisionsDigest").asText());input.set("decisions",decisions);return input;
    }
    String newIntent(){return java.util.UUID.randomUUID().toString();}
    JsonNode readOwnOperation(String intent) throws Exception{return body(sourceRequest("GET","/operations/"+intent,editor(),null).andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.status().isOk()));}
    int applicationMutationCount(String intent){return jdbc.queryForObject("SELECT COUNT(*) FROM sync_history WHERE project_id=? AND history_json LIKE ?",Integer.class,Long.parseLong(f.project()),"%\"intentId\":\""+intent+"\"%");}
}
