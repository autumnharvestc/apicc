package com.autumnharvestc.server.execution.policy;

import com.autumnharvestc.server.execution.agent.AgentRepo;
import com.fasterxml.jackson.core.type.TypeReference;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.http.HttpStatus;
import java.util.*;

@Repository
public class ScriptGrantRepo {
    public record Grant(long version,String scope,List<ScriptGrantService.ScriptRequirement> scripts,long grantedBy) {}
    private final JdbcTemplate jdbc;
    private final AgentRepo metadata;
    public ScriptGrantRepo(JdbcTemplate jdbc,AgentRepo metadata){this.jdbc=jdbc;this.metadata=metadata;}
    public Grant find(long agent,long project){return jdbc.query("SELECT version,grant_scope,scripts_json,granted_by FROM execution_script_grants WHERE agent_id=? AND project_id=?",(r,n)->new Grant(r.getLong(1),r.getString(2),metadata.decode(r.getString(3),new TypeReference<List<ScriptGrantService.ScriptRequirement>>(){}),r.getLong(4)),agent,project).stream().findFirst().orElse(new Grant(0,"script-version",List.of(),0));}
    public void replace(long agent,long ws,long project,long expected,String scope,List<ScriptGrantService.ScriptRequirement> scripts,long actor){
        var current=find(agent,project);if(current.version()!=expected)throw AgentRepo.error(HttpStatus.CONFLICT,"version_conflict","脚本批准版本已变化");
        if(expected==Long.MAX_VALUE)throw AgentRepo.error(HttpStatus.CONFLICT,"version_exhausted","脚本批准版本已达到上限");
        if(current.version()==0)jdbc.update("INSERT INTO execution_script_grants(agent_id,workspace_id,project_id,version,grant_scope,scripts_json,granted_by,updated_at) VALUES (?,?,?,1,?,?,?,CURRENT_TIMESTAMP)",agent,ws,project,scope,metadata.encode(scripts),actor);
        else if(jdbc.update("UPDATE execution_script_grants SET version=version+1,grant_scope=?,scripts_json=?,granted_by=?,updated_at=CURRENT_TIMESTAMP WHERE agent_id=? AND project_id=? AND version=?",scope,metadata.encode(scripts),actor,agent,project,expected)!=1)throw AgentRepo.error(HttpStatus.CONFLICT,"version_conflict","脚本批准版本已变化");
    }
}
