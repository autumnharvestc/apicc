package com.autumnharvestc.server.sync;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import java.sql.ResultSet;
import java.util.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertAll;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** Real owning-entity DELETE routes; future check/candidate/history rows are explicit storage-only fixtures. */
class SyncLifecycleTest extends SyncHttpFixture {
    @Autowired JdbcTemplate jdbc;
    private static final List<String> TABLES=List.of("sync_sources","sync_checks","sync_candidates","sync_history","sync_operations","sync_policies");
    record Area(Actor owner,String workspace,String project){String workspaceUrl(){return "/api/v1/workspaces/"+workspace;}String projectUrl(){return workspaceUrl()+"/projects/"+project;}}
    Area target(){return new Area(f.owner(),f.workspace(),f.project());}
    Area neighbor() throws Exception {var result=new Area(f.owner(),f.workspace(),anotherProject());publish(result);return result;}
    Area outside() throws Exception {var scope=scope();var result=new Area(scope.owner(),scope.workspace(),scope.project());publish(result);return result;}
    void publish(Area area) throws Exception {
        var files=List.of(Map.of("path","project.yaml","content","id: 00000000-0000-4000-8000-000000000070\nname: Lifecycle\n"),Map.of("path","collections/"+module+"/collection.yaml","content","id: "+module+"\nname: Target\n"));
        mvc.perform(put(area.projectUrl()+"/assets").header("Authorization","Bearer "+area.owner().token()).contentType("application/json").content(json.writeValueAsString(Map.of("format","contract-files-v1","contractProjectId","00000000-0000-4000-8000-000000000070","expectedVersion","0","changes",files,"deletes",List.of())))).andExpect(status().isOk()).andExpect(jsonPath("$.version").value("1"));
    }
    void seed(Area area,boolean workspacePolicy) throws Exception {
        var source=body(mvc.perform(post(area.projectUrl()+"/sync/sources").header("Authorization","Bearer "+area.owner().token()).contentType("application/json").content(json.writeValueAsString(write(sourceBody("url"))))).andExpect(status().isCreated()));
        savePolicy(area,false);if(workspacePolicy)savePolicy(area,true);
        long ws=Long.parseLong(area.workspace()),project=Long.parseLong(area.project());String sourceId=source.path("id").asText();
        // T9/T10 do not exist: these are clearly marked persistence fixture rows, never real checks/candidates/history.
        String fixture="{\"fixture\":\"lifecycle-storage-only-not-an-executed-check\"}";
        jdbc.update("INSERT INTO sync_checks(workspace_id,project_id,id,source_id,source_revision,subject_user_id,state,details_json) VALUES(?,?,?,?,?,?,?,?)",ws,project,UUID.randomUUID().toString(),sourceId,"1",Long.parseLong(area.owner().id()),"fixture",fixture);
        jdbc.update("INSERT INTO sync_candidates(workspace_id,project_id,id,source_id,fixed_json,expires_at) VALUES(?,?,?,?,?,?)",ws,project,UUID.randomUUID().toString(),sourceId,fixture,java.sql.Timestamp.from(java.time.Instant.now().plusSeconds(3600)));
        jdbc.update("INSERT INTO sync_history(workspace_id,project_id,id,source_id,history_json,before_content,after_content) VALUES(?,?,?,?,?,?,?)",ws,project,UUID.randomUUID().toString(),sourceId,fixture,"[]","[]");
        assertThat(counts(ws,project).values()).allSatisfy(value->assertThat(value).isPositive());
    }
    void savePolicy(Area area,boolean workspace) throws Exception {
        var policy=json.createObjectNode().put("formatVersion",1).put("revision","1").put("scope",workspace?"workspace":"project").put("maxNormalizeDepth",128);
        var input=json.createObjectNode().put("formatVersion",1).put("intentId",UUID.randomUUID().toString()).put("expectedRevision","0");input.set("policy",policy);
        mvc.perform(put((workspace?area.workspaceUrl():area.projectUrl())+"/sync/policy").header("Authorization","Bearer "+area.owner().token()).contentType("application/json").content(json.writeValueAsString(input))).andExpect(status().isOk()).andExpect(jsonPath("$.saved.revision").value("1"));
    }
    Map<String,Long> counts(long ws,Long project){var result=new LinkedHashMap<String,Long>();for(String table:TABLES)result.put(table,jdbc.queryForObject("SELECT COUNT(*) FROM "+table+" WHERE workspace_id=?"+(project==null?"":" AND project_id=?"),Long.class,project==null?new Object[]{ws}:new Object[]{ws,project}));return result;}
    Map<String,List<Map<String,String>>> snapshot(long ws,Long project){
        var result=new LinkedHashMap<String,List<Map<String,String>>>();
        for(String table:TABLES){String key=table.equals("sync_policies")?"project_id":table.equals("sync_operations")?"intent_id":"id";
            result.put(table,jdbc.query("SELECT * FROM "+table+" WHERE workspace_id=?"+(project==null?"":" AND project_id=?")+" ORDER BY project_id,"+key,(row,index)->strings(row),project==null?new Object[]{ws}:new Object[]{ws,project}));}
        return result;
    }
    Map<String,String> strings(ResultSet row) throws java.sql.SQLException {var values=new LinkedHashMap<String,String>();for(int i=1;i<=row.getMetaData().getColumnCount();i++)values.put(row.getMetaData().getColumnLabel(i),row.getString(i));return values;}
    void empty(long ws,Long project){assertThat(counts(ws,project).values()).containsOnly(0L);}
    @Test void projectDeleteRemovesAllSyncRowsAndPreservesNeighborAndWorkspacePolicy() throws Exception {
        var target=target();var neighbor=neighbor();var outside=outside();seed(target,true);seed(neighbor,false);seed(outside,true);
        long ws=Long.parseLong(target.workspace()),project=Long.parseLong(target.project());
        var neighborBefore=snapshot(ws,Long.parseLong(neighbor.project()));var parentBefore=snapshot(ws,0L);var outsideBefore=snapshot(Long.parseLong(outside.workspace()),null);
        mvc.perform(delete(target.projectUrl()).header("Authorization","Bearer "+target.owner().token())).andExpect(status().isNoContent());
        mvc.perform(get(target.projectUrl()+"/assets").header("Authorization","Bearer "+target.owner().token())).andExpect(status().isNotFound());
        mvc.perform(get(target.workspaceUrl()+"/sync/policy").header("Authorization","Bearer "+target.owner().token())).andExpect(status().isOk()).andExpect(jsonPath("$.saved.revision").value("1"));
        assertAll(()->empty(ws,project),()->assertThat(snapshot(ws,Long.parseLong(neighbor.project()))).isEqualTo(neighborBefore),()->assertThat(snapshot(ws,0L)).isEqualTo(parentBefore),()->assertThat(snapshot(Long.parseLong(outside.workspace()),null)).isEqualTo(outsideBefore));
    }
    @Test void workspaceDeleteRemovesAllProjectsAndProjectZeroSyncRowsOnlyInThatWorkspace() throws Exception {
        var target=target();var neighbor=neighbor();var outside=outside();seed(target,true);seed(neighbor,false);seed(outside,true);
        long ws=Long.parseLong(target.workspace());var outsideBefore=snapshot(Long.parseLong(outside.workspace()),null);
        assertThat(counts(ws,0L).get("sync_policies")).isEqualTo(1L);assertThat(counts(ws,0L).get("sync_operations")).isEqualTo(1L);
        mvc.perform(delete(target.workspaceUrl()).header("Authorization","Bearer "+target.owner().token())).andExpect(status().isNoContent());
        assertAll(()->empty(ws,null),()->assertThat(snapshot(Long.parseLong(outside.workspace()),null)).isEqualTo(outsideBefore),()->assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM workspaces WHERE id=?",Long.class,ws)).isZero(),()->assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM projects WHERE workspace_id=?",Long.class,ws)).isZero());
    }
    @ParameterizedTest @ValueSource(strings={"project","workspace"})
    void deletionFailureRollsBackSyncRowsAndOriginalOwningState(String kind) throws Exception {
        var target=target();var neighbor=neighbor();seed(target,true);seed(neighbor,false);long ws=Long.parseLong(target.workspace()),project=Long.parseLong(target.project());
        var before=snapshot(ws,null);long members=jdbc.queryForObject("SELECT COUNT(*) FROM memberships WHERE workspace_id=?",Long.class,ws);long files=jdbc.queryForObject("SELECT COUNT(*) FROM file_versions WHERE workspace_id=?",Long.class,ws);
        // Reuse the existing ProjectAssetsApiTest final-entity FK fault pattern, after cleanup but before commit.
        jdbc.execute("CREATE TABLE IF NOT EXISTS task3_delete_blocker (project_id BIGINT PRIMARY KEY, CONSTRAINT task3_delete_project_fk FOREIGN KEY(project_id) REFERENCES projects(id))");jdbc.update("INSERT INTO task3_delete_blocker(project_id) VALUES(?)",project);
        try{
            mvc.perform(delete(kind.equals("project")?target.projectUrl():target.workspaceUrl()).header("Authorization","Bearer "+target.owner().token())).andExpect(status().isInternalServerError());
            assertAll(()->assertThat(snapshot(ws,null)).isEqualTo(before),()->assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM memberships WHERE workspace_id=?",Long.class,ws)).isEqualTo(members),()->assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM file_versions WHERE workspace_id=?",Long.class,ws)).isEqualTo(files),()->assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM projects WHERE workspace_id=?",Long.class,ws)).isEqualTo(2L));
            mvc.perform(get(target.projectUrl()+"/assets").header("Authorization","Bearer "+target.owner().token())).andExpect(status().isOk()).andExpect(jsonPath("$.version").value("1"));
        }finally{jdbc.update("DELETE FROM task3_delete_blocker WHERE project_id=?",project);}
    }
}
