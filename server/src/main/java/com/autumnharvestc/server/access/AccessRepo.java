package com.autumnharvestc.server.access;

import com.autumnharvestc.server.core.Role;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** Persistent membership CAS identity, including removed subjects. */
@Repository
public class AccessRepo {
    private final JdbcTemplate jdbc;
    public AccessRepo(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    public int changeMember(Long workspaceId, Long userId, long expectedRevision) {
        // Existing memberships precede this metadata; establish their initial identity lazily.
        jdbc.update("""
                INSERT INTO access_members (workspace_id,user_id,revision)
                SELECT ?,?,1 WHERE EXISTS(SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=?)
                AND NOT EXISTS(SELECT 1 FROM access_members WHERE workspace_id=? AND user_id=?)
                """, workspaceId, userId, workspaceId, userId, workspaceId, userId);
        if (expectedRevision == 0) {
            return jdbc.update("INSERT INTO access_members(workspace_id,user_id,revision) VALUES(?,?,1)", workspaceId, userId);
        }
        return jdbc.update("UPDATE access_members SET revision=revision+1 WHERE workspace_id=? AND user_id=? AND revision=?",
                workspaceId, userId, expectedRevision);
    }

    public void retainDeletedMember(Long workspaceId, Long userId, long expectedRevision) {
        if (changeMember(workspaceId, userId, expectedRevision) == 0) throw AccessMutationService.conflict();
    }

    public long memberRevision(Long workspaceId, Long userId) {
        var rows = jdbc.queryForList("SELECT revision FROM access_members WHERE workspace_id=? AND user_id=?", Long.class, workspaceId, userId);
        if (!rows.isEmpty()) return rows.getFirst();
        return jdbc.queryForObject("SELECT COUNT(*) FROM memberships WHERE workspace_id=? AND user_id=?", Long.class, workspaceId, userId) > 0 ? 1 : 0;
    }

    public long policyRevision(Long workspaceId, long projectId) {
        var rows = jdbc.queryForList("SELECT revision FROM access_policy_scopes WHERE workspace_id=? AND project_id=?", Long.class, workspaceId, projectId);
        return rows.isEmpty() ? 0 : rows.getFirst();
    }

    public int changePolicy(Long workspaceId, long projectId, long expectedRevision) {
        if (expectedRevision == 0) return jdbc.update("INSERT INTO access_policy_scopes VALUES(?,?,1)", workspaceId, projectId);
        return jdbc.update("UPDATE access_policy_scopes SET revision=revision+1 WHERE workspace_id=? AND project_id=? AND revision=?",
                workspaceId, projectId, expectedRevision);
    }

    public java.util.Map<String,String> defaults(Long workspaceId, long projectId) {
        var result = new java.util.LinkedHashMap<String,String>();
        jdbc.query("SELECT code,mode FROM access_capability_defaults WHERE workspace_id=? AND project_id=?",
                rs -> { result.put(rs.getString("code"), rs.getString("mode")); }, workspaceId, projectId);
        return result;
    }

    public java.util.Map<String,String> capabilities(Long workspaceId, long projectId, Long userId) {
        var result = new java.util.LinkedHashMap<String,String>();
        jdbc.query("SELECT code,mode FROM access_member_capabilities WHERE workspace_id=? AND project_id=? AND user_id=?",
                rs -> { result.put(rs.getString("code"), rs.getString("mode")); }, workspaceId, projectId, userId);
        return result;
    }

    public void patchDefaults(Long workspaceId, long projectId, java.util.Map<String,String> entries) {
        entries.forEach((code, mode) -> {
            if (mode.equals("inherit")) {
                jdbc.update("DELETE FROM access_capability_defaults WHERE workspace_id=? AND project_id=? AND code=?", workspaceId, projectId, code);
                return;
            }
            int updated = jdbc.update("UPDATE access_capability_defaults SET mode=? WHERE workspace_id=? AND project_id=? AND code=?", mode, workspaceId, projectId, code);
            if (updated == 0) jdbc.update("INSERT INTO access_capability_defaults VALUES(?,?,?,?)", workspaceId, projectId, code, mode);
        });
    }

    public void patchCapabilities(Long workspaceId, long projectId, Long userId, java.util.Map<String,String> entries) {
        entries.forEach((code, mode) -> {
            int updated = jdbc.update("UPDATE access_member_capabilities SET mode=? WHERE workspace_id=? AND project_id=? AND user_id=? AND code=?", mode, workspaceId, projectId, userId, code);
            if (updated == 0) jdbc.update("INSERT INTO access_member_capabilities VALUES(?,?,?,?,?)", workspaceId, projectId, userId, code, mode);
        });
    }

    public void lockGate() { jdbc.queryForList("SELECT id FROM access_mutation_gate WHERE id=1 FOR UPDATE",Long.class); }
    public void lockActorMembership(Long ws,Long actor) {
        jdbc.queryForList("SELECT user_id FROM memberships WHERE workspace_id=? AND user_id=? FOR UPDATE",Long.class,ws,actor);
    }

    public void lockScope(Long ws, Long project, Long userId, boolean policy) {
        jdbc.queryForList("SELECT id FROM workspaces WHERE id=? FOR UPDATE",Long.class,ws);
        // Scope deletion shares lockGate; content's project lock must not delay revocation.
        if(policy) jdbc.queryForList("SELECT revision FROM access_policy_scopes WHERE workspace_id=? AND project_id=? FOR UPDATE",Long.class,ws,project == null ? 0 : project);
        else if(userId != null) {
            jdbc.queryForList("SELECT revision FROM access_members WHERE workspace_id=? AND user_id=? FOR UPDATE",Long.class,ws,userId);
            jdbc.queryForList("SELECT user_id FROM memberships WHERE workspace_id=? AND user_id=? FOR UPDATE",Long.class,ws,userId);
            if(project != null) jdbc.queryForList("SELECT revision FROM project_acl WHERE workspace_id=? AND project_id=? AND user_id=? FOR UPDATE",Long.class,ws,project,userId);
        }
    }

    public long membershipEpoch(Long ws,Long userId) {
        var rows=jdbc.queryForList("SELECT membership_epoch FROM access_members WHERE workspace_id=? AND user_id=?",Long.class,ws,userId);
        return rows.isEmpty()?0:rows.getFirst();
    }
    public void advanceMembershipEpoch(Long ws,Long userId) {
        jdbc.update("UPDATE access_members SET membership_epoch=membership_epoch+1 WHERE workspace_id=? AND user_id=?",ws,userId);
        // Active positive roles advance once in suspendPositiveOverrides; every other
        // project identity whose stored allow lapses must advance its shared CAS too.
        jdbc.update("""
                UPDATE project_acl a SET revision=revision+1,updated_at=CURRENT_TIMESTAMP
                WHERE a.workspace_id=? AND a.user_id=? AND NOT(a.state='active' AND a.role<>'NONE')
                AND EXISTS(SELECT 1 FROM access_member_capabilities c
                    WHERE c.workspace_id=a.workspace_id AND c.project_id=a.project_id
                      AND c.user_id=a.user_id AND c.mode='allow')
                """,ws,userId);
        jdbc.update("DELETE FROM access_member_capabilities WHERE workspace_id=? AND user_id=? AND mode='allow'",ws,userId);
    }
    public long responsibilityEpoch(Long ws,Long project,Long userId) {
        var rows=jdbc.queryForList("SELECT responsibility_epoch FROM access_project_epochs WHERE workspace_id=? AND project_id=? AND user_id=?",Long.class,ws,project,userId);
        return rows.isEmpty()?0:rows.getFirst();
    }
    /** Separate fixed background-sync responsibility; publication/mock epochs retain their original meaning. */
    public long syncCheckEpoch(Long ws,Long project,Long userId) {
        var rows=jdbc.queryForList("SELECT sync_check_epoch FROM access_project_epochs WHERE workspace_id=? AND project_id=? AND user_id=?",Long.class,ws,project,userId);
        return rows.isEmpty()?0:rows.getFirst();
    }
    public void advanceSyncCheckEpoch(Long ws,Long project,Long userId) {
        if(jdbc.update("UPDATE access_project_epochs SET sync_check_epoch=sync_check_epoch+1 WHERE workspace_id=? AND project_id=? AND user_id=?",ws,project,userId)==0)
            jdbc.update("INSERT INTO access_project_epochs(workspace_id,project_id,user_id,sync_check_epoch) VALUES(?,?,?,1)",ws,project,userId);
    }
    public void advanceResponsibilityEpoch(Long ws,Long project,Long userId) {
        if(jdbc.update("UPDATE access_project_epochs SET responsibility_epoch=responsibility_epoch+1 WHERE workspace_id=? AND project_id=? AND user_id=?",ws,project,userId)==0)
            jdbc.update("INSERT INTO access_project_epochs(workspace_id,project_id,user_id,responsibility_epoch) VALUES(?,?,?,1)",ws,project,userId);
    }
    public long projectRevision(Long ws,Long project) {
        var rows=jdbc.queryForList("SELECT revision FROM access_project_generations WHERE workspace_id=? AND project_id=?",Long.class,ws,project);
        return rows.isEmpty()?0:rows.getFirst();
    }
    public void advanceProjectRevision(Long ws,Long project) {
        if(jdbc.update("UPDATE access_project_generations SET revision=revision+1 WHERE workspace_id=? AND project_id=?",ws,project)==0)
            jdbc.update("INSERT INTO access_project_generations(workspace_id,project_id,revision) VALUES(?,?,1)",ws,project);
    }
    public record SubjectProject(Long workspaceId,Long projectId,Long userId) {}
    public java.util.List<SubjectProject> affected(Long ws,Long project,Long userId) {
        String sql="SELECT p.workspace_id,p.id,m.user_id FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id WHERE 1=1";
        var args=new java.util.ArrayList<Object>();
        if(ws!=null){sql+=" AND p.workspace_id=?";args.add(ws);}
        if(project!=null){sql+=" AND p.id=?";args.add(project);}
        if(userId!=null){sql+=" AND m.user_id=?";args.add(userId);}
        return jdbc.query(sql,(rs,n)->new SubjectProject(rs.getLong(1),rs.getLong(2),rs.getLong(3)),args.toArray());
    }
    public void audit(Long actor,Long ws,Long project,Long userId,long revision,String action) {
        jdbc.update("INSERT INTO access_audit(actor_id,workspace_id,project_id,user_id,revision,action,reason_code,created_at) VALUES(?,?,?,?,?,?,'success',CURRENT_TIMESTAMP)",
                actor,ws,project,userId,revision,action);
    }
    public void deleteByProject(Long ws,Long project) {
        for(String table:java.util.List.of("access_policy_scopes","access_capability_defaults","access_member_capabilities","access_project_epochs","access_project_generations"))
            jdbc.update("DELETE FROM "+table+" WHERE workspace_id=? AND project_id=?",ws,project);
    }
    public void deleteByWorkspace(Long ws) {
        for(String table:java.util.List.of("access_policy_scopes","access_capability_defaults","access_member_capabilities","access_project_epochs","access_project_generations","access_members"))
            jdbc.update("DELETE FROM "+table+" WHERE workspace_id=?",ws);
    }
}
