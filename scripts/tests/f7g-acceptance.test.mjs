import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { renderSourceDeployment, validateSourceDeployment } from '../check-source-deployment.mjs';
const repo = resolve(import.meta.dirname, '../..');
const { parse } = createRequire(resolve(repo, 'apps/desktop/package.json'))('yaml');
const text = path => readFile(resolve(repo, path), 'utf8');

test('Windows packaging is selected for a candidate push, a PR and main push', async () => {
  const workflow = parse(await text('.github/workflows/ci.yml'));
  const condition = workflow.jobs['package-smoke'].if;
  for (const github of [{ ref: 'refs/heads/codex/f7g-external-sync', event_name: 'push' }, { ref: 'refs/pull/12/merge', event_name: 'pull_request' }, { ref: 'refs/heads/main', event_name: 'push' }]) {
    assert.equal(condition === undefined ? true : Function('github', `return (${condition})`)(github), true, JSON.stringify(github));
  }
  assert.equal(workflow.concurrency['cancel-in-progress'], true);
});

test('runtime image configuration includes the real source-host execution closure and installed tools', async () => {
  const dockerfile = await text('Dockerfile.collaboration');
  assert.match(dockerfile, /pnpm -C packages\/execution build/);
  assert.match(dockerfile, /COPY --from=build \/app\/packages\/execution \.\/packages\/execution/);
  assert.match(dockerfile, /apt-get install[^\n]*\bgit\b[^\n]*\bopenssh-client\b[^\n]*\bca-certificates\b/);
  assert.match(dockerfile, /USER node/);
  const tools = await text('Dockerfile.ci-gate');
  assert.match(tools, /apt-get install[^\n]*\bopenssh-client\b/);
});

test('optional source deployment has bounded private storage and explicit egress without publishing RPC', async () => {
  const base = parse(await text('deploy/docker-compose.yml'));
  const collaboration = parse(await text('deploy/docker-compose.collaboration.yml'));
  const overlay = parse(await text('deploy/docker-compose.synchronization.yml'));
  const service = { ...base.services.collaboration, ...collaboration.services.collaboration, ...overlay.services.collaboration };
  assert.equal(service.read_only, true); assert.equal(service.init, true); assert.equal(service.user, '1000:1000');
  assert.equal(service.ports, undefined);
  assert.ok(service.security_opt.includes('no-new-privileges:true'));
  assert.ok(service.tmpfs?.some(value => value.startsWith('/var/lib/apicc-sources:') && /uid=1000,gid=1000,mode=0700/.test(value)));
  assert.ok(service.networks.includes('collaboration-private'));
  assert.ok(service.networks.includes('collaboration-source-egress'));
  assert.equal(base.networks['collaboration-private'].internal, true);
  assert.equal(overlay.networks['collaboration-source-egress'].internal, false);
  assert.equal(service.environment.APICC_COLLABORATION_RUNTIME_SOURCE_CONFIG_FILE, '/run/configs/collaboration-sources.json');
  const config = JSON.parse(await text('deploy/collaboration-source.example.json'));
  assert.equal(config.privateRoot, '/var/lib/apicc-sources');
  assert.deepEqual(config.tools, { gitPath: '/usr/bin/git', sshPath: '/usr/bin/ssh' });
  assert.deepEqual(config.allowedOrigins, []); assert.deepEqual(config.allowedCidrs, []);
});

test('actual Compose source configuration accepts separate application/storage memory and rejects an insufficient cgroup', () => {
  const args = ['-f', resolve(repo, 'deploy/docker-compose.yml'), '-f', resolve(repo, 'deploy/docker-compose.collaboration.yml'), '-f', resolve(repo, 'deploy/docker-compose.synchronization.yml'), '--profile', 'collaboration'];
  const environment = { ...process.env, APICC_COLLABORATION_IN_FLIGHT_BYTES: '134217728', APICC_COLLABORATION_HEADROOM_BYTES: '201326592', APICC_SYNC_PRIVATE_TMPFS_BYTES: '536870912', APICC_SYNC_RUNTIME_MEMORY_BYTES: '1342177280' };
  const legal = renderSourceDeployment(args, environment);
  assert.doesNotThrow(() => validateSourceDeployment(legal));
  assert.equal(Number(legal.services.collaboration.mem_limit), 1342177280);
  assert.equal(Number(legal.services.collaboration.environment.APICC_COLLABORATION_RUNTIME_TOTAL_MEMORY_BYTES), 805306368);
  assert.deepEqual(validateSourceDeployment(legal), { applicationBytes: 805306368, storageBytes: 536870912, cgroupBytes: 1342177280 });
  assert.match(legal.services.collaboration.tmpfs[0], /size=536870912,uid=1000,gid=1000,mode=0700,nosuid,nodev,exec$/);
  const insufficient = renderSourceDeployment(args, { ...environment, APICC_SYNC_RUNTIME_MEMORY_BYTES: '805306368' });
  assert.throws(() => validateSourceDeployment(insufficient), /SOURCE_DEPLOYMENT_MEMORY/);
});

test('actual Compose overrides reject a nonprivate/noexec source root and published RPC', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'apicc-source-compose-'));
  const base = ['-f', resolve(repo, 'deploy/docker-compose.yml'), '-f', resolve(repo, 'deploy/docker-compose.collaboration.yml'), '-f', resolve(repo, 'deploy/docker-compose.synchronization.yml')];
  const env = { ...process.env, APICC_COLLABORATION_IN_FLIGHT_BYTES: '134217728', APICC_COLLABORATION_HEADROOM_BYTES: '201326592', APICC_SYNC_PRIVATE_TMPFS_BYTES: '536870912', APICC_SYNC_RUNTIME_MEMORY_BYTES: '1342177280' };
  try {
    for (const [name, yaml, code] of [
      ['implicit-noexec', 'tmpfs: !override ["/var/lib/apicc-sources:size=536870912,uid=1000,gid=1000,mode=0700,nosuid,nodev"]', 'SOURCE_DEPLOYMENT_STORAGE'],
      ['noexec', 'tmpfs: !override ["/var/lib/apicc-sources:size=536870912,uid=1000,gid=1000,mode=0700,nosuid,nodev,noexec"]', 'SOURCE_DEPLOYMENT_STORAGE'],
      ['permissions', 'tmpfs: !override ["/var/lib/apicc-sources:size=536870912,uid=1000,gid=1000,mode=0777,nosuid,nodev"]', 'SOURCE_DEPLOYMENT_STORAGE'],
      ['rpc', 'ports: ["127.0.0.1:0:3210"]', 'SOURCE_DEPLOYMENT_BOUNDARY'],
    ]) {
      const file = join(directory, name + '.yml'); await writeFile(file, `services:\n  collaboration:\n    ${yaml}\n`);
      const config = renderSourceDeployment([...base, '-f', file, '--profile', 'collaboration'], env);
      assert.throws(() => validateSourceDeployment(config), new RegExp(code));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
