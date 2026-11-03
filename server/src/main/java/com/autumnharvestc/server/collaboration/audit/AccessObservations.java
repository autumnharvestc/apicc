package com.autumnharvestc.server.collaboration.audit;

import com.autumnharvestc.server.collaboration.artifacts.CollaborationStorage;
import com.autumnharvestc.server.collaboration.grants.GrantService;
import com.autumnharvestc.server.collaboration.policy.PolicyReadView;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import org.springframework.stereotype.Service;

/** Best effort, finite authenticated public view/download facts; never a completeness claim. */
@Service
public class AccessObservations {
    private final CollaborationStorage storage;
    // Conservative, bounded process-wide gap marker, not a per-project loss counter.
    private final AtomicBoolean missing=new AtomicBoolean();
    public AccessObservations(CollaborationStorage storage){this.storage=storage;}
    public void read(GrantService.Admission admission,boolean download){
        try{storage.publicAccess(admission.workspaceId(),admission.projectId(),admission.publicationId(),download);}
        catch(RuntimeException failure){missing.set(true);}
    }
    public Map<String,Object> state(PolicyReadView policy){
        long retention=CollaborationStorage.number(policy,PolicyReadView.Code.ACCESS_AUDIT_RETENTION_MS);
        return Map.of("state",retention==0?"disabled":missing.get()?"observations-missing":"bounded","retentionMs",retention);
    }
}
