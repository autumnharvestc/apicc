package com.autumnharvestc.server.access;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class AccessActorRevisionDomainTest extends AccessHttpFixture {
    @ParameterizedTest @ValueSource(strings={"legacy-member","workspace-role","workspace-caps","project-member"})
    void actorRevisionCannotBeIgnoredOutsideWorkspaceOwnerTransfer(String kind) throws Exception {
        Scope f=scope();member(f,"EDITOR",0).andExpect(status().isOk());
        String url=switch(kind){
            case "legacy-member"->f.workspaceUrl()+"/members/"+f.target().id();
            case "project-member"->f.projectUrl()+"/access-members/"+f.target().id();
            default->f.workspaceUrl()+"/access-members/"+f.target().id();
        };
        String mutation=kind.equals("workspace-caps")?"\"capabilities\":{\"task.execute\":\"deny\"}":"\"role\":\"VIEWER\"";
        long expected=kind.equals("project-member")?0:1;
        mvc.perform(put(url).header("Authorization","Bearer "+f.owner().token()).contentType("application/json")
                .content("{\"expectedRevision\":"+expected+",\"expectedActorRevision\":1,"+mutation+"}"))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("validation_failed"));
    }
}
