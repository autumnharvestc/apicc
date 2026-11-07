import { ExecutionHttpError } from '@apicc/execution/client';
import { stat, realpath } from 'node:fs/promises';
import { SynchronizationInputSchema, parseSynchronizationResult, type SynchronizationInput } from '../../shared/synchronization.js';
import type { LocalSync } from './types.js';
import type { ProjectLocator } from '../../shared/locations.js';
import type { createSession } from '../session.js';
import type { createDesktopSyncProviders } from './providers.js';
import { onlineWriteRefusalCodes } from './writeRefusals.js';

const sourceOwners = new Set<string>();
const onlineRefusals = new Set<string>(onlineWriteRefusalCodes);
// These local codes are thrown by Core/coordinator preconditions before its
// atomic commit. Context fences, refresh errors and arbitrary HTTP failures are
// deliberately excluded: an original write may already be durable.
const localRefusals = new Set(['SYNC_CANDIDATE_STALE', 'SYNC_CANDIDATE_NOT_FOUND', 'SYNC_CANDIDATE_DIGEST_MISMATCH', 'SYNC_SOURCE_NOT_FOUND', 'SYNC_HISTORY_NOT_FOUND', 'SYNC_HISTORY_EXPIRED', 'SYNC_ROLLBACK_CURRENT_CHANGED', 'SYNC_ROLLBACK_CONTENT_MISMATCH', 'SYNC_ROLLBACK_HISTORY_MISMATCH', 'SYNC_ROLLBACK_STAMP_MISMATCH', 'SYNC_AUTHORIZATION_CHANGED', 'SYNC_READ_ONLY', 'SYNC_INTENT_MISMATCH', 'SYNC_DECISION_REQUIRED', 'SYNC_DECISION_DUPLICATE', 'SYNC_DECISION_UNKNOWN', 'SYNC_DIAGNOSTICS_BLOCKED', 'SYNC_PROTECTED_REFERENCE', 'SYNC_PROTECTED_LOCAL_ASSET', 'SYNC_CROSS_SOURCE_OWNERSHIP', 'SYNC_MAPPING_DECISION_INVALID', 'SYNC_MAPPING_DECISION_REQUIRED', 'SYNC_MAPPING_KIND_MISMATCH', 'SYNC_MAPPING_PARENT_MISMATCH', 'SYNC_MAPPING_PARENT_NOT_SELECTED', 'SYNC_MAPPING_TARGET_ACTIVE', 'SYNC_MAPPING_TARGET_AMBIGUOUS', 'SYNC_MAPPING_TARGET_DUPLICATE', 'SYNC_MAPPING_TARGET_UNAVAILABLE']);
function writeFailure(error: unknown, local: boolean): Error {
  const code = error instanceof Error ? error.message : '';
  if (local && localRefusals.has(code)) return Error('SYNC_REJECTED:' + code);
  // AuthFilter / requireCapability rejects these finite server business codes
  // before a commit; a status alone is not sufficient evidence.
  if (!local && error instanceof ExecutionHttpError && ((error.status === 403 && error.code === 'forbidden') || (error.status === 401 && error.code === 'unauthorized') || (error.status === 409 && onlineRefusals.has(error.code ?? '')))) return Error('SYNC_REJECTED:' + error.code);
  return Error('SYNC_UNCERTAIN:SYNC_OPERATION_UNKNOWN');
}
export function createSynchronizationHost(deps: {
  session: ReturnType<typeof createSession>;
  local: (root: string, locator: ProjectLocator, locale?: 'zh-CN' | 'en') => Promise<LocalSync>;
  providers?: ReturnType<typeof createDesktopSyncProviders>;
  online?: (input: SynchronizationInput) => Promise<unknown>;
}) {
  const reads = new Map<string, { abort: AbortController; owner: object; completion: Promise<unknown> }>();
  const defaultOwner = {}, activations = new WeakMap<object, { epoch: number; scope: string }>();
  return { async close() { for (const read of reads.values()) read.abort.abort(); await Promise.allSettled([...reads.values()].map(read => read.completion)); },
    async handle(raw: SynchronizationInput, owner?: object): Promise<unknown> {
    const input = SynchronizationInputSchema.parse(raw);
    const sender = owner ?? defaultOwner, scopeKey = JSON.stringify(input.scope);
    if (input.operation === 'activate' || input.operation === 'deactivate') {
      if (input.scope.kind === 'online' && input.operation === 'activate') { if (!deps.online) throw Error('SYNC_HOST_UNAVAILABLE'); await deps.online(input); }
      if (input.scope.kind === 'local' && (input.scope.root !== deps.session.root || deps.session.workspace?.id !== input.scope.locator.workspaceId || !deps.session.locateProject(input.scope.locator))) throw Error('SYNC_CONTEXT_CHANGED');
      const previous = activations.get(sender); activations.set(sender, { epoch: (previous?.epoch ?? 0) + 1, scope: input.operation === 'deactivate' ? '' : scopeKey });
      for (const read of reads.values()) if (read.owner === sender) read.abort.abort();
      return null;
    }
    if (!activations.has(sender)) activations.set(sender, { epoch: 0, scope: scopeKey });
    const selection = activations.get(sender)!;
    const assertSelection = () => { if (activations.get(sender) !== selection || selection.scope !== scopeKey) throw Error('SYNC_CONTEXT_CHANGED'); };
    assertSelection();
    if (input.scope.kind === 'online') { if (!deps.online) throw Error('SYNC_HOST_UNAVAILABLE'); let result: unknown; try { result = await deps.online(input); } catch (error) { if (input.operation === 'apply' || input.operation === 'rollback') throw writeFailure(error, false); throw error; } assertSelection(); return result; }
    const { scope } = input, context = deps.session.captureDraftWriteContext();
    const assertCurrent = () => {
      assertSelection();
      const current = deps.session.captureDraftWriteContext();
      if (scope.root !== current.root || current.generation !== context.generation || deps.session.workspace?.id !== scope.locator.workspaceId || !deps.session.locateProject(scope.locator)) throw Error('SYNC_CONTEXT_CHANGED');
    };
    assertCurrent();
    if (input.operation === 'materials') { if (!deps.providers) throw Error('SYNC_HOST_UNAVAILABLE'); const value = await deps.providers.materials(scope.locator); assertCurrent(); return value; }
    if (input.operation === 'settings') { if (!deps.providers) throw Error('SYNC_HOST_UNAVAILABLE'); const value = await deps.providers.settings(); assertCurrent(); return value; }
    if (input.operation === 'configureTools') { if (!deps.providers) throw Error('SYNC_HOST_UNAVAILABLE'); const value = await deps.providers.configureTool(input.tool, input.locale); assertCurrent(); return value; }
    if (input.operation === 'saveSettings') { if (!deps.providers) throw Error('SYNC_HOST_UNAVAILABLE'); const value = await deps.providers.saveSettings(input); assertCurrent(); return value; }
    const client = await deps.local(scope.root, scope.locator, input.locale), location = scope.locator;
    assertCurrent();
    let result: unknown;
    switch (input.operation) {
      case 'sources': result = await client.sources(location); break;
      case 'saveSource': result = await client.saveSource(location, input.source, input.expectedRevision); break;
      case 'check': {
        if (reads.has(input.intentId)) throw Error('SYNC_CONCURRENCY_LIMIT');
        const physical = await stat(await realpath(scope.root), { bigint: true }), sourceKey = JSON.stringify([physical.dev.toString(), physical.ino.toString(), location.projectId, input.sourceId]);
        assertCurrent(); if (sourceOwners.has(sourceKey)) throw Error('SYNC_SOURCE_BUSY'); sourceOwners.add(sourceKey);
        const abort = new AbortController(), completion = client.check(location, input.sourceId, abort.signal);
        reads.set(input.intentId, { abort, owner: sender, completion });
        let retained = false;
        try { result = await completion; } catch (error) { retained = ['SYNC_PROCESS_UNCOLLECTED', 'SYNC_MATERIAL_RELEASE_FAILED'].includes((error as { code?: string }).code ?? ''); throw error; }
        finally { reads.delete(input.intentId); if (!retained) sourceOwners.delete(sourceKey); }
        break;
      }
      case 'cancel': { const read = reads.get(input.checkId); if (read && read.owner !== sender) throw Error('SYNC_CONTEXT_CHANGED'); read?.abort.abort(); result = null; break; }
      case 'detail': result = await client.detail(location, input.request); break;
      case 'candidate': result = await client.candidate(location, input.candidateId); break;
      case 'apply': try { result = await client.apply(location, { id: input.candidateId, candidateDigest: input.candidateDigest }, input.decisions, input.intentId); } catch (error) { throw writeFailure(error, true); } break;
      case 'rollback': try { result = await client.rollback(location, input.historyId, input.intentId); } catch (error) { throw writeFailure(error, true); } break;
      case 'operation': result = await client.operation(location, input.intentId); break;
      case 'history': result = await client.history(location); break;
      default: throw Error('SYNC_OPERATION_UNAVAILABLE');
    }
    assertCurrent(); return parseSynchronizationResult(input, result);
  } };
}
