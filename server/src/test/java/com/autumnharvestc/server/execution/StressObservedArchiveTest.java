package com.autumnharvestc.server.execution;

import com.autumnharvestc.server.core.Hashes;
import com.autumnharvestc.server.execution.jobs.JobDtos;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import java.util.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class StressObservedArchiveTest extends StressJobsFixture {
    private static final Map<String,Object> OBSERVED=Map.of("completeness","partial","started",1,"exited",1,"peak",1);
    private static final Map<String,Object> LATER=Map.of("completeness","partial","started",2,"exited",2,"peak",2);
    private String startedStress(F f,String intent)throws Exception {
        String job=claimStress(f,intent);send(f,message(job,"accepted","accepted-"+intent)).andExpect(status().isOk());send(f,stressStart(job)).andExpect(status().isOk());return job;
    }
    private byte[] faultEnvelope(String job,Map<String,Object> observation)throws Exception {
        var report=new LinkedHashMap<String,Object>(Map.of("executionId",execution(job),"verdict","failed","executionFact","started","reasonCode","worker-exited"));
        if(observation!=null)report.put("processObservation",observation);return json.writeValueAsBytes(report);
    }
    private Map<String,Object> completed(String job,byte[] bytes,Map<String,Object> observation){
        var value=message(job,"completed","observed-completed");value.putAll(Map.of("verdict","failed","finishedAt","2030-01-01T00:00:00Z","executionReleased",true,"evidenceComplete",false,"reportHash",Hashes.sha256Hex(bytes),"reportBytes",bytes.length));
        if(observation!=null)value.put("processObservation",observation);return value;
    }
    private org.springframework.test.web.servlet.ResultActions upload(F f,String job,byte[] bytes)throws Exception {
        return mvc.perform(put("/api/v1/runner/jobs/"+job+"/report").param("executionId",execution(job)).header("Authorization","Bearer "+f.agentToken()).header("X-Report-Hash",Hashes.sha256Hex(bytes)).contentType("application/octet-stream").content(bytes));
    }
    // Break caught: either protocol order accepts a completion/report pair with a different optional ownership fact.
    @ParameterizedTest @ValueSource(strings={"completed-first:missing-report","completed-first:missing-completion","completed-first:value","upload-first:missing-report","upload-first:missing-completion","upload-first:value"})
    void finalTwoFixesRejectsInconsistentObservationWithoutChangingLastGoodFacts(String scenario)throws Exception {
        var f=configured();String job=startedStress(f,"inconsistent-"+scenario.replace(':','-'));
        var progress=stressProgress(job,1,0);progress.put("processObservation",OBSERVED);send(f,progress).andExpect(status().isOk());
        boolean uploadFirst=scenario.startsWith("upload-first");
        var reportObservation=scenario.endsWith("missing-report")?null:scenario.equals("completed-first:value")?LATER:OBSERVED;
        var completionObservation=scenario.endsWith("missing-completion")?null:scenario.equals("upload-first:value")?LATER:OBSERVED;
        byte[] bytes=faultEnvelope(job,reportObservation);var end=completed(job,bytes,completionObservation);
        if(uploadFirst)upload(f,job,bytes).andExpect(status().isOk());else send(f,end).andExpect(status().isOk());
        var before=jobRepo.require(Long.valueOf(job),false);String metadata=jdbc.queryForObject("SELECT stress_metadata_json FROM execution_jobs WHERE id=?",String.class,Long.valueOf(job));
        var response=(uploadFirst?send(f,end):upload(f,job,bytes)).andReturn().getResponse();
        org.junit.jupiter.api.Assertions.assertAll(
            ()->assertThat(response.getStatus()).isEqualTo(409),
            ()->assertThat(json.readTree(response.getContentAsByteArray()).path("code").asText()).isEqualTo("report_type_mismatch"),
            ()->assertThat(jdbc.queryForObject("SELECT stress_metadata_json FROM execution_jobs WHERE id=?",String.class,Long.valueOf(job))).isEqualTo(metadata),
            ()->assertThat(jobRepo.require(Long.valueOf(job),false).summary()).isEqualTo(before.summary()),
            ()->assertThat(jobRepo.require(Long.valueOf(job),false).reportState()).isEqualTo(before.reportState()),
            ()->assertThat(jobRepo.require(Long.valueOf(job),false).released()).isEqualTo(before.released()));
    }
    // Shape/budget guards are contract regressions, not a new RED attributed to the former coarse whitelist.
    @ParameterizedTest @ValueSource(strings={"extra","fractional","budget","relation","false-complete"})
    void finalTwoFixesKeepsArchiveObservationStrictAndReadOnly(String mutation)throws Exception {
        var f=configured();String job=startedStress(f,"strict-archive-"+mutation);
        var progress=stressProgress(job,1,0);progress.put("processObservation",OBSERVED);send(f,progress).andExpect(status().isOk());
        var invalid=new LinkedHashMap<String,Object>(OBSERVED);
        switch(mutation){case "extra"->invalid.put("private-marker","private payload");case "fractional"->invalid.put("started",1.5);case "budget"->{invalid.put("started",4);invalid.put("peak",4);}case "relation"->invalid.put("exited",2);default->invalid.put("completeness","complete");}
        String metadata=jdbc.queryForObject("SELECT stress_metadata_json FROM execution_jobs WHERE id=?",String.class,Long.valueOf(job));
        var response=upload(f,job,faultEnvelope(job,invalid)).andExpect(status().isBadRequest()).andReturn().getResponse();
        assertThat(response.getContentAsString()).doesNotContain("private-marker","private payload");
        assertThat(jdbc.queryForObject("SELECT stress_metadata_json FROM execution_jobs WHERE id=?",String.class,Long.valueOf(job))).isEqualTo(metadata);
        assertThat(jobRepo.require(Long.valueOf(job),false).reportState()).isEqualTo("pending");
    }
    // Break caught: a real completed envelope is rejected solely because its bounded ownership observation is present.
    @ParameterizedTest @ValueSource(strings={"completed-first","upload-first-partial","legacy-no-observation"})
    void finalTwoFixesArchivesObservedOriginalEnvelopeBytesInBothProtocolOrders(String order)throws Exception {
        var f=configured();var submission=stress(f,"observed-archive-"+order);
        var target=(Map<String,Object>)submission.get("target");var plan=new LinkedHashMap<>((Map<String,Object>)target.get("plan"));
        plan.put("load",Map.of("kind","constant-vus","vus",1));plan.put("maxVus",1);
        submission.put("target",Map.of("kind","stress","plan",plan));
        submission.put("runConfig",Map.of("jobTimeoutMs",60000,"stress",Map.of("workerCount",1,"confirmedTargetOrigins",List.of("https://example.test"))));
        var binding=new LinkedHashMap<>((Map<String,Object>)preparation(submission).get("stressBinding"));
        binding.put("reservation",Map.of("jobs",1,"processes",1,"vus",1,"requestConcurrency",2,"maxRps",1.5,"metricMemoryBytes",1048576));preparation(submission).put("stressBinding",binding);
        String job=body(member(f,post(f.url()+"/jobs"),submission).andExpect(status().isCreated())).path("jobId").asText();
        stressRuntime(f,"stress-session","1");agent(f,post("/api/v1/runner/heartbeat"),new JobDtos.Exchange("stress-session","1",2L,0L,List.of())).andExpect(status().isOk());
        send(f,message(job,"accepted","archive-accepted")).andExpect(status().isOk());send(f,stressStart(job)).andExpect(status().isOk());
        byte[] source;try(var stream=getClass().getResourceAsStream("/execution/stress-observed-agent-envelope.json")){assertThat(stream).isNotNull();source=new String(stream.readAllBytes(),java.nio.charset.StandardCharsets.UTF_8).stripTrailing().getBytes(java.nio.charset.StandardCharsets.UTF_8);}
        assertThat(Hashes.sha256Hex(source)).isEqualTo("4f54a07e7b9da6a43ce70f2d57fee7b87a50a56d90eb22f80e3478221d4d2ad8");
        var envelope=(ObjectNode)json.readTree(source);envelope.put("executionId",execution(job));
        if(order.equals("legacy-no-observation"))envelope.remove("processObservation");
        else if(order.equals("upload-first-partial"))((ObjectNode)envelope.path("processObservation")).put("completeness","partial");
        byte[] bytes=json.writeValueAsBytes(envelope);String hash=Hashes.sha256Hex(bytes);
        var completed=message(job,"completed","observed-archive-completed");completed.putAll(Map.of("verdict","passed","finishedAt","2030-01-01T00:00:00Z","executionReleased",true,"evidenceComplete",true,"reportHash",hash,"reportBytes",bytes.length));
        if(envelope.has("processObservation"))completed.put("processObservation",envelope.get("processObservation"));
        boolean uploadFirst=order.equals("upload-first-partial");
        if(!uploadFirst){send(f,completed).andExpect(status().isOk());assertThat(jobRepo.require(Long.valueOf(job),false).released()).isTrue();assertThat(jobRepo.reserved(Long.valueOf(f.agent()),"result")).isPositive();}
        for(int attempt=0;attempt<2;attempt++)mvc.perform(put("/api/v1/runner/jobs/"+job+"/report").param("executionId",execution(job)).header("Authorization","Bearer "+f.agentToken()).header("X-Report-Hash",hash).contentType("application/octet-stream").content(bytes)).andExpect(status().isOk()).andExpect(jsonPath("$.archived").value(true)).andExpect(jsonPath("$.reportHash").value(hash)).andExpect(jsonPath("$.reportBytes").value(bytes.length));
        if(uploadFirst){assertThat(jobRepo.require(Long.valueOf(job),false).released()).isFalse();send(f,completed).andExpect(status().isOk());}
        send(f,completed).andExpect(status().isOk());
        assertThat(jobRepo.reserved(Long.valueOf(f.agent()),"result")).isZero();
        assertThat(member(f,get("/api/v1/jobs/"+job+"/report"),Map.of()).andExpect(status().isOk()).andReturn().getResponse().getContentAsByteArray()).isEqualTo(bytes);
        assertThat(jobRepo.reportContent(Long.valueOf(job))).isEqualTo(bytes);
        var status=body(member(f,get("/api/v1/jobs/"+job),Map.of()).andExpect(status().isOk()));assertThat(status.path("reportState").asText()).isEqualTo("archived");
        if(envelope.has("processObservation"))assertThat(status.path("stressMetadata").path("processObservation")).isEqualTo(envelope.get("processObservation"));
        else assertThat(status.path("stressMetadata").has("processObservation")).isFalse();
    }
}
