param(
  [string]$OutDir = (Join-Path $PSScriptRoot '..\desktop\vcrt')
)

$ErrorActionPreference = 'Stop'

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$roots = @()
if (Test-Path -LiteralPath $vswhere) {
  $vsPath = & $vswhere -latest -products * -property installationPath
  if ($vsPath) { $roots += (Join-Path $vsPath 'VC\Redist\MSVC') }
}
$roots += 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Redist\MSVC'
$roots += 'C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Redist\MSVC'

$redistBase = $roots | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $redistBase) {
  throw "未找到 Visual Studio MSVC Redist 目录，无法打包 CrispASR 所需的 VC++ 运行库"
}

$verDir = Get-ChildItem -LiteralPath $redistBase -Directory |
  Where-Object { $_.Name -match '^\d' } |
  Sort-Object { [version]$_.Name } -Descending |
  Select-Object -First 1
if (-not $verDir) {
  throw "在 $redistBase 下未找到有效版本号目录"
}

$crtDir = Get-ChildItem -LiteralPath (Join-Path $verDir.FullName 'x64') -Directory -Filter 'Microsoft.VC*.CRT' | Select-Object -First 1
$ompDir = Get-ChildItem -LiteralPath (Join-Path $verDir.FullName 'x64') -Directory -Filter 'Microsoft.VC*.OpenMP' | Select-Object -First 1
if (-not $crtDir -or -not $ompDir) {
  throw "未找到 x64 CRT 或 OpenMP 运行库目录"
}

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$needed = @(
  (Join-Path $crtDir.FullName 'msvcp140.dll'),
  (Join-Path $crtDir.FullName 'vcruntime140.dll'),
  (Join-Path $crtDir.FullName 'vcruntime140_1.dll'),
  (Join-Path $ompDir.FullName 'vcomp140.dll')
)

foreach ($src in $needed) {
  if (-not (Test-Path -LiteralPath $src)) {
    throw "缺少 VC++ 运行库文件：$src"
  }
  Copy-Item -LiteralPath $src -Destination $OutDir -Force
}

Write-Host "Staged 4 VC++ redist DLLs into $OutDir"
