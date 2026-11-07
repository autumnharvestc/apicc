/** HTTP409 reasons proved to precede the synchronization asset/receipt commit.
 * Candidate freshness comes from requireCurrent; Core resolution/rollback runs
 * before prepareAtomic, and the final policy/pin checks precede commitAtomic.
 * Postcommit unpin/retention, receipt integrity, transport and context errors
 * deliberately have no entry here. Consumers must also check the HTTP status. */
export const onlineWriteRefusalCodes = [
  'source-revision-changed', 'project-assets-changed', 'mapping-revision-changed', 'baseline-revision-changed', 'authorization-changed', 'core-identity-changed', 'candidate-expired',
  'SYNC_CANDIDATE_MISMATCH', 'SYNC_DECISION_REQUIRED', 'SYNC_DECISION_DUPLICATE', 'SYNC_DECISION_UNKNOWN', 'SYNC_DIAGNOSTICS_BLOCKED',
  'SYNC_PROTECTED_REFERENCE', 'SYNC_PROTECTED_LOCAL_ASSET', 'SYNC_CROSS_SOURCE_OWNERSHIP', 'SYNC_MAPPING_DECISION_INVALID', 'SYNC_MAPPING_DECISION_REQUIRED', 'SYNC_MAPPING_KIND_MISMATCH',
  'SYNC_MAPPING_PARENT_MISMATCH', 'SYNC_MAPPING_PARENT_NOT_SELECTED', 'SYNC_MAPPING_TARGET_ACTIVE', 'SYNC_MAPPING_TARGET_AMBIGUOUS', 'SYNC_MAPPING_TARGET_DUPLICATE', 'SYNC_MAPPING_TARGET_UNAVAILABLE',
  'SYNC_ROLLBACK_CURRENT_CHANGED', 'SYNC_ROLLBACK_CONTENT_MISMATCH', 'SYNC_ROLLBACK_HISTORY_MISMATCH', 'SYNC_ROLLBACK_STAMP_MISMATCH', 'sync_policy_changed', 'sync_operation_expired',
] as const;
