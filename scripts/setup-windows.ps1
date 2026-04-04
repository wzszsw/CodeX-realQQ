$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$EnvTemplate = Join-Path $ProjectRoot '.env.napcat.example'
$EnvFile = Join-Path $ProjectRoot '.env'
$DefaultNapCatRoots = @(
  'D:\develop\TOOLS\NapCatQQ\NapCat.Shell',
  'D:\develop\TOOLS\NapCatQQ\NapCat.Shell.Windows.OneKey',
  'C:\NapCatQQ\NapCat.Shell'
)
$DefaultQQPaths = @(
  'C:\Program Files\Tencent\QQNT\QQ.exe',
  'C:\Program Files (x86)\Tencent\QQNT\QQ.exe'
)

function Write-Step($message) {
  Write-Host ''
  Write-Host "==> $message" -ForegroundColor Cyan
}

function Write-Ok($message) {
  Write-Host "[OK] $message" -ForegroundColor Green
}

function Write-Warn($message) {
  Write-Host "[WARN] $message" -ForegroundColor Yellow
}

function Write-Fail($message) {
  Write-Host "[FAIL] $message" -ForegroundColor Red
}

function Test-CommandExists($name) {
  return $null -ne (Get-Command $name -ErrorAction SilentlyContinue)
}

function Read-EnvFile($path) {
  $map = @{}
  if (-not (Test-Path $path)) {
    return $map
  }

  foreach ($line in Get-Content $path) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    if ($line.TrimStart().StartsWith('#')) { continue }
    $index = $line.IndexOf('=')
    if ($index -lt 1) { continue }
    $key = $line.Substring(0, $index).Trim()
    $value = $line.Substring($index + 1).Trim()
    $map[$key] = $value
  }
  return $map
}

function Find-ExistingPath($candidates) {
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return $candidate
    }
  }
  return $null
}

function Update-EnvValue($path, $key, $value) {
  $lines = @()
  if (Test-Path $path) {
    $lines = Get-Content $path
  }

  $updated = $false
  for ($i = 0; $i -lt $lines.Count; $i += 1) {
    if ($lines[$i] -match "^$([regex]::Escape($key))=") {
      $lines[$i] = "$key=$value"
      $updated = $true
      break
    }
  }

  if (-not $updated) {
    $lines += "$key=$value"
  }

  Set-Content -Path $path -Value $lines
}

function Confirm-Action($message) {
  $answer = Read-Host "$message [y/N]"
  return $answer -match '^(y|yes)$'
}

function Test-TcpPort($host, $port) {
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $async = $client.BeginConnect($host, $port, $null, $null)
    $connected = $async.AsyncWaitHandle.WaitOne(1000, $false)
    if (-not $connected) {
      $client.Close()
      return $false
    }
    $client.EndConnect($async)
    $client.Close()
    return $true
  } catch {
    return $false
  }
}

Write-Host 'CodeX-realQQ Windows setup' -ForegroundColor Magenta
Write-Host "project root: $ProjectRoot"

Write-Step 'Checking Node.js'
if (-not (Test-CommandExists 'node')) {
  Write-Fail 'Node.js not found in PATH.'
  Write-Host 'Install Node.js 20+ first: https://nodejs.org/'
  exit 1
}

$nodeVersion = (& node -v).Trim()
Write-Ok "Node.js detected: $nodeVersion"

Write-Step 'Checking npm dependencies'
$NodeModulesDir = Join-Path $ProjectRoot 'node_modules'
if (-not (Test-Path $NodeModulesDir)) {
  Write-Warn 'node_modules not found.'
  if (Confirm-Action 'Run npm install now?') {
    Push-Location $ProjectRoot
    try {
      npm install
      Write-Ok 'npm install completed.'
    } finally {
      Pop-Location
    }
  } else {
    Write-Warn 'Skipping npm install.'
  }
} else {
  Write-Ok 'node_modules already exists.'
}

Write-Step 'Checking QQ NT'
$qqPath = Find-ExistingPath $DefaultQQPaths
if ($qqPath) {
  Write-Ok "QQ NT detected: $qqPath"
} else {
  Write-Warn 'QQ NT executable not found in the default paths.'
  Write-Host 'Install official QQ NT first.'
}

