package com.autumnharvestc.server.execution.scheduling;

import com.autumnharvestc.server.execution.agent.*;
import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.workspace.WorkspaceGuard;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.util.*;
import static com.autumnharvestc.server.execution.agent.AgentRepo.*;

@Service
@Transactional
public class SchedulePolicyService {
    private final AgentRepo repo;private final AgentService agents;private final WorkspaceGuard guard;
    private final JdbcTemplate jdbc;private final SchedulerProperties properties;
    private final NotificationProperties notification;
    public SchedulePolicyService(AgentRepo repo,AgentService agents,WorkspaceGuard guard,JdbcTemplate jdbc,SchedulerProperties properties,NotificationProperties notification) {
        this.repo=repo;this.agents=agents;this.guard=guard;this.jdbc=jdbc;this.properties=properties;this.notification=notification;
    }
    public Map<String,Object> workspace(UserAccount caller,String ws){guard.requireAdmin(id(ws),caller);return view(id(ws),null);}
    public Map<String,Object> project(UserAccount caller,String ws,String project){var entity=agents.requireProject(caller,ws,project,true);return view(entity.workspaceId(),entity.id());}
    public Map<String,Object> effective(long ws,long project){return view(ws,project);}
    /** Internal read, after caller's project authorization/lock. */
    public Map<String,Object> effectiveWorkspace(long ws){return view(ws,null);}
    public Map<String,Object> save(UserAccount caller,String ws,String project,String expectedVersion,Map<String,Object> patch) {
        return save(caller,ws,project,expectedVersion,patch,List.of());
    }
    public Map<String,Object> save(UserAccount caller,String ws,String project,String expectedVersion,Map<String,Object> patch,List<String> resetKeys) {
        if(patch==null)throw error(org.springframework.http.HttpStatus.BAD_REQUEST,"validation_failed","调度策略必填");
        long workspace=id(ws);Long projectId=project==null?null:id(project);
        if(project==null)guard.requireAdmin(workspace,caller);else agents.requireProject(caller,ws,project,true);
        jdbc.queryForList("SELECT id FROM workspaces WHERE id=? FOR UPDATE",workspace);
        if(project==null)guard.requireAdmin(workspace,caller);else agents.requireProject(caller,ws,project,true);
        String type=project==null?"schedule-ws":"schedule-project";long scope=project==null?workspace:projectId;
        var resets=new LinkedHashSet<>(resetKeys==null?List.of():resetKeys);
        if(!SchedulePolicyValues.defaults(false).keySet().containsAll(resets)||resets.stream().anyMatch(patch::containsKey))throw error(org.springframework.http.HttpStatus.BAD_REQUEST,"validation_failed","恢复继承只允许已知字段，且不能同时设置同一字段");
        var explicit=new LinkedHashMap<>(repo.config(type,scope).explicit());resets.forEach(explicit::remove);explicit.putAll(patch);
        @SuppressWarnings("unchecked") var inherited=(Map<String,Object>)(project==null?base():view(workspace,null).get("effective"));
        SchedulePolicyValues.validate(explicit,inherited,project!=null,properties.getScanIntervalMs(),properties.getMaxSchedules(),notification.getMaxPendingDeliveries());
        repo.saveConfig(type,scope,version(expectedVersion),explicit,List.of());
        repo.audit(caller.id(),"schedule-policy.save",project==null?"workspace":"project",scope,version(expectedVersion)+1);
        return view(workspace,projectId);
    }
    private Map<String,Object> view(long ws,Long project) {
        var defaults=base();
        var source=new LinkedHashMap<String,String>();defaults.keySet().forEach(k->source.put(k,"default"));
        if(properties.getMaxSchedules()<1000)source.put("maxSchedules","deployment");
        if(notification.getMaxPendingDeliveries()<1000)source.put("maxPendingDeliveries","deployment");
        if(properties.getScanIntervalMs()*2>10000)source.put("lateToleranceMs","deployment");
        var savedWs=repo.config("schedule-ws",ws);
        var effective=SchedulePolicyValues.merge(defaults,savedWs.explicit(),false,source,"workspace");
        clampDeployment(effective,source);
        var saved=project==null?savedWs:repo.config("schedule-project",project);
        if(project!=null)effective=SchedulePolicyValues.merge(effective,saved.explicit(),true,source,"project");
        clampDeployment(effective,source);
        return Map.of("default",SchedulePolicyValues.defaults(project!=null),"explicit",saved.explicit(),"explicitByScope",Map.of("workspace",savedWs.explicit(),"project",project==null?Map.of():saved.explicit()),"effective",effective,
            "source",source,"version",String.valueOf(saved.version()),"versions",Map.of("workspace",String.valueOf(savedWs.version()),"project",project==null?"0":String.valueOf(saved.version())),"appliesTo","new-admissions");
    }
    private Map<String,Object> base(){var values=SchedulePolicyValues.defaults(false);values.put("maxSchedules",Math.min(1000L,properties.getMaxSchedules()));values.put("maxPendingDeliveries",Math.min(1000L,notification.getMaxPendingDeliveries()));values.put("lateToleranceMs",Math.max(10000L,properties.getScanIntervalMs()*2));return values;}
    private void clampDeployment(Map<String,Object> values,Map<String,String> source) {
        for(var cap:Map.of("maxSchedules",properties.getMaxSchedules(),"maxPendingDeliveries",notification.getMaxPendingDeliveries()).entrySet())
            if(((Number)values.get(cap.getKey())).longValue()>cap.getValue()){values.put(cap.getKey(),cap.getValue());source.put(cap.getKey(),"deployment");}
        if(((Number)values.get("lateToleranceMs")).longValue()<properties.getScanIntervalMs()*2){values.put("lateToleranceMs",properties.getScanIntervalMs()*2);source.put("lateToleranceMs","deployment");}
    }
}
