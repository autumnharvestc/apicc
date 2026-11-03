package com.autumnharvestc.server.collaboration.artifacts;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;

/** Finite body variants: a compiled plan is not a PublicArtifactDto with a fabricated mock tag. */
public final class RemainingViews {
    private RemainingViews(){}
    public record Source(String kind,String revision,String digest,String uploadId,String jobId,String uploadedBy) {}
    public sealed interface Preview permits MemberPreview,MockPreview {}
    public record MemberPreview(String id,String state,String candidateDigest,long expectedPolicyRevision,String expiresAt,JsonNode artifact,ArtifactConstraints.Preview constraints) implements Preview {}
    public record MockPreview(String id,String state,String candidateDigest,long expectedPolicyRevision,String expiresAt,JsonNode plan,Source source,String planFingerprint,ArtifactConstraints.Preview constraints) implements Preview {}
    public sealed interface Publication permits MemberPublication,MockPublication {String id();}
    public record MemberPublication(String id,long version,String digest,String kind,String trust,String createdBy,String createdAt,long revision,boolean enabled,Source source,JsonNode artifact) implements Publication {}
    public record MockPublication(String id,long version,String digest,String kind,String trust,String createdBy,String createdAt,long revision,boolean enabled,Source source,JsonNode plan,String planFingerprint) implements Publication {}
    public record Confirmation(Publication publication,boolean replay) {}
    public record PublicationMetadata(String id,long version,String digest,String kind,String trust,String createdBy,String createdAt,long revision,boolean enabled,Source source,long policyRevision) {}
    public record PublicationPage(List<PublicationMetadata> items,String nextCursor) {public PublicationPage{items=List.copyOf(items);}}
    public record RuntimeProof(String origin,String runtimeCompatibilityId,String executionProfile,String policyRevision,String coreBuildId,String scriptApiId,String nodeVersion,String v8Version) {}
    public enum ConclusionOrigin {
        TERMINAL_INDEX("terminal-index"),MEMBER_CLAIM("member-claim"),NOT_ENDED("not-ended"),LEGACY_UNINDEXED("legacy-unindexed");
        private final String code;ConclusionOrigin(String code){this.code=code;}@com.fasterxml.jackson.annotation.JsonValue public String code(){return code;}
    }
    public enum ConclusionReason {
        NOT_ENDED("not-ended","任务尚未结束"),LEGACY_UNINDEXED("legacy-unindexed","旧任务未建立终态索引");
        private final String code,description;ConclusionReason(String code,String description){this.code=code;this.description=description;}@com.fasterxml.jackson.annotation.JsonValue public String code(){return code;}public String description(){return description;}
    }
    public record ConclusionProof(ConclusionOrigin origin,ConclusionReason reasonCode,String reason) {}
    public record HistoryMetadata(String id,String source,String kind,String trust,String createdBy,String createdAt,String conclusion,String state,String integrity,String jobId,String executionId,String agentId,String creatorId,String snapshotId,RuntimeProof runtime,ConclusionProof conclusionInfo) {}
    public record HistoryPage(List<HistoryMetadata> items,String nextCursor) {public HistoryPage{items=List.copyOf(items);}}
    public record HistoryBody(String id,String source,JsonNode artifact) {}
}
