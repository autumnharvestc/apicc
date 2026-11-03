import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { acceptanceOptions } from '../f7f-acceptance.mjs';
import { assembleShareViewer } from '../assemble-share-viewer.mjs';
import { runEvidenceCommand, candidateIdentity } from '../lib/f7f-evidence.mjs';

const repo = resolve(import.meta.dirname, '../..');
test('production mode is rejected before even an invalid evidence destination is touched', () => {
  const result = spawnSync(process.execPath, ['scripts/f7f-acceptance.mjs', '--mode=production', '--evidence-root=Z:/not-a-synthetic-root'], { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SYNTHETIC_ONLY/);
  assert.doesNotMatch(result.stderr, /at file:|ENOENT|EACCES/);
});
test('explicit synthetic mode accepts the documented invocation', () => {
  assert.equal(acceptanceOptions(['--mode=synthetic', '--evidence-root=local/f7f-acceptance']).mode, 'synthetic');
});
test('missing, duplicate and unrecognized modes cannot launch resources', () => {
  for (const args of [[], ['--mode='], ['--mode=test'], ['--mode=synthetic', '--mode=production']]) {
    assert.throws(() => acceptanceOptions(args), /SYNTHETIC_ONLY/);
  }
});
test('synthetic output refuses user roots and unknown arguments', () => {
  for (const args of [['--evidence-root=../project'], ['--evidence-root=C:/Users'], ['--project=real']]) {
    assert.throws(() => acceptanceOptions(['--mode=synthetic', ...args]), /SYNTHETIC_EVIDENCE_ROOT|ARGUMENT_INVALID/);
  }
});
test('viewer delivery copies the three fixed files independently of console', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apicc-t12-assembly-'));
  const source = join(root, 'dist'), destination = join(root, 'share-viewer');
  await mkdir(source);
  for (const name of ['index.html', 'viewer.js', 'viewer.css']) await writeFile(join(source, name), `synthetic ${name}`);
  await writeFile(join(source, 'admin.js'), 'never deliver');
  const files = await assembleShareViewer({ source, destination, consoleDirectory: join(root, 'console') });
  assert.equal(files.length, 3);
  assert.deepEqual((await readdir(destination)).sort(), ['index.html', 'viewer.css', 'viewer.js']);
  assert.equal(await readFile(join(destination, 'viewer.js'), 'utf8'), 'synthetic viewer.js');
});
test('viewer assembly refuses console overlap and incomplete build before copying', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apicc-t12-incomplete-'));
  const source = join(root, 'dist'); await mkdir(source); await writeFile(join(source, 'index.html'), 'synthetic');
  await assert.rejects(assembleShareViewer({ source, destination: join(root, 'share-viewer') }), /SHARE_VIEWER_BUILD_REQUIRED/);
  for (const destination of [join(root, 'console'), join(root, 'console', 'share-viewer'), root]) {
    await assert.rejects(assembleShareViewer({ source, destination, consoleDirectory: join(root, 'console') }), /SHARE_VIEWER_CONSOLE_OVERLAP/);
  }
});
test('actual command exit cannot become an evidence pass', async () => {
  const good = await runEvidenceCommand({ command: process.execPath, args: ['-e', 'console.log("synthetic-control")'], cwd: repo });
  assert.equal(good.passed, true); assert.equal(good.exitCode, 0);
  const bad = await runEvidenceCommand({ command: process.execPath, args: ['-e', 'process.exit(7)'], cwd: repo });
  assert.equal(bad.passed, false); assert.equal(bad.exitCode, 7);
});
test('an owned timed out process is collected and never passes', async () => {
  const result = await runEvidenceCommand({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: repo, timeoutMs: 150 });
  assert.equal(result.passed, false); assert.equal(result.timedOut, true); assert.equal(result.collected, true);
});
test('candidate identity hashes actual source and built viewer separately without using the real index', async () => {
  const identity = await candidateIdentity(repo);
  assert.equal(identity.head, spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', windowsHide: true }).stdout.trim());
  assert.match(identity.sourceSha256, /^[a-f0-9]{64}$/); assert.match(identity.indexSha256, /^[a-f0-9]{64}$/);
  assert.match(identity.packages.viewer['viewer.js'], /^[a-f0-9]{64}$/);
});
test('a legal synthetic invocation explains a missing Java prerequisite instead of claiming groups ran', () => {
  const result = spawnSync(process.execPath, ['scripts/f7f-acceptance.mjs', '--mode=synthetic', '--evidence-root=local/f7f-acceptance'], {
    cwd: repo, encoding: 'utf8', windowsHide: true, env: { ...process.env, JAVA_HOME: 'Z:/apicc-synthetic-missing-jdk' },
  });
  assert.equal(result.status, 1); assert.match(result.stderr, /PREREQUISITE_JAVA21/); assert.doesNotMatch(result.stdout, /passed|G1.*OK|G5.*OK/);
});
