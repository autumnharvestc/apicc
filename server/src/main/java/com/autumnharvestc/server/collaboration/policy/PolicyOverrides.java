package com.autumnharvestc.server.collaboration.policy;

import java.util.List;
import java.util.Map;
import static com.autumnharvestc.server.collaboration.policy.PolicyPatch.*;
import static com.autumnharvestc.server.collaboration.policy.PolicyReadView.*;

/** Finite local storage values. Null is inherited; this record is not an execution-agent policy. */
public record PolicyOverrides(
    Boolean externalSharingAllowed,Boolean historyPublishingAllowed,Boolean sharedMockAllowed,
    Long defaultShareDurationMs,Long maxShareDurationMs,Boolean externalDownloadAllowed,
    Long previewTtlMs,Long maxPreviewsPerPerson,Long maxPreviewsPerProject,Long publicationOperationTimeoutMs,
    Long maxSourceBytes,Long maxArtifactBytes,Boolean evidenceAllowed,Long maxFieldBytes,Long maxEvidenceBytes,
    Long maxProjectVersions,Long maxProjectStorageBytes,Long maxProjectActiveGrants,
    Long inactiveArtifactRetentionMs,Long memberUploadRetentionMs,Long maxMemberUploadRecords,Long defaultPageSize,Long maxPageSize,
    Long publicReadRps,Long publicReadInFlight,Long mockRps,Long mockInFlight,Long maxMockRequestBytes,Long maxMockResponseBytes,
    Long maxMockDelayMs,Long mockCallTimeoutMs,Long mockLogMaxEntries,Long mockLogRetentionMs,
    List<String> extraSensitiveHeaders,List<String> extraSensitiveQuery,List<String> extraSensitiveFields,List<String> extraSensitivePointers,List<String> corsAllowedOrigins,
    Long managementAuditRetentionMs,Long accessAuditRetentionMs,Long cleanupBatchSize,Long cleanupIntervalMs) {
    PolicyOverrides apply(PolicyPatch patch) {
        var changes=patch.changes();
        return new PolicyOverrides(
            bool(changes,Code.EXTERNAL_SHARING_ALLOWED,externalSharingAllowed),bool(changes,Code.HISTORY_PUBLISHING_ALLOWED,historyPublishingAllowed),bool(changes,Code.SHARED_MOCK_ALLOWED,sharedMockAllowed),
            number(changes,Code.DEFAULT_SHARE_DURATION_MS,defaultShareDurationMs),number(changes,Code.MAX_SHARE_DURATION_MS,maxShareDurationMs),bool(changes,Code.EXTERNAL_DOWNLOAD_ALLOWED,externalDownloadAllowed),
            number(changes,Code.PREVIEW_TTL_MS,previewTtlMs),number(changes,Code.MAX_PREVIEWS_PER_PERSON,maxPreviewsPerPerson),number(changes,Code.MAX_PREVIEWS_PER_PROJECT,maxPreviewsPerProject),number(changes,Code.PUBLICATION_OPERATION_TIMEOUT_MS,publicationOperationTimeoutMs),
            number(changes,Code.MAX_SOURCE_BYTES,maxSourceBytes),number(changes,Code.MAX_ARTIFACT_BYTES,maxArtifactBytes),bool(changes,Code.EVIDENCE_ALLOWED,evidenceAllowed),number(changes,Code.MAX_FIELD_BYTES,maxFieldBytes),number(changes,Code.MAX_EVIDENCE_BYTES,maxEvidenceBytes),
            number(changes,Code.MAX_PROJECT_VERSIONS,maxProjectVersions),number(changes,Code.MAX_PROJECT_STORAGE_BYTES,maxProjectStorageBytes),number(changes,Code.MAX_PROJECT_ACTIVE_GRANTS,maxProjectActiveGrants),
            number(changes,Code.INACTIVE_ARTIFACT_RETENTION_MS,inactiveArtifactRetentionMs),number(changes,Code.MEMBER_UPLOAD_RETENTION_MS,memberUploadRetentionMs),number(changes,Code.MAX_MEMBER_UPLOAD_RECORDS,maxMemberUploadRecords),number(changes,Code.DEFAULT_PAGE_SIZE,defaultPageSize),number(changes,Code.MAX_PAGE_SIZE,maxPageSize),
            number(changes,Code.PUBLIC_READ_RPS,publicReadRps),number(changes,Code.PUBLIC_READ_IN_FLIGHT,publicReadInFlight),number(changes,Code.MOCK_RPS,mockRps),number(changes,Code.MOCK_IN_FLIGHT,mockInFlight),number(changes,Code.MAX_MOCK_REQUEST_BYTES,maxMockRequestBytes),number(changes,Code.MAX_MOCK_RESPONSE_BYTES,maxMockResponseBytes),
            number(changes,Code.MAX_MOCK_DELAY_MS,maxMockDelayMs),number(changes,Code.MOCK_CALL_TIMEOUT_MS,mockCallTimeoutMs),number(changes,Code.MOCK_LOG_MAX_ENTRIES,mockLogMaxEntries),number(changes,Code.MOCK_LOG_RETENTION_MS,mockLogRetentionMs),
            strings(changes,Code.EXTRA_SENSITIVE_HEADERS,extraSensitiveHeaders),strings(changes,Code.EXTRA_SENSITIVE_QUERY,extraSensitiveQuery),strings(changes,Code.EXTRA_SENSITIVE_FIELDS,extraSensitiveFields),strings(changes,Code.EXTRA_SENSITIVE_POINTERS,extraSensitivePointers),strings(changes,Code.CORS_ALLOWED_ORIGINS,corsAllowedOrigins),
            number(changes,Code.MANAGEMENT_AUDIT_RETENTION_MS,managementAuditRetentionMs),number(changes,Code.ACCESS_AUDIT_RETENTION_MS,accessAuditRetentionMs),number(changes,Code.CLEANUP_BATCH_SIZE,cleanupBatchSize),number(changes,Code.CLEANUP_INTERVAL_MS,cleanupIntervalMs));
    }
    private static Boolean bool(Map<Code,Change> changes,Code code,Boolean old){var change=changes.get(code);if(change==null)return old;if(change instanceof Inherit)return null;return ((BooleanValue)change).value();}
    private static Long number(Map<Code,Change> changes,Code code,Long old){var change=changes.get(code);if(change==null)return old;if(change instanceof Inherit)return null;return ((IntegerValue)change).value();}
    private static List<String> strings(Map<Code,Change> changes,Code code,List<String> old){var change=changes.get(code);if(change==null)return old;if(change instanceof Inherit)return null;return ((StringListValue)change).value();}
    private Boolean bool(Code code) {
        return switch(code) {
            case EXTERNAL_SHARING_ALLOWED->externalSharingAllowed;case HISTORY_PUBLISHING_ALLOWED->historyPublishingAllowed;case SHARED_MOCK_ALLOWED->sharedMockAllowed;
            case EXTERNAL_DOWNLOAD_ALLOWED->externalDownloadAllowed;case EVIDENCE_ALLOWED->evidenceAllowed;default->null;
        };
    }
    private Long number(Code code) {
        return switch(code) {
            case DEFAULT_SHARE_DURATION_MS->defaultShareDurationMs;case MAX_SHARE_DURATION_MS->maxShareDurationMs;case PREVIEW_TTL_MS->previewTtlMs;
            case MAX_PREVIEWS_PER_PERSON->maxPreviewsPerPerson;case MAX_PREVIEWS_PER_PROJECT->maxPreviewsPerProject;case PUBLICATION_OPERATION_TIMEOUT_MS->publicationOperationTimeoutMs;
            case MAX_SOURCE_BYTES->maxSourceBytes;case MAX_ARTIFACT_BYTES->maxArtifactBytes;case MAX_FIELD_BYTES->maxFieldBytes;case MAX_EVIDENCE_BYTES->maxEvidenceBytes;
            case MAX_PROJECT_VERSIONS->maxProjectVersions;case MAX_PROJECT_STORAGE_BYTES->maxProjectStorageBytes;case MAX_PROJECT_ACTIVE_GRANTS->maxProjectActiveGrants;
            case INACTIVE_ARTIFACT_RETENTION_MS->inactiveArtifactRetentionMs;case MEMBER_UPLOAD_RETENTION_MS->memberUploadRetentionMs;case MAX_MEMBER_UPLOAD_RECORDS->maxMemberUploadRecords;
            case DEFAULT_PAGE_SIZE->defaultPageSize;case MAX_PAGE_SIZE->maxPageSize;case PUBLIC_READ_RPS->publicReadRps;case PUBLIC_READ_IN_FLIGHT->publicReadInFlight;
            case MOCK_RPS->mockRps;case MOCK_IN_FLIGHT->mockInFlight;case MAX_MOCK_REQUEST_BYTES->maxMockRequestBytes;case MAX_MOCK_RESPONSE_BYTES->maxMockResponseBytes;
            case MAX_MOCK_DELAY_MS->maxMockDelayMs;case MOCK_CALL_TIMEOUT_MS->mockCallTimeoutMs;case MOCK_LOG_MAX_ENTRIES->mockLogMaxEntries;case MOCK_LOG_RETENTION_MS->mockLogRetentionMs;
            case MANAGEMENT_AUDIT_RETENTION_MS->managementAuditRetentionMs;case ACCESS_AUDIT_RETENTION_MS->accessAuditRetentionMs;case CLEANUP_BATCH_SIZE->cleanupBatchSize;case CLEANUP_INTERVAL_MS->cleanupIntervalMs;default->null;
        };
    }
    private List<String> strings(Code code) {
        return switch(code) {
            case EXTRA_SENSITIVE_HEADERS->extraSensitiveHeaders;case EXTRA_SENSITIVE_QUERY->extraSensitiveQuery;case EXTRA_SENSITIVE_FIELDS->extraSensitiveFields;
            case EXTRA_SENSITIVE_POINTERS->extraSensitivePointers;case CORS_ALLOWED_ORIGINS->corsAllowedOrigins;default->null;
        };
    }
    List<Setting> view(List<Setting> defaults,Source source) {
        return defaults.stream().map(setting->{
            if(setting instanceof BooleanSetting item){var value=bool(item.code());return value==null?item:new BooleanSetting(item.code(),item.builtin(),value,value,source,item.unit(),item.effect());}
            if(setting instanceof IntegerSetting item){var value=number(item.code());return value==null?item:new IntegerSetting(item.code(),item.builtin(),value,value,source,item.unit(),item.effect(),item.minimum(),item.maximum());}
            if(setting instanceof StringListSetting item){var value=strings(item.code());return value==null?item:new StringListSetting(item.code(),item.builtin(),value,value,source,item.unit(),item.effect(),item.maxItems(),item.maxItemCodePoints());}
            return setting;
        }).toList();
    }
}
