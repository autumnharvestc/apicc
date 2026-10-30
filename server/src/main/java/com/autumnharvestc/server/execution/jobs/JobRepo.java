package com.autumnharvestc.server.execution.jobs;

import com.autumnharvestc.server.core.Hashes;
import com.autumnharvestc.server.store.IdGeneration;
import com.fasterxml.jackson.databind.*;
import org.springframework.stereotype.Repository;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import java.sql.*;
import java.time.OffsetDateTime;
import java.util.*;
import static com.autumnharvestc.server.execution.agent.AgentRepo.error;
import static org.springframework.http.HttpStatus.*;

/** Durable business state. HTTP waiters never own assignments or execution state. */
@Repository
public class JobRepo {
    public record ScheduleOrigin(long occurrenceId,long scheduleId,long revision) {
        public ScheduleOrigin {if(occurrenceId<=0||scheduleId<=0||revision<=0)throw new IllegalArgumentException("Scheduling source identity must be positive");}
    }
    public Optional<ScheduleOrigin> scheduleOrigin(long job){return jdbc.query("SELECT schedule_occurrence_id,schedule_id,schedule_revision FROM execution_jobs WHERE id=? AND schedule_occurrence_id IS NOT NULL",(r,n)->new ScheduleOrigin(r.getLong(1),r.getLong(2),r.getLong(3)),job).stream().findFirst();}
    void bindScheduleOrigin(long job,ScheduleOrigin origin){if(jdbc.update("UPDATE execution_jobs SET schedule_occurrence_id=?,schedule_id=?,schedule_revision=? WHERE id=? AND schedule_occurrence_id IS NULL AND schedule_id IS NULL AND schedule_revision IS NULL",origin.occurrenceId(),origin.scheduleId(),origin.revision(),job)!=1)throw new IllegalStateException("Job schedule origin is already fixed");}
    public record Job(long id,long execution,long workspace,long project,long user,long agent,long snapshot,
        String intent,String intentHash,JsonNode submission,JsonNode task,String inputsDigest,
        String state,boolean accepted,String cancelState,boolean released,String permitId,JsonNode permit,
        long sequence,JsonNode progress,JsonNode summary,String reportHash,Long reportBytes,String reportState,
        long inputBytes,long resultBytes,OffsetDateTime queueExpiresAt) {}
    public record Status(long id, long execution, long workspace, long project, long agent, long user,
        String state, String cancelState, boolean released, String reportState,
        JsonNode task, JsonNode progress, JsonNode summary, JsonNode permit,JsonNode stressMetadata,String waitReason,String reportKind,String reportVerdict) {}
    private static final String JOB_COLUMNS = """
        id,execution_id,workspace_id,project_id,submitted_by,agent_id,snapshot_id,
        intent_id,intent_hash,submission_json,task_json,inputs_digest,state,accepted,
        cancel_state,execution_released,permit_id,permit_json,progress_sequence,progress_json,
        summary_json,report_hash,report_bytes,report_state,reserved_input_bytes,
        reserved_result_bytes,queue_expires_at
        """;
    private static final String STATUS_COLUMNS = """
        id,execution_id,workspace_id,project_id,agent_id,submitted_by,state,cancel_state,
        execution_released,report_state,task_json,progress_json,summary_json,permit_json,stress_metadata_json,capacity_wait_reason,report_kind,report_verdict
        """;
    private final JdbcTemplate jdbc;private final ObjectMapper json;private final IdGeneration ids;
    public JobRepo(JdbcTemplate jdbc,ObjectMapper json,IdGeneration ids){this.jdbc=jdbc;this.json=json;this.ids=ids;}
    public long nextId(){
        if(ids.appAssigned())return ids.nextId();
        var key=new GeneratedKeyHolder();jdbc.update(c->c.prepareStatement("INSERT INTO execution_job_ids DEFAULT VALUES",new String[]{"id"}),key);return Objects.requireNonNull(key.getKey()).longValue();
    }
    private Job row(ResultSet r, int index) throws SQLException {
        return new Job(r.getLong("id"), r.getLong("execution_id"), r.getLong("workspace_id"),
            r.getLong("project_id"), r.getLong("submitted_by"), r.getLong("agent_id"), r.getLong("snapshot_id"),
            r.getString("intent_id"), r.getString("intent_hash"), parse(r.getString("submission_json")),
            parse(r.getString("task_json")), r.getString("inputs_digest"), r.getString("state"),
            r.getBoolean("accepted"), r.getString("cancel_state"), r.getBoolean("execution_released"),
            r.getString("permit_id"), parse(r.getString("permit_json")), r.getLong("progress_sequence"),
            parse(r.getString("progress_json")), parse(r.getString("summary_json")), r.getString("report_hash"),
            (Long) r.getObject("report_bytes"), r.getString("report_state"), r.getLong("reserved_input_bytes"),
            r.getLong("reserved_result_bytes"), r.getObject("queue_expires_at", OffsetDateTime.class));
    }
    private Status statusRow(ResultSet r, int index) throws SQLException {
        return new Status(r.getLong("id"), r.getLong("execution_id"), r.getLong("workspace_id"),
            r.getLong("project_id"), r.getLong("agent_id"), r.getLong("submitted_by"), r.getString("state"), r.getString("cancel_state"),
            r.getBoolean("execution_released"), r.getString("report_state"), parse(r.getString("task_json")),
            parse(r.getString("progress_json")), parse(r.getString("summary_json")), parse(r.getString("permit_json")),parse(r.getString("stress_metadata_json")),r.getString("capacity_wait_reason"),r.getString("report_kind"),r.getString("report_verdict"));
    }
    public Optional<Job> find(long job){return jdbc.query("SELECT "+JOB_COLUMNS+" FROM execution_jobs WHERE id=?",this::row,job).stream().findFirst();}
    public Job require(long job,boolean lock){return jdbc.query("SELECT "+JOB_COLUMNS+" FROM execution_jobs WHERE id=?"+(lock?" FOR UPDATE":""),this::row,job).stream().findFirst().orElseThrow(()->error(NOT_FOUND,"job_not_found","任务不存在"));}
    public Optional<Job> intent(long user,long project,String intent){return jdbc.query("SELECT "+JOB_COLUMNS+" FROM execution_jobs WHERE submitted_by=? AND project_id=? AND intent_id=?",this::row,user,project,intent).stream().findFirst();}
    public Status status(long job) {
        return jdbc.query("SELECT " + STATUS_COLUMNS + " FROM execution_jobs WHERE id=?", this::statusRow, job)
            .stream().findFirst().orElseThrow(() -> error(NOT_FOUND,"job_not_found","任务不存在"));
    }
    public List<Status> statuses(long project, int limit, Long before) {
        if (before == null) return jdbc.query("SELECT " + STATUS_COLUMNS
            + " FROM execution_jobs WHERE project_id=? ORDER BY id DESC LIMIT ?", this::statusRow, project, limit);
        return jdbc.query("SELECT " + STATUS_COLUMNS
            + " FROM execution_jobs WHERE project_id=? AND id<? ORDER BY id DESC LIMIT ?", this::statusRow, project, before, limit);
    }
    public List<Job> queued(long agent){return jdbc.query("SELECT "+JOB_COLUMNS+" FROM execution_jobs WHERE agent_id=? AND state='queued' ORDER BY id",this::row,agent);}
    public JsonNode inputs(long job) { return parse(jdbc.queryForObject("SELECT inputs_json FROM execution_jobs WHERE id=?", String.class, job)); }
    public byte[] reportContent(long job) { return jdbc.queryForObject("SELECT report_content FROM execution_jobs WHERE id=?", byte[].class, job); }
    /** Authoritative active references, derived from jobs rather than a second ref-count ledger. */
    public Set<String> activeDebugSessions(long agent) {
        var handles = new HashSet<String>();
        jdbc.query("SELECT task_json FROM execution_jobs WHERE agent_id=? AND state IN ('queued','preparing','running')",
            (org.springframework.jdbc.core.RowCallbackHandler) r -> {
                var task = parse(r.getString(1));
                if (task.has("debugSessionId")) handles.add(task.get("debugSessionId").asText());
            }, agent);
        return handles;
    }
    public void insert(long job,long execution,long ws,long project,long user,long agent,long snapshot,String intent,String intentHash,Object submission,Object task,Object inputs,String digest,OffsetDateTime expires){jdbc.update("INSERT INTO execution_jobs(id,execution_id,workspace_id,project_id,submitted_by,agent_id,snapshot_id,intent_id,intent_hash,submission_json,task_json,inputs_json,inputs_digest,queue_expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",job,execution,ws,project,user,agent,snapshot,intent,intentHash,encode(submission),encode(task),encode(inputs),digest,expires);}
    public long queuedCount(Long agent,Long project){String sql="SELECT COUNT(*) FROM execution_jobs WHERE state='queued'";var args=new ArrayList<Object>();if(agent!=null){sql+=" AND agent_id=?";args.add(agent);}if(project!=null){sql+=" AND project_id=?";args.add(project);}return count(sql,args.toArray());}
    public long occupied(long agent){return count("SELECT COUNT(*) FROM execution_jobs WHERE agent_id=? AND state IN ('preparing','running') AND execution_released=FALSE",agent);}
    public long sharedOccupied(long agent){return jdbc.query("SELECT task_json FROM execution_jobs WHERE agent_id=? AND state IN ('preparing','running') AND execution_released=FALSE",(r,n)->parse(r.getString(1)),agent).stream().filter(t->t.path("dispatchKind").asText().equals("shared-debug")).count();}
    public long reserved(long agent,String type){return Objects.requireNonNull(jdbc.queryForObject("SELECT COALESCE(SUM("+(type.equals("input")?"reserved_input_bytes":"reserved_result_bytes")+"),0) FROM execution_jobs WHERE agent_id=?",Long.class,agent));}
    public boolean claim(Job job,long inputBytes,long resultBytes){return jdbc.update("UPDATE execution_jobs SET state='preparing',report_state='pending',reserved_input_bytes=?,reserved_result_bytes=? WHERE id=? AND execution_id=? AND agent_id=? AND state='queued' AND cancel_state='none'",inputBytes,resultBytes,job.id(),job.execution(),job.agent())==1;}
    public void accepted(Job j){jdbc.update("UPDATE execution_jobs SET accepted=TRUE WHERE id=? AND execution_id=? AND agent_id=? AND state='preparing'",j.id(),j.execution(),j.agent());ack(j.agent(),List.of(deliveryId(j)));}
    public void permit(Job j,long permit,Object payload){if(jdbc.update("UPDATE execution_jobs SET permit_id=?,permit_json=? WHERE id=? AND execution_id=? AND agent_id=? AND state='preparing' AND permit_id IS NULL AND cancel_state='none'",permit,encode(payload),j.id(),j.execution(),j.agent())!=1)throw error(CONFLICT,"state_conflict","当前状态不允许启动许可");}
    public void started(Job j){if(jdbc.update("UPDATE execution_jobs SET state='running' WHERE id=? AND execution_id=? AND agent_id=? AND state='preparing' AND permit_id IS NOT NULL",j.id(),j.execution(),j.agent())!=1)throw error(CONFLICT,"state_conflict","当前任务未获启动许可或已经结束");}
    public void progress(Job j,long sequence,Object payload){jdbc.update("UPDATE execution_jobs SET progress_sequence=?,progress_json=? WHERE id=? AND execution_id=? AND agent_id=? AND state IN ('preparing','running') AND progress_sequence<?",sequence,encode(payload),j.id(),j.execution(),j.agent(),sequence);}
    public void requestCancel(Job j){jdbc.update("UPDATE execution_jobs SET cancel_state='requested' WHERE id=? AND state IN ('preparing','running') AND cancel_state='none'",j.id());}
    public void end(Job j,Object summary,String hash,Long bytes,boolean cancelled){
        String transfer = j.reportState().equals("archived") ? "archived"
            : !j.state().equals("queued") || hash != null ? "pending" : "none";
        long heldResultBytes = transfer.equals("pending") ? j.resultBytes() : 0;
        int updated = jdbc.update("""
            UPDATE execution_jobs SET state='ended',execution_released=TRUE,summary_json=?,
                report_hash=?,report_bytes=?,report_state=?,cancel_state=?,
                reserved_input_bytes=0,reserved_result_bytes=?
            WHERE id=? AND execution_id=? AND agent_id=? AND state IN ('queued','preparing','running')
            """, encode(summary), hash, bytes, transfer, cancelled ? "confirmed" : j.cancelState(),
            heldResultBytes, j.id(), j.execution(), j.agent());
        if (updated != 1) throw error(CONFLICT,"state_conflict","任务已结束，不能覆盖终态");
        jdbc.update("DELETE FROM execution_stress_reservations WHERE job_id=? AND agent_id=?",j.id(),j.agent());
        jdbc.update("UPDATE execution_job_outbox SET acknowledged=TRUE WHERE job_id=?",j.id());
    }
    public void archive(Job j,String hash,byte[] bytes,OffsetDateTime retainedAt){if(jdbc.update("UPDATE execution_jobs SET report_hash=?,report_bytes=?,report_content=?,report_state='archived',report_retained_at=?,reserved_result_bytes=0 WHERE id=? AND execution_id=? AND agent_id=? AND report_content IS NULL AND report_state<>'expired'",hash,bytes.length,bytes,retainedAt,j.id(),j.execution(),j.agent())!=1)throw error(CONFLICT,"report_conflict","已有不同归档内容");}
    public static String deliveryId(Job j){return "delivery-"+j.id()+"-"+j.execution();}
    public void outbox(long agent,Long job,Long execution,String kind,String message,Object payload){if(count("SELECT COUNT(*) FROM execution_job_outbox WHERE message_id=?",message)==0)jdbc.update("INSERT INTO execution_job_outbox(message_id,agent_id,job_id,execution_id,kind,payload_json) VALUES(?,?,?,?,?,?)",message,agent,job,execution,kind,encode(payload));}
    public List<Map<String,Object>> pending(long agent,String kind){return jdbc.query("SELECT payload_json FROM execution_job_outbox WHERE agent_id=? AND acknowledged=FALSE AND "+(kind.equals("delivery")?"kind='delivery'":"kind<>'delivery'")+" ORDER BY message_id",(r,n)->map(parse(r.getString(1))),agent);}
    public void ack(long agent,List<String> ids){for(String message:ids)jdbc.update("UPDATE execution_job_outbox SET acknowledged=TRUE WHERE message_id=? AND agent_id=?",message,agent);}
    public void redeliverConfig(long agent,String message){jdbc.update("UPDATE execution_job_outbox SET acknowledged=FALSE WHERE agent_id=? AND message_id=? AND kind='apply-config'",agent,message);}
    public String receipt(long agent,String message){return jdbc.query("SELECT payload_hash FROM execution_job_messages WHERE agent_id=? AND message_id=?",(r,n)->r.getString(1),agent,message).stream().findFirst().orElse(null);}
    public void receipt(Job j,String message,String hash){jdbc.update("INSERT INTO execution_job_messages(agent_id,message_id,payload_hash,job_id,execution_id) VALUES(?,?,?,?,?)",j.agent(),message,hash,j.id(),j.execution());}
    public long count(String sql,Object... values){return Objects.requireNonNull(jdbc.queryForObject(sql,Long.class,values));}
    public JsonNode parse(String value){if(value==null)return null;try{return json.readTree(value);}catch(Exception e){throw new IllegalStateException("Invalid durable job metadata",e);}}
    public String encode(Object value){try{return json.writeValueAsString(value);}catch(Exception e){throw new IllegalStateException("Cannot encode durable job metadata",e);}}
    @SuppressWarnings("unchecked") public Map<String,Object> map(JsonNode value){return json.convertValue(value,Map.class);}
    public <T> T decode(JsonNode value,Class<T> type){return com.autumnharvestc.server.execution.ExecutionDtos.decode(value,type);}
    /** Stable object-key ordering; arrays retain business order. No credentials are included. */
    public String digest(Object value){return Hashes.sha256HexUtf8(encode(canonical(json.valueToTree(value))));}
    /** Execution-input compatibility boundary. Kept separate from durable intent/message identities. */
    public String executionInputDigest(Object value){return Hashes.sha256HexUtf8(ExecutionInputDigest.text(json.valueToTree(value)));}
    private JsonNode canonical(JsonNode n){if(n.isObject()){var object=json.createObjectNode();var keys=new TreeSet<String>();n.fieldNames().forEachRemaining(keys::add);for(String key:keys)object.set(key,canonical(n.get(key)));return object;}if(n.isArray()){var array=json.createArrayNode();n.forEach(item->array.add(canonical(item)));return array;}return n;}
}
