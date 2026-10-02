[CmdletBinding()]
param(
    [ValidateSet('template', 'ready')]
    [string]$Mode = 'template',
    [switch]$CheckDocker
)

$ErrorActionPreference = 'Stop'
$manifestDir = $PSScriptRoot
$secretPath = Join-Path $manifestDir 'secret.yaml'

function Require-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing command: $Name"
    }
}

Require-Command 'kubectl'
Require-Command 'git'

$rendered = (& kubectl kustomize $manifestDir 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) {
    throw 'kubectl kustomize failed.'
}

$requiredKinds = @('kind: Deployment', 'kind: Service', 'kind: PersistentVolumeClaim')
foreach ($kind in $requiredKinds) {
    if (-not $rendered.Contains($kind)) {
        throw "Rendered output is missing $kind."
    }
}

if ($Mode -eq 'ready') {
    if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) {
        throw 'Ready mode requires secret.yaml copied from secret.example.yaml.'
    }

    # 只检查占位符和 Git 忽略状态，不打印 Secret 内容。
    $secretText = Get-Content -LiteralPath $secretPath -Raw -Encoding utf8
    if ($secretText -match 'REPLACE_|PASSWORD|YOUR_|EXAMPLE') {
        throw 'secret.yaml still contains placeholders; content was not printed.'
    }

    & git check-ignore --quiet -- $secretPath
    if ($LASTEXITCODE -ne 0) {
        throw 'secret.yaml is not ignored by .gitignore; refusing to continue.'
    }

    if ($rendered -match 'REPLACE_WITH_|REPLACE_ME') {
        throw 'Kustomize images still contain placeholders; set an immutable registry and Git SHA.'
    }
}

if ($CheckDocker) {
    Require-Command 'docker'
    & docker info --format '{{.ServerVersion}}' *> $null
    if ($LASTEXITCODE -ne 0) {
        throw 'Docker daemon is unavailable.'
    }
}

$modeLabel = if ($Mode -eq 'ready') { 'ready (secret and image placeholders checked)' } else { 'template (placeholders allowed)' }
Write-Output "Sealos preflight passed: $modeLabel"
if ($CheckDocker) { Write-Output 'Docker daemon check passed.' }
