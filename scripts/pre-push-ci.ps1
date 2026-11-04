$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Invoke-Checked([string]$FilePath, [string[]]$Arguments) {
  Write-Host ("[RUN] " + $FilePath + " " + ($Arguments -join ' '))
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$FilePath 失败（exit $LASTEXITCODE）" }
}

# The bundle is the only source for the Linux suite. A dirty tree could make
# Windows and Linux silently test different candidates, so reject it first.
$dirty = & git status --porcelain --untracked-files=normal
if ($LASTEXITCODE -ne 0) { throw '无法读取 git 候选状态。' }
$candidateSha = (& git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $candidateSha -notmatch '^[a-f0-9]{40}$') { throw '无法确定候选 HEAD。' }
Write-Host "[CANDIDATE] $candidateSha"

$runId = [guid]::NewGuid().ToString('N')
$volume = "apicc-ci88-$runId"
$container = "apicc-ci88-suite-$runId"
$localEvidence = Join-Path $repoRoot "local/ci88-fix/pre-push-$runId"
New-Item -ItemType Directory -Path $localEvidence -Force | Out-Null
$bundle = Join-Path $localEvidence 'candidate.bundle'
$receiptPath = Join-Path $localEvidence 'receipt.json'
$receipt = [ordered]@{
  candidateSha = $candidateSha
  startedAt = (Get-Date).ToUniversalTime().ToString('o')
  finishedAt = $null
  passed = $false
  error = $null
  tools = [ordered]@{}
  stages = @()
  evidence = @()
  evidenceCopied = $false
  cleanup = @()
  finalHead = $null
  finalClean = $false
}
function Save-Receipt {
  $receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $receiptPath -Encoding utf8
}
function Invoke-Logged([string]$Name, [string]$FilePath, [string[]]$Arguments) {
  $log = Join-Path $localEvidence "$Name.log"
  $entry = [ordered]@{ name = $Name; startedAt = (Get-Date).ToUniversalTime().ToString('o'); finishedAt = $null; exitCode = $null; passed = $false; log = $log; error = $null }
  $receipt.stages += $entry
  Write-Host ("[RUN $Name] " + $FilePath + " " + ($Arguments -join ' '))
  try {
    & $FilePath @Arguments 2>&1 | Tee-Object -FilePath $log
    $entry.exitCode = $LASTEXITCODE
    if ($entry.exitCode -ne 0) { throw "$FilePath 失败（exit $($entry.exitCode)）" }
    $entry.passed = $true
  } catch {
    if ($null -eq $entry.exitCode) { $entry.exitCode = -1 }
    $entry.error = $_.Exception.Message
    throw
  } finally {
    $entry.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
    Save-Receipt
  }
}
function Assert-Evidence([string]$Stage, [string]$Pattern) {
  $matches = @(Get-ChildItem -Path (Join-Path $localEvidence "linux/$Stage/$Pattern") -File -ErrorAction SilentlyContinue)
  if ($matches.Count -eq 0) { throw "缺少 $Stage 的必要证据：$Pattern" }
}
$volumeCreated = $false
$containerCreated = $false
$gateError = $null
Save-Receipt
if ($dirty) {
  $receipt.error = "推送前门禁需要已提交且干净的候选工作区：$($dirty -join '; ')"
  $receipt.finalHead = $candidateSha
  $receipt.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
  Save-Receipt
  throw "$($receipt.error)；收据：$receiptPath"
}
try {
  Invoke-Logged 'docker-info' 'docker' @('info', '--format', '{{.ServerVersion}}')
  Invoke-Logged 'docker-compose' 'docker' @('compose', 'version')
  $receipt.tools.docker = (Get-Content -LiteralPath (Join-Path $localEvidence 'docker-info.log') -Raw).Trim()
  $receipt.tools.compose = (Get-Content -LiteralPath (Join-Path $localEvidence 'docker-compose.log') -Raw).Trim()
  $nodeVersion = (& node --version).Trim()
  if ($LASTEXITCODE -ne 0 -or $nodeVersion -ne 'v22.19.0') { throw "Node 必须是 v22.19.0，实际：$nodeVersion" }
  $pnpmVersion = (& pnpm --version).Trim()
  if ($LASTEXITCODE -ne 0 -or $pnpmVersion -ne '11.21.0') { throw "pnpm 必须是 11.21.0，实际：$pnpmVersion" }
  $receipt.tools.windowsNode = $nodeVersion
  $receipt.tools.windowsPnpm = $pnpmVersion
  Invoke-Logged 'frozen-install' 'pnpm' @('install', '--frozen-lockfile')
  Invoke-Logged 'windows-full' 'pwsh' @('-NoProfile', '-File', 'scripts/test-all.ps1')
  Invoke-Logged 'windows-package' 'node' @('scripts/ci-stage.mjs', 'windows-package')

  Invoke-Logged 'bundle-create' 'git' @('bundle', 'create', $bundle, 'HEAD')
  Invoke-Logged 'bundle-verify' 'git' @('bundle', 'verify', $bundle)
  Invoke-Logged 'tool-image' 'docker' @('build', '--pull', '-f', 'Dockerfile.ci-gate', '-t', 'apicc-ci-gate:ci88', '.')
  $receipt.tools.linux = @(& docker run --rm apicc-ci-gate:ci88 sh -c 'set -e; node --version; pnpm --version; java -version 2>&1; mvn --version; docker compose version')
  if ($LASTEXITCODE -ne 0) { throw 'Linux 测试工具版本读取失败。' }

  Invoke-Logged 'volume-create' 'docker' @('volume', 'create', $volume)
  $volumeCreated = $true
  $mountpoint = (& docker volume inspect $volume --format '{{.Mountpoint}}').Trim()
  if ($LASTEXITCODE -ne 0 -or $mountpoint -notmatch '^/[A-Za-z0-9_./-]+$') { throw "Docker volume 挂载路径无效：$mountpoint" }
  Write-Host "[MOUNTPOINT] $mountpoint"
  $receipt.tools.mountpoint = $mountpoint
  Invoke-Logged 'suite-start' 'docker' @('run', '-d', '--init', '--name', $container, '--mount', "type=volume,source=$volume,target=$mountpoint", '-v', '/var/run/docker.sock:/var/run/docker.sock', '-e', "TMPDIR=$mountpoint/tmp", 'apicc-ci-gate:ci88', 'sleep', 'infinity')
  $containerCreated = $true
  Invoke-Logged 'suite-tmp' 'docker' @('exec', $container, 'mkdir', '-p', "$mountpoint/tmp")
  Invoke-Logged 'bundle-copy' 'docker' @('cp', $bundle, "${container}:${mountpoint}/candidate.bundle")
  foreach ($stage in @('linux-test', 'linux-server', 'brand')) {
    $stageScript = @'
set -euo pipefail
mount='{MOUNT}'
sha='{SHA}'
stage='{STAGE}'
repo="$mount/$stage"
git init -q "$repo"
git -C "$repo" fetch -q "$mount/candidate.bundle" HEAD
git -C "$repo" checkout --detach -q "$sha"
test "$(git -C "$repo" rev-parse HEAD)" = "$sha"
cd "$repo"
export APICC_RUNNER_E2E_HOST="$(hostname -i | cut -d ' ' -f 1)"
export APICC_STRESS_DIAGNOSTICS_DIR="$repo/local/ci-stress-diagnostics"
node scripts/ci-stage.mjs "$stage"
'@
    # Native Bash receives the here-string bytes, including checkout CRLF.
    $stageScript = $stageScript.Replace("`r`n", "`n").Replace('{MOUNT}', $mountpoint).Replace('{SHA}', $candidateSha).Replace('{STAGE}', $stage)
    Invoke-Logged $stage 'docker' @('exec', $container, 'bash', '-o', 'pipefail', '-c', $stageScript)
  }
} catch {
  $gateError = $_.Exception.Message
} finally {
  if ($containerCreated) {
    try {
      $copyScript = @'
set -euo pipefail
mount='{MOUNT}'
for stage in linux-test linux-server brand; do
  repo="$mount/$stage"
  [ -d "$repo" ] || continue
  cd "$repo"
  for file in server/target/surefire-reports/*.xml local/ci-stress-diagnostics/normal-eight-*/summary.json local/ci-stress-diagnostics/normal-eight-*/diagnostics.json local/ci-stress-diagnostics/normal-eight-*/capture.json local/f7f-acceptance/composition-*/facts.json local/f7f-acceptance/composition-*/cleanup.json local/f7f-acceptance/composition-*/result.json; do
    [ -f "$file" ] || continue
    dst="$mount/ci88-evidence/$stage/$file"
    mkdir -p "$(dirname "$dst")"
    cp -- "$file" "$dst"
  done
done
'@
      $copyScript = $copyScript.Replace("`r`n", "`n").Replace('{MOUNT}', $mountpoint)
      Invoke-Logged 'evidence-select' 'docker' @('exec', $container, 'bash', '-o', 'pipefail', '-c', $copyScript)
      $linuxEvidence = Join-Path $localEvidence 'linux'
      New-Item -ItemType Directory -Path $linuxEvidence -Force | Out-Null
      Invoke-Logged 'evidence-copy' 'docker' @('cp', "${container}:${mountpoint}/ci88-evidence/.", $linuxEvidence)
      $receipt.evidence = @(Get-ChildItem -LiteralPath $linuxEvidence -File -Recurse | ForEach-Object { $_.FullName.Substring($linuxEvidence.Length + 1) })
      $receipt.evidenceCopied = $true
      if (-not $gateError) {
        Assert-Evidence 'linux-server' 'server/target/surefire-reports/*.xml'
        Assert-Evidence 'linux-test' 'local/f7f-acceptance/composition-*/facts.json'
      }
    } catch {
      if (-not $gateError) { $gateError = $_.Exception.Message }
      $receipt.evidenceCopied = $false
    }
  }
  if ($containerCreated) {
    try { Invoke-Checked 'docker' @('rm', '-f', $container); $receipt.cleanup += "container:${container}:removed" }
    catch { $receipt.cleanup += "container:${container}:FAILED:$($_.Exception.Message)"; if (-not $gateError) { $gateError = $_.Exception.Message } }
  }
  if ($volumeCreated) {
    try { Invoke-Checked 'docker' @('volume', 'rm', $volume); $receipt.cleanup += "volume:${volume}:removed" }
    catch { $receipt.cleanup += "volume:${volume}:FAILED:$($_.Exception.Message)"; if (-not $gateError) { $gateError = $_.Exception.Message } }
  }
  if (-not $gateError -and $receipt.evidenceCopied) {
    try {
      $runnerPattern = Join-Path $repoRoot 'local/f7b-t11/apicc-runner-smoke-*.json'
      $collaborationPattern = Join-Path $repoRoot 'local/f7f-acceptance/containers-*/containers.json'
      $runnerBefore = @(Get-ChildItem -Path $runnerPattern -File -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
      $collaborationBefore = @(Get-ChildItem -Path $collaborationPattern -File -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
      Invoke-Logged 'deployment' 'node' @('scripts/ci-stage.mjs', 'deployment')
      $runnerNew = @(Get-ChildItem -Path $runnerPattern -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notin $runnerBefore })
      $collaborationNew = @(Get-ChildItem -Path $collaborationPattern -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notin $collaborationBefore })
      if ($runnerNew.Count -eq 0 -or $collaborationNew.Count -eq 0) { throw '部署冒烟缺少本次新生成的 runner 或 collaboration 证据。' }
      foreach ($file in @($runnerNew) + @($collaborationNew)) {
        $result = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
        if ($result.passed -ne $true) { throw "本次部署冒烟证据未通过：$($file.FullName)" }
        $receipt.evidence += $file.FullName.Substring($repoRoot.Length + 1)
      }
    } catch {
      $gateError = $_.Exception.Message
    }
  }
  $finalHead = (& git rev-parse HEAD).Trim()
  $headExit = $LASTEXITCODE
  $finalDirty = @(& git status --porcelain --untracked-files=normal)
  $statusExit = $LASTEXITCODE
  $receipt.finalHead = $finalHead
  $receipt.finalClean = ($statusExit -eq 0 -and $finalDirty.Count -eq 0)
  if (($headExit -ne 0 -or $finalHead -ne $candidateSha -or -not $receipt.finalClean) -and -not $gateError) { $gateError = '长跑后 HEAD 或工作区状态与开始时不同。' }
  $receipt.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
  $receipt.error = $gateError
  $required = @('frozen-install', 'windows-full', 'windows-package', 'linux-test', 'linux-server', 'brand', 'deployment')
  $passedNames = @($receipt.stages | Where-Object { $_.passed } | ForEach-Object { $_.name })
  $receipt.passed = (-not $gateError -and $receipt.evidenceCopied -and @($required | Where-Object { $_ -notin $passedNames }).Count -eq 0)
  Save-Receipt
  Write-Host "[EVIDENCE] $receiptPath"
}
if (-not $receipt.passed) { throw "推送前门禁失败：$($receipt.error)；收据：$receiptPath" }
Write-Host "[DONE] $candidateSha 的完整推送前门禁通过；收据：$receiptPath"
