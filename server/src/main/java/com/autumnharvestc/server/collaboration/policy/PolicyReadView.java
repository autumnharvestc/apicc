package com.autumnharvestc.server.collaboration.policy;

import com.fasterxml.jackson.annotation.*;
import java.math.BigDecimal;
import java.util.List;
import java.util.Locale;

/** Finite user-facing policy values, distinct from execution-agent policy and runtime secrets. */
public record PolicyReadView(Long revision,Long projectionRevision,List<Setting> settings,Resources resources,Identity identity) {
    public PolicyReadView { settings=List.copyOf(settings); }
    public enum Scope {
        PLATFORM,WORKSPACE,PROJECT;
        @JsonValue public String code(){return name().toLowerCase(Locale.ROOT);}
    }
    public record Lineage(Scope scope,String workspaceId,String projectId,long revision,long projectionRevision) {}
    public record Identity(String deploymentDigest,String effectiveDigest,List<Lineage> lineage) {
        public Identity { lineage=List.copyOf(lineage); }
    }
    public enum Code {
        EXTERNAL_SHARING_ALLOWED("externalSharingAllowed"),HISTORY_PUBLISHING_ALLOWED("historyPublishingAllowed"),SHARED_MOCK_ALLOWED("sharedMockAllowed"),
        DEFAULT_SHARE_DURATION_MS("defaultShareDurationMs"),MAX_SHARE_DURATION_MS("maxShareDurationMs"),EXTERNAL_DOWNLOAD_ALLOWED("externalDownloadAllowed"),
        PREVIEW_TTL_MS("previewTtlMs"),MAX_PREVIEWS_PER_PERSON("maxPreviewsPerPerson"),MAX_PREVIEWS_PER_PROJECT("maxPreviewsPerProject"),MAX_PREVIEWS_GLOBAL("maxPreviewsGlobal"),
        PUBLICATION_OPERATION_TIMEOUT_MS("publicationOperationTimeoutMs"),MAX_SOURCE_BYTES("maxSourceBytes"),MAX_ARTIFACT_BYTES("maxArtifactBytes"),EVIDENCE_ALLOWED("evidenceAllowed"),
        MAX_FIELD_BYTES("maxFieldBytes"),MAX_EVIDENCE_BYTES("maxEvidenceBytes"),MAX_PROJECT_VERSIONS("maxProjectVersions"),MAX_PROJECT_STORAGE_BYTES("maxProjectStorageBytes"),MAX_PROJECT_ACTIVE_GRANTS("maxProjectActiveGrants"),
        INACTIVE_ARTIFACT_RETENTION_MS("inactiveArtifactRetentionMs"),MEMBER_UPLOAD_RETENTION_MS("memberUploadRetentionMs"),MAX_MEMBER_UPLOAD_RECORDS("maxMemberUploadRecords"),DEFAULT_PAGE_SIZE("defaultPageSize"),MAX_PAGE_SIZE("maxPageSize"),
        PUBLIC_READ_RPS("publicReadRps"),PUBLIC_READ_IN_FLIGHT("publicReadInFlight"),MOCK_RPS("mockRps"),MOCK_IN_FLIGHT("mockInFlight"),MAX_MOCK_REQUEST_BYTES("maxMockRequestBytes"),MAX_MOCK_RESPONSE_BYTES("maxMockResponseBytes"),
        MAX_MOCK_DELAY_MS("maxMockDelayMs"),MOCK_CALL_TIMEOUT_MS("mockCallTimeoutMs"),MOCK_LOG_MAX_ENTRIES("mockLogMaxEntries"),MOCK_LOG_RETENTION_MS("mockLogRetentionMs"),
        EXTRA_SENSITIVE_HEADERS("extraSensitiveHeaders"),EXTRA_SENSITIVE_QUERY("extraSensitiveQuery"),EXTRA_SENSITIVE_FIELDS("extraSensitiveFields"),EXTRA_SENSITIVE_POINTERS("extraSensitivePointers"),CORS_ALLOWED_ORIGINS("corsAllowedOrigins"),
        MANAGEMENT_AUDIT_RETENTION_MS("managementAuditRetentionMs"),ACCESS_AUDIT_RETENTION_MS("accessAuditRetentionMs"),CLEANUP_BATCH_SIZE("cleanupBatchSize"),CLEANUP_INTERVAL_MS("cleanupIntervalMs"),RPC_CONNECT_TIMEOUT_MS("rpcConnectTimeoutMs"),RPC_CALL_TIMEOUT_MS("rpcCallTimeoutMs"),
        DEPLOYMENT_MAX_STORAGE_BYTES("deploymentMaxStorageBytes"),DEPLOYMENT_PUBLIC_READ_RPS("deploymentPublicReadRps"),DEPLOYMENT_PUBLIC_READ_IN_FLIGHT("deploymentPublicReadInFlight"),DEPLOYMENT_MOCK_RPS("deploymentMockRps"),DEPLOYMENT_MOCK_IN_FLIGHT("deploymentMockInFlight"),DEPLOYMENT_MAX_ACTIVE_GRANTS("deploymentMaxActiveGrants"),
        NODE_CACHE_BYTES("nodeCacheBytes"),RPC_MAX_MESSAGE_BYTES("rpcMaxMessageBytes");
        private final String code;
        Code(String code){this.code=code;}
        @JsonValue public String code(){return code;}
    }
    public enum Source {
        BUILTIN,DEPLOYMENT,PLATFORM,WORKSPACE,PROJECT,UPPER_CEILING,UNION;
        @JsonValue public String code(){return name().toLowerCase(Locale.ROOT).replace('_','-');}
    }
    public enum Unit {
        BOOLEAN("boolean"),MILLISECONDS("milliseconds"),BYTES("bytes"),COUNT("count"),REQUESTS_PER_SECOND("requests-per-second"),ITEMS("items"),VCPU("vCPU");
        private final String code;Unit(String code){this.code=code;}@JsonValue public String code(){return code;}
    }
    public enum Effect {
        CURRENT_ACCESS_AND_NEW_GRANTS,NEW_PUBLICATIONS,NEW_GRANTS,EACH_DOWNLOAD,NEW_PREVIEWS,NEW_OPERATIONS,
        NEW_PROJECTIONS_AND_EXISTING_GRANT_COMPLIANCE,NEW_PROJECTIONS,NEW_STORAGE_WRITES,NEW_OR_ROTATED_GRANTS,
        ELIGIBLE_CLEANUP,NEW_UPLOADS_AND_RETENTION,EACH_LIST_READ,EACH_ADMISSION,EACH_MOCK_CALL,
        NEW_PLANS_AND_CURRENT_CALLS,NEW_LOG_ENTRIES_AND_CLEANUP,EACH_BROWSER_CALL,AUDIT_CLEANUP,
        NEW_ACCESS_RECORDS_AND_CLEANUP,NEXT_CLEANUP_CYCLE,NEW_RPC_CALLS,RUNTIME_STARTUP;
        @JsonValue public String code(){return name().toLowerCase(Locale.ROOT).replace('_','-');}
    }
    @JsonTypeInfo(use=JsonTypeInfo.Id.NAME,include=JsonTypeInfo.As.PROPERTY,property="valueType")
    @JsonSubTypes({
        @JsonSubTypes.Type(value=BooleanSetting.class,name="boolean"),@JsonSubTypes.Type(value=IntegerSetting.class,name="integer"),
        @JsonSubTypes.Type(value=DecimalSetting.class,name="decimal"),@JsonSubTypes.Type(value=StringListSetting.class,name="string-list")
    })
    public sealed interface Setting permits BooleanSetting,IntegerSetting,DecimalSetting,StringListSetting {Code code();}
    public record BooleanSetting(Code code,Boolean builtin,Boolean local,Boolean effective,Source source,Unit unit,Effect effect) implements Setting {}
    public record IntegerSetting(Code code,Long builtin,Long local,Long effective,Source source,Unit unit,Effect effect,Long minimum,Long maximum) implements Setting {}
    public record DecimalSetting(Code code,BigDecimal builtin,BigDecimal local,BigDecimal effective,Source source,Unit unit,Effect effect,BigDecimal minimum,BigDecimal maximum) implements Setting {}
    public record StringListSetting(Code code,List<String> builtin,List<String> local,List<String> effective,Source source,Unit unit,Effect effect,Integer maxItems,Integer maxItemCodePoints) implements Setting {
        public StringListSetting { builtin=List.copyOf(builtin);local=local==null?null:List.copyOf(local);effective=List.copyOf(effective); }
    }

    public record RecommendedDecimal(BigDecimal value,BigDecimal minimum,BigDecimal maximum,Unit unit) {}
    public record RecommendedBytes(Long value,Long minimum,Long maximum,Unit unit) {}
    public record Recommendations(RecommendedDecimal cpuVcpu,RecommendedBytes totalMemoryBytes,RecommendedBytes nodeHeapBytes) {}
    public enum ConfigurationStatus {
        UNCONFIGURED,CONFIGURED;
        @JsonValue public String code(){return name().toLowerCase(Locale.ROOT);}
    }
    public record ConfiguredDecimal(BigDecimal value,ConfigurationStatus status,Unit unit) {}
    public record ConfiguredBytes(Long value,ConfigurationStatus status,Unit unit) {}
    public record ExternalLimits(ConfiguredDecimal cpuVcpu,ConfiguredBytes totalMemoryBytes) {}
    public record ApplicationSettings(ConfiguredBytes nodeHeapBytes,ConfiguredBytes inFlightBytes,ConfiguredBytes headroomBytes) {}
    public record Resources(Recommendations recommendations,ExternalLimits externalLimits,ApplicationSettings applicationSettings) {}
}
