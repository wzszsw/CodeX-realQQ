$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $ProjectRoot '.env'

if (-not (Test-Path $EnvFile)) {
  Write-Host ".env not found. Copy .env.example to .env first."
  exit 1
}

Set-Location $ProjectRoot
$env:APP_MODE = 'stdin'
node src/index.js
