import type { AiEvidence, CaseOutcome, EvidenceIdentity } from '@apicc/core';

function canonical(value: unknown): unknown {
  return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;
}
/** Core's native case location only selects a prepare-authorised identity, never a renderer node index or AI path. */
export function caseEvidenceIdentity(evidence: AiEvidence, authorised: readonly AiEvidence[], actualCases: readonly CaseOutcome[]): EvidenceIdentity | undefined {
  const stem = /^cases\[\d+\](?=\.|$)/.exec(evidence.location)?.[0];
  if (!stem) return;
  const identity = authorised.find(item => item.kind === 'execution-identity' && item.state === 'collected' && item.location === `${stem}.evidence.identity`)?.value;
  if (!identity || typeof identity !== 'object') return;
  const key = JSON.stringify(canonical(identity));
  return actualCases.find(row => row.evidence?.identity && JSON.stringify(canonical(row.evidence.identity)) === key)?.evidence?.identity;
}
