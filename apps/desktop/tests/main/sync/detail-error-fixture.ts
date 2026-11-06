import { createOnlineSession } from '../../../src/main/online/session.js';
import { createOnlineClient } from '../../../src/main/online/client.js';
import { handleOnlineSynchronization } from '../../../src/main/online/synchronization.js';
import type { SynchronizationInput } from '../../../src/shared/synchronization.js';
import { candidateView, onlineScope } from '../../renderer/components/sync/fixtures.js';

/** Real authenticated member session and bounded detail request; no native IPC. */
export async function onlineDetailFailure(code: string, status = 409) {
  const requests: string[] = [], candidate = candidateView().candidate;
  const path = `https://control.test/api/v1/workspaces/11/projects/33/sync/candidates/${candidate.id}/changes/${candidate.changes[0]!.changeId}/details?side=source`;
  const fetcher: typeof fetch = async url => {
    if (String(url).endsWith('/auth/login')) return Response.json({ token: 'owned-member', expiresAt: '2027-01-01T00:00:00Z', user: { id: '7', username: 'member', displayName: 'Member', role: 'USER', disabled: false } });
    requests.push(String(url)); if (String(url) !== path) throw Error('Unexpected fixture route');
    return Response.json({ code, message: 'PRIVATE SERVER BODY MUST NOT CROSS IPC' }, { status });
  };
  const session = createOnlineSession({ createClient: (baseUrl, hooks) => createOnlineClient({ baseUrl, fetch: fetcher, onUnauthorized: hooks.onUnauthorized }), tokenStore: { save() {}, load() { return null; }, clear() {} } });
  await session.login({ baseUrl: 'https://control.test', username: 'member', password: 'owned-password' }); session.openWorkspace({ workspaceId: '11', name: 'Owned workspace', myRole: 'EDITOR' });
  const input: SynchronizationInput = { scope: onlineScope, operation: 'detail', request: { formatVersion: 1, candidateId: candidate.id, candidateDigest: candidate.candidateDigest, changeId: candidate.changes[0]!.changeId, side: 'source' } };
  return { input, path, requests, handle: (value: SynchronizationInput = input) => handleOnlineSynchronization({ session, fetch: fetcher }, value) };
}
