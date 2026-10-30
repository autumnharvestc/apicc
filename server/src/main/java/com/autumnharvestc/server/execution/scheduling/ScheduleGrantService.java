package com.autumnharvestc.server.execution.scheduling;

import com.autumnharvestc.server.core.*;
import com.autumnharvestc.server.execution.agent.*;
import com.autumnharvestc.server.store.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.util.*;
import static com.autumnharvestc.server.execution.agent.AgentRepo.*;
import static org.springframework.http.HttpStatus.*;

@Service
@Transactional
public class ScheduleGrantService {
    private final AgentService agents;private final AgentRepo metadata;private final PermissionService permissions;
    private final UserRepo users;private final JdbcTemplate jdbc;
    public ScheduleGrantService(AgentService agents,AgentRepo metadata,PermissionService permissions,UserRepo users,JdbcTemplate jdbc){this.agents=agents;this.metadata=metadata;this.permissions=permissions;this.users=users;this.jdbc=jdbc;}
    public void requireRead(UserAccount caller,String ws,String project){
        if(caller==null||caller.disabled()||users.findById(caller.id()).filter(u->!u.disabled()).isEmpty())throw error(FORBIDDEN,"schedule-subject-unavailable","调度成员已停用或不存在");
        agents.requireProject(caller,ws,project,false);
    }
    public boolean canManage(UserAccount caller,String ws,String project){
        requireRead(caller,ws,project);var role=permissions.effectiveRole(id(ws),caller.id(),id(project)).orElseThrow();
        return permissions.isAdmin(role)||role==Role.EDITOR&&selected(id(ws),id(project)).contains(String.valueOf(caller.id()));
    }
    public void requireManage(UserAccount caller,String ws,String project){if(!canManage(caller,ws,project))throw error(FORBIDDEN,"schedule-manage-required","需要本项目定时任务管理授权及执行权限");agents.requireExecution(caller,ws,project);}
    public UserAccount requireSubject(long subject,long ws,long project){
        var user=users.findById(subject).filter(u->!u.disabled()).orElseThrow(()->error(FORBIDDEN,"schedule-subject-unavailable","计划执行主体已停用或不存在"));
        try{requireManage(user,String.valueOf(ws),String.valueOf(project));}catch(ApiException e){throw error(FORBIDDEN,"schedule-subject-unauthorized","计划执行主体已失去项目执行权或调度授权");}return user;
    }
    private List<String> selected(long ws,long project){return jdbc.query("SELECT user_ids_json FROM execution_schedule_grants WHERE workspace_id=? AND project_id=?",(r,n)->metadata.decode(r.getString(1),new com.fasterxml.jackson.core.type.TypeReference<List<String>>(){}),ws,project).stream().findFirst().orElse(List.of());}
    private long current(long ws,long project){return jdbc.query("SELECT version FROM execution_schedule_grants WHERE workspace_id=? AND project_id=?",(r,n)->r.getLong(1),ws,project).stream().findFirst().orElse(0L);}
    public Map<String,Object> get(UserAccount caller,String ws,String project){requireRead(caller,ws,project);agents.requireProject(caller,ws,project,true);return projection(id(ws),id(project));}
    public Map<String,Object> options(UserAccount caller,String ws,String project){
        requireRead(caller,ws,project);agents.requireProject(caller,ws,project,true);
        var rows=jdbc.query("SELECT user_id FROM memberships WHERE workspace_id=? ORDER BY created_at,user_id",(r,n)->r.getLong(1),id(ws)).stream().map(userId->{
            var user=users.findById(userId).orElseThrow();var role=permissions.effectiveRole(id(ws),userId,id(project)).orElse(null);
            String reason=user.disabled()?"account-disabled":role==null?"project-access-denied":role!=Role.EDITOR?"editor-required":null;
            var row=new LinkedHashMap<String,Object>();row.put("userId",String.valueOf(userId));row.put("username",user.username());row.put("displayName",user.displayName());row.put("effectiveRole",role==null?null:role.name());row.put("eligible",reason==null);row.put("reasonCode",reason);return row;
        }).toList();return Map.of("items",rows);
    }
    public Map<String,Object> projection(long ws,long project){
        var effective=selected(ws,project).stream().filter(value->users.findById(id(value)).filter(u->!u.disabled()).isPresent()&&jdbc.queryForObject("SELECT COUNT(*) FROM memberships WHERE workspace_id=? AND user_id=?",Long.class,ws,id(value))>0&&permissions.effectiveRole(ws,id(value),project).orElse(null)==Role.EDITOR).toList();
        return Map.of("version",String.valueOf(current(ws,project)),"userIds",effective);
    }
    public Map<String,Object> save(UserAccount caller,String ws,String project,ScheduleDtos.GrantUpdate update){
        requireRead(caller,ws,project);agents.requireProject(caller,ws,project,true);long w=id(ws),p=id(project),expected=version(update.expectedVersion());
        if(current(w,p)!=expected)throw error(CONFLICT,"version_conflict","调度授权版本已变化");
        if(update.userIds()==null||new HashSet<>(update.userIds()).size()!=update.userIds().size())throw error(BAD_REQUEST,"validation_failed","授权成员列表必填且不能重复");
        for(String value:update.userIds()){
            var user=users.findById(id(value)).filter(u->!u.disabled()).orElseThrow(()->error(FORBIDDEN,"schedule-grant-ineligible","只能授权本项目有效 EDITOR"));
            agents.requireExecution(user,ws,project);
            if(permissions.effectiveRole(w,user.id(),p).orElse(null)!=Role.EDITOR)throw error(FORBIDDEN,"schedule-grant-ineligible","显式调度授权仅适用于本项目 EDITOR");
        }
        if(expected==Long.MAX_VALUE)throw error(CONFLICT,"version_exhausted","调度授权版本已达到上限");
        if(expected==0&&jdbc.queryForObject("SELECT COUNT(*) FROM execution_schedule_grants WHERE workspace_id=? AND project_id=?",Long.class,w,p)==0)jdbc.update("INSERT INTO execution_schedule_grants(workspace_id,project_id,version,user_ids_json) VALUES(?,?,1,?)",w,p,metadata.encode(update.userIds()));
        else jdbc.update("UPDATE execution_schedule_grants SET version=?,user_ids_json=? WHERE workspace_id=? AND project_id=? AND version=?",expected+1,metadata.encode(update.userIds()),w,p,expected);
        metadata.audit(caller.id(),"schedule-grants.save","project",p,expected+1);return projection(w,p);
    }
}
