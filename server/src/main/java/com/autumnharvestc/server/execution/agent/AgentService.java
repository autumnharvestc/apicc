package com.autumnharvestc.server.execution.agent;

import com.autumnharvestc.server.core.PermissionService;
import com.autumnharvestc.server.store.*;
import com.autumnharvestc.server.workspace.WorkspaceGuard;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.util.*;
import static com.autumnharvestc.server.execution.agent.AgentRepo.*;

@Service
@Transactional
public class AgentService {
    private final AgentRepo repo;
    private final JdbcTemplate jdbc;
    private final WorkspaceGuard guard;
    private final PermissionService permissions;
    private final ProjectRepo projects;
    private final com.autumnharvestc.server.auth.TokenService tokens;
    private final com.autumnharvestc.server.execution.ExecutionProperties properties;
    public AgentService(AgentRepo repo,JdbcTemplate jdbc,WorkspaceGuard guard,PermissionService permissions,ProjectRepo projects,com.autumnharvestc.server.auth.TokenService tokens,com.autumnharvestc.server.execution.ExecutionProperties properties) { this.repo=repo;this.jdbc=jdbc;this.guard=guard;this.permissions=permissions;this.projects=projects;this.tokens=tokens;this.properties=properties; }
    public static void requirePlatform(UserAccount caller) { if(caller==null || caller.disabled() || caller.role()!=PlatformRole.SUPERADMIN) throw error(HttpStatus.FORBIDDEN,"forbidden","需要平台超管权限"); }
    public ProjectRecord requireProject(UserAccount caller,String workspaceId,String projectId,boolean admin) {
        long ws=id(workspaceId), project=id(projectId);
        guard.requireMember(ws,caller);
        if(jdbc.queryForList("SELECT id FROM projects WHERE workspace_id=? AND id=? FOR UPDATE",ws,project).isEmpty()) throw error(HttpStatus.NOT_FOUND,"project_not_found","项目不存在");
        guard.requireMember(ws,caller);
        var role=permissions.effectiveRole(ws,caller.id(),project).orElseThrow(()->error(HttpStatus.FORBIDDEN,"project_forbidden","该项目不可见"));
        if(admin && !permissions.isAdmin(role)) throw error(HttpStatus.FORBIDDEN,"forbidden","需要有效项目 OWNER/ADMIN 权限");
        return projects.find(project).filter(p->p.workspaceId()==ws).orElseThrow(()->error(HttpStatus.NOT_FOUND,"project_not_found","项目不存在"));
    }
    public void requireExecution(UserAccount caller,String ws,String project) {
        var entity=requireProject(caller,ws,project,false);
        var role=permissions.effectiveRole(entity.workspaceId(),caller.id(),entity.id()).orElseThrow();
        if(!permissions.canWrite(role)) throw error(HttpStatus.FORBIDDEN,"forbidden","需要 EDITOR 及以上执行权限");
    }
    public boolean canCancel(UserAccount caller,String ws,String project,long submittedBy) {
        var entity=requireProject(caller,ws,project,false);
        var role=permissions.effectiveRole(entity.workspaceId(),caller.id(),entity.id()).orElseThrow();
        return permissions.canWrite(role)&&(caller.id()==submittedBy||permissions.isAdmin(role));
    }
    public List<AgentRepo.Agent> list(UserAccount caller) { requirePlatform(caller);return repo.list(); }
    public List<Map<String,Object>> workspaceDirectory(UserAccount caller) {
        requirePlatform(caller);
        return jdbc.query("SELECT id,name FROM workspaces ORDER BY id",(r,n)->Map.<String,Object>of("id",String.valueOf(r.getLong(1)),"name",r.getString(2)));
    }
    public AgentRepo.Agent create(UserAccount caller,String name) { requirePlatform(caller);validName(name);var agent=repo.create(name);repo.audit(caller.id(),"agent.create","agent",agent.id(),null);return agent; }
    public Map<String,Object> issueEnrollment(UserAccount caller,String agentId){
        requirePlatform(caller);long agent=id(agentId);if(repo.require(agent,true).revoked())throw error(HttpStatus.CONFLICT,"agent_revoked","已撤销身份不能重新登记");
        long ttl=properties.getDeployment().getEnrollmentTtlMs();if(ttl<=0||ttl>9007199254740991L)throw error(HttpStatus.BAD_REQUEST,"validation_failed","登记有效期必须为正安全整数毫秒");
        String plain="enroll_"+tokens.issue();var expires=java.time.OffsetDateTime.now(java.time.ZoneOffset.UTC).plusNanos((ttl%1000)*1000000).plusSeconds(ttl/1000);
        jdbc.update("INSERT INTO execution_agent_enrollments(token_hash,agent_id,created_by,expires_at) VALUES (?,?,?,?)",tokens.sha256Hex(plain),agent,caller.id(),expires);
        repo.audit(caller.id(),"agent.enrollment-issue","agent",agent,null);return Map.of("agentId",agentId,"enrollmentToken",plain,"expiresAt",expires.toInstant().toString());
    }
    public Map<String,Object> enroll(String enrollmentToken){
        if(enrollmentToken==null||enrollmentToken.isBlank()||enrollmentToken.length()>512)throw error(HttpStatus.UNAUTHORIZED,"unauthorized","登记材料无效、过期或已使用");
        String hash=tokens.sha256Hex(enrollmentToken);var agentIds=jdbc.query("SELECT agent_id FROM execution_agent_enrollments WHERE token_hash=?",(r,n)->r.getLong(1),hash);
        if(agentIds.isEmpty())throw error(HttpStatus.UNAUTHORIZED,"unauthorized","登记材料无效、过期或已使用");
        long agent=agentIds.getFirst();if(repo.require(agent,true).revoked())throw error(HttpStatus.UNAUTHORIZED,"unauthorized","代理身份已撤销");
        var now=java.time.OffsetDateTime.now(java.time.ZoneOffset.UTC);
        if(jdbc.update("UPDATE execution_agent_enrollments SET used_at=? WHERE token_hash=? AND agent_id=? AND used_at IS NULL AND expires_at>?",now,hash,agent,now)!=1)throw error(HttpStatus.UNAUTHORIZED,"unauthorized","登记材料无效、过期或已使用");
        String identity="agent_"+tokens.issue();jdbc.update("UPDATE execution_agents SET identity_hash=? WHERE id=?",tokens.sha256Hex(identity),agent);
        repo.audit(agent,"agent.enrolled","agent",agent,null);return Map.of("agentId",String.valueOf(agent),"agentToken",identity);
    }
    public AgentRepo.Agent patch(UserAccount caller,String agentId,String name,Boolean accepting) { requirePlatform(caller);long agent=id(agentId);repo.require(agent,true);if(name!=null)validName(name);repo.patch(agent,name,accepting);repo.audit(caller.id(),"agent.update","agent",agent,null);return repo.require(agent,false); }
    public void revoke(UserAccount caller,String agentId) { requirePlatform(caller);long agent=id(agentId);repo.require(agent,true);repo.revoke(agent);repo.audit(caller.id(),"agent.revoke","agent",agent,null); }
    public List<String> workspaceGrants(UserAccount caller,String agentId) { requirePlatform(caller);long agent=id(agentId);repo.require(agent,false);return repo.workspaceGrants(agent); }
    public void grantWorkspaces(UserAccount caller,String agentId,List<String> workspaceIds) {
        requirePlatform(caller);long agent=id(agentId);repo.require(agent,true);
        var granted=ids(workspaceIds);
        for(long ws:granted) if(repo.count("SELECT COUNT(*) FROM workspaces WHERE id=?",ws)==0) throw error(HttpStatus.NOT_FOUND,"workspace_not_found","工作区不存在");
        for(String existing:repo.workspaceGrants(agent)) if(!granted.contains(id(existing))) {
            long ws=id(existing);
            jdbc.update("DELETE FROM execution_project_agents WHERE agent_id=? AND project_id IN (SELECT project_id FROM execution_agent_project_allocations WHERE agent_id=? AND workspace_id=?)",agent,agent,ws);
            jdbc.update("UPDATE execution_project_settings SET default_agent_id=NULL WHERE default_agent_id=? AND project_id IN (SELECT project_id FROM execution_agent_project_allocations WHERE agent_id=? AND workspace_id=?)",agent,agent,ws);
            jdbc.update("DELETE FROM execution_agent_project_allocations WHERE agent_id=? AND workspace_id=?",agent,ws);
            jdbc.update("DELETE FROM execution_agent_workspace_grants WHERE agent_id=? AND workspace_id=?",agent,ws);
        }
        for(long ws:granted) if(!repo.granted(agent,ws)) jdbc.update("INSERT INTO execution_agent_workspace_grants(agent_id,workspace_id) VALUES (?,?)",agent,ws);
        repo.audit(caller.id(),"agent.workspace-grants","agent",agent,null);
    }
    public List<AgentRepo.Agent> available(UserAccount caller,String workspaceId) { long ws=id(workspaceId);guard.requireAdmin(ws,caller);return repo.list().stream().filter(a->!a.revoked() && repo.granted(a.id(),ws)).toList(); }
    public List<String> allocations(UserAccount caller,String workspaceId,String agentId) {
        long ws=id(workspaceId),agent=id(agentId);guard.requireAdmin(ws,caller);repo.require(agent,false);
        if(!repo.granted(agent,ws))throw error(HttpStatus.FORBIDDEN,"agent_not_granted","代理未获工作区授权");
        return jdbc.query("SELECT project_id FROM execution_agent_project_allocations WHERE workspace_id=? AND agent_id=? ORDER BY project_id",(r,n)->String.valueOf(r.getLong(1)),ws,agent);
    }
    public List<AgentRepo.Agent> candidates(UserAccount caller,String ws,String project) {
        var entity=requireProject(caller,ws,project,true);
        return repo.list().stream().filter(a->!a.revoked()&&repo.granted(a.id(),entity.workspaceId())&&repo.allocated(a.id(),entity.workspaceId(),entity.id())).toList();
    }
    public AgentRepo.Agent get(UserAccount caller,String agentId) {requirePlatform(caller);return repo.require(id(agentId),false);}
    public void allocate(UserAccount caller,String workspaceId,String agentId,List<String> projectIds) {
        long ws=id(workspaceId),agent=id(agentId);guard.requireAdmin(ws,caller);var selected=ids(projectIds);
        for(long project:selected) if(jdbc.queryForList("SELECT id FROM projects WHERE id=? AND workspace_id=? FOR UPDATE",project,ws).isEmpty()) throw error(HttpStatus.NOT_FOUND,"project_not_found","项目不属于该工作区");
        repo.require(agent,true);guard.requireAdmin(ws,caller);
        if(!repo.granted(agent,ws)) throw error(HttpStatus.FORBIDDEN,"agent_not_granted","代理未获工作区授权");
        var old=jdbc.query("SELECT project_id FROM execution_agent_project_allocations WHERE agent_id=? AND workspace_id=?",(r,n)->r.getLong(1),agent,ws);
        for(long project:old) if(!selected.contains(project)) {
            jdbc.update("DELETE FROM execution_project_agents WHERE project_id=? AND agent_id=?",project,agent);
            jdbc.update("UPDATE execution_project_settings SET default_agent_id=NULL WHERE project_id=? AND default_agent_id=?",project,agent);
            jdbc.update("DELETE FROM execution_agent_project_allocations WHERE agent_id=? AND project_id=?",agent,project);
        }
        for(long project:selected) if(!repo.allocated(agent,ws,project)) jdbc.update("INSERT INTO execution_agent_project_allocations(agent_id,workspace_id,project_id) VALUES (?,?,?)",agent,ws,project);
        repo.audit(caller.id(),"agent.project-allocation","workspace",ws,null);
    }
    public void associate(UserAccount caller,String workspaceId,String projectId,List<String> agentIds,String defaultAgentId) {
        var entity=requireProject(caller,workspaceId,projectId,true);var selected=ids(agentIds);
        for(long agent:selected) { repo.require(agent,true);if(!repo.granted(agent,entity.workspaceId())||!repo.allocated(agent,entity.workspaceId(),entity.id())) throw error(HttpStatus.FORBIDDEN,"agent_not_allocated","代理未获工作区及本项目分配授权"); }
        if(defaultAgentId!=null && !selected.contains(id(defaultAgentId))) throw error(HttpStatus.BAD_REQUEST,"validation_failed","默认代理必须属于本项目关联集合");
        requireProject(caller,workspaceId,projectId,true);
        jdbc.update("DELETE FROM execution_project_agents WHERE project_id=?",entity.id());
        for(long agent:selected) jdbc.update("INSERT INTO execution_project_agents(project_id,agent_id) VALUES (?,?)",entity.id(),agent);
        if(repo.count("SELECT COUNT(*) FROM execution_project_settings WHERE project_id=?",entity.id())==0) jdbc.update("INSERT INTO execution_project_settings(project_id,default_agent_id) VALUES (?,?)",entity.id(),defaultAgentId==null?null:id(defaultAgentId));
        else jdbc.update("UPDATE execution_project_settings SET default_agent_id=? WHERE project_id=?",defaultAgentId==null?null:id(defaultAgentId),entity.id());
        repo.audit(caller.id(),"project.agents","project",entity.id(),null);
    }
    public Map<String,Object> associations(UserAccount caller,String ws,String project) {
        var entity=requireProject(caller,ws,project,false);var result=new LinkedHashMap<String,Object>();result.put("agentIds",repo.associated(entity.id()));result.put("defaultAgentId",repo.defaultAgent(entity.id()));return result;
    }
    /** Submit/claim/start seam. Does not claim to stop already running tasks. */
    public AgentRepo.Agent requireUsable(String agentId,String workspaceId,String projectId) {
        long agent=id(agentId),ws=id(workspaceId),project=id(projectId);var row=repo.require(agent,true);
        if(projects.find(project).filter(p->p.workspaceId()==ws).isEmpty()) throw error(HttpStatus.NOT_FOUND,"project_not_found","项目不存在或作用域不符");
        if(row.revoked() || !row.acceptingJobs()) throw error(HttpStatus.FORBIDDEN,"agent_unavailable","代理身份已撤销或停止接收新任务");
        if(!repo.granted(agent,ws)||!repo.allocated(agent,ws,project)||!repo.associated(agent,project)) throw error(HttpStatus.FORBIDDEN,"agent_not_associated","代理未获本项目完整授权及关联");
        return row;
    }
    private static Set<Long> ids(List<String> values) { if(values==null)throw error(HttpStatus.BAD_REQUEST,"validation_failed","ID 集合必填");var result=new TreeSet<Long>();for(String value:values)if(!result.add(id(value)))throw error(HttpStatus.BAD_REQUEST,"validation_failed","ID 集合不能重复");return result; }
    private static void validName(String name) { if(name==null||name.isBlank()||name.length()>128)throw error(HttpStatus.BAD_REQUEST,"validation_failed","代理名称必填且不超过 128 字符"); }
}
