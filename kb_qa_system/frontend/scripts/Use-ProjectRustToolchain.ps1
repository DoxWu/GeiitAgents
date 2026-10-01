$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$toolsRoot = Join-Path $repoRoot '.tools'
$cargoHome = Join-Path $toolsRoot 'cargo'
$rustupHome = Join-Path $toolsRoot 'rustup'
$settingsPath = Join-Path $rustupHome 'settings.toml'

if (-not (Test-Path -LiteralPath $settingsPath)) {
  throw "Project Rustup settings were not found: $settingsPath"
}

$settings = Get-Content -LiteralPath $settingsPath -Raw
if ($settings -notmatch '(?m)^default_toolchain\s*=\s*"([\w.-]+)"') {
  throw 'Project Rustup default toolchain is not configured.'
}

$toolchainBin = Join-Path $rustupHome "toolchains/$($Matches[1])/bin"
$cargo = Join-Path $toolchainBin 'cargo.exe'
$rustc = Join-Path $toolchainBin 'rustc.exe'
if (-not (Test-Path -LiteralPath $cargo) -or -not (Test-Path -LiteralPath $rustc)) {
  throw "Project Rust toolchain is incomplete: $toolchainBin"
}

$env:CARGO_HOME = $cargoHome
$env:RUSTUP_HOME = $rustupHome
$env:CARGO = $cargo
$env:RUSTC = $rustc
$env:PATH = "$toolchainBin;$($cargoHome)\bin;$env:PATH"
Write-Output "Project Rust toolchain loaded: $(& $cargo --version)"
