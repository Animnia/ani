# ani installer for Windows — one line (PowerShell):
#   irm https://raw.githubusercontent.com/Animnia/ani/main/install.ps1 | iex
#
# What it does:
#   1. ensures Node.js >= 24 (winget, or official zip into ~\.ani\node)
#   2. clones (or zip-downloads) ani into ~\.ani
#   3. installs an `ani` command (ani.cmd) into ~\.ani\bin and adds it to the user PATH
#   4. seeds ~\.ani\ani.json from the example config
# Re-running updates ani (git pull).
#
# Env overrides:
#   $env:ANI_DIR          install dir      (default: ~\.ani)
#   $env:ANI_NODE_MIRROR  node dist mirror (default: https://nodejs.org/dist)
#                         e.g. https://registry.npmmirror.com/-/binary/node for CN users
$ErrorActionPreference = 'Stop'

$Repo   = 'https://github.com/Animnia/ani'
$AniDir = if ($env:ANI_DIR) { $env:ANI_DIR } else { Join-Path $HOME '.ani' }
$Mirror = if ($env:ANI_NODE_MIRROR) { $env:ANI_NODE_MIRROR } else { 'https://nodejs.org/dist' }
$MinMajor = 24

function Say($m)  { Write-Host "[ani] $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "[ani] $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "[ani] $m" -ForegroundColor Red; exit 1 }

function Test-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { return $false }
  try {
    $major = [int](& node -p "process.versions.node.split('.')[0]" 2>$null)
    return $major -ge $MinMajor
  } catch { return $false }
}

function Install-Node {
  # try winget first (cleanest), fall back to official zip
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Say "installing Node.js via winget…"
    try {
      & winget install OpenJS.NodeJS --silent --accept-package-agreements --accept-source-agreements --disable-interactivity | Out-Null
      # refresh PATH for this session
      $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
      if (Test-Node) { return }
      Warn "winget install finished but node still not visible — trying zip fallback"
    } catch { Warn "winget failed: $_ — trying zip fallback" }
  }
  Say "downloading official Node $MinMajor zip…"
  # resolve the exact zip from SHASUMS256.txt inside latest-vN.x (index.json
  # lists newer majors first — do NOT use it for version resolution)
  $sums = (Invoke-WebRequest -Uri "$Mirror/latest-v$MinMajor.x/SHASUMS256.txt" -TimeoutSec 30).Content
  $zip = (($sums -split "`n" | ForEach-Object { ($_ -split '\s+')[-1] }) | Where-Object { $_ -match "node-v[0-9.]+-win-x64\.zip$" } | Select-Object -First 1)
  if (-not $zip) { Die "could not resolve Node $MinMajor zip from $Mirror" }
  $url = "$Mirror/latest-v$MinMajor.x/$zip"
  Say "fetching $url"
  New-Item -ItemType Directory -Force -Path $AniDir | Out-Null
  $tmp = Join-Path $AniDir 'node.zip'
  Invoke-WebRequest -Uri $url -OutFile $tmp -TimeoutSec 600
  $extract = Join-Path $AniDir ($zip -replace '\.zip$','')
  Expand-Archive -Path $tmp -DestinationPath $AniDir -Force
  Remove-Item $tmp -Force
  $dest = Join-Path $AniDir 'node'
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  Rename-Item $extract $dest
  $env:Path = "$dest;" + $env:Path
  Say "node $ver installed to $dest"
}

Say "=== ani installer ==="
New-Item -ItemType Directory -Force -Path $AniDir | Out-Null

# 1. node
if (Test-Node) {
  Say "found node $(& node --version)"
} else {
  Install-Node
  $localNode = Join-Path $AniDir 'node'
  if ((-not (Test-Node)) -and (Test-Path (Join-Path $localNode 'node.exe'))) {
    $env:Path = "$localNode;" + $env:Path
  }
}
if (-not (Test-Node)) { Die "node setup failed" }

# resolve a node path for the shim
$localNodeExe = Join-Path $AniDir 'node\node.exe'
$nodeExe = if (Test-Path $localNodeExe) { $localNodeExe } else { (Get-Command node).Source }
Say "using node at $nodeExe"

# 2. ani source
$gitDir = Join-Path $AniDir '.git'
if ((Test-Path $gitDir) -and (Get-Command git -ErrorAction SilentlyContinue)) {
  Say "updating existing install…"
  & git -C $AniDir pull --ff-only
  if ($LASTEXITCODE -ne 0) { Warn "git pull failed — keeping current version" }
} elseif (Get-Command git -ErrorAction SilentlyContinue) {
  $occupied = Get-ChildItem $AniDir | Where-Object { $_.Name -ne 'node' -and $_.Name -ne 'bin' }
  if ($occupied) { Die "$AniDir is not empty and not an ani checkout — set `$env:ANI_DIR to elsewhere" }
  Say "fetching $Repo …"
  # init+fetch works even when $AniDir already holds a node/ dir
  & git -C $AniDir init -b main -q
  & git -C $AniDir remote add origin "$Repo.git"
  & git -C $AniDir fetch --depth 1 origin main -q
  & git -C $AniDir checkout -qf -t origin/main
  if ($LASTEXITCODE -ne 0) { Die "git fetch/checkout failed" }
} else {
  Say "git not found — downloading zip…"
  $zipUrl = 'https://codeload.github.com/Animnia/ani/zip/refs/heads/main'
  $tmpZip = Join-Path $AniDir 'ani.zip'
  Invoke-WebRequest -Uri $zipUrl -OutFile $tmpZip -TimeoutSec 600
  $tmpDir = Join-Path $AniDir '.dl'
  if (Test-Path $tmpDir) { Remove-Item $tmpDir -Recurse -Force }
  Expand-Archive -Path $tmpZip -DestinationPath $tmpDir
  Copy-Item -Recurse -Force (Join-Path $tmpDir 'ani-main\*') $AniDir
  Remove-Item $tmpZip, $tmpDir -Recurse -Force
}

# 3. ani command shim
$binDir = Join-Path $AniDir 'bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$shim = Join-Path $binDir 'ani.cmd'
$shimContent = @"
@echo off
"$nodeExe" "$AniDir\ani.ts" %*
"@
$shimContent | Out-File -Encoding ascii $shim

# add to user PATH (once)
$userPath = [Environment]::GetEnvironmentVariable('Path','User')
if (($userPath -split ';') -notcontains $binDir) {
  [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $binDir), 'User')
  Say "added $binDir to user PATH"
}
$env:Path = "$binDir;" + $env:Path

# 4. config
$cfg = Join-Path $AniDir 'ani.json'
if (-not (Test-Path $cfg)) {
  Copy-Item (Join-Path $AniDir 'ani.example.json') $cfg
  Say "created $cfg — EDIT IT: add your DeepSeek apiKey and channel tokens"
}

Say ""
Say "✅ ani installed to $AniDir"
Say "next steps:"
Say "  1. edit config:   notepad $cfg"
Say "  2. open a NEW terminal (PATH refresh) and run:  ani"
Say "     or right now:  $shim"
