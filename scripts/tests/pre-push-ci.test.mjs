import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const original = resolve(import.meta.dirname, '../pre-push-ci.ps1');
const pwsh = process.platform === 'win32' ? spawnSync('where.exe', ['pwsh'], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/)[0] : '';

function git(repo, ...args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
}

test('Linux stage and evidence commands use Unix newlines from either Windows checkout format', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'apicc-ci88-bash-'));
  try {
    const harness = join(root, 'capture.ps1');
    await writeFile(harness, `
$ErrorActionPreference = 'Stop'
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:CI88_SOURCE, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Invalid source fixture' }
$assignments = @($ast.FindAll({ param($item) $item -is [System.Management.Automation.Language.AssignmentStatementAst] -and $item.Left -is [System.Management.Automation.Language.VariableExpressionAst] -and $item.Left.VariablePath.UserPath -in @('stageScript', 'copyScript') }, $true))
$commands = @($ast.FindAll({ param($item) $item -is [System.Management.Automation.Language.CommandAst] -and $item.GetCommandName() -eq 'Invoke-Logged' }, $true))
$stageCommand = @($commands | Where-Object { $_.CommandElements[1].Extent.Text -eq '$stage' })
$copyCommand = @($commands | Where-Object { $_.CommandElements[1].Value -eq 'evidence-select' })
if ($stageCommand.Count -ne 1 -or $copyCommand.Count -ne 1) { throw 'Missing real Bash boundary' }
function Invoke-Logged([string]$Name, [string]$FilePath, [string[]]$Arguments) {
  [pscustomobject]@{ name=$Name; file=$FilePath; arguments=$Arguments } | ConvertTo-Json -Compress -Depth 5
}
$mountpoint = '/var/lib/docker/volumes/apicc-ci88-synthetic/_data'
$candidateSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
$container = 'apicc-ci88-synthetic'
foreach ($stage in @('linux-test','linux-server','brand')) {
  foreach ($assignment in $assignments | Where-Object { $_.Left.VariablePath.UserPath -eq 'stageScript' }) { Invoke-Expression $assignment.Extent.Text }
  Invoke-Expression $stageCommand[0].Extent.Text
}
foreach ($assignment in $assignments | Where-Object { $_.Left.VariablePath.UserPath -eq 'copyScript' }) { Invoke-Expression $assignment.Extent.Text }
Invoke-Expression $copyCommand[0].Extent.Text
`);
    const source = await readFile(original, 'utf8');
    for (const ending of ['\n', '\r\n']) {
      const candidate = join(root, ending === '\n' ? 'lf.ps1' : 'crlf.ps1');
      await writeFile(candidate, source.replace(/\r?\n/g, ending));
      const result = spawnSync(pwsh, ['-NoProfile', '-File', harness], {
        env: { ...process.env, CI88_SOURCE: candidate }, encoding: 'utf8', windowsHide: true,
      });
      assert.equal(result.status, 0, result.stderr);
      const commands = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
      assert.deepEqual(commands.map(command => command.name), ['linux-test','linux-server','brand','evidence-select']);
      for (const command of commands) {
        assert.equal(command.file, 'docker');
        assert.deepEqual(command.arguments.slice(0, 7), ['exec','apicc-ci88-synthetic','bash','-o','pipefail','-c',command.arguments.at(-1)]);
        assert.match(command.arguments.at(-1), /^set -euo pipefail\n/);
        assert.doesNotMatch(command.arguments.at(-1), /\r/, command.name + ' must reach Bash with LF lines');
      }
    }
  } finally {
    const resolved = resolve(root);
    assert.ok(resolved.startsWith(resolve(tmpdir()) + sep));
    await rm(resolved, { recursive: true, force: true });
  }
});

