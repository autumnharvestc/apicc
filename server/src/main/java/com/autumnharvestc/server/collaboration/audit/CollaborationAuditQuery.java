package com.autumnharvestc.server.collaboration.audit;

import com.autumnharvestc.server.collaboration.artifacts.CollaborationStorage;
import com.autumnharvestc.server.collaboration.policy.*;
import com.fasterxml.jackson.databind.*;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/** Reads the three real owning tables independently; no reconstruction of missing historical evidence. */
@Service
public class CollaborationAuditQuery {
    private final ObjectMapper json;private final CollaborationPolicyService policies;private final MetadataQuery pages;private final AccessObservations observations;
    public CollaborationAuditQuery(ObjectMapper json,CollaborationPolicyService policies,MetadataQuery pages,AccessObservations observations){this.json=json;this.policies=policies;this.pages=pages;this.observations=observations;}
    public Object read(long ws,long project,Map<String,String> query){var policy=policies.publicationSnapshot(ws,project);var result=pages.page("audit",ws,project,policy,query,List.of(
        new MetadataQuery.Source("access","access_audit",MetadataQuery.TIMESTAMP_MS,"workspace_id=? AND project_id=?",List.of(ws,project),(row,index)->{var item=base(row);item.put("revision",row.getLong("revision"));item.put("reason",row.getString("reason_code"));item.put("objectKind",row.getObject("user_id")==null?null:"MEMBER");item.put("objectId",row.getObject("user_id")==null?null:String.valueOf(row.getLong("user_id")));return item;}),
        new MetadataQuery.Source("execution","execution_management_audit",MetadataQuery.TIMESTAMP_MS,"scope_type='project' AND scope_id=?",List.of(project),(row,index)->{var item=base(row);item.put("revision",row.getObject("version"));item.put("objectKind","PROJECT");item.put("objectId",String.valueOf(row.getLong("scope_id")));item.put("agentId",row.getObject("agent_id")==null?null:String.valueOf(row.getLong("agent_id")));String stored=row.getString("asset_locations_json"),summary=row.getString("asset_summary");JsonNode locations=stored==null?null:tree(stored);item.put("locations",locations);item.put("locationLabel",locations==null?"未采集":locations.isEmpty()?"无变更位置":"已采集业务位置");item.put("summary",summary);item.put("summaryLabel",summary==null?"未采集":switch(summary){case "script-changed"->"脚本已变更";case "script-unchanged"->"脚本未变更";case "classification-disabled"->"分类未启用";case "classification-unavailable"->"分类服务不可用";default->summary;});item.put("beforeRevision",row.getString("asset_before_revision"));item.put("afterRevision",row.getString("asset_after_revision"));return item;}),
        new MetadataQuery.Source("collaboration","collaboration_management_audit","created_at_epoch_ms","workspace_id=? AND project_id=?",List.of(ws,project),(row,index)->{JsonNode event=tree(row.getString("event_json"));var item=new LinkedHashMap<String,Object>();item.put("id",String.valueOf(row.getLong("id")));for(String field:List.of("objectKind","revision","action","reason"))item.put(field,event.path(field));for(String field:List.of("actorId","objectId"))item.put(field,event.path(field).isMissingNode()||event.path(field).isNull()?null:event.path(field).asText());item.put("time",java.time.Instant.ofEpochMilli(row.getLong("created_at_epoch_ms")).toString());return item;})
    ));result.put("accessDetails",observations.state(policy));return result;}
    private Map<String,Object> base(java.sql.ResultSet row)throws java.sql.SQLException{var item=new LinkedHashMap<String,Object>();item.put("id",String.valueOf(row.getLong("id")));item.put("actorId",String.valueOf(row.getLong("actor_id")));item.put("action",row.getString("action"));item.put("time",row.getTimestamp("created_at").toInstant().toString());return item;}
    private JsonNode tree(String value){try{return json.readTree(value);}catch(java.io.IOException e){throw new IllegalStateException("Invalid stored collaboration audit",e);}}
}
