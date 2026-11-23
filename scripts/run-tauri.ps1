param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('dev', 'build')]
  [string]$Mode,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ExtraArgs
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

& (Join-Path $PSScriptRoot 'stage-vcrt.ps1')

if ($Mode -eq 'build') {
  Push-Location $root
  try {
    & npm run build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  } finally {
    Pop-Location
  }
}

$tauriCmd = Join-Path $root 'node_modules\.bin\tauri.cmd'
if (-not (Test-Path -LiteralPath $tauriCmd)) {
  throw "未找到 $tauriCmd，请先在项目根目录执行 npm install"
}

Push-Location (Join-Path $root 'desktop')
try {
  & $tauriCmd $Mode @ExtraArgs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}
