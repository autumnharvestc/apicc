package com.autumnharvestc.server.collaboration.artifacts;

import java.time.Instant;

/** Finite storage extension contract, not an admission policy or a grant/log product. */
public final class StorageTypes {
    private StorageTypes() {}
    public enum Kind { PREVIEW,ARTIFACT,POLICY,AUDIT,REFERENCE,UPLOAD,PLAN,LOG,VERSION_COUNTER,WORKSPACE,GRANT,GRANT_OPERATION,APPLIED_POLICY }
    public enum Action { PREVIEW_CREATED,PREVIEW_CANCELLED,PREVIEW_RECLAIMED,ARTIFACT_CREATED,ARTIFACT_RECLAIMED,ARTIFACT_UPDATED,UPLOAD_ACCEPTED,UPLOAD_RECLAIMED,POLICY_UPDATED,REFERENCE_ACQUIRED,REFERENCE_RELEASED,PROJECT_DELETED,WORKSPACE_DELETED,AUDIT_CLEANUP,GRANT_CREATED,GRANT_ROTATED,GRANT_REVOKED,GRANT_INVALIDATED }
    public enum Reason { USER_COMMAND,EXPIRED,INACTIVE,PROJECT_REMOVED }
    public enum OwnerKind { CANDIDATE,ACTIVE_OPERATION,GRANT,UPLOAD,PLAN }
    public record StoredKey(Kind kind,long id) {}
    public record Owner(OwnerKind kind,long id,Instant expiresAt) {
        public static Owner candidate(long id){return new Owner(OwnerKind.CANDIDATE,id,null);}
        public static Owner operation(long id,Instant expiry){return new Owner(OwnerKind.ACTIVE_OPERATION,id,expiry);}
    }
    public record AuditEvent(Action action,Reason reason,Long actorId,long workspaceId,long projectId,Kind objectKind,long objectId,Long revision,long occurredAtEpochMs) {}
    public record Usage(long actualBytes,long reservedAuditBytes,long bodyBytes,long auditBytes,long previewCount,long artifactCount,long pendingPreviews) {
        public long occupiedBytes(){return actualBytes+reservedAuditBytes;}
    }
}
