// Real optional deployment consumer. All names/ports/data belong to this one synthetic invocation.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runEvidenceCommand } from './lib/f7f-evidence.mjs';

export async function smokeCollaboration(evidenceParent = 'local/f7f-acceptance') {
  const repo = resolve(import.meta.dirname, '..'), parent = resolve(repo, evidenceParent);
  if (!parent.startsWith(resolve(repo, 'local') + (process.platform === 'win32' ? '\\' : '/'))) throw Error('SYNTHETIC_EVIDENCE_ROOT');
  await mkdir(parent, { recursive: true }); const root = await mkdtemp(join(parent, 'containers-'));
  const prefix = `apicc-f7f-${randomBytes(6).toString('hex')}`, server = `${prefix}-server`, runtime = `${prefix}-runtime`;
  const secret = join(root, 'rpc-secret'), override = join(root, 'owned-compose.json');
  await writeFile(secret, randomBytes(32).toString('hex'));
  const serverImage = process.env.APICC_F7F_SERVER_IMAGE ?? 'apicc-f7f-server:candidate';
  const runtimeImage = process.env.APICC_F7F_RUNTIME_IMAGE ?? 'apicc-f7f-collaboration:candidate';
  const data = { services: { server: { image: serverImage, container_name: server, environment: { APICC_SERVER_ADMIN_USERNAME: 'synthetic-f7f-admin', APICC_SERVER_ADMIN_PASSWORD: 'synthetic-password8', APICC_COLLABORATION_PUBLIC_ENABLED:'false' } }, collaboration: { image: runtimeImage, container_name: runtime } }, volumes: { 'apicc-data': { name: `${prefix}-data` } } };
  await writeFile(override, JSON.stringify(data));
  const syntheticEnv=join(root,'synthetic.env');await writeFile(syntheticEnv,'');
  const env = { ...process.env, APICC_SERVER_ENV_FILE:syntheticEnv, APICC_SERVER_BIND_ADDRESS:'127.0.0.1', APICC_SERVER_PORT:'0', APICC_COLLABORATION_SECRET_FILE: secret, APICC_COLLABORATION_CPU_VCPU:'1', APICC_COLLABORATION_MEMORY_BYTES:'805306368', APICC_COLLABORATION_HEAP_BYTES:'402653184', APICC_COLLABORATION_CACHE_BYTES:'67108864', APICC_COLLABORATION_MAX_WIRE_BYTES:'33554432', APICC_COLLABORATION_IN_FLIGHT_BYTES: '134217728', APICC_COLLABORATION_HEADROOM_BYTES: '201326592' };
  const base = ['compose', '--project-name', prefix, '-f', join(repo, 'deploy/docker-compose.yml')];
  const combo = [...base, '-f', join(repo, 'deploy/docker-compose.collaboration.yml'), '-f', override, '--profile', 'collaboration'];
  const result = { root, prefix, images: {}, checks: [], cleanup: [], passed: false };
  const save = () => writeFile(join(root, 'containers.json'), JSON.stringify(result, null, 2) + '\n');
  let sequence = 0, created = false;
  // AbortSignal.timeout timers and fetch sockets may be unref'ed while Docker's proxy starts.
  // Keep the bounded workflow alive so its own deadlines/finally cleanup actually run.
  const workflowLifetime = setInterval(() => {}, 1000);
  const docker = async args => {
    const value = await runEvidenceCommand({ command: 'docker', args, cwd: repo, env, timeoutMs: 120000, logFile: join(root, `docker-${++sequence}.log`) });
    if (!value.passed) throw Error(`DOCKER_COMMAND_FAILED: ${args[0]} exit=${value.exitCode}; ${root}`);
    return value.stdout.trim();
  };
  const inspect = async name => JSON.parse(await docker(['inspect', '--format', '{{json .}}', name]));
  const ready = async () => {
    const deadline = Date.now() + 60000; let last;
    while (Date.now() < deadline) {
      const value = await inspect(server); if (!value.State.Running) throw Error('OWNED_JAVA_STOPPED');
      const binding = value.NetworkSettings.Ports['8080/tcp']?.[0];
      if (binding) { const origin = `http://127.0.0.1:${binding.HostPort}`; try { const response = await fetch(`${origin}/api/v1/ping`, { signal: AbortSignal.timeout(2000) }); if (response.ok) return origin; last = response.status; } catch (error) { last = error.message; } }
      await new Promise(done => setTimeout(done, 250));
    }
    throw Error(`OWNED_JAVA_READINESS_TIMEOUT: ${last}`);
  };
  try {
    for (const image of [serverImage, runtimeImage]) result.images[image] = JSON.parse(await docker(['image','inspect','--format','{{json .}}',image])).Id;
    const javaOnly = JSON.parse(await docker([...base, '-f', override, 'config', '--format', 'json']));
    assert.equal(javaOnly.services.collaboration, undefined); result.checks.push({ javaOnlyDefaultHasNoNode: true });
    assert.ok(javaOnly.services.server.ports.every(port=>port.host_ip==='127.0.0.1'&&port.published==='0'));
    created = true;
    await docker([...base, '-f', override, 'up', '-d', '--no-build', 'server']);
    let origin = await ready();
    result.checks.push({ javaOnlyPing: (await fetch(`${origin}/api/v1/ping`)).status, origin });
    await docker([...combo, 'up', '-d', '--no-build']); origin = await ready();
    const node = await inspect(runtime), control = await inspect(server);
    assert.equal(node.HostConfig.ReadonlyRootfs, true); assert.equal(node.Config.User, '1000:1000');
    assert.equal(node.HostConfig.Memory, 805306368); assert.equal(node.HostConfig.NanoCpus, 1000000000);
    assert.deepEqual(node.HostConfig.PortBindings, {});
    assert.ok(node.Mounts.some(mount => mount.Destination === '/run/secrets/collaboration-rpc' && mount.RW === false));
    assert.ok(!node.Config.Env.some(value => /agent.*token/i.test(value)));
    const networkName = Object.keys(node.NetworkSettings.Networks)[0];
    const network = JSON.parse(await docker(['network','inspect','--format','{{json .}}',networkName])); assert.equal(network.Internal, true);
    const processFacts = JSON.parse(await docker(['exec',runtime,'node','--max-old-space-size=384','--input-type=module','-e', "import fs from 'node:fs';import v8 from 'node:v8';import {coreBuildIdentity} from './apps/collaboration-runtime/dist/core-identity.js';const runtimeProcesses=fs.readdirSync('/proc').filter(x=>/^[0-9]+$/.test(x)).flatMap(pid=>{try{const argv=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0');return argv[0].endsWith('node')&&argv.includes('apps/collaboration-runtime/dist/main.js')?[{pid,argv,rssSampleKiB:Number(fs.readFileSync('/proc/'+pid+'/status','utf8').match(/VmRSS:\\s+(\\d+)/)?.[1])}]:[];}catch{return [];}});console.log(JSON.stringify({uid:process.getuid(),runtimeProcesses,probeHeapSizeLimit:v8.getHeapStatistics().heap_size_limit,coreBuildIdentity:await coreBuildIdentity(),secretReadable:fs.readFileSync('/run/secrets/collaboration-rpc','utf8').length>=32}));"]));
    assert.equal(processFacts.uid, 1000); assert.equal(processFacts.runtimeProcesses.length,1); assert.ok(processFacts.runtimeProcesses[0].argv.includes('--max-old-space-size=384')); assert.equal(processFacts.secretReadable, true);
    assert.equal(processFacts.coreBuildIdentity,JSON.parse(await readFile(join(repo,'server/src/main/resources/collaboration-runtime-boundary.json'),'utf8')).coreBuildIdentity);
    await docker(['exec',server,'sh','-c','test -s /app/share-viewer/index.html && test -s /app/share-viewer/viewer.js && test -s /app/share-viewer/viewer.css && test ! -e /app/console/share-viewer/viewer.js']);
    result.checks.push({ applied: { memory: node.HostConfig.Memory, cpu: node.HostConfig.NanoCpus, readOnly: true, networkInternal: true, publishedRpcPorts: node.HostConfig.PortBindings, secretReadOnly: true, processFacts }, serverImage: control.Image });
    let token = '';
    const api = async (method, path, body, expected = 200) => {
      const startedAt=new Date().toISOString(),started=Date.now();
      const response = await fetch(`${origin}/api/v1/${path}`, { method, headers: { 'content-type':'application/json', ...(token ? {authorization:`Bearer ${token}`} : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      const text = await response.text(),value=text?JSON.parse(text):null;
      result.checks.push({httpAttempt:{method,path,startedAt,endedAt:new Date().toISOString(),durationMs:Date.now()-started,status:response.status,code:value?.code??null}});
      if(expected==='node-offline') {
        assert.ok((response.status===503&&value?.code==='collaboration_projection_unavailable')||(response.status===408&&value?.code==='publication_deadline_exceeded'),`${method} ${path}: ${text}`);
        return {status:response.status,code:value.code,durationMs:Date.now()-started,connectTimeoutMs:3000,callTimeoutMs:10000,publicationOperationTimeoutMs:60000};
      }
      assert.equal(response.status, expected, `${method} ${path}: ${text}`);
      if(expected===503)assert.equal(value?.code,'collaboration_projection_unavailable');
      return value;
    };
    token = (await api('POST','auth/login',{username:'synthetic-f7f-admin',password:'synthetic-password8'})).token;
    const ws = (await api('GET','connect')).workspaceId, group = (await api('GET',`workspaces/${ws}/groups`))[0].id;
    const project = (await api('POST',`workspaces/${ws}/projects`,{name:'F7f owned container source',groupId:group},201)).id;
    const prefixPath = `workspaces/${ws}/projects/${project}`;
    const files = JSON.parse(await readFile(join(repo,'server/src/test/resources/asset-mutation-fixtures.json'),'utf8')).beforeFiles;
    const assets = await api('PUT',`${prefixPath}/assets`,{format:'contract-files-v1',contractProjectId:'10000000-0000-4000-8000-000000000001',expectedVersion:'0',changes:files,deletes:[]});
    const input = {title:'Docker finite Core projection',includeEvidence:false,source:{kind:'document',revision:assets.version,manifestHash:assets.manifestHash,scope:{kind:'project'}}};
    await api('POST',`${prefixPath}/collaboration/previews`,input,201); result.checks.push({ javaToNodeProjection: 201 });
    // Existing configured values are reported honestly, without claiming declaration proves health.
    const deployment = await api('GET','admin/collaboration/deployment');
    assert.equal(deployment.resources.find(row=>row.code==='applicationSettings.inFlightBytes').value,134217728);
    result.checks.push({ deploymentResourceConfiguration: deployment.resources, resourceConstraint: deployment.resourceConstraint });
    await docker(['stop','--timeout','10',runtime]);
    result.checks.push({ nodeOfflineProjection:await api('POST',`${prefixPath}/collaboration/previews`,input,'node-offline') });
    await writeFile(secret, randomBytes(32).toString('hex')); await docker(['start',runtime]);
    await new Promise(done=>setTimeout(done,500)); await api('POST',`${prefixPath}/collaboration/previews`,input,503);
    result.checks.push({ badSecretProjection:503 });
    await docker(['restart',server]); origin=await ready(); token=(await api('POST','auth/login',{username:'synthetic-f7f-admin',password:'synthetic-password8'})).token;
    await api('POST',`${prefixPath}/collaboration/previews`,input,201); result.checks.push({ matchingSecretAfterRestart:201 });
    const incompatible = `import{createServer}from'node:http';import{readFile}from'node:fs/promises';import{startCollaborationRuntime}from'./apps/collaboration-runtime/dist/server.js';const secret=(await readFile('/run/secrets/collaboration-rpc','utf8')).trim();const runtime=await startCollaborationRuntime({secret,host:'127.0.0.1',port:3211});createServer(async(req,res)=>{const chunks=[];for await(const b of req)chunks.push(b);const upstream=await fetch(runtime.url+'/rpc',{method:'POST',headers:{'X-Apicc-Collaboration-Key':secret},body:Buffer.concat(chunks)});const body=await upstream.json();body.protocolVersion=2;res.writeHead(upstream.status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));}).listen(3210,'0.0.0.0');`;
    data.services.collaboration.entrypoint=['node','--input-type=module','-e',incompatible];await writeFile(override,JSON.stringify(data));
    await docker([...combo,'up','-d','--no-build','--force-recreate','collaboration']);
    await new Promise(done=>setTimeout(done,500));await api('POST',`${prefixPath}/collaboration/previews`,input,503);result.checks.push({ actualJavaRejectsIncompatibleNodeEnvelope:503 });
    result.passed = true;
  } catch (error) { result.failure = error.message; }
  finally {
    if (created) {
      try {
        await docker([...combo,'stop','--timeout','10']);
        for (const name of [server,runtime]) {
          const value=await inspect(name); assert.equal(value.Config.Labels['com.docker.compose.project'],prefix); assert.equal(value.State.Running,false);
          await docker(['logs',name]); result.cleanup.push({ name, id:value.Id, running:false, exitCode:value.State.ExitCode });
        }
        await docker(['cp',`${server}:/data`,join(root,'saved-data')]);
        await docker([...combo,'down']);
        const volume=JSON.parse(await docker(['volume','inspect','--format','{{json .}}',`${prefix}-data`])); assert.equal(volume.Labels['com.docker.compose.project'],prefix);
        await docker(['volume','rm',`${prefix}-data`]);result.cleanup.push({ removedOwnedVolume:`${prefix}-data`,savedData:join(root,'saved-data') });
      } catch (error) { result.passed=false; result.cleanup.push({ failure:error.message, preserveOwnedPrefix:prefix }); }
    }
    await save(); clearInterval(workflowLifetime);
  }
  console.log(`F7F_CONTAINER_EVIDENCE ${root}`);
  if (!result.passed) throw Error(`COLLABORATION_CONTAINER_SMOKE_FAILED: ${result.failure ?? 'cleanup'}; ${root}`);
  return result;
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try { await smokeCollaboration(process.argv[2]); } catch(error) { console.error(error.message); process.exitCode=1; }
}
