import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export async function candidateIdentity(repo) {
  const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }).trim();
  const paths = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))].sort();
  const tree = createHash('sha256');
  for (const path of paths) {
    tree.update(path).update('\0');
    try { tree.update(sha256(await readFile(join(repo, path)))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; tree.update('DELETED'); }
    tree.update('\0');
  }
  const viewer = {};
  for (const file of ['index.html', 'viewer.js', 'viewer.css']) viewer[file] = sha256(await readFile(join(repo, 'apps/share-viewer/dist', file)));
  const core = JSON.parse(await readFile(join(repo, 'server/src/main/resources/collaboration-runtime-boundary.json'), 'utf8')).coreBuildIdentity;
  return { head: git(['rev-parse', 'HEAD']), branch: git(['branch', '--show-current']), sourceSha256: tree.digest('hex'), indexSha256: sha256(await readFile(resolve(repo, git(['rev-parse', '--git-path', 'index'])))), packages: { coreBuildIdentity: core, viewer, runtime: sha256(await readFile(join(repo, 'apps/collaboration-runtime/dist/main.js'))) } };
}

/** Bounded subprocess, no shell interpolation. Only its verified owned PID tree may be stopped. */
export async function runEvidenceCommand({ command, args = [], cwd, timeoutMs = 300000, env = process.env, logFile }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw Error('COMMAND_BUDGET_INVALID');
  if (logFile) { await mkdir(dirname(logFile), { recursive: true }); await appendFile(logFile, `cwd=${cwd}\ncommand=${JSON.stringify([command, ...args])}\n`); }
  const startedAt = new Date().toISOString();
  const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  let stdout = '', stderr = '', timedOut = false, startError, cleanupError;
  let writes = Promise.resolve();
  for (const [stream, name] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) stream.on('data', bytes => {
    if (name === 'stdout') stdout = (stdout + bytes).slice(-1048576); else stderr = (stderr + bytes).slice(-1048576);
    if (logFile) writes = writes.then(() => appendFile(logFile, bytes));
  });
  const stop = () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') {
      const kill = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
      if (kill.status !== 0 && child.exitCode === null) cleanupError = `OWNED_TREE_STOP_FAILED: ${kill.status}`;
    } else { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') cleanupError = error.code; } }
  };
  const timeout = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  const interrupted = () => { timedOut = true; stop(); };
  process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
  const terminal = await new Promise(resolveResult => {
    child.once('error', error => { startError = error.code ?? 'COMMAND_START_FAILED'; });
    child.once('close', (exitCode, signal) => resolveResult({ exitCode, signal }));
  });
  clearTimeout(timeout); process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
  await writes;
  const result = { command, args, cwd, pid: child.pid, startedAt, endedAt: new Date().toISOString(), ...terminal, timedOut, collected: true, startError, cleanupError, passed: terminal.exitCode === 0 && !timedOut && !startError && !cleanupError };
  if (logFile) await appendFile(logFile, `\nPROCESS_RESULT=${JSON.stringify(result)}\n`);
  return { ...result, stdout, stderr };
}
