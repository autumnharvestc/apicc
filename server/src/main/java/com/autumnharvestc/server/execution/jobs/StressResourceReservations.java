package com.autumnharvestc.server.execution.jobs;

import com.autumnharvestc.server.execution.config.ExecutionConfigService;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import java.math.BigDecimal;
import java.util.*;
import static com.autumnharvestc.server.execution.jobs.JobService.*;
import static com.autumnharvestc.server.execution.agent.AgentRepo.error;
import static org.springframework.http.HttpStatus.CONFLICT;

/** Called only while the existing project -> agent -> policy -> job locks are held.
 * The client supplies the Core result; Java validates authority and reserves that fixed result,
 * never compiles workflows or substitutes the admission ceiling for the actual reservation. */
@Component
public class StressResourceReservations {
    private static final String[] VECTOR={"jobs","processes","vus","requestConcurrency","maxRps","metricMemoryBytes"};
    private static final String[] COLUMNS={"jobs","processes","vus","request_concurrency","max_rps","metric_memory_bytes"};
    private static final String[] CAPS={"maxConcurrentStressJobs","maxStressProcesses","maxStressVus","maxStressRequestConcurrency","maxStressRps","maxStressMetricMemoryBytes"};
    private final JdbcTemplate jdbc;private final ExecutionConfigService configs;private final JobRepo repo;
    public StressResourceReservations(JdbcTemplate jdbc,ExecutionConfigService configs,JobRepo repo){this.jdbc=jdbc;this.configs=configs;this.repo=repo;}
    public static boolean isStress(JobDtos.Submit s){return s.target().path("kind").asText().equals("stress");}
    public void validate(JobDtos.Submit s,Map<String,Object> effective,long agent){
        var b=s.preparation().stressBinding();
        if(!isStress(s)){if(b!=null||s.runConfig().stress()!=null)mismatch();return;}
        var plan=s.target().path("plan");var node=cast(effective.get("agent"));var policy=policy(effective);
        if(b==null||!s.preparation().dispatchKind().equals("dedicated-task")||!s.preparation().requiredCapabilities().containsAll(List.of("task:stress","stress:local-workers-v1","protocol:http")))mismatch();
        if(s.environmentId()!=null&&plan.has("environmentId")&&!s.environmentId().equals(plan.path("environmentId").asText()))mismatch();
        long workers=s.runConfig().stress()==null?1:s.runConfig().stress().path("workerCount").asLong(1);
        long vus=plan.path("maxVus").asLong(1),processes=workers==1?1:workers+1;
        if(workers>number(policy,"maxStressWorkers")||workers>vus||vus>Math.min(number(node,"maxStressVus"),number(policy,"maxStressVus"))||processes>number(node,"maxStressProcesses")||number(node,"maxConcurrentStressJobs")==0)mismatch();
        var admission=b.path("admissionLimits");var r=b.path("reservation");
        equal(admission.path("maxVus"),Math.min(number(node,"maxStressVus"),number(policy,"maxStressVus")));
        var agentSources=cast(configs.agentState(agent).get("sources"));var sources=cast(effective.get("sources"));
        for(String field:List.of("maxRequestConcurrency","maxRps")){
            String cap=field.equals("maxRps")?"maxStressRps":"maxStressRequestConcurrency";
            double n=((Number)node.get(cap)).doubleValue(),p=((Number)policy.get(cap)).doubleValue();
            var requested=plan.get(field);double upper=requested==null?Math.min(n,p):requested.doubleValue();
            if(upper>Math.min(n,p))mismatch();equal(admission.path(field),upper);
            if(requested==null?!b.path("requested").path(field).isNull():!same(b.path("requested").path(field),requested))mismatch();
            String expected=requested!=null?"plan":n<p?"agent."+cap+":"+agentSources.get(cap):"policy."+cap+":"+sources.get("policy."+cap);
            if(!expected.equals(b.path("sources").path(field).asText()))mismatch();
        }
        equal(b.path("numericMemoryBytes"),number(policy,"stressMetricMemoryBytes"));equal(b.path("evidenceMaxSamples"),number(policy,"stressEvidenceMaxSamples"));
        equal(r.path("jobs"),1);equal(r.path("processes"),processes);equal(r.path("vus"),vus);
        equal(r.path("metricMemoryBytes"),processes*number(policy,"stressMetricMemoryBytes"));
        if(r.path("metricMemoryBytes").longValue()>number(node,"maxStressMetricMemoryBytes")||r.path("requestConcurrency").doubleValue()>admission.path("maxRequestConcurrency").doubleValue()||r.path("maxRps").doubleValue()>admission.path("maxRps").doubleValue())mismatch();
    }
    private static boolean same(JsonNode a,JsonNode b){return a.isNumber()&&b.isNumber()&&a.decimalValue().compareTo(b.decimalValue())==0;}
    private static void equal(JsonNode actual,double expected){if(!actual.isNumber()||actual.doubleValue()!=expected)mismatch();}
    private static void mismatch(){throw error(CONFLICT,"stress_binding_mismatch","压测固定声明与当前权威配置、来源或拓扑不符，请重新准备");}
    /** Exact decimal summation avoids overflow and truncation of fractional request rates. */
    public Map<String,Object> capacity(long agent,Map<String,Object> node){
        var used=new BigDecimal[VECTOR.length];Arrays.fill(used,BigDecimal.ZERO);
        jdbc.query("SELECT jobs,processes,vus,request_concurrency,max_rps,metric_memory_bytes FROM execution_stress_reservations WHERE agent_id=?",(org.springframework.jdbc.core.RowCallbackHandler) row->{
            for(int i=0;i<VECTOR.length;i++)used[i]=used[i].add(new BigDecimal(row.getString(COLUMNS[i])));
        },agent);
        var values=new LinkedHashMap<String,Object>();var limits=new LinkedHashMap<String,Object>();var draining=new ArrayList<String>();
        for(int i=0;i<VECTOR.length;i++){var limit=new BigDecimal(node.get(CAPS[i]).toString());values.put(VECTOR[i],used[i]);limits.put(VECTOR[i],limit);if(used[i].compareTo(limit)>0)draining.add(VECTOR[i]);}
        return Map.of("used",values,"limits",limits,"drainingDimensions",draining);
    }
    public String blockingReason(long agent,JsonNode additional,Map<String,Object> node){
        var snapshot=capacity(agent,node);var used=cast(snapshot.get("used"));var limits=cast(snapshot.get("limits"));
        for(String dimension:VECTOR){var total=(BigDecimal)used.get(dimension);if(additional!=null)total=total.add(additional.path(dimension).decimalValue());if(total.compareTo((BigDecimal)limits.get(dimension))>0)return "stress."+dimension;}
        return null;
    }
    /** Scope has already been authorized by JobService; only numbers from the same authority escape. */
    public Map<String,Object> waitProjection(JobRepo.Status job){
        if(job.waitReason()==null||!job.waitReason().startsWith("stress.")||!job.state().equals("queued"))return null;
        String dimension=job.waitReason().substring(7);if(!Arrays.asList(VECTOR).contains(dimension))return null;
        var snapshot=capacity(job.agent(),configs.agentValues(job.agent()));var used=cast(snapshot.get("used"));var limits=cast(snapshot.get("limits"));
        var requested=repo.inputs(job.id()).path("stressBinding").path("reservation").path(dimension);if(!requested.isNumber())requested=repo.require(job.id(),false).submission().path("preparation").path("stressBinding").path("reservation").path(dimension);
        if(!requested.isNumber())return null;
        return Map.of("dimension",dimension,"used",used.get(dimension),"requested",requested.decimalValue(),"limit",limits.get(dimension),"draining",((BigDecimal)used.get(dimension)).compareTo((BigDecimal)limits.get(dimension))>0);
    }
    public void reserve(JobRepo.Job j,JsonNode r){
        jdbc.update("INSERT INTO execution_stress_reservations(job_id,agent_id,jobs,processes,vus,request_concurrency,max_rps,metric_memory_bytes) VALUES(?,?,?,?,?,?,?,?)",j.id(),j.agent(),r.path("jobs").longValue(),r.path("processes").longValue(),r.path("vus").longValue(),r.path("requestConcurrency").longValue(),r.path("maxRps").doubleValue(),r.path("metricMemoryBytes").longValue());
    }
    public void waitReason(JobRepo.Job j,String reason){jdbc.update("UPDATE execution_jobs SET capacity_wait_reason=? WHERE id=? AND state='queued'",reason,j.id());}
    public void fixMetadata(JobRepo.Job j,JsonNode runtime){
        var fixed=repo.inputs(j.id());var reservation=fixed.path("stressBinding").path("reservation");
        var identity=new LinkedHashMap<String,Object>();for(String key:List.of("coreBuildId","scriptApiId","nodeVersion","v8Version","runtimeCompatibilityId"))identity.put(key,runtime.path(key));
        var node=configs.agentValues(j.agent());long jobLimit=number(node,"maxConcurrentJobs"),stressJobLimit=number(node,"maxConcurrentStressJobs");
        long activeOtherJobs=jdbc.queryForObject("SELECT COUNT(*) FROM execution_jobs WHERE agent_id=? AND id<>? AND execution_released=FALSE AND state<>'queued' AND state<>'ended'",Long.class,j.agent(),j.id());
        var hints=jobLimit>1||stressJobLimit>1?List.of(Map.of("code","shared-agent-capacity","jobLimit",jobLimit,"stressJobLimit",stressJobLimit,"activeOtherJobs",activeOtherJobs)):List.of();
        var metadata=Map.of("location",Map.of("kind","agent","agentId",String.valueOf(j.agent())),"executor",fixed.path("stressExecutor"),
            "workerCount",j.submission().path("runConfig").path("stress").path("workerCount").asLong(1),"processes",reservation.path("processes"),"resources",Map.of("requested",reservation,"effective",reservation),"runtime",identity,
            "status",Map.of("preparation","preparing","execution","pending","upload","pending"),"contentionHints",hints);
        jdbc.update("UPDATE execution_jobs SET stress_metadata_json=? WHERE id=? AND stress_metadata_json IS NULL",repo.encode(metadata),j.id());
    }
    public void status(JobRepo.Job j,String preparation,String execution,String upload){
        var raw=jdbc.queryForObject("SELECT stress_metadata_json FROM execution_jobs WHERE id=?",String.class,j.id());if(raw==null)return;
        var value=(com.fasterxml.jackson.databind.node.ObjectNode)repo.parse(raw);var status=(com.fasterxml.jackson.databind.node.ObjectNode)value.path("status");
        if(preparation!=null)status.put("preparation",preparation);if(execution!=null)status.put("execution",execution);if(upload!=null)status.put("upload",upload);
        jdbc.update("UPDATE execution_jobs SET stress_metadata_json=? WHERE id=?",repo.encode(value),j.id());
    }
    public static void validateObservationShape(JsonNode observation){
        if(!observation.isObject())bad("进程观测必须是对象");
        var fields=new HashSet<String>();observation.fieldNames().forEachRemaining(fields::add);
        if(!fields.equals(Set.of("completeness","started","exited","peak"))||!observation.path("completeness").isTextual()||!Set.of("complete","partial").contains(observation.path("completeness").asText()))bad("进程观测形状无效");
        for(String key:List.of("started","exited","peak")){var count=observation.path(key);if(!count.isIntegralNumber()||!count.canConvertToLong()||count.longValue()<0||count.longValue()>1001)bad("进程观测超出有界计数");}
    }
    /** The same fixed authority validates control facts and archive bytes without rewriting accepted metadata. */
    public void validateObservation(JobRepo.Job job,JsonNode observation){checkedObservation(job,observation);}
    private com.fasterxml.jackson.databind.node.ObjectNode checkedObservation(JobRepo.Job job,JsonNode observation){
        validateObservationShape(observation);
        if(!job.task().path("target").path("kind").asText().equals("stress"))bad("普通任务不接受压测进程观测");
        var raw=jdbc.queryForObject("SELECT stress_metadata_json FROM execution_jobs WHERE id=?",String.class,job.id());if(raw==null)bad("压测固定执行身份缺失");
        var value=(com.fasterxml.jackson.databind.node.ObjectNode)repo.parse(raw);long started=observation.path("started").longValue(),exited=observation.path("exited").longValue(),peak=observation.path("peak").longValue(),budget=value.path("processes").longValue();
        if(started>budget||exited>started||peak>started||observation.path("completeness").asText().equals("complete")&&started!=budget)bad("进程观测超出固定预算或冒充完整拓扑");
        var previous=value.get("processObservation");if(previous!=null){for(String key:List.of("started","exited","peak"))if(observation.path(key).longValue()<previous.path(key).longValue())bad("进程观测累计值倒退");if(previous.path("completeness").asText().equals("complete")&&!observation.path("completeness").asText().equals("complete"))bad("完整进程观测不可倒退");}
        return value;
    }
    public void observation(JobRepo.Job job,JsonNode observation){
        var value=checkedObservation(job,observation);value.set("processObservation",observation.deepCopy());
        jdbc.update("UPDATE execution_jobs SET stress_metadata_json=? WHERE id=?",repo.encode(value),job.id());
    }
}
