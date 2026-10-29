package com.autumnharvestc.server.execution.jobs;

import com.autumnharvestc.server.execution.ExecutionDtos.*;
import com.autumnharvestc.server.execution.policy.ScriptGrantService.PreparedScriptRequirement;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.*;

public final class JobDtos {
    private JobDtos() {}
    public record Scope(String workspaceId,String groupId,String projectId) {}
    public record RunConfig(Long jobTimeoutMs,Long scriptTimeoutMs,JsonNode requestSettings,
        @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL) JsonNode stress) {
        public RunConfig {if(stress!=null&&stress.isNull())stress=null;}
    }
    public record Preparation(Scope scope,String manifestHash,String scriptPlanDigest,String scriptGrantVersion,
        List<PreparedScriptRequirement> scriptRequirements,String executionProfile,String dispatchKind,
        String requiredCoreBuildId,List<String> requiredCapabilities,String runtimeCompatibilityId,
        @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL) JsonNode stressBinding) {
        public Preparation {if(stressBinding!=null&&stressBinding.isNull())stressBinding=null;}
    }
    @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
    public record Submit(String intentId,String agentId,String snapshotId,JsonNode target,String environmentId,
        String debugSessionId,RunConfig runConfig,MaterialSelection materials,Preparation preparation,JsonNode network) {
        public Submit { if(network!=null&&network.isNull())network=null; }
    }
    public record Exchange(String sessionId,String appliedConfigVersion,Long availableSlots,
        Long availableSharedDebugSlots,List<String> acknowledgements) {}
    public record Application(String configVersion,String appliedConfigVersion,List<String> pendingFields,List<String> restartRequiredFields,String status) {}
    public record RuntimeRegistration(Long protocolVersion,String sessionId,String coreBuildId,String scriptApiId,
        String nodeVersion,String v8Version,String runtimeCompatibilityId,List<String> capabilities,Application configuration) {}
    public record Batch(List<Map<String,Object>> deliveries,List<Map<String,Object>> commands) {
        public static Batch empty(){return new Batch(List.of(),List.of());}
        @com.fasterxml.jackson.annotation.JsonIgnore
        public boolean isEmpty(){return deliveries.isEmpty()&&commands.isEmpty();}
    }
}
