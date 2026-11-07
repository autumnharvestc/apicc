import { it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createProjectSnapshot } from '@apicc/core';
import { readBuildIdentity } from '@apicc/execution/buildIdentity';
import { createDesktopCredentialHost } from '../../../src/main/credentials.js';
import { createDesktopSyncProviders } from '../../../src/main/sync/providers.js';
import { id, withLocalSync } from './fixtures.js';
import { withGitSource } from '../../../../../packages/execution/tests/sourceHost/git-fixture.mjs';
import type { SyncSource } from '@apicc/core/sync';

type LocalFixture = Parameters<Parameters<typeof withLocalSync>[0]>[0];
function native(f: LocalFixture) {
  const credentials = createDesktopCredentialHost(f.session, { secretStore: f.secrets.store, credentialPrivateRoot: join(f.privateRoot, 'credentials'), networkPrivateRoot: join(f.privateRoot, 'network'), oauthPrivateRoot: join(f.privateRoot, 'oauth') });
  const locator = { workspaceId: id(825), ...f.location };
  const provider = createDesktopSyncProviders({ session: f.session, credentials, privateRoot: join(f.privateRoot, 'sync'), confirmDestination: async () => true,
    pickTool: async tool => process.platform === 'win32' ? tool === 'git' ? 'D:/env/Git/cmd/git.exe' : 'C:/Windows/System32/OpenSSH/ssh.exe' : `/usr/bin/${tool}` });
  return { credentials, locator, provider };
}

it('F7g real main provider checks URL, recovers the original receipt and reopens durable rollback', async () => {
  await withLocalSync(async f => {
    let n = native(f), service = await n.provider.open(n.locator);
    const before = createProjectSnapshot(f.readProject()).definitionRevision;
    const checked = await service.check(f.location, f.source.id);
    expect(checked.applicable).toBe(true);
    expect(checked.candidate.stamp.coreBuildId).toBe((await readBuildIdentity()).coreBuildId);
    expect(createProjectSnapshot(f.readProject()).definitionRevision).toBe(before);
    const intent = f.newIntent(), receipt = await service.apply(f.location, checked.candidate, f.decisions(checked.candidate), intent);
    expect(await service.operation(f.location, intent)).toEqual(receipt);
    await f.reopen(); n = native(f); service = await n.provider.open(n.locator);
    expect(await service.operation(f.location, intent)).toEqual(receipt);
    const rollback = await service.rollback(f.location, receipt.historyId!, f.newIntent());
    expect(rollback.status).toBe('committed');
    expect(createProjectSnapshot(f.readProject()).definitionRevision).toBe(before);
    expect((await service.history(f.location)).map(row => row.operationKind)).toEqual(['apply', 'rollback']);
    expect((await readdir(join(f.privateRoot, 'sync')).catch(() => [])).filter(name => /^(read-|owner-)/.test(name))).toEqual([]);
  });
}, 30000);

it('F7g real main provider uses process-local CA and strict SSH host authority with installed tools', async () => {
  await withGitSource(async git => {
    for (const kind of ['git-https', 'git-ssh'] as const) await withLocalSync(async f => {
      const n = native(f);
      await n.provider.configureTool('git'); await n.provider.configureTool('ssh');
      const put = async (refId: string, value: string) => expect(await n.credentials.put({ locator: n.locator, ref: { id: refId, policy: 'test-auto' }, value })).toEqual({ ok: true });
      await put('owned-http', JSON.stringify({ formatVersion: 1, kind: 'http-headers', headers: [{ name: 'Authorization', value: 'Basic b3duZWQ6c3ludGhldGlj' }] }));
      await put('owned-key', await readFile(git.privateKeyPath, 'utf8'));
      await put('owned-hosts', (await readFile(git.knownHostsPath, 'utf8')).replaceAll('owned.git.test', git.hostname));
      await put('owned-passphrase', git.passphrase);
      const httpsOrigin = `https://${git.hostname}:${git.httpsPort}`;
      const initial = await n.credentials.networkProfilesGet(n.locator);
      await n.credentials.networkProfilesSave({ locator: n.locator, revision: initial.revision, configuration: { formatVersion: 1, profiles: [{ id: 'owned-ca', name: 'Owned process CA', kind: 'direct', targetTlsBindings: [{ origin: httpsOrigin, tls: { caCertificatePaths: [join(git.directory, 'ca.pem')] } }] }], environmentSelections: [] } });
      let service = await n.provider.open(n.locator);
      const { url: _url, ...common } = f.source;
      const source = { ...common, revision: '2', kind, repositoryUrl: kind === 'git-https' ? `${httpsOrigin}/repo-sha1.git` : `ssh://ownedgit@${git.hostname}:${git.sshPort}/fixture/repo-sha1.git`, ref: 'refs/heads/main', filePath: 'openapi.yaml',
        ...(kind === 'git-https' ? { authRef: 'owned-http', networkProfileRef: 'owned-ca' } : { privateKeyRef: 'owned-key', knownHostsRef: 'owned-hosts', passphraseRef: 'owned-passphrase' }) } as SyncSource;
      await service.saveSource(f.location, source, '1');
      const before = createProjectSnapshot(f.readProject()).definitionRevision;
      const checked = await service.check(f.location, source.id);
      expect(checked.candidate.upstream).toMatchObject({ kind: 'git', commitOid: git.repositories.sha1.commitOid, blobOid: git.repositories.sha1.blobOid });
      expect(createProjectSnapshot(f.readProject()).definitionRevision).toBe(before);
      if (source.kind === 'git-https') {
        const { networkProfileRef: _profile, ...untrusted } = source;
        await service.saveSource(f.location, { ...untrusted, revision: '3' }, '2');
        await expect(service.check(f.location, source.id)).rejects.toThrow('SYNC_TLS_FAILED');
      } else {
        await put('owned-hosts', (await readFile(git.wrongHostKeyRef, 'utf8')).replaceAll('owned.git.test', git.hostname));
        await expect(service.check(f.location, source.id)).rejects.toThrow('SYNC_HOST_KEY_MISMATCH');
      }
      expect((await readdir(join(f.privateRoot, 'sync'))).filter(name => /^(read-|owner-)/.test(name))).toEqual([]);
      expect(createProjectSnapshot(f.readProject()).definitionRevision).toBe(before);
    });
  });
}, 120000);
