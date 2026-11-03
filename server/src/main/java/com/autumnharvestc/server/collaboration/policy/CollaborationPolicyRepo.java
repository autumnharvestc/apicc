package com.autumnharvestc.server.collaboration.policy;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import java.util.Optional;

@Repository
public class CollaborationPolicyRepo {
    public record Stored(long revision,long projectionRevision,PolicyOverrides settings) {}
    private final JdbcTemplate jdbc;private final ObjectMapper json;
    public CollaborationPolicyRepo(JdbcTemplate jdbc,ObjectMapper json){this.jdbc=jdbc;this.json=json;}
    public Optional<Stored> find(long workspace,long project) {
        return find(workspace,project,false);
    }
    private Optional<Stored> find(long workspace,long project,boolean locked) {
        return jdbc.query("SELECT revision,projection_revision,settings_json FROM collaboration_policy WHERE workspace_id=? AND project_id=?"+(locked?" FOR UPDATE":""),(row,index)->{
            try{return new Stored(row.getLong("revision"),row.getLong("projection_revision"),json.readValue(row.getString("settings_json"),PolicyOverrides.class));}
            catch(java.io.IOException problem){throw new java.sql.SQLException("Cannot read typed collaboration policy",problem);}
        },workspace,project).stream().findFirst();
    }
    /** Fixed order: policy gate, policy row, then caller takes the shared access mutation gate. */
    public void lockGate() { jdbc.queryForList("SELECT id FROM collaboration_policy_gate WHERE id=1 FOR UPDATE",Long.class); }
    public Stored lock(long workspace,long project) {
        lockGate();
        if(find(workspace,project).isEmpty())jdbc.update("INSERT INTO collaboration_policy(workspace_id,project_id,revision,projection_revision,settings_json) VALUES(?,?,0,1,'{}')",workspace,project);
        return find(workspace,project,true).orElseThrow();
    }
    public void save(long workspace,long project,long expected,PolicyOverrides settings) {
        String body;try{body=json.writeValueAsString(settings);}catch(com.fasterxml.jackson.core.JsonProcessingException problem){throw new IllegalStateException("Cannot encode typed collaboration policy",problem);}
        if(jdbc.update("UPDATE collaboration_policy SET revision=revision+1,projection_revision=projection_revision+1,settings_json=? WHERE workspace_id=? AND project_id=? AND revision=?",body,workspace,project,expected)!=1)
            throw new com.autumnharvestc.server.core.ApiException(org.springframework.http.HttpStatus.CONFLICT,"collaboration_policy_revision_conflict","协作策略已变化，请刷新后重试");
    }
}
