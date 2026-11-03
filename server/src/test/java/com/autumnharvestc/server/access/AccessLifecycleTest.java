package com.autumnharvestc.server.access;

import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertAll;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class AccessLifecycleTest extends AccessHttpFixture {
    private String additionalProject(Scope f,String name) throws Exception {
        String group=body(mvc.perform(post(f.workspaceUrl()+"/groups").header("Authorization","Bearer "+f.owner().token())
                .contentType("application/json").content(json.writeValueAsString(java.util.Map.of("name",name))))
                .andExpect(status().isCreated())).get("id").asText();
        return body(mvc.perform(post(f.workspaceUrl()+"/projects").header("Authorization","Bearer "+f.owner().token())
                .contentType("application/json").content(json.writeValueAsString(java.util.Map.of("groupId",group,"name",name))))
                .andExpect(status().isCreated())).get("id").asText();
    }

    // Catches membership deletion leaving a positive ACL that automatically revives on rejoin.
    @Test void rejoinDoesNotRestorePriorProjectAdmin() throws Exception {
        Scope f = scope();
        String inherited=additionalProject(f,"no old override");
        String denied=additionalProject(f,"explicit NONE");
        member(f, "VIEWER", 0).andExpect(status().isOk());
        acl(f, "ADMIN", 0).andExpect(status().isOk());
        mvc.perform(put(f.workspaceUrl()+"/projects/"+denied+"/acl").header("Authorization","Bearer "+f.owner().token())
                .contentType("application/json").content(json.writeValueAsString(java.util.Map.of("userId",f.target().id(),"role","NONE","expectedRevision",0))))
                .andExpect(status().isOk());
        assets(f).andExpect(status().isOk());
        mvc.perform(delete(f.workspaceUrl() + "/members/" + f.target().id()).param("expectedRevision", "1")
                .header("Authorization", "Bearer " + f.owner().token())).andExpect(status().isNoContent());
        assets(f).andExpect(status().isForbidden());
        member(f, "VIEWER", 2).andExpect(status().isOk());
        var decision = access.resolve(Long.valueOf(f.target().id()), Long.valueOf(f.workspace()), Long.valueOf(f.project()));
        assertAll("old ADMIN must remain pending until explicit versioned confirmation",
                () -> assets(f).andExpect(status().isForbidden()),
                () -> mvc.perform(get(f.workspaceUrl() + "/tree").header("Authorization", "Bearer " + f.target().token()))
                        .andExpect(status().isOk()).andExpect(jsonPath("$.projects.length()").value(1))
                        .andExpect(jsonPath("$.projects[0].id").value(inherited)),
                () -> mvc.perform(put(f.workspaceUrl() + "/files/" + f.project() + "/revived.yaml")
                        .header("Authorization", "Bearer " + f.target().token()).contentType("application/json")
                        .content("{\"content\":\"must not write\",\"baseVersion\":0}"))
                        .andExpect(status().isForbidden()),
                () -> assertThat(decision.overrideState()).isEqualTo("pending-confirmation"),
                () -> assertThat(decision.effectiveRole()).isEmpty(),
                () -> assertThat(decision.capabilities()).doesNotContain(Capability.TASK_EXECUTE));
        mvc.perform(get(f.workspaceUrl()+"/projects/"+denied+"/assets").header("Authorization","Bearer "+f.target().token()))
                .andExpect(status().isForbidden());
        mvc.perform(get(f.workspaceUrl()+"/projects/"+inherited+"/assets").header("Authorization","Bearer "+f.target().token()))
                .andExpect(status().isOk());
        mvc.perform(put(f.workspaceUrl()+"/files/"+inherited+"/viewer.yaml").header("Authorization","Bearer "+f.target().token())
                .contentType("application/json").content("{\"content\":\"read only\",\"baseVersion\":0}"))
                .andExpect(status().isForbidden());
        acl(f,"EDITOR",2).andExpect(status().isOk());
        var confirmed=access.resolve(Long.valueOf(f.target().id()),Long.valueOf(f.workspace()),Long.valueOf(f.project()));
        assertThat(confirmed.effectiveRole()).contains(com.autumnharvestc.server.core.Role.EDITOR);
        assertThat(confirmed.capabilities()).contains(Capability.TASK_EXECUTE).doesNotContain(Capability.PUBLICATION_MANAGE);
        assets(f).andExpect(status().isOk());
        mvc.perform(put(f.workspaceUrl()+"/files/"+f.project()+"/restored.yaml").header("Authorization","Bearer "+f.target().token())
                .contentType("application/json").content("{\"content\":\"restored editor\",\"baseVersion\":0}"))
                .andExpect(status().isCreated());
        mvc.perform(put(f.workspaceUrl()+"/members/"+f.owner().id()).header("Authorization","Bearer "+f.target().token())
                .contentType("application/json").content("{\"role\":\"VIEWER\",\"expectedRevision\":1}"))
                .andExpect(status().isForbidden());
    }
}
