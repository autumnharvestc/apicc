import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createIpcDeps } from '../../../src/main/ipc.js';
import { createSession } from '../../../src/main/session.js';
import { createTokenStore } from '../../../src/main/online/tokenStore.js';
import { createOnlineClient } from '../../../src/main/online/client.js';
import { createOnlineStore } from '../../../src/renderer/src/stores/online.js';
import { createMemoryApi } from '../../../src/renderer/src/api/memory.js';
import { IpcChannel } from '../../../src/shared/channels.js';

it.each(['before-resume', 'after-resume'] as const)('G03 renderer dismissal with real IPC, HTTP and token files: old login finishes %s', async order => {
  const directory = await mkdtemp(join(tmpdir(), 'apicc-g03-auth-'));
  let release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), arrived = new Promise<void>(resolve => { started = resolve; });
  const meTokens: string[] = [];
  const initial = { id: '7', username: 'initial', displayName: 'Synthetic initial account' };
  const late = { id: '8', username: 'late', displayName: 'Synthetic late account' };
  const server = createServer(async (request, response) => {
    const send = (status: number, data: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(data)); };
    if (request.url === '/api/v1/auth/login') {
      let body = ''; for await (const chunk of request) body += chunk;
      const { username } = JSON.parse(body) as { username: string };
      if (username === 'late') { started(); await held; }
      send(200, { token: `synthetic-token-${username}`, expiresAt: '2099-01-01T00:00:00Z', user: username === 'late' ? late : initial });
    } else if (request.url === '/api/v1/me') {
      const token = request.headers.authorization ?? ''; meTokens.push(token);
      send(200, token === 'Bearer synthetic-token-late' ? late : initial);
    } else send(404, { code: 'not_found', message: 'Unexpected synthetic endpoint' });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // The real token file implementation is exercised. OS safeStorage is an injected shape,
  // as in tokenStore.test.ts; this does not claim verification of the OS keychain.
  const storage = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(Buffer.from(value).toString('base64')), decryptString: (value: Buffer) => Buffer.from(value.toString(), 'base64').toString() };
  const tokenStore = createTokenStore({ dir: directory, storage });
  const deps = createIpcDeps({ session: createSession(), pickDirectory: async () => '', saveFile: async () => '', online: { fetch, tokenStore, createClient: (url, hooks) => createOnlineClient({ baseUrl: url, fetch, timeoutMs: 5000, onUnauthorized: hooks.onUnauthorized }) } });
  const api = createMemoryApi();
  api.onlineLogin = input => deps.handle(IpcChannel.OnlineLogin, {}, input);
  api.onlineResume = input => deps.handle(IpcChannel.OnlineResume, {}, input);
  const profiles = new Map<string, string>();
  const online = createOnlineStore({ api, storage: { getItem: key => profiles.get(key) ?? null, setItem: (key, value) => { profiles.set(key, value); }, removeItem: key => { profiles.delete(key); }, clear: () => profiles.clear(), key: index => [...profiles.keys()][index] ?? null, get length() { return profiles.size; } } });
  try {
    online.addProfile(baseUrl, 'G03 isolated endpoint'); await online.resume(baseUrl);
    await online.login('initial', 'synthetic-password8'); expect(online.user).toEqual(initial);
    const pending = online.login('late', 'synthetic-password8'); await arrived;
    online.dismissAuthentication();
    if (order === 'before-resume') {
      release(); await pending;
      // A completed main login can be deliberately recovered only by fresh server validation.
      expect(online.user).toEqual(initial); expect(tokenStore.load(baseUrl)).toBe('synthetic-token-late');
      await online.resume(baseUrl); expect(online.user).toEqual(late); expect(meTokens.at(-1)).toBe('Bearer synthetic-token-late');
    } else {
      await online.resume(baseUrl); expect(online.user).toEqual(initial);
      release(); await pending; expect(online.user).toEqual(initial);
      expect(tokenStore.load(baseUrl)).toBe('synthetic-token-initial'); expect(meTokens.at(-1)).toBe('Bearer synthetic-token-initial');
    }
    expect(online.error).toBeNull(); expect(online.submitting).toBe(false);
    expect(JSON.stringify(online.$state)).not.toContain('synthetic-token-');
    expect(createTokenStore({ dir: directory, storage }).load(baseUrl)).toBe(order === 'before-resume' ? 'synthetic-token-late' : 'synthetic-token-initial');
  } finally {
    release(); await deps.stopOnlineExecutions(); await deps.stopMocks(); await deps.stopSynchronization();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
