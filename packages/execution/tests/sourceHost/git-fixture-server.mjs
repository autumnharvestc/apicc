// Owned test service only. Nothing in this file is imported by product code.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, chmodSync, appendFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:https';
const root = '/fixture';
const run = (tool, args, options = {}) => execFileSync(tool, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
const write = (name, text, mode = 0o600) => { writeFileSync(`${root}/${name}`, text, { mode }); chmodSync(`${root}/${name}`, mode); };
mkdirSync(root, { recursive: true });
run('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-subj', '/CN=Owned Git Fixture CA', '-days', '2']);
run('/usr/bin/openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=owned.git.test']);
write('extensions', 'subjectAltName=DNS:owned.git.test,DNS:localhost,IP:127.0.0.1\n' + (process.env.APICC_FIXTURE_CRL_URL ? `crlDistributionPoints=URI:${process.env.APICC_FIXTURE_CRL_URL}\n` : ''));
run('/usr/bin/openssl', ['x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.pem', '-days', '2', '-extfile', 'extensions']);
write('index.txt', ''); write('crlnumber', '1000\n');
write('ca-config', '[ca]\ndefault_ca=owned\n[owned]\ndatabase=/fixture/index.txt\ncertificate=/fixture/ca.pem\nprivate_key=/fixture/ca.key\ncrlnumber=/fixture/crlnumber\ndefault_md=sha256\ndefault_crl_days=2\ncrl_extensions=crl_ext\n[crl_ext]\nauthorityKeyIdentifier=keyid:always\n');
run('/usr/bin/openssl', ['ca', '-gencrl', '-config', 'ca-config', '-out', 'ca-crl.pem']);
run('/usr/bin/openssl', ['crl', '-in', 'ca-crl.pem', '-outform', 'DER', '-out', 'ca.crl']);
for (const name of ['host', 'wrong-host', 'client']) run('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', name === 'client' ? 'owned-passphrase' : '', '-f', `${root}/${name}`]);
const rawText = 'openapi: 3.0.3\ninfo:\n  title: Owned fixture\n  version: 1.0.0\npaths: {}\n';
const repositories = {};
for (const format of ['sha1', 'sha256']) {
  const work = `${root}/work-${format}`;
  run('/usr/bin/git', ['init', `--object-format=${format}`, '--initial-branch=main', work]);
  const git = (...args) => run('/usr/bin/git', ['-C', work, ...args], { env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Owned fixture', GIT_AUTHOR_EMAIL: 'owned@example.invalid', GIT_COMMITTER_NAME: 'Owned fixture', GIT_COMMITTER_EMAIL: 'owned@example.invalid', GIT_AUTHOR_DATE: '2026-11-04T00:00:00Z', GIT_COMMITTER_DATE: '2026-11-04T00:00:00Z' } });
  writeFileSync(`${work}/openapi.yaml`, rawText);
  writeFileSync(`${work}/pointer.yaml`, 'version https://git-lfs.github.com/spec/v1\noid sha256:' + '1'.repeat(64) + '\nsize 123\n');
  writeFileSync(`${work}/large.yaml`, 'x'.repeat(70000));
  run('/usr/bin/ln', ['-s', 'openapi.yaml', `${work}/link.yaml`]);
  git('add', '.'); git('commit', '-m', 'Owned fixed fixture');
  const commitOid = git('rev-parse', 'HEAD');
  const blobOid = git('rev-parse', 'HEAD:openapi.yaml');
  git('update-index', '--add', '--cacheinfo', `160000,${commitOid},submodule`); git('commit', '-m', 'Owned gitlink fixture');
  const fixedCommitOid = git('rev-parse', 'HEAD');
  git('tag', '-a', 'owned-tag', '-m', 'Owned annotated tag', fixedCommitOid);
  git('update-ref', 'refs/tags/owned-blob', blobOid);
  run('/usr/bin/git', ['clone', '--bare', work, `${root}/repo-${format}.git`]);
  const movedRawText = rawText.replace('Owned fixture', 'Owned moved fixture').replace('1.0.0', '2.0.0');
  writeFileSync(`${work}/openapi.yaml`, movedRawText); git('add', 'openapi.yaml'); git('commit', '-m', 'Owned moved branch');
  const movedCommitOid = git('rev-parse', 'HEAD'); const movedBlobOid = git('rev-parse', 'HEAD:openapi.yaml');
  run('/usr/bin/git', [`--git-dir=${root}/repo-${format}.git`, 'fetch', work, 'main']);
  repositories[format] = { commitOid: fixedCommitOid, blobOid, rawText, movedCommitOid, movedBlobOid, movedRawText };
  writeFileSync(`${work}/invalid-utf8.yaml`, Buffer.from([0xff])); git('add', 'invalid-utf8.yaml'); git('commit', '-m', 'Owned invalid UTF-8 source');
  run('/usr/bin/git', [`--git-dir=${root}/repo-${format}.git`, 'fetch', work, 'main']);
  run('/usr/bin/git', [`--git-dir=${root}/repo-${format}.git`, 'update-ref', 'refs/heads/invalid-utf8', git('rev-parse', 'HEAD')]);
}
run('/usr/sbin/useradd', ['-M', '-d', root, '-s', '/bin/sh', 'ownedgit']);
// Unlock the account without enabling password authentication.
run('/usr/sbin/usermod', ['-p', '*', 'ownedgit']);
write('serve-git', `#!/bin/sh
case "$SSH_ORIGINAL_COMMAND" in
"git-upload-pack '/fixture/repo-sha1.git'") repo=/fixture/repo-sha1.git;;
"git-upload-pack '/fixture/repo-sha256.git'") repo=/fixture/repo-sha256.git;;
*) exit 126;;
esac
printf "ssh\\n" >> /fixture/uploads
while test -f /fixture/pause-uploads; do /bin/sleep 0.02; done
exec /usr/bin/git-upload-pack "$repo"
`, 0o755);
write('authorized_keys', `restrict,command="/fixture/serve-git" ${readFileSync(`${root}/client.pub`, 'utf8')}`, 0o644);
write('uploads', '', 0o666);
run('/usr/bin/chown', ['-R', 'ownedgit:ownedgit', `${root}/repo-sha1.git`, `${root}/repo-sha256.git`]);
write('sshd_config', `Port 2222\nListenAddress 0.0.0.0\nHostKey ${root}/host\nPidFile ${root}/sshd.pid\nAuthorizedKeysFile ${root}/authorized_keys\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nAllowUsers ownedgit\nLogLevel VERBOSE\n`);
const sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', `${root}/sshd_config`], { stdio: ['ignore', 'ignore', 'inherit'] });
sshd.on('exit', code => { if (code) process.exit(code); });
const server = createServer({ key: readFileSync(`${root}/server.key`), cert: readFileSync(`${root}/server.pem`) }, (req, res) => {
  appendFileSync(`${root}/http-requests`, JSON.stringify({ method: req.method, path: req.url, authorization: req.headers.authorization, internalToken: req.headers['x-apicc-source-token'], contentType: req.headers['content-type'] }) + '\n');
  if (req.headers.authorization !== 'Basic b3duZWQ6c3ludGhldGlj') { res.writeHead(401, { 'www-authenticate': 'Basic realm="owned"' }); res.end(); return; }
  const url = new URL(req.url, 'https://owned.git.test');
  if (url.pathname.startsWith('/redirect.git/')) { res.writeHead(302, { location: '/repo-sha1.git/info/refs?service=git-upload-pack' }); res.end(); return; }
  if (!/^\/repo-sha(?:1|256)\.git\//.test(url.pathname)) { res.writeHead(404); res.end(); return; }
  if (url.pathname.endsWith('/git-upload-pack')) appendFileSync(`${root}/uploads`, 'https\n');
  const start = () => {
  const backend = spawn('/usr/lib/git-core/git-http-backend', [], { env: { PATH: '/usr/bin:/bin', GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', REQUEST_METHOD: req.method, PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: req.headers['content-type'] ?? '', CONTENT_LENGTH: req.headers['content-length'] ?? '', REMOTE_USER: 'ownedgit', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let header = Buffer.alloc(0); let started = false;
  backend.stdout.on('data', chunk => {
    if (started) { res.write(chunk); return; }
    header = Buffer.concat([header, chunk]); const split = header.indexOf('\r\n\r\n'); if (split < 0) return;
    const lines = header.subarray(0, split).toString().split('\r\n'); const headers = {}; let status = 200;
    for (const line of lines) { const at = line.indexOf(':'); if (at < 0) continue; const key = line.slice(0, at); const value = line.slice(at + 1).trim(); if (key.toLowerCase() === 'status') status = Number(value.slice(0, 3)); else headers[key] = value; }
    res.writeHead(status, headers); started = true; res.write(header.subarray(split + 4));
  });
  backend.on('exit', () => { if (!started) res.writeHead(502); res.end(); }); req.pipe(backend.stdin); res.on('close', () => { if (backend.exitCode === null) backend.kill(); });
  };
  if (url.pathname.endsWith('/git-upload-pack') && existsSync(`${root}/pause-uploads`)) {
    const waiting = setInterval(() => { if (!existsSync(`${root}/pause-uploads`)) { clearInterval(waiting); if (!res.destroyed) start(); } }, 20);
    res.on('close', () => clearInterval(waiting));
  } else start();
});
write('http-requests', ''); let activeHttpSockets = 0; write('http-active', '0');
server.on('connection', socket => { activeHttpSockets++; write('http-active', String(activeHttpSockets)); socket.on('close', () => { activeHttpSockets--; write('http-active', String(activeHttpSockets)); }); });
server.listen(8443, '0.0.0.0', () => write('ready.json', JSON.stringify({ repositories })));
process.on('SIGTERM', () => { server.close(); sshd.kill(); });
