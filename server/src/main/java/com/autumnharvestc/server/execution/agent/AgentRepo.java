package com.autumnharvestc.server.execution.agent;

import com.autumnharvestc.server.core.ApiException;
import com.autumnharvestc.server.core.EntityIds;
import com.autumnharvestc.server.store.IdGeneration;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Repository;
import java.util.*;

@Repository
public class AgentRepo {
    public record Agent(long id,String name,boolean acceptingJobs,boolean revoked) {}
    public record Config(long version,Map<String,Object> explicit,long appliedVersion,List<String> pendingFields,List<String> restartRequiredFields) {}
    private final JdbcTemplate jdbc;
    private final IdGeneration ids;
    private final ObjectMapper json;
    public AgentRepo(JdbcTemplate jdbc,IdGeneration ids,ObjectMapper json) { this.jdbc=jdbc; this.ids=ids; this.json=json; }
    public static ApiException error(HttpStatus status,String code,String message) { return new ApiException(status,code,message); }
    public static long id(String value) {
        if(value==null || !value.matches("[1-9][0-9]*")) throw error(HttpStatus.BAD_REQUEST,"validation_failed","实体 ID 必须为正 BIGINT 字符串");
        return EntityIds.parse(value);
    }
    public static long version(String value) {
        try { if(value==null || !value.matches("0|[1-9][0-9]*")) throw new NumberFormatException(); return Long.parseLong(value); }
        catch(NumberFormatException ex) { throw error(HttpStatus.BAD_REQUEST,"validation_failed","版本必须是非负 BIGINT 字符串"); }
    }
    public Agent require(long id,boolean lock) {
        return jdbc.query("SELECT id,name,accepting_jobs,revoked FROM execution_agents WHERE id=?"+(lock?" FOR UPDATE":""),
            (r,n)->new Agent(r.getLong(1),r.getString(2),r.getBoolean(3),r.getBoolean(4)),id).stream().findFirst()
            .orElseThrow(()->error(HttpStatus.NOT_FOUND,"agent_not_found","代理不存在"));
    }
    public List<Agent> list() { return jdbc.query("SELECT id,name,accepting_jobs,revoked FROM execution_agents ORDER BY id",(r,n)->new Agent(r.getLong(1),r.getString(2),r.getBoolean(3),r.getBoolean(4))); }
    public Agent create(String name) {
        long id;
        if(ids.appAssigned()) { id=ids.nextId(); jdbc.update("INSERT INTO execution_agents(id,name) VALUES (?,?)",id,name); }
        else { var keys=new GeneratedKeyHolder(); jdbc.update(c->{var s=c.prepareStatement("INSERT INTO execution_agents(name) VALUES (?)",new String[]{"id"});s.setString(1,name);return s;},keys);id=Objects.requireNonNull(keys.getKey()).longValue(); }
        return require(id,false);
    }
    public void patch(long id,String name,Boolean accepting) {
        if(name!=null) jdbc.update("UPDATE execution_agents SET name=? WHERE id=?",name,id);
        if(accepting!=null) jdbc.update("UPDATE execution_agents SET accepting_jobs=? WHERE id=?",accepting,id);
    }
    public void revoke(long id) { jdbc.update("UPDATE execution_agents SET revoked=TRUE,identity_hash=NULL WHERE id=?",id); }
    public List<String> workspaceGrants(long agent) { return jdbc.query("SELECT workspace_id FROM execution_agent_workspace_grants WHERE agent_id=? ORDER BY workspace_id",(r,n)->String.valueOf(r.getLong(1)),agent); }
    public boolean granted(long agent,long ws) { return count("SELECT COUNT(*) FROM execution_agent_workspace_grants WHERE agent_id=? AND workspace_id=?",agent,ws)>0; }
    public boolean allocated(long agent,long ws,long project) { return count("SELECT COUNT(*) FROM execution_agent_project_allocations WHERE agent_id=? AND workspace_id=? AND project_id=?",agent,ws,project)>0; }
    public boolean associated(long agent,long project) { return count("SELECT COUNT(*) FROM execution_project_agents WHERE agent_id=? AND project_id=?",agent,project)>0; }
    public List<String> associated(long project) { return jdbc.query("SELECT agent_id FROM execution_project_agents WHERE project_id=? ORDER BY agent_id",(r,n)->String.valueOf(r.getLong(1)),project); }
    public String defaultAgent(long project) { return jdbc.query("SELECT default_agent_id FROM execution_project_settings WHERE project_id=?",(r,n)->r.getString(1),project).stream().filter(Objects::nonNull).findFirst().orElse(null); }
    public long count(String sql,Object... values) { return Objects.requireNonNull(jdbc.queryForObject(sql,Long.class,values)); }
    public Config config(String type,long scope) {
        return jdbc.query("SELECT version,config_json,applied_version,pending_fields_json,restart_fields_json FROM execution_configs WHERE scope_type=? AND scope_id=?",(r,n)->new Config(r.getLong(1),decode(r.getString(2),new TypeReference<Map<String,Object>>(){}),r.getLong(3),decode(r.getString(4),new TypeReference<List<String>>(){}),decode(r.getString(5),new TypeReference<List<String>>(){})),type,scope).stream().findFirst().orElse(new Config(0,Map.of(),0,List.of(),List.of()));
    }
    public void saveConfig(String type,long scope,long expected,Map<String,Object> explicit,List<String> changed) {
        if(expected==Long.MAX_VALUE) throw error(HttpStatus.CONFLICT,"version_exhausted","配置版本已达到上限");
        var old=config(type,scope);
        if(old.version()!=expected) throw error(HttpStatus.CONFLICT,"version_conflict","配置版本已变化");
        var pending=new LinkedHashSet<>(old.pendingFields()); pending.addAll(changed);
        if(old.version()==0 && count("SELECT COUNT(*) FROM execution_configs WHERE scope_type=? AND scope_id=?",type,scope)==0)
            jdbc.update("INSERT INTO execution_configs(scope_type,scope_id,version,config_json,pending_fields_json) VALUES (?,?,1,?,?)",type,scope,encode(explicit),encode(pending));
        else if(jdbc.update("UPDATE execution_configs SET version=version+1,config_json=?,pending_fields_json=?,restart_fields_json='[]' WHERE scope_type=? AND scope_id=? AND version=?",encode(explicit),encode(pending),type,scope,expected)!=1)
            throw error(HttpStatus.CONFLICT,"version_conflict","配置版本已变化");
    }
    public void audit(long actor,String action,String type,long scope,Long version) {
        audit(actor,action,type,scope,version,null);
    }
    public void auditScriptGrant(long actor,String action,long project,long agent,long version) {
        audit(actor,action,"project",project,version,agent);
    }
    private void audit(long actor,String action,String type,long scope,Long version,Long agent) {
        if(ids.appAssigned()) jdbc.update("INSERT INTO execution_management_audit(id,actor_id,action,scope_type,scope_id,version,agent_id) VALUES (?,?,?,?,?,?,?)",ids.nextId(),actor,action,type,scope,version,agent);
        else jdbc.update("INSERT INTO execution_management_audit(actor_id,action,scope_type,scope_id,version,agent_id) VALUES (?,?,?,?,?,?)",actor,action,type,scope,version,agent);
    }
    public String encode(Object value) { try{return json.writeValueAsString(value);}catch(JsonProcessingException ex){throw new IllegalStateException("Cannot encode execution metadata",ex);} }
    public <T> T decode(String value,TypeReference<T> type) { try{return json.readValue(value,type);}catch(JsonProcessingException ex){throw new IllegalStateException("Invalid stored execution metadata",ex);} }
}
