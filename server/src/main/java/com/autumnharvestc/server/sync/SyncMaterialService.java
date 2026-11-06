package com.autumnharvestc.server.sync;

import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.execution.ExecutionDtos.*;
import com.autumnharvestc.server.execution.materials.ProjectCredentialService;
import com.autumnharvestc.server.execution.agent.AgentService;
import com.autumnharvestc.server.access.Capability;
import java.util.List;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Internal source-domain material seam; plaintext is never exposed by the CRUD controllers. */
@Service
@Transactional
public class SyncMaterialService {
    private final SyncSourceService sources;
    private final ProjectCredentialService credentials;
    private final AgentService agents;
    public SyncMaterialService(SyncSourceService sources,ProjectCredentialService credentials,AgentService agents){this.sources=sources;this.credentials=credentials;this.agents=agents;}
    public CredentialValue resolve(UserAccount actor,String ws,String project,String sourceId,String sourceRevision,String purpose,CredentialSelection selection){
        var source=sources.read(actor,ws,project,sourceId);
        if(!"source-check".equals(purpose))throw SyncDtos.denied();
        agents.requireCapability(actor,ws,project,Capability.SYNC_CHECK);
        if(!source.path("revision").asText().equals(sourceRevision))throw SyncDtos.conflict("SYNC_SOURCE_REVISION_CHANGED");
        if(selection!=null&&!List.of("authRef","networkProfileRef","privateKeyRef","knownHostsRef","passphraseRef").stream().anyMatch(field->source.has(field)&&source.path(field).asText().equals(selection.refId())))throw SyncDtos.denied();
        return credentials.resolveAuthorized(Long.parseLong(ws),Long.parseLong(project),selection);
    }
}
