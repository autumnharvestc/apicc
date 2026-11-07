// Executed by the packaged Electron Node host. Every import resolves inside the
// package; source node_modules and a Docker daemon are not prerequisites.
async function probe(resources, privateRoot) {
  const assert = require('node:assert/strict'), path = require('node:path');
  const fs = require('node:fs/promises'), { createRequire, syncBuiltinESMExports } = require('node:module');
  const childProcess = require('node:child_process'), originalSpawn = childProcess.spawn;
  const start = Date.now(), events = [];
  const record = (kind, facts = {}) => {
    if (events.length >= 16) return;
    const event = { ms: Date.now() - start, kind, ...facts }; events.push(event);
    // Only finite lifecycle facts, never descriptors, environment or raw streams.
    console.log('PACKAGED_SOURCE_HOST_LIFECYCLE ' + JSON.stringify(event));
  };
  childProcess.spawn = function (...args) {
    const child = Reflect.apply(originalSpawn, this, args);
    if (path.basename(args[0]) !== 'owned-process.exe') return child;
    record('helper-spawn', { pid: Number.isInteger(child.pid) ? child.pid : null });
    let pending = '', parsing = true;
    child.stdout.on('data', bytes => {
      if (!parsing) return;
      pending += bytes.toString('utf8');
      if (pending.length > 65536) { pending = ''; parsing = false; record('observation-limit'); return; }
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        try {
          const frame = JSON.parse(line);
          if (frame.kind === 'started') record('started');
          else if (frame.kind === 'collected') record('collected-frame', { activeZero: frame.activeProcesses === 0, exitCode: Number.isInteger(frame.exitCode) ? frame.exitCode : null });
          else if (frame.kind === 'uncollected') record('uncollected-frame');
          else record('unexpected-frame');
        } catch { record('invalid-frame'); }
      }
    });
    child.on('error', () => record('helper-error'));
    child.on('exit', code => record('helper-exit', { code: Number.isInteger(code) ? code : null }));
    child.on('close', code => record('helper-close', { code: Number.isInteger(code) ? code : null }));
    const kill = child.kill;
    child.kill = function (...values) { record('kill-requested'); return Reflect.apply(kill, this, values); };
    return child;
  };
  syncBuiltinESMExports();
  let directory, collectionUnknown = false, stage = 'entry';
  try {
    const local = createRequire(path.join(resources, 'app.asar', 'package.json'));
    const entry = local.resolve('@apicc/execution/source-host');
    assert.ok(entry.includes('app.asar'));
    const { runOwnedProcess } = local(path.join(path.dirname(entry), 'process.js'));
    const { probeSourceGitTools } = local(path.join(path.dirname(entry), 'tools.js'));
    stage = 'fixture'; directory = await fs.mkdtemp(path.join(privateRoot, 'packaged-source-'));
    const pidFile = path.join(directory, 'descendant.pid');
    const descendant = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`;
    const script = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});c.unref();setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(pidFile)}))process.exit(0)},10);`;
    stage = 'owned-process';
    const result = await runOwnedProcess({ toolPath: process.execPath, args: ['-e', script], cwd: directory,
      env: { SystemRoot: process.env.SystemRoot, ELECTRON_RUN_AS_NODE: '1' }, maxOutputBytes: 16384, signal: AbortSignal.timeout(15000) });
    stage = 'descendant-state';
    const pid = Number(await fs.readFile(pidFile, 'utf8'));
    let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
    assert.equal(result.collected, true); assert.equal(result.exitCode, 0); assert.equal(alive, false);
    stage = 'missing-tool';
    await assert.rejects(probeSourceGitTools({ gitPath: path.join(directory, 'intentionally-missing-git.exe') }, new AbortController().signal, 'git-https', directory), { code: 'SYNC_TOOL_UNAVAILABLE' });
    console.log('PACKAGED_SOURCE_HOST_READY ' + JSON.stringify({ entry, descendantPid: pid, descendantAlive: alive, collected: result.collected, missingToolCode: 'SYNC_TOOL_UNAVAILABLE' }));
  } catch (error) {
    const allowed = new Set(['SYNC_PROCESS_UNCOLLECTED', 'SYNC_PROCESS_HELPER_INVALID', 'SYNC_PROCESS_HELPER_UNAVAILABLE', 'SYNC_PROCESS_INPUT_LIMIT', 'SYNC_PROCESS_OUTPUT_LIMIT', 'SYNC_PROCESS_START_FAILED', 'SYNC_INTERRUPTED', 'SYNC_DISK_MONITOR_FAILED', 'SYNC_TOOL_UNAVAILABLE', 'ERR_ASSERTION', 'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ENOENT', 'EACCES', 'EPERM']);
    const code = allowed.has(error?.code) ? error.code : 'PACKAGED_SOURCE_HOST_PROBE_FAILED';
    collectionUnknown = code === 'SYNC_PROCESS_UNCOLLECTED';
    const observation = { code, stage, collectionUnknown, privateFixtureRetained: collectionUnknown && Boolean(directory), events };
    console.error('PACKAGED_SOURCE_HOST_FAILURE ' + JSON.stringify(observation));
    if (collectionUnknown && directory) {
      try { await fs.writeFile(path.join(directory, 'source-host-lifecycle.json'), JSON.stringify(observation) + '\n', { mode: 0o600, flag: 'wx' }); } catch { /* The same bounded evidence remains in the smoke log. */ }
    }
    throw Object.assign(new Error(code), { code });
  } finally {
    childProcess.spawn = originalSpawn; syncBuiltinESMExports();
    // The native helper owns collection. A sampled PID is only an observation;
    // unknown collection retains the fixture and must never guess a PID to kill.
    if (directory && !collectionUnknown) await fs.rm(directory, { recursive: true, force: true });
  }
}
export const packagedSourceHostProbe = (resources, privateRoot) => `(${probe.toString()})(${JSON.stringify(resources)},${JSON.stringify(privateRoot)}).catch(error=>{console.error(error);process.exitCode=1});`;