test('pre-push rejects dirty candidates and failed external commands before later stages', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'apicc-ci88-prepush-'));
  const repo = join(root, 'repo'), bin = join(root, 'bin'), log = join(root, 'commands.log');
  try {
    await mkdir(join(repo, 'scripts'), { recursive: true });
    await mkdir(bin);
    await copyFile(original, join(repo, 'scripts', 'pre-push-ci.ps1'));
    await writeFile(join(repo, 'scripts', 'test-all.ps1'), "Write-Output 'SYNTHETIC_WINDOWS_FAIL'; exit 23\n");
    await writeFile(join(repo, '.gitignore'), 'local/\n');
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.name', 'CI88 Fixture');
    git(repo, 'config', 'user.email', 'ci88@example.invalid');
    git(repo, 'add', '.gitignore', 'scripts/pre-push-ci.ps1', 'scripts/test-all.ps1');
    git(repo, 'commit', '-qm', 'candidate');
    await writeFile(join(bin, 'docker.cmd'), '@echo off\r\necho docker %*>>"%CI88_LOG%"\r\nif "%CI88_DOCKER_FAIL%"=="1" exit /b 17\r\nif "%1"=="info" echo 29.8.0\r\nif "%1"=="compose" echo Docker Compose version v2.39.4\r\nexit /b 0\r\n');
    await writeFile(join(bin, 'node.cmd'), '@echo off\r\necho node %*>>"%CI88_LOG%"\r\nif "%1"=="--version" echo v22.19.0\r\nexit /b 0\r\n');
    await writeFile(join(bin, 'pnpm.cmd'), '@echo off\r\necho pnpm %*>>"%CI88_LOG%"\r\nif "%1"=="--version" echo 11.21.0\r\nif "%1"=="install" if "%CI88_MUTATE%"=="1" echo altered>uncommitted.txt\r\nexit /b 0\r\n');
    const env = { ...process.env, PATH: `${bin}${sep === '\\' ? ';' : ':'}${process.env.PATH}`, CI88_LOG: log };
    const run = (extraEnv = {}) => spawnSync(pwsh, ['-NoProfile', '-File', join(repo, 'scripts', 'pre-push-ci.ps1')], {
      cwd: repo, env: { ...env, ...extraEnv }, encoding: 'utf8', windowsHide: true,
    });

    await writeFile(join(repo, 'uncommitted.txt'), 'dirty');
    const dirty = run();
    assert.notEqual(dirty.status, 0);
    assert.match(dirty.stderr, /uncommitted\.txt/);
    await assert.rejects(readFile(log), /ENOENT/);
    const receipts = async () => (await readdir(join(repo, 'local', 'ci88-fix'))).map(name => join(repo, 'local', 'ci88-fix', name, 'receipt.json'));
    const dirtyReceipts = await receipts();
    assert.equal(dirtyReceipts.length, 1);
    assert.equal(JSON.parse(await readFile(dirtyReceipts[0], 'utf8')).passed, false);

    await rm(join(repo, 'uncommitted.txt'));
    const noDocker = run({ CI88_DOCKER_FAIL: '1' });
    assert.notEqual(noDocker.status, 0);
    assert.match(noDocker.stderr, /docker/);
    assert.equal((await readFile(log, 'utf8')).trim(), 'docker info --format {{.ServerVersion}}');
    const afterDockerFailure = await receipts();
    assert.equal(afterDockerFailure.length, 2);
    const parsedDockerReceipts = await Promise.all(afterDockerFailure.map(async path => JSON.parse(await readFile(path, 'utf8'))));
    const dockerReceipt = parsedDockerReceipts.find(item => item.stages.some(stage => stage.name === 'docker-info'));
    assert.ok(dockerReceipt);
    assert.equal(dockerReceipt.passed, false);
    assert.equal(dockerReceipt.stages.find(stage => stage.name === 'docker-info').exitCode, 17);
    assert.match(dockerReceipt.candidateSha, /^[a-f0-9]{40}$/);

    await writeFile(log, '');
    const failedWindows = run({ CI88_DOCKER_FAIL: '0' });
    assert.notEqual(failedWindows.status, 0);
    assert.match(failedWindows.stdout, /SYNTHETIC_WINDOWS_FAIL/);
    const commands = await readFile(log, 'utf8');
    assert.match(commands, /docker compose version/);
    assert.match(commands, /pnpm install --frozen-lockfile/);
    assert.doesNotMatch(commands, /windows-package/);
    const windowsReceipts = await Promise.all((await receipts()).map(async path => JSON.parse(await readFile(path, 'utf8'))));
    assert.ok(windowsReceipts.some(item => item.stages.find(stage => stage.name === 'windows-full')?.exitCode === 23));

    await writeFile(log, '');
    const mutated = run({ CI88_DOCKER_FAIL: '0', CI88_MUTATE: '1' });
    assert.notEqual(mutated.status, 0);
    const allReceipts = await Promise.all((await receipts()).map(async path => JSON.parse(await readFile(path, 'utf8'))));
    const mutationReceipt = allReceipts.find(item => item.finalClean === false && item.stages.some(stage => stage.name === 'windows-full'));
    assert.ok(mutationReceipt);
    assert.equal(mutationReceipt.finalClean, false);
    assert.equal(mutationReceipt.passed, false);
  } finally {
    const resolved = resolve(root);
    assert.ok(resolved.startsWith(resolve(tmpdir()) + sep));
    await rm(resolved, { recursive: true, force: true });
  }
});
