package com.autumnharvestc.server.execution.materials;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import java.util.*;

@Repository
public class JdbcProjectCredentialStore implements ProjectCredentialStore {
    private final JdbcTemplate jdbc;
    public JdbcProjectCredentialStore(JdbcTemplate jdbc){this.jdbc=jdbc;}
    private static final org.springframework.jdbc.core.RowMapper<Envelope> ROW=(r,n)->new Envelope(r.getLong("workspace_id"),r.getLong("project_id"),r.getString("ref_id"),r.getLong("version"),r.getString("key_id"),r.getBytes("nonce"),r.getBytes("ciphertext"));
    public Optional<Envelope> find(long ws,long project,String ref){return jdbc.query("SELECT * FROM execution_project_credentials WHERE workspace_id=? AND project_id=? AND ref_id=?",ROW,ws,project,ref).stream().findFirst();}
    public List<Envelope> list(long ws,long project){return jdbc.query("SELECT * FROM execution_project_credentials WHERE workspace_id=? AND project_id=? ORDER BY ref_id",ROW,ws,project);}
    /** Caller holds the real project row lock, also covering absent-reference creation. */
    public void save(Envelope row){
        if(jdbc.update("UPDATE execution_project_credentials SET version=?,key_id=?,nonce=?,ciphertext=? WHERE workspace_id=? AND project_id=? AND ref_id=?",row.version(),row.keyId(),row.nonce(),row.ciphertext(),row.workspaceId(),row.projectId(),row.refId())==0)
            jdbc.update("INSERT INTO execution_project_credentials(workspace_id,project_id,ref_id,version,key_id,nonce,ciphertext) VALUES(?,?,?,?,?,?,?)",row.workspaceId(),row.projectId(),row.refId(),row.version(),row.keyId(),row.nonce(),row.ciphertext());
    }
}
