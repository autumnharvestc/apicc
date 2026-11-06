package com.autumnharvestc.server.sync;
import org.junit.jupiter.api.Test;
import com.fasterxml.jackson.databind.JsonNode;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import java.util.*;

class SyncCandidateDetailTest extends SyncCheckHttpFixture {
    private JsonNode apiChange(JsonNode candidate){return java.util.stream.StreamSupport.stream(candidate.path("changes").spliterator(),false).filter(value->value.path("path").asText().endsWith("api.yaml")).findFirst().orElseThrow();}
    private String detailPath(JsonNode candidate,JsonNode change,String side){return "/candidates/"+candidate.path("id").asText()+"/changes/"+change.path("changeId").asText()+"/details?side="+side;}
    @Test void fixedDetailComesFromProtectedCandidateFilesAndCurrentProjectReadAuthority() throws Exception {
        var candidate=checkToCandidate(createUrlSource("/fast")).path("candidate");var change=apiChange(candidate);
        var fixed=json.readTree(jdbc.queryForObject("SELECT fixed_json FROM sync_candidates WHERE project_id=? AND id=?",String.class,Long.parseLong(f.project()),candidate.path("id").asText()));
        var expected=java.util.stream.StreamSupport.stream(fixed.path("planInput").path("remoteFiles").spliterator(),false).filter(file->file.path("path").equals(change.path("path"))).findFirst().orElseThrow().path("content").asText();
        var detail=body(sourceRequest("GET",detailPath(candidate,change,"source"),editor(),null).andExpect(status().isOk()));
        assertThat(detail.path("kind").asText()).isEqualTo("document");assertThat(detail.path("text").asText()).isEqualTo(expected);
        sourceRequest("GET",detailPath(candidate,change,"baseline"),editor(),null).andExpect(status().isOk()).andExpect(jsonPath("$.kind").value("absent"));
        capabilities("NONE",Map.of());sourceRequest("GET",detailPath(candidate,change,"source"),editor(),null).andExpect(status().isForbidden());
    }
    @Test void unknownChangeAndUnsupportedSideAreRejectedAtTheRealExistingCandidateRoute() throws Exception {
        var candidate=checkToCandidate(createUrlSource("/fast")).path("candidate");var change=apiChange(candidate);
        sourceRequest("GET",detailPath(candidate,change,"live"),editor(),null).andExpect(status().isBadRequest());
        var wrong=change.deepCopy();((com.fasterxml.jackson.databind.node.ObjectNode)wrong).put("changeId","0".repeat(64));
        sourceRequest("GET",detailPath(candidate,wrong,"source"),editor(),null).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("SYNC_CANDIDATE_MISMATCH"));
    }
    @Test void unknownCandidateCannotSelectAnyProjectOrFile() throws Exception {
        var candidate=checkToCandidate(createUrlSource("/fast")).path("candidate");var change=apiChange(candidate);((com.fasterxml.jackson.databind.node.ObjectNode)candidate).put("id",UUID.randomUUID().toString());
        sourceRequest("GET",detailPath(candidate,change,"source"),editor(),null).andExpect(status().isNotFound());
    }
}
