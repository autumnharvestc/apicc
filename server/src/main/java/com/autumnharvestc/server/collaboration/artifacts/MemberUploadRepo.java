package com.autumnharvestc.server.collaboration.artifacts;

import com.autumnharvestc.server.core.Hashes;
import com.autumnharvestc.server.core.ApiException;
import com.autumnharvestc.server.store.IdGeneration;
import java.sql.*;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Repository;
import static org.springframework.http.HttpStatus.*;

/** One actual immutable upload row image; callers own current authority and policy/account/project locks. */
@Repository
public class MemberUploadRepo {
    public record Metadata(long id,long workspace,long project,long actor,String kind,String digest,String conclusion,long createdAt,long expiresAt) {}
    public record Fixed(Metadata metadata,byte[] body) {}
    private final JdbcTemplate jdbc;private final IdGeneration ids;private final CollaborationTime time;
    public MemberUploadRepo(JdbcTemplate jdbc,IdGeneration ids,CollaborationTime time){this.jdbc=jdbc;this.ids=ids;this.time=time;}
    public Fixed fixed(long workspace,long project,long id,long maximum,boolean artifactRead){return jdbc.query("SELECT * FROM collaboration_member_uploads WHERE id=? FOR UPDATE",(row,index)->{
        var metadata=metadata(row);if(metadata.workspace()!=workspace||metadata.project()!=project)throw ArtifactService.error(NOT_FOUND,"history_not_found");
        if(time.now().toEpochMilli()>=metadata.expiresAt())throw ArtifactService.error(GONE,"source_upload_expired");
        byte[] body;try{body=SourceByteBudget.readBinary(row.getBinaryStream("body"),maximum);}catch(ApiException limit){if(artifactRead&&limit.getCode().equals("source_size_limit"))throw ArtifactService.error(CONFLICT,"artifact_size_limit");throw limit;}catch(java.io.IOException problem){throw new SQLException("Cannot acquire bounded member history",problem);}
        if(!Hashes.sha256Hex(body).equals(metadata.digest()))throw ArtifactService.error(CONFLICT,"source_digest_mismatch");return new Fixed(metadata,body);
    },id).stream().findFirst().orElseThrow(()->ArtifactService.error(NOT_FOUND,"history_not_found"));}
    public Metadata metadata(long id,boolean locked){return jdbc.query("SELECT id,workspace_id,project_id,actor_id,kind,digest,conclusion,created_at_epoch_ms,expires_at_epoch_ms FROM collaboration_member_uploads WHERE id=?"+(locked?" FOR UPDATE":""),(row,index)->metadata(row),id).stream().findFirst().orElse(null);}
    private Metadata metadata(ResultSet row)throws SQLException{return new Metadata(row.getLong("id"),row.getLong("workspace_id"),row.getLong("project_id"),row.getLong("actor_id"),row.getString("kind"),row.getString("digest"),row.getString("conclusion"),row.getLong("created_at_epoch_ms"),row.getLong("expires_at_epoch_ms"));}
    public long insert(long ws,long project,long actor,String kind,String digest,String conclusion,byte[] body,long createdAt,long expiresAt){
        Object[] values={ws,project,actor,kind,digest,conclusion,body,createdAt,expiresAt};
        if(ids.appAssigned()){long id=ids.nextId();var args=new ArrayList<Object>();args.add(id);args.addAll(Arrays.asList(values));jdbc.update("INSERT INTO collaboration_member_uploads(id,workspace_id,project_id,actor_id,kind,digest,conclusion,body,created_at_epoch_ms,expires_at_epoch_ms) VALUES(?,?,?,?,?,?,?,?,?,?)",args.toArray());return id;}
        var key=new GeneratedKeyHolder();jdbc.update(connection->{var statement=connection.prepareStatement("INSERT INTO collaboration_member_uploads(workspace_id,project_id,actor_id,kind,digest,conclusion,body,created_at_epoch_ms,expires_at_epoch_ms) VALUES(?,?,?,?,?,?,?,?,?)",new String[]{"id"});for(int i=0;i<values.length;i++)statement.setObject(i+1,values[i]);return statement;},key);return Objects.requireNonNull(key.getKey()).longValue();
    }
}
