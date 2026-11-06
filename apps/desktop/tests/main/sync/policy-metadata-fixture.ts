import { createOnlineSession } from '../../../src/main/online/session.js';
import { createOnlineClient } from '../../../src/main/online/client.js';
import { handleOnlineSynchronization } from '../../../src/main/online/synchronization.js';
export async function metadataOnlineAdapter(body: unknown) {
  const fetcher: typeof fetch = async url => {
    if (String(url).endsWith('/auth/login')) return Response.json({ token: 'owned-policy', expiresAt: '2027-01-01T00:00:00Z', user: { id: '7', username: 'member', displayName: 'Member', role: 'USER', disabled: false } });
    if (String(url) !== 'https://control.test/api/v1/workspaces/11/projects/33/sync/policy') throw Error('Unexpected metadata fixture route');
    return Response.json(body);
  };
  const session = createOnlineSession({ createClient: (baseUrl, hooks) => createOnlineClient({ baseUrl, fetch: fetcher, onUnauthorized: hooks.onUnauthorized }), tokenStore: { save() {}, load() { return null; }, clear() {} } });
  await session.login({ baseUrl: 'https://control.test', username: 'member', password: 'owned-password' }); session.openWorkspace({ workspaceId: '11', name: 'Owned workspace', myRole: 'EDITOR' });
  return { handle: (input: Parameters<typeof handleOnlineSynchronization>[1]) => handleOnlineSynchronization({ session, fetch: fetcher }, input) };
}
