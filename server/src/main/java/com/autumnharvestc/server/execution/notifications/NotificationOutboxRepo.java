package com.autumnharvestc.server.execution.notifications;
import java.time.*;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Repository;
import com.autumnharvestc.server.store.IdGeneration;
@Repository
public class NotificationOutboxRepo {
    private final JdbcTemplate jdbc;private final IdGeneration ids;
    public NotificationOutboxRepo(JdbcTemplate jdbc,IdGeneration ids){this.jdbc=jdbc;this.ids=ids;}
    public long insert(long event,long ws,long project,long channel,long version,String body,String hash,String limits,Instant deadline,Instant now){
        var args=new ArrayList<Object>();if(ids.appAssigned())args.add(ids.nextId());args.addAll(List.of(event,ws,project,channel,version,body,hash,limits,utc(deadline),utc(now),utc(now)));
        String sql="INSERT INTO execution_notification_outbox("+(ids.appAssigned()?"id,":"")+"event_id,workspace_id,project_id,channel_id,channel_version,body_json,body_hash,limits_json,deadline_utc,next_attempt_at,updated_at) VALUES("+(ids.appAssigned()?"?,":"")+"?,?,?,?,?,?,?,?,?,?,?)";
        var key=new GeneratedKeyHolder();jdbc.update(c->{var s=c.prepareStatement(sql,new String[]{"id"});for(int i=0;i<args.size();i++)s.setObject(i+1,args.get(i));return s;},key);return ids.appAssigned()?((Number)args.getFirst()).longValue():Objects.requireNonNull(key.getKey()).longValue();
    }
    public record Row(long id,long event,long workspace,long project,long channel,long version,String body,String hash,String limits,String state,int attempts,String owner,String token,Instant leaseUntil,Instant deadline,Instant next){}
    public Optional<Row> find(long id,boolean lock){return jdbc.query("SELECT * FROM execution_notification_outbox WHERE id=?"+(lock?" FOR UPDATE":""),(r,n)->new Row(r.getLong("id"),r.getLong("event_id"),r.getLong("workspace_id"),r.getLong("project_id"),r.getLong("channel_id"),r.getLong("channel_version"),r.getString("body_json"),r.getString("body_hash"),r.getString("limits_json"),r.getString("state"),r.getInt("attempts"),r.getString("owner_id"),r.getString("lease_token"),value(r.getObject("lease_until_utc",OffsetDateTime.class)),value(r.getObject("deadline_utc",OffsetDateTime.class)),value(r.getObject("next_attempt_at",OffsetDateTime.class))),id).stream().findFirst();}
    public long pending(Long ws,Long project){String where=ws==null?"":project==null?" AND workspace_id=?":" AND workspace_id=? AND project_id=?";return jdbc.queryForObject("SELECT COUNT(*) FROM execution_notification_outbox WHERE state IN ('pending','sending')"+where,Long.class,ws==null?new Object[]{}:project==null?new Object[]{ws}:new Object[]{ws,project});}
    public long active(Instant now){return jdbc.queryForObject("SELECT COUNT(*) FROM execution_notification_outbox WHERE state='sending' AND lease_until_utc>? AND deadline_utc>?",Long.class,utc(now),utc(now));}
    public List<Long> due(Instant now,int limit){return jdbc.query("SELECT id FROM execution_notification_outbox WHERE (state='pending' AND next_attempt_at<=?) OR (state='sending' AND (lease_until_utc<=? OR deadline_utc<=?)) ORDER BY id LIMIT ?",(r,n)->r.getLong(1),utc(now),utc(now),utc(now),limit);}
    public Row take(Row row,String owner,String token,Instant until,Instant now){jdbc.update("UPDATE execution_notification_outbox SET state='sending',attempts=attempts+1,owner_id=?,lease_token=?,lease_until_utc=?,updated_at=? WHERE id=?",owner,token,utc(until),utc(now),row.id());return find(row.id(),false).orElseThrow();}
    public void terminal(long id,String state,String reason,Integer status,Instant now){jdbc.update("UPDATE execution_notification_outbox SET state=?,reason_code=?,http_status=?,next_attempt_at=NULL,owner_id=NULL,lease_token=NULL,lease_until_utc=NULL,updated_at=? WHERE id=?",state,reason,status,utc(now),id);}
    public void complete(Row claim,String state,String reason,Integer status,Instant next,Instant now){
        jdbc.update("UPDATE execution_notification_outbox SET state=?,reason_code=?,http_status=?,next_attempt_at=?,owner_id=NULL,lease_token=NULL,lease_until_utc=NULL,updated_at=? WHERE id=? AND event_id=? AND channel_id=? AND channel_version=? AND state='sending' AND owner_id=? AND lease_token=? AND lease_until_utc=? AND lease_until_utc>? AND body_hash=? AND EXISTS(SELECT 1 FROM execution_notification_channels c WHERE c.id=execution_notification_outbox.channel_id AND c.workspace_id=execution_notification_outbox.workspace_id AND c.version=execution_notification_outbox.channel_version AND c.enabled=TRUE AND c.deleted=FALSE)",state,reason,status,next==null?null:utc(next),utc(now),claim.id(),claim.event(),claim.channel(),claim.version(),claim.owner(),claim.token(),utc(claim.leaseUntil()),utc(now),claim.hash());
    }
    public void stopChannel(long channel,long version,Instant now){jdbc.update("UPDATE execution_notification_outbox SET state='stopped',reason_code='channel-changed',next_attempt_at=NULL,owner_id=NULL,lease_token=NULL,lease_until_utc=NULL,updated_at=? WHERE channel_id=? AND channel_version=? AND state IN ('pending','sending')",utc(now),channel,version);}
    public record DeliveryView(String id,String channelId,String channelVersion,String state,String reasonCode,int attempts,Integer status,String deadlineUtc,String nextAttemptAtUtc){}
    public List<DeliveryView> views(long event){return jdbc.query("SELECT * FROM execution_notification_outbox WHERE event_id=? ORDER BY id",(r,n)->new DeliveryView(r.getString("id"),r.getString("channel_id"),r.getString("channel_version"),r.getString("state"),r.getString("reason_code"),r.getInt("attempts"),(Integer)r.getObject("http_status"),r.getObject("deadline_utc",OffsetDateTime.class).toInstant().toString(),instant(r.getObject("next_attempt_at",OffsetDateTime.class))),event);}
    static Instant value(OffsetDateTime t){return t==null?null:t.toInstant();}
    static String instant(OffsetDateTime t){return t==null?null:t.toInstant().toString();}
    static OffsetDateTime utc(Instant t){return t.atOffset(ZoneOffset.UTC);}
}
