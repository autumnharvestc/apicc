package com.autumnharvestc.server.collaboration.grants;

import com.autumnharvestc.server.store.IdGeneration;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Repository;

@Repository
public class GrantRepo {
    public record Grant(long id,long workspace,long project,long publication,long version,String purpose,String audience,
            long responsible,long responsibilityEpoch,String publicId,byte[] keyHash,long generation,long createdAt,
            long expiresAt,String state,String reason,Long endedAt,boolean downloadAllowed,long revision,String operationIntent) {}
    private final JdbcTemplate jdbc;
    private final IdGeneration ids;
    public GrantRepo(JdbcTemplate jdbc,IdGeneration ids){this.jdbc=jdbc;this.ids=ids;}

    public long create(long ws,long project,long publication,long version,String purpose,String audience,long responsible,
            long epoch,String publicId,byte[] hash,long created,long expires,boolean download,String intent) {
        return insert("collaboration_grants","workspace_id,project_id,publication_id,version,purpose,audience,responsible_id,responsibility_epoch,public_id,key_hash,generation,created_at,expires_at,state,download_allowed,revision,operation_intent",
            ws,project,publication,version,purpose,audience,responsible,epoch,publicId,hash,1,created,expires,"active",download,1,intent);
    }
    public Grant find(long id,boolean locked){return jdbc.query("SELECT * FROM collaboration_grants WHERE id=?"+(locked?" FOR UPDATE":""),(row,index)->row(row),id).stream().findFirst().orElse(null);}
    public Grant publicGrant(String id){return jdbc.query("SELECT * FROM collaboration_grants WHERE public_id=?",(row,index)->row(row),id).stream().findFirst().orElse(null);}
    public long publicationHighWater(long workspace,long project,long publication){return jdbc.queryForObject("SELECT COALESCE(MAX(id),0) FROM collaboration_grants WHERE workspace_id=? AND project_id=? AND publication_id=?",Long.class,workspace,project,publication);}
    public List<Grant> publicationPage(long workspace,long project,long publication,long highWater,long before,int limit){return jdbc.query("SELECT * FROM collaboration_grants WHERE workspace_id=? AND project_id=? AND publication_id=? AND id<=? AND id<? ORDER BY id DESC FETCH FIRST ? ROWS ONLY",(row,index)->row(row),workspace,project,publication,highWater,before,limit);}
    public record Operation(long id,long actor,long grant,String command,String fingerprint,long revision,long generation){}
    public Operation operation(long ws,long project,String intent){return jdbc.query("SELECT id,actor_id,grant_id,command,fingerprint,revision,generation FROM collaboration_grant_operations WHERE workspace_id=? AND project_id=? AND operation_intent=?",
        (row,index)->new Operation(row.getLong(1),row.getLong(2),row.getLong(3),row.getString(4),row.getString(5),row.getLong(6),row.getLong(7)),ws,project,intent).stream().findFirst().orElse(null);}
    public long operation(long ws,long project,String intent,long actor,long grant,String command,String fingerprint,long revision,long generation){
        return insert("collaboration_grant_operations","workspace_id,project_id,operation_intent,actor_id,grant_id,command,fingerprint,revision,generation",ws,project,intent,actor,grant,command,fingerprint,revision,generation);
    }
    public void rotate(long id,byte[] hash,String intent){jdbc.update("UPDATE collaboration_grants SET key_hash=?,generation=generation+1,revision=revision+1,operation_intent=? WHERE id=?",hash,intent,id);}
    public void inactivate(long id,String reason,long ended){jdbc.update("UPDATE collaboration_grants SET state='inactive',reason=?,ended_at=?,revision=CASE WHEN revision<9007199254740991 THEN revision+1 ELSE revision END WHERE id=? AND state='active'",reason,ended,id);}
    public record Scope(long workspace,long project) implements Comparable<Scope>{
        @Override public int compareTo(Scope other){int first=Long.compare(workspace,other.workspace);return first==0?Long.compare(project,other.project):first;}
    }
    public List<Scope> scopes(long workspace,Long project){
        String where=workspace==0?"":" AND workspace_id=?"+(project==null?"":" AND project_id=?");
        Object[] args=workspace==0?new Object[0]:project==null?new Object[]{workspace}:new Object[]{workspace,project};
        return jdbc.query("SELECT DISTINCT workspace_id,project_id FROM collaboration_grants WHERE state='active'"+where+" ORDER BY workspace_id,project_id",(r,i)->new Scope(r.getLong(1),r.getLong(2)),args);
    }
    public List<Grant> activePage(long ws,long project,long after){return jdbc.query("SELECT * FROM collaboration_grants WHERE workspace_id=? AND project_id=? AND state='active' AND id>? ORDER BY id FETCH FIRST 200 ROWS ONLY",(r,i)->row(r),ws,project,after);}
    public List<Grant> expiredPage(long workspace,long project,Long publication,long now,int limit){
        String target=publication==null?"":" AND publication_id=?";
        var args=new ArrayList<Object>(List.of(workspace,project,now));
        if(publication!=null)args.add(publication);
        args.add(limit);
        return jdbc.query("SELECT * FROM collaboration_grants WHERE workspace_id=? AND project_id=? AND state='active' AND expires_at<=?"+target+" ORDER BY id FETCH FIRST ? ROWS ONLY FOR UPDATE",
            (row,index)->row(row),args.toArray());
    }
    public boolean applied(String digest,long occurredAt){
        var previous=jdbc.queryForList("SELECT digest FROM collaboration_deployment_policy_applied WHERE id=1",String.class).stream().findFirst().orElse(null);
        if(jdbc.update("UPDATE collaboration_deployment_policy_applied SET digest=?,applied_at=? WHERE id=1",digest,occurredAt)==0)
            jdbc.update("INSERT INTO collaboration_deployment_policy_applied(id,digest,applied_at) VALUES(1,?,?)",digest,occurredAt);
        return !Objects.equals(previous,digest);
    }
    public long activeExternal(Long ws,Long project,long now){
        String scope=ws==null?"":" AND workspace_id=? AND project_id=?";
        return jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_grants WHERE audience='external' AND state='active' AND expires_at>?"+scope,Long.class,ws==null?new Object[]{now}:new Object[]{now,ws,project});
    }
    private Grant row(ResultSet r)throws SQLException {
        return new Grant(r.getLong("id"),r.getLong("workspace_id"),r.getLong("project_id"),r.getLong("publication_id"),r.getLong("version"),r.getString("purpose"),r.getString("audience"),
            r.getLong("responsible_id"),r.getLong("responsibility_epoch"),r.getString("public_id"),r.getBytes("key_hash"),r.getLong("generation"),r.getLong("created_at"),r.getLong("expires_at"),
            r.getString("state"),r.getString("reason"),r.getObject("ended_at",Long.class),r.getBoolean("download_allowed"),r.getLong("revision"),r.getString("operation_intent"));
    }
    private long insert(String table,String columns,Object... values) {
        String marks=String.join(",",Collections.nCopies(values.length,"?"));
        if(ids.appAssigned()){
            long id=ids.nextId();var args=new ArrayList<Object>();args.add(id);args.addAll(Arrays.asList(values));
            jdbc.update("INSERT INTO "+table+"(id,"+columns+") VALUES(?,"+marks+")",args.toArray());return id;
        }
        var key=new GeneratedKeyHolder();
        jdbc.update(connection->{var statement=connection.prepareStatement("INSERT INTO "+table+"("+columns+") VALUES("+marks+")",new String[]{"id"});
            for(int i=0;i<values.length;i++)statement.setObject(i+1,values[i]);return statement;},key);
        return Objects.requireNonNull(key.getKey()).longValue();
    }
}
