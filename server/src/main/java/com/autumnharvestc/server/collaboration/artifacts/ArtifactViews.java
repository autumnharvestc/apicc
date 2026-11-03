package com.autumnharvestc.server.collaboration.artifacts;

import com.autumnharvestc.server.access.Capability;
import com.autumnharvestc.server.core.Role;
import com.autumnharvestc.server.core.AclRole;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;

/** Artifact bodies are exclusively the strict generated Core PublicArtifactDto contract, not arbitrary objects. */
public final class ArtifactViews {
    private ArtifactViews() {}
    public record Preview(String id,String state,String candidateDigest,long expectedPolicyRevision,String expiresAt,JsonNode artifact,ArtifactConstraints.Preview constraints) {}
    public record Publication(String id,long version,String digest,String kind,String trust,String createdBy,String createdAt,JsonNode artifact,long revision,boolean enabled,RemainingViews.Source source) {}
    public record Metadata(String id,long version,String digest,String kind,String trust,String createdAt) {}
    public record Page(List<Metadata> items) {public Page{items=List.copyOf(items);}}
    public record Operation(String publicationIntentId,String state,String publicationId,String candidateDigest) {}
    public record ReportIdentity(String jobId,String executionId,String agentId,String creatorId,String snapshotId) {}
    public record UploadIdentity(String uploadId,String uploadedBy) {}
    public record MemberClaim(String kind,String revision,String digest) {}
    public record Source(String kind,String revision,String digest,JsonNode scope,ReportIdentity report,UploadIdentity upload,MemberClaim claim) {
        public Source(String kind,String revision,String digest,JsonNode scope,ReportIdentity report){this(kind,revision,digest,scope,report,null,null);}
    }
    public record AccessIdentity(long accountRevision,long workspaceMemberRevision,long projectMemberRevision,long workspacePolicyRevision,long projectPolicyRevision,
            long projectGeneration,long membershipEpoch,long responsibilityEpoch,boolean accountEnabled,boolean member,Role workspaceRole,AclRole overrideRole,String overrideState,Role effectiveRole,List<Capability> capabilities) {
        public AccessIdentity{capabilities=List.copyOf(capabilities);}
    }
}
