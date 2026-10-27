package com.autumnharvestc.server.execution.materials;

import com.autumnharvestc.server.execution.ExecutionDtos.*;

/**
 * T6 implements this using its single authoritative job/execution/assignment state.
 * It must lock and recheck agentId/jobId/executionId, current project/member rights,
 * snapshot ownership and the persisted required-material selection. Never trust a
 * request's project, snapshot or reference list. No implementation means deny.
 */
public interface AssignedMaterialAuthorizer {
    record AuthorizedMaterials(ExecutionSnapshot snapshot,MaterialSelection selection) {}
    AuthorizedMaterials requireAssigned(long agentId,long jobId,long executionId);
}
