import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Catch the real gate exporting every Get-Command candidate as one unusable
// ProcessBuilder executable. Execute its actual assignment, not a copied resolver.
test('Windows gate exports one runnable Node22.19.0 path when PATH has multiple real candidates', {
  skip: process.platform !== 'win32',
}, () => {
  const candidateDirectory = mkdtempSync(join(tmpdir(), 'apicc-gate-node-'));
  const extraNode = join(candidateDirectory, 'node.exe');
  copyFileSync(process.execPath, extraNode);
  try {
  const gate = fileURLToPath(new URL('../test-all.ps1', import.meta.url));
  const command = String.raw`
$ErrorActionPreference = 'Stop'
$candidates = @((Get-Command node -CommandType Application).Source | Select-Object -Unique)
if ($candidates.Count -lt 2) { throw 'TEST_PREREQUISITE: at least two real Node executable candidates are required' }
foreach ($candidate in $candidates) {
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw 'TEST_PREREQUISITE: Node candidate does not exist' }
}
$firstVersion = (& node --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $firstVersion -ne 'v22.19.0') { throw 'TEST_PREREQUISITE: first Node must be exactly v22.19.0' }
Write-Output "REAL_CANDIDATES=$($candidates.Count) FIRST_VERSION=$firstVersion"
$tokens = $null; $parseErrors = $null
$gateAst = [System.Management.Automation.Language.Parser]::ParseFile('${gate.replaceAll("'", "''")}', [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Gate script must parse before exercising its executable selection' }
$assignments = @($gateAst.FindAll({ param($item)
  $item -is [System.Management.Automation.Language.AssignmentStatementAst] -and
  $item.Left -is [System.Management.Automation.Language.VariableExpressionAst] -and
  $item.Left.VariablePath.UserPath -eq 'env:APICC_TEST_NODE'
}, $true))
if ($assignments.Count -ne 1) { throw 'Expected exactly one real Java Node executable assignment in gate' }
Invoke-Expression $assignments[0].Extent.Text
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = $env:APICC_TEST_NODE
$start.Arguments = '--version'
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$process = New-Object System.Diagnostics.Process
$process.StartInfo = $start
try {
  [void]$process.Start()
  $selectedVersion = $process.StandardOutput.ReadToEnd().Trim()
  $process.WaitForExit()
  if ($process.ExitCode -ne 0 -or $selectedVersion -ne 'v22.19.0') { throw 'Selected executable must run exactly Node22.19.0' }
  if (-not (Test-Path -LiteralPath $env:APICC_TEST_NODE -PathType Leaf)) { throw 'Selected executable must be a single existing path' }
  Write-Output "SELECTED_NODE=$env:APICC_TEST_NODE VERSION=$selectedVersion"
} finally { $process.Dispose() }
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', timeout: 30_000, windowsHide: true,
    env: { ...process.env, PATH: `${dirname(process.execPath)};${candidateDirectory};${process.env.PATH ?? ''}` },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /REAL_CANDIDATES=\d+ FIRST_VERSION=v22\.19\.0/);
  assert.match(result.stdout, /SELECTED_NODE=.+ VERSION=v22\.19\.0/);
  process.stdout.write(result.stdout);
  } finally {
    unlinkSync(extraNode);
    rmdirSync(candidateDirectory);
  }
});
