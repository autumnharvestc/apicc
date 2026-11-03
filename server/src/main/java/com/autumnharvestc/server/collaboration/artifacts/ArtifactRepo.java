package com.autumnharvestc.server.collaboration.artifacts;

import com.autumnharvestc.server.collaboration.policy.PolicyReadView;
import com.autumnharvestc.server.store.IdGeneration;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Repository;
import java.time.Instant;
import java.util.*;
import java.sql.*;

/** Fixed-byte storage. Callers serialize admission with policy/access/project locks; quota/audit remain staged. */
@Repository
public class ArtifactRepo {
    public record Candidate(long id,long workspace,long project,long actor,String state,ArtifactViews.Source source,ArtifactViews.AccessIdentity access,
            PolicyReadView policy,String digest,byte[] body,Instant createdAt,Instant expiresAt,long operationDeadline) {}
    public record Publication(long id,long workspace,long project,long actor,long preview,long version,String intent,String kind,String trust,String digest,byte[] body,Instant createdAt,ArtifactViews.Source source,PolicyReadView policy,long revision,boolean enabled) {}
    public record PublicationHead(long id,long workspace,long project,long actor,long preview,String kind,String digest,long revision,boolean enabled) {}
    private final JdbcTemplate jdbc;private final ObjectMapper json;private final IdGeneration ids;
    public ArtifactRepo(JdbcTemplate jdbc,ObjectMapper json,IdGeneration ids){this.jdbc=jdbc;this.json=json;this.ids=ids;}
    public long addCandidate(long workspace,long project,long actor,ArtifactViews.Source source,ArtifactViews.AccessIdentity access,PolicyReadView policy,String digest,byte[] body,Instant createdAt,Instant expiresAt,long operationDeadline){
        return insert("collaboration_previews","workspace_id,project_id,actor_id,state,source_json,access_json,policy_json,candidate_digest,body,created_at,expires_at,operation_deadline,source_kind",
            new Object[]{workspace,project,actor,"pending",encode(source),encode(access),encode(policy),digest,body,Timestamp.from(createdAt),Timestamp.from(expiresAt),operationDeadline,source.kind()});
    }
    public record PreviewState(long workspace,long project,long actor,String kind,String state,Long receiptRetireAt) {}
    /** Management identity survives body reclamation; old non-Mock rows retain their publication-management domain. */
    public PreviewState previewState(long id){
        return jdbc.query("SELECT workspace_id,project_id,actor_id,COALESCE(source_kind,purpose,'document'),state,receipt_retire_at_epoch_ms FROM collaboration_previews WHERE id=?",
            (row,index)->new PreviewState(row.getLong(1),row.getLong(2),row.getLong(3),row.getString(4),row.getString(5),row.getObject(6,Long.class)),id)
            .stream().findFirst().orElse(null);
    }
    public Candidate candidate(long id,boolean locked){return candidate(id,locked,Long.MAX_VALUE);}
    public Candidate candidate(long id,boolean locked,long maximum){
        return jdbc.query("SELECT * FROM collaboration_previews WHERE id=?"+(locked?" FOR UPDATE":""),(row,index)->new Candidate(row.getLong("id"),row.getLong("workspace_id"),row.getLong("project_id"),row.getLong("actor_id"),row.getString("state"),
            decode(row.getString("source_json"),ArtifactViews.Source.class),decode(row.getString("access_json"),ArtifactViews.AccessIdentity.class),decode(row.getString("policy_json"),PolicyReadView.class),row.getString("candidate_digest"),body(row,maximum),row.getTimestamp("created_at").toInstant(),row.getTimestamp("expires_at").toInstant(),row.getLong("operation_deadline")),id).stream().findFirst().orElse(null);
    }
    public void state(long id,String state){jdbc.update("UPDATE collaboration_previews SET state=? WHERE id=?",state,id);}
    public void terminal(long id,String state,Instant now){jdbc.update("UPDATE collaboration_previews SET state=?,terminal_at_epoch_ms=? WHERE id=?",state,now.toEpochMilli(),id);}
    public void lockProject(long workspace,long project){jdbc.queryForList("SELECT id FROM projects WHERE workspace_id=? AND id=? FOR UPDATE",Long.class,workspace,project);}
    public long publish(Candidate candidate,String intent,Instant now){
        return publish(candidate,intent,now,candidate.source());
    }
    public long publish(Candidate candidate,String intent,Instant now,ArtifactViews.Source source){
        long ws=candidate.workspace(),project=candidate.project();
        if(jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_publication_versions WHERE workspace_id=? AND project_id=?",Long.class,ws,project)==0){Long maximum=jdbc.queryForObject("SELECT MAX(version) FROM collaboration_publications WHERE workspace_id=? AND project_id=?",Long.class,ws,project);jdbc.update("INSERT INTO collaboration_publication_versions(workspace_id,project_id,next_version) VALUES(?,?,?)",ws,project,maximum==null?1:maximum+1);}
        long version=jdbc.queryForObject("SELECT next_version FROM collaboration_publication_versions WHERE workspace_id=? AND project_id=? FOR UPDATE",Long.class,ws,project);jdbc.update("UPDATE collaboration_publication_versions SET next_version=next_version+1 WHERE workspace_id=? AND project_id=?",ws,project);
        var artifact=tree(candidate.body());boolean mock=source.kind().equals("mock");String kind=mock?"mock":artifact.path("kind").asText(),trust=mock?"saved-contract":artifact.at("/source/trust").asText();
        long id=insert("collaboration_publications","workspace_id,project_id,actor_id,preview_id,version,publication_intent_id,kind,trust,digest,body,source_json,policy_json,format_version,created_at,revision,enabled,purpose,source_kind,source_revision,source_digest,source_upload_id,source_uploaded_by,source_job_id,policy_epoch",new Object[]{ws,project,candidate.actor(),candidate.id(),version,intent,kind,trust,candidate.digest(),candidate.body(),encode(source),encode(candidate.policy()),mock?0:artifact.path("formatVersion").asInt(),Timestamp.from(now),1,!mock,source.kind(),source.kind(),source.revision(),source.digest(),source.upload()==null?null:source.upload().uploadId(),source.upload()==null?null:source.upload().uploadedBy(),source.report()==null?null:source.report().jobId(),candidate.policy().projectionRevision()});
        terminal(candidate.id(),"committed",now);return id;
    }
    public Publication publication(long id){return publication(id,Long.MAX_VALUE);}
    public Publication publication(long id,long maximum){return jdbc.query("SELECT * FROM collaboration_publications WHERE id=?",(row,index)->publicationRow(row,maximum),id).stream().findFirst().orElse(null);}
    public Publication publication(long id,long maximum,java.util.function.Consumer<PublicationHead> authorize){return jdbc.query("SELECT * FROM collaboration_publications WHERE id=?",(row,index)->{authorize.accept(head(row));return publicationRow(row,maximum);},id).stream().findFirst().orElse(null);}
    public PublicationHead head(long id,boolean locked){return jdbc.query("SELECT id,workspace_id,project_id,actor_id,preview_id,kind,digest,revision,enabled FROM collaboration_publications WHERE id=?"+(locked?" FOR UPDATE":""),(row,index)->head(row),id).stream().findFirst().orElse(null);}
    private PublicationHead head(ResultSet row)throws SQLException{return new PublicationHead(row.getLong("id"),row.getLong("workspace_id"),row.getLong("project_id"),row.getLong("actor_id"),row.getLong("preview_id"),row.getString("kind"),row.getString("digest"),row.getLong("revision"),row.getBoolean("enabled"));}
    public Publication intent(long workspace,long project,String intent){return intent(workspace,project,intent,Long.MAX_VALUE);}
    public PublicationHead intentHead(long workspace,long project,String intent){
        return jdbc.query("SELECT id,workspace_id,project_id,actor_id,preview_id,kind,digest,revision,enabled FROM collaboration_publications WHERE workspace_id=? AND project_id=? AND publication_intent_id=? ORDER BY id FETCH FIRST 1 ROW ONLY",
            (row,index)->head(row),workspace,project,intent).stream().findFirst().orElse(null);
    }
    public Publication intent(long workspace,long project,String intent,long maximum){return jdbc.query("SELECT * FROM collaboration_publications WHERE workspace_id=? AND project_id=? AND publication_intent_id=? ORDER BY id",(row,index)->publicationRow(row,maximum),workspace,project,intent).stream().findFirst().orElse(null);}
    public List<ArtifactViews.Metadata> list(long workspace,long project){return jdbc.query("SELECT id,version,digest,kind,trust,created_at FROM collaboration_publications WHERE workspace_id=? AND project_id=? ORDER BY id DESC",(row,index)->new ArtifactViews.Metadata(String.valueOf(row.getLong("id")),row.getLong("version"),row.getString("digest"),row.getString("kind"),row.getString("trust"),row.getTimestamp("created_at").toInstant().toString()),workspace,project);}
    private Publication publicationRow(ResultSet row,long maximum)throws SQLException{return new Publication(row.getLong("id"),row.getLong("workspace_id"),row.getLong("project_id"),row.getLong("actor_id"),row.getLong("preview_id"),row.getLong("version"),row.getString("publication_intent_id"),row.getString("kind"),row.getString("trust"),row.getString("digest"),maximum<0?null:body(row,maximum),row.getTimestamp("created_at").toInstant(),decode(row.getString("source_json"),ArtifactViews.Source.class),decode(row.getString("policy_json"),PolicyReadView.class),row.getLong("revision"),row.getBoolean("enabled"));}
    /** Fixed application buffers; completed bytes never escape their owning transaction as a JDBC stream. */
    private byte[] body(ResultSet row,long maximum)throws SQLException{
        try(var input=row.getBinaryStream("body");var output=new java.io.ByteArrayOutputStream()){
            byte[] buffer=new byte[8192];long total=0;int length;
            while((length=input.read(buffer,0,(int)Math.min(buffer.length,maximum==Long.MAX_VALUE?buffer.length:maximum-total+1)))!=-1){total+=length;if(total>maximum)throw new com.autumnharvestc.server.core.ApiException(org.springframework.http.HttpStatus.CONFLICT,"artifact_size_limit","固定版本实际字节超过当前上限");output.write(buffer,0,length);}return output.toByteArray();
        }catch(java.io.IOException problem){throw new SQLException("Cannot read bounded fixed artifact",problem);}
    }
    private long insert(String table,String columns,Object[] parameters){
        var values=new ArrayList<Object>(Arrays.asList(parameters));String marks=String.join(",",Collections.nCopies(values.size(),"?"));
        if(ids.appAssigned()){long id=ids.nextId();values.addFirst(id);jdbc.update("INSERT INTO "+table+"(id,"+columns+") VALUES(?,"+marks+")",values.toArray());return id;}
        var key=new GeneratedKeyHolder();jdbc.update(connection->{var statement=connection.prepareStatement("INSERT INTO "+table+"("+columns+") VALUES("+marks+")",new String[]{"id"});for(int i=0;i<values.size();i++)statement.setObject(i+1,values.get(i));return statement;},key);return Objects.requireNonNull(key.getKey()).longValue();
    }
    private String encode(Object value){try{return json.writeValueAsString(value);}catch(java.io.IOException invalid){throw new IllegalStateException("Cannot encode typed publication storage",invalid);}}
    private <T>T decode(String value,Class<T> type)throws SQLException{try{return json.readValue(value,type);}catch(java.io.IOException invalid){throw new SQLException("Cannot read typed publication storage",invalid);}}
    public com.fasterxml.jackson.databind.JsonNode tree(byte[] value){try{return json.readTree(value);}catch(java.io.IOException invalid){throw new IllegalStateException("Cannot read stored artifact DTO",invalid);}}
}
