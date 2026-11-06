import type { SyncPolicyValues } from '@apicc/core/sync/shared';
export const policyFields: { key: keyof SyncPolicyValues; min: number; max: number; unit: 'milliseconds' | 'bytes' | 'days' | 'count' | 'perSource' | 'layers' }[] = [
  { key: 'connectTimeoutMs', min: 1000, max: 60000, unit: 'milliseconds' }, { key: 'urlDeadlineMs', min: 5000, max: 600000, unit: 'milliseconds' }, { key: 'gitDeadlineMs', min: 10000, max: 1800000, unit: 'milliseconds' }, { key: 'maxAttempts', min: 1, max: 3, unit: 'count' },
  { key: 'maxSourceBytes', min: 65536, max: 16 * 1048576, unit: 'bytes' }, { key: 'maxCompareInputBytes', min: 1048576, max: 64 * 1048576, unit: 'bytes' }, { key: 'maxCompareOutputBytes', min: 262144, max: 32 * 1048576, unit: 'bytes' },
  { key: 'maxNormalizeDepth', min: 16, max: 256, unit: 'layers' }, { key: 'maxNormalizeNodes', min: 1000, max: 1000000, unit: 'count' }, { key: 'gitDiskThresholdBytes', min: 32 * 1048576, max: 2147483648, unit: 'bytes' },
  { key: 'projectConcurrency', min: 1, max: 4, unit: 'count' }, { key: 'hostConcurrency', min: 1, max: 16, unit: 'count' }, { key: 'candidateTtlMs', min: 300000, max: 604800000, unit: 'milliseconds' }, { key: 'historyRetentionDays', min: 1, max: 365, unit: 'days' }, { key: 'historyMaxEntries', min: 1, max: 1000, unit: 'perSource' },
];
export const utcTime = (value: number | string | null | undefined) => value == null ? null : Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString().replace('T', ' ').replace('Z', ' UTC') : String(value);
export const shortIdentity = (value: string) => value.length > 16 ? value.slice(0, 12) + '…' : value;
export function readableReason(code: string, t: (key: string) => string, te: (key: string) => boolean) { const key = 'sync.reasons.' + code; return te(key) ? t(key) : `${t('sync.unknownReason')} (${code.slice(0, 96)})`; }
