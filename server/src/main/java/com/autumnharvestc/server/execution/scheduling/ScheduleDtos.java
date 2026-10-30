package com.autumnharvestc.server.execution.scheduling;

import java.util.*;
import com.fasterxml.jackson.annotation.*;

public final class ScheduleDtos {
    private ScheduleDtos() {}
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Materials(String projectId,List<CredentialBinding> credentials,
        List<com.autumnharvestc.server.execution.ExecutionDtos.AttachmentSelection> attachments,
        Map<String,com.autumnharvestc.server.execution.ExecutionDtos.AttachmentSelection> attachmentPaths) {}
    @JsonInclude(JsonInclude.Include.NON_NULL)
    @com.fasterxml.jackson.databind.annotation.JsonSerialize(using=ExecutionSerializer.class)
    public record Execution(String agentId,String snapshotId,com.fasterxml.jackson.databind.JsonNode target,String environmentId,
        com.autumnharvestc.server.execution.jobs.JobDtos.RunConfig runConfig,Materials materials,
        com.autumnharvestc.server.execution.jobs.JobDtos.Preparation preparation,com.fasterxml.jackson.databind.JsonNode network) {}
    public record Notifications(Boolean inApp,List<String> eventKinds,List<String> channelIds) {}
    /** Preserve the original Job DTO serialization contract; omit absent values only in schedules. */
    public static final class ExecutionSerializer extends com.fasterxml.jackson.databind.JsonSerializer<Execution> {
        private static final com.fasterxml.jackson.databind.ObjectMapper JSON=new com.fasterxml.jackson.databind.ObjectMapper().setSerializationInclusion(JsonInclude.Include.NON_NULL);
        @Override public void serialize(Execution e,com.fasterxml.jackson.core.JsonGenerator generator,com.fasterxml.jackson.databind.SerializerProvider provider)throws java.io.IOException {
            var fields=new LinkedHashMap<String,Object>();fields.put("agentId",e.agentId());fields.put("snapshotId",e.snapshotId());fields.put("target",e.target());fields.put("environmentId",e.environmentId());fields.put("runConfig",e.runConfig());fields.put("materials",e.materials());fields.put("preparation",e.preparation());fields.put("network",e.network());generator.writeTree(JSON.valueToTree(fields));
        }
    }
    public record Save(String name,Rule rule,Policies policies,Execution execution,Notifications notifications) {}
    public record Update(String expectedVersion,String name,Rule rule,Policies policies,Execution execution,Notifications notifications,
        Boolean enabled,Boolean reauthorize,Boolean refreshExecution) {}
    public record View(String id,String workspaceId,String projectId,String name,String version,String revision,boolean enabled,
        String subjectUserId,Rule rule,Policies policies,Execution execution,String snapshotVersion,String manifestHash,
        Notifications notifications,String pausedReasonCode,String nextPlannedAtUtc,String cancellationVersion,
        String evaluatedThroughUtc,String lastAdmittedPlannedAtUtc) {}
    public record GrantUpdate(String expectedVersion,List<String> userIds) {}
    @JsonTypeInfo(use=JsonTypeInfo.Id.NAME,property="kind")
    @JsonSubTypes({@JsonSubTypes.Type(value=OnceRule.class,name="once"),@JsonSubTypes.Type(value=CronRule.class,name="cron")})
    public sealed interface Rule permits OnceRule,CronRule { String timeZone(); }
    public record OnceRule(String atUtc,String timeZone) implements Rule {}
    public record CronRule(String expression,String timeZone,String dstOverlap) implements Rule {}
    public record PreviewRequest(Rule rule,String afterUtc) {}
    public record Candidate(String plannedAtUtc,String localTime,String offset) {}
    public record Preview(List<Candidate> candidates,List<String> notices,Map<String,Object> limits) {}
    public record PolicyUpdate(String expectedVersion,Map<String,Object> policy,List<String> resetKeys) {
        public PolicyUpdate(String expectedVersion,Map<String,Object> policy){this(expectedVersion,policy,List.of());}
    }
    public record Policies(@com.fasterxml.jackson.databind.annotation.JsonDeserialize(using=StrictInteger.class) long lateToleranceMs,String misfire,
                           @com.fasterxml.jackson.databind.annotation.JsonDeserialize(using=StrictInteger.class) long catchupWindowMs,String overlap,
                           @com.fasterxml.jackson.databind.annotation.JsonDeserialize(using=StrictInteger.class) long queueTimeoutMs) {
        public Policies {
            SchedulePolicyValues.bounded(lateToleranceMs,"lateToleranceMs",1000,300000);
            SchedulePolicyValues.bounded(catchupWindowMs,"catchupWindowMs",1000,86400000);
            SchedulePolicyValues.bounded(queueTimeoutMs,"queueTimeoutMs",1000,86400000);
            if(!"skip".equals(misfire)&&!"catch-up-one".equals(misfire)||!"skip".equals(overlap)&&!"queue-one".equals(overlap))throw new IllegalArgumentException("Invalid schedule policy enum");
        }
    }
    public static final class StrictInteger extends com.fasterxml.jackson.databind.JsonDeserializer<Long> {
        @Override public Long deserialize(com.fasterxml.jackson.core.JsonParser parser,com.fasterxml.jackson.databind.DeserializationContext context) throws java.io.IOException {
            if(!parser.isExpectedNumberIntToken())return (Long)context.handleUnexpectedToken(Long.class,parser);
            return parser.getLongValue();
        }
    }
    @JsonTypeInfo(use=JsonTypeInfo.Id.NAME,property="mode")
    @JsonSubTypes({@JsonSubTypes.Type(value=CurrentCredentialBinding.class,name="current-at-trigger"),@JsonSubTypes.Type(value=FixedCredentialBinding.class,name="fixed-version")})
    public sealed interface CredentialBinding permits CurrentCredentialBinding,FixedCredentialBinding {String refId();}
    public record CurrentCredentialBinding(String refId) implements CredentialBinding {public CurrentCredentialBinding{reference(refId);}}
    public record FixedCredentialBinding(String refId,String version) implements CredentialBinding {
        public FixedCredentialBinding{reference(refId);com.autumnharvestc.server.execution.agent.AgentRepo.id(version);}
    }
    private static void reference(String refId){if(refId==null||!refId.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,255}"))throw new IllegalArgumentException("Invalid credential reference");}
}
