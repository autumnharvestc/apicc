package com.autumnharvestc.server.sync;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.jdbc.core.JdbcTemplate;
@Service
public class SyncRetentionService {
    private final SyncPolicyService policies;private final SyncStorage accounting;private final SyncHistoryService history;private final JdbcTemplate jdbc;
    public SyncRetentionService(SyncStorage accounting,SyncHistoryService history,JdbcTemplate jdbc,SyncPolicyService policies){this.policies=policies;this.accounting=accounting;this.history=history;this.jdbc=jdbc;}
    @Transactional public int cleanup(long workspace,long project){accounting.lock(workspace,project);jdbc.queryForList("SELECT id FROM projects WHERE workspace_id=? AND id=? FOR UPDATE",workspace,project);return cleanupLocked(workspace,project,null);}
    @Transactional(propagation=org.springframework.transaction.annotation.Propagation.MANDATORY)
    public int cleanupLocked(long workspace,long project,com.autumnharvestc.server.collaboration.policy.PolicyReadView policy){
        long rows=0;for(String table:java.util.List.of("sync_sources","sync_checks","sync_candidates","sync_history","sync_operations","sync_policies"))rows+=jdbc.queryForObject("SELECT COUNT(*) FROM "+table+" WHERE workspace_id=? AND project_id=?",Long.class,workspace,project);if(rows==0)return 0;
        var effective=policies.maintenanceEffective(workspace,project);if(effective.isEmpty())return 0;
        if(policy!=null)accounting.attachLocked(workspace,project,policy);return history.retain(workspace,project,null,effective.get().path("policy"));
    }
}
