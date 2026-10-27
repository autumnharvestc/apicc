$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Invoke-Checked([string]$FilePath, [string[]]$Arguments) {
  Write-Host ("[RUN] " + $FilePath + " " + ($Arguments -join ' '))
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) { throw "外部命令失败（exit $LASTEXITCODE）：$FilePath" }
}
function Invoke-Pnpm([string[]]$PnpmArguments) {
  if ($env:APICC_PNPM_CLI) { Invoke-Checked 'node' (@($env:APICC_PNPM_CLI, '--config.verify-deps-before-run=false') + $PnpmArguments) }
  else { Invoke-Checked 'pnpm' (@('--config.verify-deps-before-run=false') + $PnpmArguments) }
}
$env:npm_config_verify_deps_before_run = 'false'

if ([string]::IsNullOrWhiteSpace($env:JAVA_HOME)) { throw 'JAVA_HOME 必须指向 JDK 21 根目录。' }
$javaExe = Join-Path -Path $env:JAVA_HOME -ChildPath 'bin/java.exe'
if (-not (Test-Path -LiteralPath $javaExe -PathType Leaf)) { throw "JAVA_HOME 无效，缺少：$javaExe" }

# Java -version 正常写 stderr；用 Process 捕获两个流，避免 PowerShell 5 Stop 将正常 stderr 当异常。
$javaInfo = New-Object System.Diagnostics.ProcessStartInfo
$javaInfo.FileName = $javaExe
$javaInfo.Arguments = '-version'
$javaInfo.UseShellExecute = $false
$javaInfo.CreateNoWindow = $true
$javaInfo.RedirectStandardOutput = $true
$javaInfo.RedirectStandardError = $true
$javaProc = New-Object System.Diagnostics.Process
$javaProc.StartInfo = $javaInfo
try {
  [void]$javaProc.Start()
  $javaStdout = $javaProc.StandardOutput.ReadToEnd()
  $javaStderr = $javaProc.StandardError.ReadToEnd()
  $javaProc.WaitForExit()
  if ($javaProc.ExitCode -ne 0) { throw "java -version 失败（exit $($javaProc.ExitCode)）：$javaStderr$javaStdout" }
  $javaText = "$javaStdout`n$javaStderr"
  $javaMatch = [regex]::Match($javaText, 'version\s+"(\d+)')
  if (-not $javaMatch.Success -or [int]$javaMatch.Groups[1].Value -ne 21) { throw "必须使用 Java 21，实际输出：$javaText" }
  Write-Host '[GATE] Java 21 OK'
} finally {
  if ($javaProc) { $javaProc.Dispose() }
}

$nodeVersion = (& node --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw "node --version 失败（exit $LASTEXITCODE）" }
$nodeMatch = [regex]::Match($nodeVersion, '^v(\d+)\.(\d+)\.(\d+)')
if ($nodeVersion -ne 'v22.19.0') { throw "最终候选门禁要求固定 Node22.19.0，实际：$nodeVersion" }
Write-Host "[GATE] $nodeVersion OK"
Invoke-Pnpm @('--version')
$nestedPnpmVersion = (& pnpm --config.verify-deps-before-run=false --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $nestedPnpmVersion -ne '11.21.0') { throw "脚本内嵌 pnpm 也必须由 PATH 解析为11.21.0，实际：$nestedPnpmVersion；请在当前子进程PATH前置同版本shim。" }

Invoke-Checked 'node' @('scripts/check-brand-neutral.mjs', '--self-check')
Invoke-Checked 'node' @('--test', 'scripts/tests/check-brand-neutral.test.mjs')
Invoke-Checked 'node' @('scripts/check-brand-neutral.mjs', '--include-untracked')
foreach ($package in @('packages/plugin-sdk', 'packages/core', 'packages/execution')) {
  Invoke-Pnpm @('-C', $package, 'build')
  Invoke-Pnpm @('-C', $package, 'typecheck')
}
Invoke-Pnpm @('-C', 'packages/execution', 'check:java-input-schema')
foreach ($package in @('apps/runner-agent', 'apps/desktop', 'apps/admin-web', 'packages/cli')) {
  Invoke-Pnpm @('-C', $package, 'build')
  # desktop/admin build already include their src+tests type checks.
  if ($package -in @('apps/runner-agent', 'packages/cli')) { Invoke-Pnpm @('-C', $package, 'typecheck') }
}
Invoke-Pnpm @('-r', '--workspace-concurrency=1', 'test', '--maxWorkers=2')

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("apicc-maven-gate-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempRoot | Out-Null
try {
  $mvn = Join-Path $repoRoot 'server/mvnw.cmd'
  if (-not (Test-Path -LiteralPath $mvn -PathType Leaf)) { throw "缺少 Maven wrapper：$mvn" }
  Invoke-Checked $mvn @('-s', 'server/.mvn/settings.xml', '-f', 'server/pom.xml', "-Dapicc.build.directory=$tempRoot", 'test')
} finally {
  if ([IO.Path]::GetFullPath($tempRoot).StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
Write-Host '[DONE] Windows full gate passed.'
