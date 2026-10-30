package com.autumnharvestc.server.execution.notifications;

import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Repository;
import com.autumnharvestc.server.store.IdGeneration;

@Repository
public class NotificationChannelRepo {
    private final JdbcTemplate jdbc;private final IdGeneration ids;
    public NotificationChannelRepo(JdbcTemplate jdbc,IdGeneration ids){this.jdbc=jdbc;this.ids=ids;}
    public record Row(long id,long workspace,String name,long version,boolean enabled,boolean deleted,String origin,String keyId,byte[] nonce,byte[] ciphertext,String limits){}
    public long reserve(long ws,String name,boolean enabled,String origin){
        if(ids.appAssigned()){long id=ids.nextId();jdbc.update("INSERT INTO execution_notification_channels(id,workspace_id,name,enabled,origin) VALUES(?,?,?,?,?)",id,ws,name,enabled,origin);return id;}
        var key=new GeneratedKeyHolder();jdbc.update(c->{var s=c.prepareStatement("INSERT INTO execution_notification_channels(workspace_id,name,enabled,origin) VALUES(?,?,?,?)",new String[]{"id"});s.setLong(1,ws);s.setString(2,name);s.setBoolean(3,enabled);s.setString(4,origin);return s;},key);return Objects.requireNonNull(key.getKey()).longValue();
    }
    public void ciphertext(long id,ChannelCipher.Envelope e){jdbc.update("UPDATE execution_notification_channels SET key_id=?,nonce=?,ciphertext=? WHERE id=?",e.keyId(),e.nonce(),e.ciphertext(),id);}
    public Optional<Row> find(long ws,long id,boolean lock){return jdbc.query("SELECT * FROM execution_notification_channels WHERE workspace_id=? AND id=?"+(lock?" FOR UPDATE":""),(r,n)->new Row(r.getLong("id"),r.getLong("workspace_id"),r.getString("name"),r.getLong("version"),r.getBoolean("enabled"),r.getBoolean("deleted"),r.getString("origin"),r.getString("key_id"),r.getBytes("nonce"),r.getBytes("ciphertext"),r.getString("limits_json")),ws,id).stream().findFirst();}
    public List<Row> list(long ws){return jdbc.query("SELECT id FROM execution_notification_channels WHERE workspace_id=? AND deleted=FALSE ORDER BY id",(r,n)->r.getLong(1),ws).stream().map(id->find(ws,id,false).orElseThrow()).toList();}
    public boolean activeVersion(String id,String version){return jdbc.queryForObject("SELECT COUNT(*) FROM execution_notification_channels WHERE id=? AND version=? AND enabled=TRUE AND deleted=FALSE",Long.class,Long.parseLong(id),Long.parseLong(version))==1;}
    public void limits(long id,String limits){jdbc.update("UPDATE execution_notification_channels SET limits_json=? WHERE id=?",limits,id);}
    public void update(Row old,String name,String origin,boolean enabled,boolean deleted,String limits,ChannelCipher.Envelope e){if(jdbc.update("UPDATE execution_notification_channels SET name=?,origin=?,enabled=?,deleted=?,limits_json=?,version=version+1,key_id=?,nonce=?,ciphertext=? WHERE id=? AND workspace_id=? AND version=?",name,origin,enabled,deleted,limits,e.keyId(),e.nonce(),e.ciphertext(),old.id(),old.workspace(),old.version())!=1)throw com.autumnharvestc.server.execution.agent.AgentRepo.error(org.springframework.http.HttpStatus.CONFLICT,"version_conflict","渠道版本已变化");}
}
