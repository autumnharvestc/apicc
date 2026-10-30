package com.autumnharvestc.server.execution;

import java.util.*;
import org.junit.jupiter.api.Test;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import static org.assertj.core.api.Assertions.*;

class ScheduleAuthorizationTest extends ScheduleFixture {
    record Member(String token,String id) {}
    Member user(F f,String role)throws Exception{
        String name="s-"+java.util.UUID.randomUUID().toString().substring(0,15);
        var registration=body(mvc.perform(post("/api/v1/auth/register").contentType("application/json").content(json.writeValueAsString(Map.of("username",name,"password","password123","displayName",name)))).andExpect(status().isCreated()));
        String id=jdbc.queryForObject("SELECT id FROM users WHERE username=?",String.class,name);
        jdbc.update("INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?,?,?,CURRENT_TIMESTAMP)",Long.valueOf(f.ws()),Long.valueOf(id),role);
        String token=body(mvc.perform(post("/api/v1/auth/login").contentType("application/json").content(json.writeValueAsString(Map.of("username",name,"password","password123")))).andExpect(status().isOk())).path("token").asText();return new Member(token,id);
    }
    F as(F f,Member user){return new F(user.token(),f.ws(),f.group(),f.project(),f.snapshot(),f.agent(),f.agentToken(),f.assets());}
    @Test void editorRequiresIndependentGrantAndViewerCannotBeElevated()throws Exception{
        var f=fixture();var editor=user(f,"EDITOR");var viewer=user(f,"VIEWER");
        member(as(f,editor),post(f.url()+"/schedules"),save(f)).andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("schedule-manage-required"));
        member(f,put(f.url()+"/schedule-grants"),Map.of("expectedVersion","0","userIds",List.of(editor.id()))).andExpect(status().isOk()).andExpect(jsonPath("$.version").value("1"));
        member(as(f,editor),post(f.url()+"/schedules"),save(f)).andExpect(status().isCreated()).andExpect(jsonPath("$.subjectUserId").value(editor.id()));
        member(f,put(f.url()+"/schedule-grants"),Map.of("expectedVersion","1","userIds",List.of(viewer.id()))).andExpect(status().isForbidden());
    }
    @Test void onlyEffectiveProjectAdminsManageGrantsWithOptimisticVersion()throws Exception{
        var f=fixture();var editor=user(f,"EDITOR");
        member(f,put(f.url()+"/schedule-grants"),Map.of("expectedVersion","0","userIds",List.of(editor.id()))).andExpect(status().isOk());
        member(f,put(f.url()+"/schedule-grants"),Map.of("expectedVersion","0","userIds",List.of())).andExpect(status().isConflict());
        member(as(f,editor),get(f.url()+"/schedule-grants"),Map.of()).andExpect(status().isForbidden());
        var other=fixture();
        member(f,get("/api/v1/workspaces/9223372036854775807/projects/"+other.project()+"/schedule-grants"),Map.of()).andExpect(status().isNotFound());
    }
    @Test void staleGrantsCannotElevateViewersAndOptionsRemainReadableToEditors()throws Exception{
        var f=fixture();var viewer=user(f,"VIEWER");var editor=user(f,"EDITOR");
        jdbc.update("INSERT INTO execution_schedule_grants(workspace_id,project_id,version,user_ids_json) VALUES(?,?,1,?)",Long.valueOf(f.ws()),Long.valueOf(f.project()),json.writeValueAsString(List.of(viewer.id())));
        member(as(f,viewer),post(f.url()+"/schedules"),save(f)).andExpect(status().isForbidden());
        member(as(f,editor),get(f.url()+"/schedules/options"),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.canManageSchedules").value(false));
        member(f,get(f.url()+"/schedule-grants"),Map.of()).andExpect(status().isOk()).andExpect(jsonPath("$.userIds").isEmpty());
    }
    @Test void revokedSubjectCannotEnableButAdminCanExplicitlyReauthorizeANewRevision()throws Exception{
        var f=fixture();var editor=user(f,"EDITOR");
        member(f,put(f.url()+"/schedule-grants"),Map.of("expectedVersion","0","userIds",List.of(editor.id()))).andExpect(status().isOk());
        String id=body(member(as(f,editor),post(f.url()+"/schedules"),save(f)).andExpect(status().isCreated())).path("id").asText();
        member(f,put(f.url()+"/schedule-grants"),Map.of("expectedVersion","1","userIds",List.of())).andExpect(status().isOk());
        member(f,put(f.url()+"/schedules/"+id),Map.of("expectedVersion","1","name","仍是原主体")).andExpect(status().isOk()).andExpect(jsonPath("$.subjectUserId").value(editor.id())).andExpect(jsonPath("$.revision").value("1"));
        member(f,put(f.url()+"/schedules/"+id),Map.of("expectedVersion","2","enabled",true)).andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("schedule-subject-unauthorized"));
        String admin=scheduleUsers.findByUsername("admin").orElseThrow().id().toString();
        member(f,put(f.url()+"/schedules/"+id),Map.of("expectedVersion","2","reauthorize",true,"enabled",true)).andExpect(status().isOk()).andExpect(jsonPath("$.subjectUserId").value(admin)).andExpect(jsonPath("$.revision").value("2")).andExpect(jsonPath("$.cancellationVersion").value("1"));
        var other=fixture();member(f,get(other.url()+"/schedules/"+id),Map.of()).andExpect(status().isNotFound());
    }
    @Test void fixedSnapshotReadReusesCurrentExecutionRightsAndRejectsRemovedMembers()throws Exception{
        var f=fixture();var editor=user(f,"EDITOR");var viewer=user(f,"VIEWER");
        member(as(f,editor),get(f.url()+"/execution-snapshots/"+f.snapshot()),Map.of()).andExpect(status().isOk());
        member(as(f,viewer),get(f.url()+"/execution-snapshots/"+f.snapshot()),Map.of()).andExpect(status().isForbidden());
        jdbc.update("DELETE FROM memberships WHERE workspace_id=? AND user_id=?",Long.valueOf(f.ws()),Long.valueOf(editor.id()));
        member(as(f,editor),get(f.url()+"/execution-snapshots/"+f.snapshot()),Map.of()).andExpect(status().isForbidden());
    }
}
