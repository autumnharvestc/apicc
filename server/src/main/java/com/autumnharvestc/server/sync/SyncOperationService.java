package com.autumnharvestc.server.sync;
import com.autumnharvestc.server.store.UserAccount;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
@Service @Transactional
public class SyncOperationService {
    private final com.fasterxml.jackson.databind.ObjectMapper json;private final SyncRepo repo;private final SyncSourceService sources;
    public SyncOperationService(SyncRepo repo,SyncSourceService sources,com.fasterxml.jackson.databind.ObjectMapper json){this.json=json;this.repo=repo;this.sources=sources;}
    public JsonNode read(UserAccount actor,String ws,String project,String intent){sources.requireRead(actor,ws,project);var operation=repo.operation(Long.parseLong(ws),Long.parseLong(project),intent).orElseThrow(()->SyncRepo.missing("sync_operation_not_found"));if(operation.actor()!=actor.id())throw SyncRepo.missing("sync_operation_not_found");if(java.util.Set.of("apply","rollback").contains(operation.kind()))SyncHistoryService.verify(json,"receipt",operation.response());return operation.response();}
}