Write-Step 'Checking NapCatQQ'
$napcatRoot = Find-ExistingPath $DefaultNapCatRoots
if ($napcatRoot) {
  Write-Ok "NapCatQQ detected: $napcatRoot"
} else {
  Write-Warn 'NapCatQQ not found in the default paths.'
  Write-Host 'Recommended project: https://github.com/NapNeko/NapCatQQ'
}

Write-Step 'Checking .env'
if (-not (Test-Path $EnvFile)) {
  if (Test-Path $EnvTemplate) {
    Copy-Item $EnvTemplate $EnvFile
    Write-Ok '.env created from .env.napcat.example'
  } else {
    Write-Fail '.env.napcat.example not found.'
    exit 1
  }
} else {
  Write-Ok '.env already exists.'
}

$envMap = Read-EnvFile $EnvFile

if (-not $envMap.ContainsKey('CODEX_BIN')) {
  Update-EnvValue $EnvFile 'CODEX_BIN' 'codex'
}

if (-not $envMap.ContainsKey('KNOWLEDGE_ROOT')) {
  Update-EnvValue $EnvFile 'KNOWLEDGE_ROOT' $ProjectRoot
}

if (-not $envMap.ContainsKey('KNOWLEDGE_LABEL')) {
  Update-EnvValue $EnvFile 'KNOWLEDGE_LABEL' 'knowledge-base'
}

$envMap = Read-EnvFile $EnvFile

Write-Step 'Checking OneBot configuration'
$wsUrl = [string]($envMap['ONEBOT_WS_URL'])
$token = [string]($envMap['ONEBOT_ACCESS_TOKEN'])

if ([string]::IsNullOrWhiteSpace($wsUrl)) {
  Write-Warn 'ONEBOT_WS_URL is empty in .env'
} else {
  Write-Ok "ONEBOT_WS_URL: $wsUrl"
}

if ([string]::IsNullOrWhiteSpace($token) -or $token -eq 'your_token') {
  Write-Warn 'ONEBOT_ACCESS_TOKEN is empty or still placeholder.'
} else {
  Write-Ok 'ONEBOT_ACCESS_TOKEN is configured.'
}

$host = $null
$port = $null
if ($wsUrl -match '^ws://([^/:]+):(\d+)') {
  $host = $Matches[1]
  $port = [int]$Matches[2]
}

if ($host -and $port) {
  if (Test-TcpPort $host $port) {
    Write-Ok "OneBot TCP endpoint reachable: $host`:$port"
  } else {
    Write-Warn "OneBot TCP endpoint not reachable yet: $host`:$port"
  }
}

Write-Step 'Optional NapCat launch'
if ($napcatRoot) {
  $launcher = Join-Path $napcatRoot 'launcher-win10.bat'
  if ((Test-Path $launcher) -and (Confirm-Action 'Launch NapCatQQ now?')) {
    Start-Process -FilePath $launcher -WorkingDirectory $napcatRoot
    Write-Ok 'NapCatQQ launcher started.'
  }
}

Write-Step 'Next steps'
Write-Host '1. If NapCatQQ opened a QR code, scan it in mobile QQ and complete login.'
Write-Host '2. Open NapCatQQ WebUI.'
Write-Host '3. Enable the local OneBot 11 WebSocket server.'
Write-Host '4. Confirm the WebSocket URL and token.'
Write-Host "5. Edit $EnvFile and fill:"
Write-Host '   - ONEBOT_WS_URL'
Write-Host '   - ONEBOT_ACCESS_TOKEN'
Write-Host '   - KNOWLEDGE_ROOT'
Write-Host '   - KNOWLEDGE_LABEL'
Write-Host '6. Start the bridge:'
Write-Host "   cd $ProjectRoot"
Write-Host '   node src/index.js'
Write-Host '7. Test private chat first, then group @ mention, then image questions.'

Write-Step 'Recommended verification'
Write-Host 'Expected bridge logs:'
Write-Host '  CodeX-realQQ starting'
Write-Host '  mode: onebot'
Write-Host '  onebot connected: ws://127.0.0.1:3001'
Write-Host '  onebot self id: ...'
