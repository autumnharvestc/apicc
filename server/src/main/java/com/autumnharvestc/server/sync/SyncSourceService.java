package com.autumnharvestc.server.sync;

import com.autumnharvestc.server.store.*;
import com.autumnharvestc.server.access.*;
import com.autumnharvestc.server.execution.agent.AgentService;
import com.autumnharvestc.server.execution.agent.AgentRepo;
import com.autumnharvestc.server.core.ApiException;
import com.autumnharvestc.server.core.EntityIds;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.http.HttpStatus;
import java.util.*;

@Service
@Transactional
public class SyncSourceService {
    private final SyncStorage accounting;private final SyncRepo repo;
    private final AgentService agents;
    private final ProjectAccessService access;
    private final SyncDtos dtos;
    private final JdbcTemplate jdbc;
    private final AgentRepo audit;
    public SyncSourceService(SyncRepo repo,AgentService agents,ProjectAccessService access,SyncDtos dtos,JdbcTemplate jdbc,AgentRepo audit,SyncStorage accounting){this.accounting=accounting;this.repo=repo;this.agents=agents;this.access=access;this.dtos=dtos;this.jdbc=jdbc;this.audit=audit;}
    /** Existing project lock plus the complete current identity/member/ACL authority. */
    public ProjectRecord requireRead(UserAccount actor,String ws,String project){
        var entity=agents.requireProject(actor,ws,project,false);
        if(access.resolve(actor.id(),entity.workspaceId(),entity.id()).effectiveRole().isEmpty())throw SyncDtos.denied();
        return entity;
    }
    public List<JsonNode> list(UserAccount actor,String ws,String project){var entity=requireRead(actor,ws,project);return repo.sources(entity.workspaceId(),entity.id());}
    public JsonNode read(UserAccount actor,String ws,String project,String source){
        var entity=requireRead(actor,ws,project);return repo.source(entity.workspaceId(),entity.id(),source).orElseThrow(SyncSourceService::missing);
    }
    public JsonNode save(UserAccount actor,String ws,String project,String routeSource,JsonNode input){
        accounting.lock(EntityIds.parse(ws),EntityIds.parse(project));
        agents.requireCapability(actor,ws,project,Capability.SYNC_MANAGE);
        long w=EntityIds.parse(ws),p=EntityIds.parse(project);
        dtos.require("sourceSave",input);var source=dtos.source(input.get("source"));String id=source.path("id").asText();
        if(source.path("schedule").path("enabled").asBoolean())throw SyncDtos.conflict("SYNC_SCHEDULE_GRANT_REQUIRED");
        if(routeSource!=null&&!routeSource.equals(id))throw SyncDtos.invalid();
        String intent=input.path("intentId").asText(),kind=routeSource==null?"source-create":"source-update";
        String digest=dtos.digest(kind,routeSource,input);var replay=repo.replay(w,p,intent,actor.id(),kind,digest);if(replay.isPresent())return replay.get();
        var previous=repo.source(w,p,id);
        if(routeSource!=null&&previous.isEmpty())throw missing();
        if(routeSource==null&&previous.isPresent())throw SyncDtos.conflict("SYNC_SOURCE_REVISION_CHANGED");
        String expected=input.path("expectedSourceRevision").asText();
        if(!expected.equals(previous.map(value->value.path("revision").asText()).orElse("0"))||!source.path("revision").asText().equals(SyncDtos.next(expected)))throw SyncDtos.conflict("SYNC_SOURCE_REVISION_CHANGED");
        long asset=SyncDtos.assetVersion(input.path("expectedAssetVersion").asText());
        if(asset!=jdbc.queryForObject("SELECT asset_version FROM projects WHERE id=? AND workspace_id=?",Long.class,p,w))throw SyncDtos.conflict("SYNC_PROJECT_ASSETS_CHANGED");
        String module=source.path("moduleId").asText();
        if(jdbc.queryForObject("SELECT COUNT(*) FROM file_versions WHERE workspace_id=? AND path=?",Integer.class,w,p+"/collections/"+module+"/collection.yaml")==0)throw SyncDtos.conflict("SYNC_SOURCE_MODULE_MISMATCH");
        if(previous.isPresent()&&!previous.get().path("moduleId").asText().equals(module))throw SyncDtos.conflict("SYNC_SOURCE_MODULE_CHANGE_UNSUPPORTED");
        var descriptor=descriptor(source);
        if(repo.sources(w,p).stream().anyMatch(value->!value.path("id").asText().equals(id)&&descriptor(value).equals(descriptor)))throw SyncDtos.conflict("SYNC_SOURCE_DUPLICATE");
        repo.saveSource(w,p,source);repo.operation(w,p,intent,actor.id(),kind,digest,source);audit.audit(actor.id(),"sync.source.save","project",p,null);
        return source;
    }
    private static Map<String,String> descriptor(JsonNode source){
        var descriptor=new LinkedHashMap<String,String>();
        for(String key:List.of("moduleId","kind","url","repositoryUrl","ref","filePath","authRef","networkProfileRef","privateKeyRef","knownHostsRef","passphraseRef"))if(source.has(key))descriptor.put(key,source.get(key).asText());
        return descriptor;
    }
    private static ApiException missing(){return new ApiException(HttpStatus.NOT_FOUND,"sync_source_not_found","同步来源不存在于当前项目");}
}
