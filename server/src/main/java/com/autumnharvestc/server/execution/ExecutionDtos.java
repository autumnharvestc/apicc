package com.autumnharvestc.server.execution;

import java.util.List;
import java.util.Map;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.databind.cfg.*;
import com.fasterxml.jackson.databind.type.LogicalType;
import com.autumnharvestc.server.execution.agent.AgentRepo;
import org.springframework.http.HttpStatus;

public final class ExecutionDtos {
    private ExecutionDtos() {}
    public record AssetChange(String path, String content) {}
    public record AssetDelta(String format, String contractProjectId, String expectedVersion,
                             List<AssetChange> changes, List<String> deletes) {}
    public record AssetFile(String path, String content, String version, String hash, long size) {}
    public record ProjectAssets(String workspaceId, String groupId, String projectId, String format,
                                String contractProjectId, String version, String manifestHash, List<AssetFile> files) {
        public ProjectAssets { files = List.copyOf(files); }
    }
    public record SnapshotRequest(String expectedVersion) {}
    public record ExecutionSnapshot(String snapshotId, String createdByUserId, ProjectAssets assets) {}
    public record AgentCreate(String name) {}
    public record AgentPatch(String name,Boolean acceptingJobs,String expectedVersion,Map<String,Object> config,String expectedPolicyVersion,Map<String,Object> policy) {}
    public record WorkspaceGrants(List<String> workspaceIds) {}
    public record ProjectAllocation(String agentId,List<String> projectIds) {}
    public record ProjectExecutionSettings(String expectedVersion,List<String> agentIds,String defaultAgentId,Map<String,Object> policy) {}
    public record PolicyUpdate(String expectedVersion,Map<String,Object> policy) {}
    public record EnrollmentRequest(String enrollmentToken) {}
    public record CredentialWrite(String expectedVersion,String value) {}
    public record CredentialSelection(String refId,String version) {}
    public record CredentialMetadata(String refId,String version,String status) {}
    public record CredentialValue(String refId,String version,String value) {}
    public record AttachmentWrite(String refId,String expectedVersion,String kind,String contentBase64) {}
    public record AttachmentSelection(String refId,String version,String hash) {}
    public record AttachmentMetadata(String refId,String version,String hash,long size,String kind) {}
    public record AttachmentValue(String refId,String version,String hash,long size,String kind,String contentBase64) {}
    @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
    public record MaterialSelection(String projectId,List<CredentialSelection> credentials,List<AttachmentSelection> attachments,Map<String,AttachmentSelection> attachmentPaths) {
        public MaterialSelection(String projectId,List<CredentialSelection> credentials,List<AttachmentSelection> attachments){this(projectId,credentials,attachments,null);}
    }
    public record MaterialScope(String workspaceId,String groupId,String projectId) {}
    public record ProjectRunMaterials(String snapshotId,MaterialScope scope,List<CredentialValue> credentials,List<AttachmentValue> attachments) {}
    public record AgentMaterialRequest(String executionId) {}
    private static final ObjectMapper CONTROL_JSON=controlJson();
    private static ObjectMapper controlJson(){var mapper=JsonMapper.builder().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES).disable(MapperFeature.ALLOW_COERCION_OF_SCALARS).build();mapper.coercionConfigFor(LogicalType.Textual).setCoercion(CoercionInputShape.Integer,CoercionAction.Fail).setCoercion(CoercionInputShape.Float,CoercionAction.Fail).setCoercion(CoercionInputShape.Boolean,CoercionAction.Fail);return mapper;}
    public static <T> T decode(JsonNode value,Class<T> type){try{if(value==null||!value.isObject())throw new IllegalArgumentException();return CONTROL_JSON.treeToValue(value,type);}catch(Exception e){throw AgentRepo.error(HttpStatus.BAD_REQUEST,"validation_failed","控制字段类型错误或包含未知字段");}}
}
