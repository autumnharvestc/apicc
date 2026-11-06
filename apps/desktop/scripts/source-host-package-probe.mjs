// Executed by the packaged Electron Node host. Every import resolves inside the
// package; source node_modules and a Docker daemon are not prerequisites.
async function probe(resources, privateRoot) {
  const assert = require('node:assert/strict'), path = require('node:path');
  const fs = require('node:fs/promises'), { createRequire } = require('node:module');
  const local = createRequire(path.join(resources, 'app.asar', 'package.json'));
  const entry = local.resolve('@apicc/execution/source-host');
  assert.ok(entry.includes('app.asar'));
  const { runOwnedProcess } = local(path.join(path.dirname(entry), 'process.js'));
  const { probeSourceGitTools } = local(path.join(path.dirname(entry), 'tools.js'));
  const directory = await fs.mkdtemp(path.join(privateRoot, 'packaged-source-'));
  const pidFile = path.join(directory, 'descendant.pid');
  let pid;
  try {
    const descendant = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`;
    const script = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});c.unref();setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(pidFile)}))process.exit(0)},10);`;
    const result = await runOwnedProcess({ toolPath: process.execPath, args: ['-e', script], cwd: directory,
      env: { SystemRoot: process.env.SystemRoot, ELECTRON_RUN_AS_NODE: '1' }, maxOutputBytes: 16384, signal: AbortSignal.timeout(15000) });
    pid = Number(await fs.readFile(pidFile, 'utf8'));
    let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
    assert.equal(result.collected, true); assert.equal(result.exitCode, 0); assert.equal(alive, false);
    await assert.rejects(probeSourceGitTools({ gitPath: path.join(directory, 'intentionally-missing-git.exe') }, new AbortController().signal, 'git-https', directory), { code: 'SYNC_TOOL_UNAVAILABLE' });
    console.log('PACKAGED_SOURCE_HOST_READY ' + JSON.stringify({ entry, descendantPid: pid, descendantAlive: alive, collected: result.collected, missingToolCode: 'SYNC_TOOL_UNAVAILABLE' }));
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await fs.rm(directory, { recursive: true, force: true });
  }
}
export const packagedSourceHostProbe = (resources, privateRoot) => `(${probe.toString()})(${JSON.stringify(resources)},${JSON.stringify(privateRoot)}).catch(error=>{console.error(error);process.exitCode=1});`;
