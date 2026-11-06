import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const exec = promisify(execFile);
export const fixtureImage = process.env.APICC_GIT_FIXTURE_IMAGE || 'apicc-f7g-ssh-fixture:node22';
export async function withGitSource(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'apicc-owned-git-'));
  const transport = process.env.APICC_GIT_FIXTURE_TRANSPORT ?? (process.platform !== 'win32' && existsSync('/.dockerenv') ? 'bridge' : 'host');
  if (!['host', 'bridge'].includes(transport)) throw Error('Owned Git fixture transport must be host or bridge');
  const clientContainer = process.env.APICC_GIT_FIXTURE_CLIENT_CONTAINER ?? process.env.HOSTNAME;
  const crlRequests = [];
  const crlServer = createServer(async (req, res) => {
    crlRequests.push({ path: req.url, remoteAddress: req.socket.remoteAddress });
    try { const body = await readFile(join(directory, 'ca.crl')); res.writeHead(200, { 'content-type': 'application/pkix-crl', connection: 'close' }); res.end(body); }
    catch { res.writeHead(503, { connection: 'close' }); res.end(); }
  });
  const docker = process.env.APICC_TEST_DOCKER || 'docker';
  let container;
  let network, connected = false;
  const command = async args => (await exec(docker, args, { windowsHide: true, maxBuffer: 2 * 1024 * 1024, timeout: 60000 })).stdout.trim();
  try {
    // Missing prerequisite is an explicit setup failure, never a test skip or business RED.
    await command(['image', 'inspect', fixtureImage]);
    let clientAddress = '127.0.0.1';
    if (transport === 'bridge') {
      if (!clientContainer) throw Error('Owned bridge client container identity required');
      network = 'apicc-owned-git-' + randomUUID();
      await command(['network', 'create', '--internal', network]);
      await command(['network', 'connect', network, clientContainer]); connected = true;
      const info = JSON.parse(await command(['inspect', '--format', '{{json .NetworkSettings.Networks}}', clientContainer]));
      clientAddress = info[network].IPAddress;
    }
    // All-interface bind is confined to the owned client container, never a host listener.
    await new Promise(resolve => crlServer.listen(0, transport === 'bridge' ? '0.0.0.0' : '127.0.0.1', resolve));
    const crlUrl = `http://${clientAddress}:${crlServer.address().port}/ca.crl`;
    container = await command(['create', '--init', ...(transport === 'host' ? ['--publish', '127.0.0.1::2222', '--publish', '127.0.0.1::8443'] : ['--network', network, '--network-alias', 'owned.git.test']), '--env', `APICC_FIXTURE_CRL_URL=${crlUrl}`, '--entrypoint', '/usr/bin/tini', fixtureImage, '--', '/usr/local/bin/node', '/fixture-server.mjs']);
    await command(['cp', fileURLToPath(new URL('./git-fixture-server.mjs', import.meta.url)), `${container}:/fixture-server.mjs`]);
    await command(['start', container]);
    let metadata;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { metadata = JSON.parse(await command(['exec', container, 'cat', '/fixture/ready.json'])); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    if (!metadata) throw new Error(`Owned Git fixture prerequisite failed: ${await command(['logs', container])}`);
    const sshPort = transport === 'bridge' ? 2222 : Number((await command(['port', container, '2222/tcp'])).split(':').at(-1));
    const httpsPort = transport === 'bridge' ? 8443 : Number((await command(['port', container, '8443/tcp'])).split(':').at(-1));
    const address = transport === 'host' ? '127.0.0.1' : JSON.parse(await command(['inspect', '--format', '{{json .NetworkSettings.Networks}}', container]))[network].IPAddress;
    for (const name of ['client', 'host.pub', 'wrong-host.pub', 'ca.pem', 'ca.crl']) await command(['cp', `${container}:/fixture/${name}`, join(directory, name)]);
    const hostKey = (await readFile(join(directory, 'host.pub'), 'utf8')).split(' ').slice(0, 2).join(' ');
    const wrongKey = (await readFile(join(directory, 'wrong-host.pub'), 'utf8')).split(' ').slice(0, 2).join(' ');
    await writeFile(join(directory, 'known_hosts'), `[owned.git.test]:${sshPort} ${hostKey}\n`);
    await writeFile(join(directory, 'wrong_hosts'), `[owned.git.test]:${sshPort} ${wrongKey}\n`);
    const f = {
      directory, container, transport, address, hostname: transport === 'host' ? '127.0.0.1' : 'owned.git.test', sshPort, httpsPort, crlUrl, crlRequests, ...metadata,
      httpsUrl: `https://owned.git.test:${httpsPort}/repo-sha1.git`, sshUrl: `ssh://ownedgit@owned.git.test:${sshPort}/fixture/repo-sha1.git`,
      privateKeyPath: join(directory, 'client'), knownHostsPath: join(directory, 'known_hosts'), wrongHostKeyRef: join(directory, 'wrong_hosts'), passphrase: 'owned-passphrase',
      caPem: await readFile(join(directory, 'ca.pem'), 'utf8'),
      command, exec: args => command(['exec', container, ...args]),
      uploads: async () => (await command(['exec', container, 'cat', '/fixture/uploads'])).split('\n').filter(Boolean),
      requests: async () => (await command(['exec', container, 'cat', '/fixture/http-requests'])).split('\n').filter(Boolean).map(line => JSON.parse(line)),
      activeHttpSockets: async () => Number(await command(['exec', container, 'cat', '/fixture/http-active'])),
      pauseUploads: () => command(['exec', container, 'touch', '/fixture/pause-uploads']),
      resumeUploads: () => command(['exec', container, 'rm', '-f', '/fixture/pause-uploads']),
      moveBranch: (format = 'sha1') => command(['exec', container, '/usr/bin/git', `--git-dir=/fixture/repo-${format}.git`, 'update-ref', 'refs/heads/main', metadata.repositories[format].movedCommitOid]),
      resetBranch: (format = 'sha1') => command(['exec', container, '/usr/bin/git', `--git-dir=/fixture/repo-${format}.git`, 'update-ref', 'refs/heads/main', metadata.repositories[format].commitOid]),
      async positiveControls(protocols = ['https', 'ssh']) {
        await command(['exec', container, '/usr/local/bin/node', '--input-type=module', '-e', `
          import {writeFileSync,mkdirSync} from 'node:fs'; import {execFileSync} from 'node:child_process';
          writeFileSync('/fixture/askpass','#!/bin/sh\\nprintf "%s\\\\n" owned-passphrase\\n',{mode:0o700});
          writeFileSync('/fixture/client_hosts','[owned.git.test]:2222 '+${JSON.stringify(hostKey)}+'\\n');
          writeFileSync('/fixture/client_config','Host owned.git.test\\n HostName 127.0.0.1\\n HostKeyAlias [owned.git.test]:2222\\n Port 2222\\n User ownedgit\\n IdentityFile /fixture/client\\n UserKnownHostsFile /fixture/client_hosts\\n GlobalKnownHostsFile /dev/null\\n StrictHostKeyChecking yes\\n IdentitiesOnly yes\\n IdentityAgent none\\n');
          const env={PATH:'/usr/bin:/bin',HOME:'/fixture/empty',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_SSH_COMMAND:'/usr/bin/ssh -F /fixture/client_config',SSH_ASKPASS:'/fixture/askpass',SSH_ASKPASS_REQUIRE:'force',DISPLAY:'owned:0'};
          for(const protocol of ${JSON.stringify(protocols)}) {const dir='/fixture/control-'+protocol;execFileSync('/usr/bin/git',['init','--bare',dir],{env});const url=protocol==='https'?'https://owned.git.test:8443/repo-sha1.git':'ssh://ownedgit@owned.git.test:2222/fixture/repo-sha1.git';const args=['-C',dir,'-c','safe.directory=*'];if(protocol==='https')args.push('-c','http.curloptResolve=owned.git.test:8443:127.0.0.1','-c','http.sslCAInfo=/fixture/ca.pem','-c','http.extraHeader=Authorization: Basic b3duZWQ6c3ludGhldGlj');execFileSync('/usr/bin/git',[...args,'fetch','--no-tags',url,'refs/heads/main'],{env});const text=execFileSync('/usr/bin/git',['-C',dir,'show','FETCH_HEAD:openapi.yaml'],{env,encoding:'utf8'});if(text!==${JSON.stringify(metadata.repositories.sha1.rawText)})throw Error('fixed blob mismatch');}
        `]);
      },
      async positiveWindowsControls(protocols = ['https', 'ssh']) {
        if (process.platform !== 'win32') throw new Error('Windows prerequisite probe requires Windows');
        const ps = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
        const git = 'D:/env/Git/cmd/git.exe';
        const ssh = 'C:/Windows/System32/OpenSSH/ssh.exe';
        const source = join(directory, 'fixture-askpass.cs'); const askpass = join(directory, 'fixture-askpass.exe');
        const value = join(directory, 'fixture-passphrase');
        await writeFile(value, 'owned-passphrase');
        await writeFile(source, 'using System; using System.IO; public static class FixtureAskpass { public static int Main(string[] args) { Console.WriteLine(File.ReadAllText(Environment.GetEnvironmentVariable("APICC_FIXTURE_PASSPHRASE_FILE"))); return 0; } }');
        const bootstrap = '$ErrorActionPreference="Stop"; Add-Type -Path $env:APICC_FIXTURE_SOURCE -OutputAssembly $env:APICC_FIXTURE_EXE -OutputType ConsoleApplication; Get-ExecutionPolicy';
        const environment = { SystemRoot: process.env.SystemRoot, TEMP: directory, TMP: directory, APICC_FIXTURE_SOURCE: source, APICC_FIXTURE_EXE: askpass };
        const compileStart = performance.now();
        const policy = (await exec(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(bootstrap, 'utf16le').toString('base64')], { env: environment, windowsHide: true })).stdout.trim();
        const compileDurationMs = Math.round(performance.now() - compileStart);
        // Fixture-owned private key must have the same ACL premise stock ssh enforces.
        const sid = (await exec('C:/Windows/System32/whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true })).stdout.trim().split(',')[1].replaceAll('"', '');
        await exec('C:/Windows/System32/icacls.exe', [f.privateKeyPath, '/inheritance:r', '/grant:r', `*${sid}:F`], { windowsHide: true });
        const config = join(directory, 'windows-ssh-config');
        const q = value => '"' + value.replaceAll('\\', '/') + '"';
        await writeFile(config, `Host owned.git.test\n HostName 127.0.0.1\n HostKeyAlias [owned.git.test]:${sshPort}\n Port ${sshPort}\n User ownedgit\n IdentityFile ${q(f.privateKeyPath)}\n UserKnownHostsFile ${q(f.knownHostsPath)}\n GlobalKnownHostsFile NUL\n StrictHostKeyChecking yes\n IdentitiesOnly yes\n IdentityAgent none\n`);
        const env = { SystemRoot: process.env.SystemRoot, PROGRAMDATA: process.env.PROGRAMDATA, TEMP: directory, TMP: directory, HOME: directory, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: `${q(ssh)} -F ${q(config)}`, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: 'owned:0', APICC_FIXTURE_PASSPHRASE_FILE: value };
        const results = [];
        const caPath = join(directory, 'ca.pem');
        const gitConfig = join(directory, 'https-config');
        await writeFile(gitConfig, `[http]\n schannelUseSSLCAInfo = true\n sslCAInfo = ${q(caPath)}\n curloptResolve = owned.git.test:${httpsPort}:127.0.0.1\n extraHeader = Authorization: Basic b3duZWQ6c3ludGhldGlj\n`);
        for (const protocol of protocols) {
          const target = join(directory, `control-windows-${protocol}`);
          await exec(git, ['init', '--bare', target], { env, windowsHide: true });
          try { await exec(git, ['-C', target, ...(protocol === 'https' ? ['-c', `include.path=${gitConfig}`] : []), 'fetch', '--no-tags', protocol === 'https' ? f.httpsUrl : f.sshUrl, 'refs/heads/main'], { env, windowsHide: true, timeout: 20000 }); }
          catch (error) { if (protocol !== 'ssh') throw error; const diagnosis = await exec(ssh, ['-vvv', '-F', config, '-T', 'owned.git.test', 'owned-fixture-diagnostic'], { env, windowsHide: true, timeout: 10000 }).catch(e => e); throw new Error(`Stock SSH fixture prerequisite: ${diagnosis.stderr}`); }
          const text = (await exec(git, ['-C', target, 'show', 'FETCH_HEAD:openapi.yaml'], { env, windowsHide: true })).stdout;
          if (text !== metadata.repositories.sha1.rawText) throw new Error('Windows fixture blob mismatch');
          results.push({ protocol, commitOid: (await exec(git, ['-C', target, 'rev-parse', 'FETCH_HEAD'], { env, windowsHide: true })).stdout.trim() });
        }
        return { policy, compileDurationMs, results, crlUrl, crlRequests: [...crlRequests] };
      },
    };
    await callback(f);
  } finally {
    if (container) await command(['rm', '--force', '--volumes', container]);
    if (connected) await command(['network', 'disconnect', network, clientContainer]);
    if (network) await command(['network', 'rm', network]);
    crlServer.closeAllConnections(); if (crlServer.listening) await new Promise(resolve => crlServer.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}
