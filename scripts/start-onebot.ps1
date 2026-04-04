$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $ProjectRoot '.env'

if (-not (Test-Path $EnvFile)) {
  Write-Host ".env not found. Copy .env.napcat.example to .env and fill ONEBOT_WS_URL / ONEBOT_ACCESS_TOKEN first."
  exit 1
}

Set-Location $ProjectRoot
node src/index.js
