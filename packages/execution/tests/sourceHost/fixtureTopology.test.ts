import { it, expect } from 'vitest';
import { withGitSource } from './git-fixture.mjs';
import { installGitApplication } from './git-application.js';
import { gitReaderFixture } from './git-reader-fixture.js';

it('owned transport reaches real HTTPS and SSH and collects each private read', async () => {
  const application = await installGitApplication();
  try {
    await withGitSource(async fixture => {
      const info = JSON.parse(await fixture.command(['inspect', '--format', '{{json .}}', fixture.container]));
      expect(info.HostConfig.Init).toBe(true);
      if (fixture.transport === 'bridge') {
        expect(info.HostConfig.PortBindings).toEqual({});
        expect(fixture.sshPort).toBe(2222); expect(fixture.httpsPort).toBe(8443);
        expect(fixture.address).not.toBe('127.0.0.1');
      } else expect(Object.values(info.HostConfig.PortBindings).flat().every((value: any) => value.HostIp === '127.0.0.1')).toBe(true);
      const reader = await gitReaderFixture(fixture, application);
      for (const kind of ['git-https', 'git-ssh'] as const) {
        const read = await reader.read(reader.input(kind));
        expect(read.status).toBe('read');
        if (read.status !== 'read') throw Error('Owned Git fixture must return an actual content read');
        expect(read.rawText).toBe(fixture.repositories.sha1.rawText);
        expect(read.upstream).toMatchObject({ commitOid: fixture.repositories.sha1.commitOid, blobOid: fixture.repositories.sha1.blobOid });
      }
      expect(reader.releases).toEqual([{ exists: false, retained: 0 }, { exists: false, retained: 0 }]);
      expect(reader.retained()).toBe(0);
    });
  } finally { await application.close(); }
}, 60000);
