package com.autumnharvestc.server.collaboration.audit;

import com.autumnharvestc.server.collaboration.artifacts.*;
import com.autumnharvestc.server.collaboration.policy.*;
import com.fasterxml.jackson.databind.*;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class MockLogs {
    private final JdbcTemplate jdbc;private final ObjectMapper json;private final CollaborationStorage storage;private final CollaborationPolicyService policies;private final TransactionTemplate tx;
    private final java.util.concurrent.atomic.AtomicBoolean observationGap=new java.util.concurrent.atomic.AtomicBoolean();
    private final ArtifactRepo artifacts;
    private final MetadataQuery pages;
    public MockLogs(JdbcTemplate jdbc,ObjectMapper json,CollaborationStorage storage,CollaborationPolicyService policies,PlatformTransactionManager manager,ArtifactRepo artifacts,MetadataQuery pages){this.jdbc=jdbc;this.json=json;this.storage=storage;this.policies=policies;this.artifacts=artifacts;this.pages=pages;tx=new TransactionTemplate(manager);}
    public void record(long workspace,long project,long publication,MockLogEntry entry){try{tx.executeWithoutResult(status->{var policy=policies.publicationSnapshot(workspace,project);storage.lockScope(workspace,project);artifacts.lockProject(workspace,project);var head=artifacts.head(publication,true);if(head==null||head.workspace()!=workspace||head.project()!=project)return;storage.mockLog(workspace,project,publication,entry,policy);storage.limitMockLogs(workspace,project,publication,CollaborationStorage.number(policy,PolicyReadView.Code.MOCK_LOG_MAX_ENTRIES),policy);});}catch(RuntimeException unavailable){observationGap.set(true);}}
    public Object read(long workspace,long project,long publication,Map<String,String> query){return tx.execute(status->{var policy=policies.publicationSnapshot(workspace,project);storage.lockScope(workspace,project);artifacts.lockProject(workspace,project);var head=artifacts.head(publication,true);if(head==null||head.workspace()!=workspace||head.project()!=project)throw new com.autumnharvestc.server.core.ApiException(org.springframework.http.HttpStatus.NOT_FOUND,"publication_not_found","当前项目中没有对应发布版本");storage.expireMockLogs(workspace,project,publication,policy);long discarded=storage.limitMockLogs(workspace,project,publication,CollaborationStorage.number(policy,PolicyReadView.Code.MOCK_LOG_MAX_ENTRIES),policy);
        var page=pages.page("mock-logs:"+publication,workspace,project,policy,query,List.of(new MetadataQuery.Source("items","collaboration_mock_logs","created_at_epoch_ms","workspace_id=? AND project_id=? AND publication_id=?",List.of(workspace,project,publication),(row,index)->{var item=new LinkedHashMap<String,Object>();tree(row.getString("metadata_json")).fields().forEachRemaining(field->item.put(field.getKey(),field.getValue()));item.put("id",String.valueOf(row.getLong("id")));return item;})));
        boolean disabled=CollaborationStorage.number(policy,PolicyReadView.Code.MOCK_LOG_MAX_ENTRIES)==0;
        String label=disabled?"命中明细留存已关闭，不能据此判断没有访问":discarded>0?"仅保留有限明细，较旧记录已丢弃":"仅保留有限明细";
        if(observationGap.get())label+="；本服务启动以来发生观测缺失，可能涉及本版本";
        if(disabled)page.put("items",List.of());page.put("discarded",discarded);page.put("state",disabled?"disabled":observationGap.get()?"observations-missing":"bounded");page.put("integrityLabel",label);page.put("maxEntries",CollaborationStorage.number(policy,PolicyReadView.Code.MOCK_LOG_MAX_ENTRIES));page.put("retentionMs",CollaborationStorage.number(policy,PolicyReadView.Code.MOCK_LOG_RETENTION_MS));return page;});
    }
    private JsonNode tree(String text){try{return json.readTree(text);}catch(java.io.IOException e){throw new IllegalStateException("Invalid stored finite Mock metadata",e);}}
}
