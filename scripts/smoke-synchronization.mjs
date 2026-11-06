// Fresh deployment-job entry: built-ins only, including its tracked owned fixture.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer as createHttpsServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createServer as createPortReservation } from 'node:net';
import { withGitSource } from '../packages/execution/tests/sourceHost/git-fixture.mjs';
import { runEvidenceCommand } from './lib/f7f-evidence.mjs';
import { renderSourceDeployment, startSourceDeployment } from './check-source-deployment.mjs';

const repo = resolve(import.meta.dirname, '..');
const moduleId = '00000000-0000-4000-8000-000000000071';
const contractProjectId = '00000000-0000-4000-8000-000000000070';
const sleep = ms => new Promise(done => setTimeout(done, ms));
const doc = description => ({ openapi: '3.0.3', info: { title: 'Owned F7g 中文 and English source', version: '1' }, paths: { '/pets': { get: { operationId: 'ownedPets', description, responses: { 200: { description: 'OK' } } } } } });
export async function smokeSynchronization({ keep = false, evidenceParent = 'local/f7g-acceptance' } = {}) {
  const parent = resolve(repo, evidenceParent);
  if (!parent.startsWith(repo + (process.platform === 'win32' ? '\\' : '/'))) throw Error('OWNED_EVIDENCE_ROOT_REQUIRED');
  await mkdir(parent, { recursive: true }); const root = await mkdtemp(join(parent, 'containers-'));
  const prefix = 'apicc-f7g-' + randomBytes(5).toString('hex');
  const names = { server: prefix + '-server', runtime: prefix + '-runtime', source: prefix + '-source' };
  const serverImage = process.env.APICC_F7G_SERVER_IMAGE ?? 'apicc-server:local';
  const runtimeImage = process.env.APICC_F7G_RUNTIME_IMAGE ?? 'apicc-collaboration:local';
  const receipt = { root, prefix, keep, names, images: {}, checks: [], cleanup: [], passed: false };
  const reservation = createPortReservation();
  await new Promise((done, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', done); });
  const controlPort = reservation.address().port;
  await new Promise(done => reservation.close(done));
  const gitText = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1048576 }).trim();
  const paths = [...new Set(gitText(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(path => /^(apps|packages|server|scripts|deploy)\//.test(path) || /^(Dockerfile.*|pnpm.*|package\.json)$/.test(path)))].sort();
  const sourceHash = createHash('sha256');
  for (const path of paths) { sourceHash.update(path).update('\0'); try { sourceHash.update(createHash('sha256').update(await readFile(join(repo, path))).digest('hex')); } catch (error) { if (error.code !== 'ENOENT') throw error; sourceHash.update('DELETED'); } sourceHash.update('\0'); }
  receipt.source = { head: gitText(['rev-parse', 'HEAD']), sourceSha256: sourceHash.digest('hex'), paths: paths.length, scope: 'apps/packages/server/scripts/deploy, Dockerfiles and workspace manifests; excludes docs and ignored outputs' };
  const save = () => writeFile(join(root, 'synchronization.json'), JSON.stringify(receipt, null, 2));
  const environment = { ...process.env, APICC_SERVER_BIND_ADDRESS: '127.0.0.1', APICC_SERVER_PORT: String(controlPort),
    APICC_SERVER_ENV_FILE: join(root, 'synthetic.env'), APICC_COLLABORATION_SECRET_FILE: join(root, 'rpc-secret'),
    APICC_COLLABORATION_SOURCE_CONFIG_FILE: join(root, 'source-config.json'),
    APICC_COLLABORATION_CPU_VCPU: '1', APICC_COLLABORATION_MEMORY_BYTES: '805306368', APICC_COLLABORATION_HEAP_BYTES: '402653184',
    APICC_COLLABORATION_CACHE_BYTES: '67108864', APICC_COLLABORATION_MAX_WIRE_BYTES: '33554432',
    APICC_COLLABORATION_IN_FLIGHT_BYTES: '134217728', APICC_COLLABORATION_HEADROOM_BYTES: '201326592',
    APICC_SYNC_PRIVATE_TMPFS_BYTES: '536870912', APICC_SYNC_RUNTIME_MEMORY_BYTES: '1342177280' };
  let sequence = 0, created = false, https;
  const lifetime = setInterval(() => {}, 1000);
  const docker = async args => {
    const result = await runEvidenceCommand({ command: 'docker', args, cwd: repo, env: environment, timeoutMs: 120000, logFile: join(root, `docker-${++sequence}.log`) });
    if (!result.passed) throw Error(`OWNED_DOCKER_PREREQUISITE: ${args[0]} exit=${result.exitCode}; ${root}`);
    return result.stdout.trim();
  };
  const inspect = async name => JSON.parse(await docker(['inspect', '--format', '{{json .}}', name]));
  const compose = ['--project-name', prefix, '-f', join(repo, 'deploy/docker-compose.yml'), '-f', join(repo, 'deploy/docker-compose.collaboration.yml'), '-f', join(repo, 'deploy/docker-compose.synchronization.yml'), '-f', join(root, 'owned-compose.json'), '--profile', 'collaboration'];
  const ready = async () => {
    const until = Date.now() + 90000;
    while (Date.now() < until) {
      const server = await inspect(names.server); if (!server.State.Running) throw Error('OWNED_JAVA_STOPPED');
      const port = server.NetworkSettings.Ports['8080/tcp']?.[0]?.HostPort;
      if (port) { const url = `http://127.0.0.1:${port}`; try { if ((await fetch(url + '/api/v1/ping', { signal: AbortSignal.timeout(2000) })).ok) return url; } catch {} }
      await sleep(200);
    }
    throw Error('OWNED_JAVA_READINESS');
  };
  try {
    await withGitSource(async git => {
      const subnet = `172.30.${randomBytes(1)[0]}.0/24`;
      await writeFile(join(root, 'synthetic.env'), ''); await writeFile(join(root, 'rpc-secret'), randomBytes(32).toString('hex'));
      await writeFile(join(root, 'material-key'), randomBytes(32)); await writeFile(join(root, 'openapi.json'), JSON.stringify(doc('upstream initial')));
      const origins = ['http://synthetic-source:8081', 'https://owned.git.test:8443', 'ssh://owned.git.test:2222'];
      await writeFile(join(root, 'source-config.json'), JSON.stringify({ privateRoot: '/var/lib/apicc-sources', tools: { gitPath: '/usr/bin/git', sshPath: '/usr/bin/ssh' }, allowedOrigins: origins, allowedCidrs: [subnet], maxRedirects: 0 }));
      const sourceCode = `const fs=require('node:fs');require('node:http').createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(fs.readFileSync('/run/spec/openapi.json'))}).listen(8081,'0.0.0.0')`;
      const override = { services: {
        server: { image: serverImage, container_name: names.server, environment: { APICC_SERVER_ADMIN_USERNAME: 'synthetic-f7g-admin', APICC_SERVER_ADMIN_PASSWORD: 'synthetic-password8', APICC_EXECUTION_MATERIALS_MASTER_KEY_FILE: '/run/secrets/material-key', APICC_COLLABORATION_PUBLIC_ENABLED: 'false' }, secrets: [{ source: 'material-key', target: 'material-key' }] },
        collaboration: { image: runtimeImage, container_name: names.runtime },
        'synthetic-source': { image: runtimeImage, container_name: names.source, entrypoint: ['node', '-e', sourceCode], init: true, user: '1000:1000', read_only: true, cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], mem_limit: '67108864', networks: ['collaboration-source-egress'], volumes: [{ type: 'bind', source: join(root, 'openapi.json'), target: '/run/spec/openapi.json', read_only: true }] },
      }, secrets: { 'material-key': { file: join(root, 'material-key') } }, networks: { 'collaboration-source-egress': { ipam: { config: [{ subnet }] } } }, volumes: { 'apicc-data': { name: prefix + '-data' } } };
      await writeFile(join(root, 'owned-compose.json'), JSON.stringify(override));
      for (const image of [serverImage, runtimeImage]) receipt.images[image] = JSON.parse(await docker(['image', 'inspect', '--format', '{{json .}}', image])).Id;
      // The same capacity validator gates both this smoke and the operator --up entry.
      const rendered = renderSourceDeployment(compose, environment);
      created = true; const started = startSourceDeployment(compose, environment); receipt.capacity = started.facts;
      await writeFile(join(root, 'compose-up.log'), started.output);
      const network = rendered.networks['collaboration-source-egress'].name;
      await docker(['network', 'connect', '--alias', 'owned.git.test', network, git.container]);
      receipt.fixture = { container: git.container, network, transport: 'private bridge; no host RPC ports' };
      let origin = await ready();
      await docker(['cp', `${git.container}:/fixture/server.pem`, join(root, 'server.pem')]);
      await docker(['cp', `${git.container}:/fixture/server.key`, join(root, 'server.key')]);
      await writeFile(join(root, 'ca.pem'), git.caPem);
      https = createHttpsServer({ key: await readFile(join(root, 'server.key')), cert: await readFile(join(root, 'server.pem')) }, (req, res) => {
        if (req.url === '/owned-source/openapi.json') { readFile(join(root, 'openapi.json')).then(body => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(body); }); return; }
        const proxy = httpRequest(origin + req.url, { method: req.method, headers: req.headers }, upstream => { res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res); });
        proxy.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(proxy);
      });
      await new Promise(done => https.listen(0, '127.0.0.1', done));
      receipt.session = { httpOrigin: origin, httpsOrigin: `https://127.0.0.1:${https.address().port}`, caPath: join(root, 'ca.pem'), username: 'synthetic-f7g-admin', password: 'synthetic-password8', dataVolume: prefix + '-data', stopFile: join(root, 'stop-requested') };
      const runtime = await inspect(names.runtime);
      assert.equal(runtime.HostConfig.Init, true); assert.equal(runtime.HostConfig.ReadonlyRootfs, true); assert.equal(runtime.HostConfig.Memory, 1342177280);
      assert.deepEqual(runtime.HostConfig.PortBindings, {}); assert.equal(runtime.Config.User, '1000:1000');
      assert.ok(runtime.HostConfig.Tmpfs['/var/lib/apicc-sources'].includes('size=536870912'));
      receipt.checks.push({ actualRuntimeBoundaries: { init: true, readOnly: true, cgroupMemoryBytes: runtime.HostConfig.Memory, privateTmpfs: runtime.HostConfig.Tmpfs, publishedRpc: runtime.HostConfig.PortBindings } });
      const tools = await docker(['exec', names.runtime, 'sh', '-c', 'git --version; ssh -V; node --version; test -r /etc/ssl/certs/ca-certificates.crt']); receipt.checks.push({ installedTools: tools });
      let token = '';
      const api = async (method, path, body, expected = 200) => {
        const response = await fetch(origin + '/api/v1/' + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
        const raw = await response.text(), value = raw ? JSON.parse(raw) : null;
        receipt.checks.push({ method, path, status: response.status, code: value?.code ?? null }); assert.equal(response.status, expected, `${method} ${path}: ${raw}`); return value;
      };
      token = (await api('POST', 'auth/login', { username: receipt.session.username, password: receipt.session.password })).token;
      const ws = (await api('GET', 'connect')).workspaceId, group = (await api('GET', `workspaces/${ws}/groups`))[0].id;
      const project = (await api('POST', `workspaces/${ws}/projects`, { name: 'F7g 合成项目 / long English synchronization project name', groupId: group }, 201)).id;
      const projectPath = `workspaces/${ws}/projects/${project}`, sync = projectPath + '/sync';
      receipt.session.workspaceId = ws; receipt.session.projectId = project; receipt.session.groupId = group;
      // T7's metadata-only YAML is not a legal comparison input. Construct and
      // validate the complete synthetic project through this actual image's Core.
      const files = JSON.parse(await docker(['exec', names.runtime, 'node', '--input-type=module', '-e', `import{ContractProjectSchema}from'./packages/core/dist/contract/workspace.js';import{encodeContractProjectFiles}from'./packages/core/dist/storage/contractFiles.js';import{readSyncProject}from'./packages/core/dist/sync/index.js';const project=ContractProjectSchema.parse({id:${JSON.stringify(contractProjectId)},name:'F7g owned',globals:{},collections:[{id:${JSON.stringify(moduleId)},name:'Target',apis:[],folders:[]}],models:[],components:[]});const files=[...encodeContractProjectFiles(project).files].map(([path,content])=>({path,content}));await readSyncProject(files);console.log(JSON.stringify(files));`]));
      let assets = await api('PUT', projectPath + '/assets', { format: 'contract-files-v1', contractProjectId, expectedVersion: '0', changes: files, deletes: [] });
      const credential = (ref, value, expectedVersion = '0') => api('PUT', projectPath + '/credentials/' + ref, { expectedVersion, value });
      await credential('owned-http', JSON.stringify({ formatVersion: 1, kind: 'http-headers', headers: [{ name: 'Authorization', value: 'Basic b3duZWQ6c3ludGhldGlj' }] }));
      await credential('owned-network', JSON.stringify({ formatVersion: 1, kind: 'network-profile', profile: { kind: 'direct', name: 'Owned private CA', targetTlsBindings: [{ origin: origins[1], tls: { caPems: [git.caPem], clientCertPems: [] } }] } }));
      await credential('owned-key', await readFile(git.privateKeyPath, 'utf8'));
      const hostKey = (await readFile(git.knownHostsPath, 'utf8')).replace(`:${git.sshPort}`, ':2222');
      const wrongKey = (await readFile(git.wrongHostKeyRef, 'utf8')).replace(`:${git.sshPort}`, ':2222');
      await credential('owned-hosts', hostKey); await credential('owned-wrong-hosts', wrongKey); await credential('owned-passphrase', git.passphrase);
      const sources = {};
      for (const kind of ['url', 'git-https', 'git-ssh']) {
        const source = { formatVersion: 1, id: randomUUID(), revision: '1', moduleId, kind, schedule: { enabled: false, rule: { kind: 'cron', expression: '0 0 * * * *', timeZone: 'UTC', dstOverlap: 'first' } },
          ...(kind === 'url' ? { url: origins[0] + '/openapi.json' } : { repositoryUrl: kind === 'git-https' ? origins[1] + '/repo-sha1.git' : 'ssh://ownedgit@owned.git.test:2222/fixture/repo-sha1.git', ref: 'refs/heads/main', filePath: 'openapi.yaml', ...(kind === 'git-https' ? { authRef: 'owned-http', networkProfileRef: 'owned-network' } : { privateKeyRef: 'owned-key', knownHostsRef: 'owned-hosts', passphraseRef: 'owned-passphrase' }) }) };
        sources[kind] = await api('POST', sync + '/sources', { formatVersion: 1, intentId: randomUUID(), expectedAssetVersion: assets.version, expectedSourceRevision: '0', source }, 201);
      }
      const check = async (source, failure) => {
        const accepted = await api('POST', sync + `/sources/${source.id}/checks`, { formatVersion: 1, intentId: randomUUID(), expectedSourceRevision: source.revision, expectedAssetVersion: assets.version }, 202);
        const until = Date.now() + 60000; let status;
        while (Date.now() < until) { status = await api('GET', sync + '/checks/' + accepted.checkId); if (['succeeded', 'failed', 'lost', 'cancelled'].includes(status.state)) break; await sleep(100); }
        assert.equal(status.state, failure ? 'failed' : 'succeeded', JSON.stringify(status));
        if (failure) { assert.equal(status.detailCode, failure); return status; }
        return api('GET', sync + '/candidates/' + status.candidateId);
      };
      const urlView = await check(sources.url); await check(sources['git-https']); await check(sources['git-ssh']);
      // These failures reach real clients after successful trust/auth controls.
      const updateSource = async (source, fields) => {
        const next = { ...source, ...fields, revision: String(BigInt(source.revision) + 1n) };
        return api('PUT', sync + '/sources/' + source.id, { formatVersion: 1, intentId: randomUUID(), expectedAssetVersion: assets.version, expectedSourceRevision: source.revision, source: next });
      };
      sources['git-https'] = await updateSource(sources['git-https'], { networkProfileRef: undefined }); await check(sources['git-https'], 'SYNC_TLS_FAILED');
      sources['git-https'] = await updateSource(sources['git-https'], { networkProfileRef: 'owned-network' });
      sources['git-ssh'] = await updateSource(sources['git-ssh'], { knownHostsRef: 'owned-wrong-hosts' }); await check(sources['git-ssh'], 'SYNC_HOST_KEY_MISMATCH');
      sources['git-ssh'] = await updateSource(sources['git-ssh'], { knownHostsRef: 'owned-hosts' });
      assert.equal((await api('GET', projectPath + '/assets')).version, assets.version);
      const candidate = urlView.candidate;
      const decisions = { formatVersion: 1, candidateDigest: candidate.candidateDigest, entries: candidate.changes.map(change => ({ changeId: change.changeId, decision: 'take-source' })).sort((a, b) => a.changeId.localeCompare(b.changeId)) };
      const decisionsDigest = await docker(['exec', names.runtime, 'node', '--input-type=module', '-e', "import{hash}from'./packages/core/dist/sync/index.js';console.log(hash(JSON.parse(process.argv[1])))", JSON.stringify(['apicc-sync-decisions-v1', decisions])]);
      const intentId = randomUUID(), apply = { formatVersion: 1, intentId, sourceId: candidate.sourceId, candidateId: candidate.id, candidateDigest: candidate.candidateDigest, expectedAssetVersion: assets.version, expectedSourceRevision: '1', decisions, decisionsDigest };
      // Explicit human-equivalent application; only these synthetic assets change.
      const applied = await api('POST', sync + '/applications', apply); assert.equal(applied.status, 'committed');
      assert.deepEqual(await api('GET', sync + '/operations/' + intentId), applied);
      assets = await api('GET', projectPath + '/assets');
      await docker(['restart', names.server]); origin = await ready();
      assert.equal(origin, receipt.session.httpOrigin, 'The same owned control address must survive backend restart');
      token = (await api('POST', 'auth/login', { username: receipt.session.username, password: receipt.session.password })).token;
      assert.deepEqual(await api('GET', sync + '/operations/' + intentId), applied);
      const rolled = await api('POST', sync + '/rollbacks', { formatVersion: 1, intentId: randomUUID(), sourceId: sources.url.id, historyId: applied.historyId, expectedAssetVersion: assets.version, expectedSourceRevision: '1' });
      assert.equal(rolled.kind, 'rollback'); assets = await api('GET', projectPath + '/assets');
      const privateFacts = await docker(['exec', names.runtime, 'node', '-e', "const fs=require('node:fs');console.log(JSON.stringify({root:fs.readdirSync('/var/lib/apicc-sources'),uid:process.getuid(),execution:require.resolve('@apicc/execution/source-host',{paths:['/app/apps/collaboration-runtime']})}));"]);
      receipt.checks.push({ explicitApplyReceiptRecoveredAcrossBackendRestart: applied.intentId, rollback: rolled.intentId, finalAssetVersion: assets.version, privateFacts: JSON.parse(privateFacts) });
      receipt.session.sources = sources; receipt.session.urlCandidateId = candidate.id; receipt.passed = true;
      await save(); console.log('F7G_SYNTHETIC_SESSION ' + JSON.stringify(receipt.session)); console.log('F7G_DEPLOYMENT_EVIDENCE ' + root);
      if (keep) { console.log('Owned services remain until the recorded stop-requested file is created.'); while (!await access(receipt.session.stopFile).then(() => true, () => false)) await sleep(500); }
      await docker(['network', 'disconnect', network, git.container]);
    });
  } catch (error) { receipt.failure = error.stack; receipt.passed = false; }
  finally {
    if (https) { https.closeAllConnections(); await new Promise(done => https.close(done)); }
    if (created) try {
      await docker(['compose', ...compose, 'stop', '--timeout', '10']);
      for (const name of Object.values(names)) { const info = await inspect(name); assert.equal(info.Config.Labels['com.docker.compose.project'], prefix); assert.equal(info.State.Running, false); await docker(['logs', name]); receipt.cleanup.push({ name, id: info.Id, running: false, exitCode: info.State.ExitCode }); }
      await docker(['cp', `${names.server}:/data`, join(root, 'saved-data')]);
      await docker(['compose', ...compose, 'down']);
      const volume = JSON.parse(await docker(['volume', 'inspect', '--format', '{{json .}}', prefix + '-data'])); assert.equal(volume.Labels['com.docker.compose.project'], prefix);
      await docker(['volume', 'rm', prefix + '-data']); receipt.cleanup.push({ removedOwnedVolume: prefix + '-data' });
    } catch (error) { receipt.passed = false; receipt.cleanup.push({ failure: error.message, preserveOwnedPrefix: prefix }); }
    await save(); clearInterval(lifetime);
  }
  if (!receipt.passed) throw Error(`SYNCHRONIZATION_DEPLOYMENT_FAILED: ${receipt.failure}; ${root}`);
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  smokeSynchronization({ keep: process.argv.includes('--keep'), evidenceParent: process.env.APICC_F7G_EVIDENCE_PARENT ?? 'local/f7g-acceptance' }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
