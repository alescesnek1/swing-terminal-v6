<#
.SYNOPSIS
  First-time SwingTerminal local worker installer for Windows (TESTNET only).

.DESCRIPTION
  Bootstraps a brand-new machine so the web "START BOT" button works one-click:
    1. clones (or pulls) the repo into %USERPROFILE%\SwingTerminalWorker
    2. runs npm install
    3. exchanges the short-lived pairing code at POST /api/bot/worker-pair for
       the worker bootstrap config (control URL + shared worker token)
    4. prompts LOCALLY for Binance Spot Testnet API key/secret and writes them,
       together with the worker token, to a gitignored .env.worker
    5. registers the swingworker:// protocol and runs a testnet preflight

  SECURITY:
    - The pairing code is short-lived and single-use; it carries NO secrets.
    - The worker token is fetched from the control server, never embedded in any
      URL and never shown in the browser.
    - Binance keys are read locally (secret via SecureString, never echoed),
      written only to .env.worker, and never logged or committed.
    - .env.worker is gitignored. No secrets are written to the registry.

.PARAMETER PairCode
  The short-lived pairing code minted by the web app (Install Worker).

.PARAMETER ControlUrl
  The control server origin (defaults to the production Netlify site).

.PARAMETER Help
  Print usage and exit without making any changes.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-worker-windows.ps1 -PairCode <CODE>
#>
[CmdletBinding()]
param(
    [string]$PairCode,
    [string]$ControlUrl = 'https://swing-terminal-v6.netlify.app',
    [string]$Repo = 'https://github.com/alescesnek1/swing-terminal-v6.git',
    [switch]$Help
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$msg) { Write-Host "[INSTALL] $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn2([string]$msg) { Write-Host "[WARN] $msg" -ForegroundColor Yellow }

function Show-Usage {
    Write-Host @'
SwingTerminal Worker installer (Windows, TESTNET only)

Usage:
  install-worker-windows.ps1 -PairCode <CODE> [-ControlUrl <url>] [-Repo <git url>]

What it does:
  - clones/pulls the repo into %USERPROFILE%\SwingTerminalWorker
  - npm install
  - redeems the pairing code for the worker token (no secrets in the URL)
  - prompts locally for Binance Spot Testnet API key/secret (not sent to the web)
  - writes a gitignored .env.worker, registers swingworker://, runs a preflight

After it finishes: return to the web app and click START BOT.
'@
}

if ($Help) { Show-Usage; exit 0 }

if (-not $PairCode) {
    Write-Warn2 'No -PairCode provided. Generate one from the web app (Install Worker on this computer).'
    Show-Usage
    exit 1
}

$ControlUrl = $ControlUrl.TrimEnd('/')
$InstallDir = Join-Path $env:USERPROFILE 'SwingTerminalWorker'

Write-Step "Install directory: $InstallDir"

# --- 1. Require git and node/npm ---
function Test-Cmd([string]$name) {
    $null = Get-Command $name -ErrorAction SilentlyContinue
    return $?
}

$missing = @()
if (-not (Test-Cmd 'git'))  { $missing += 'git' }
if (-not (Test-Cmd 'node')) { $missing += 'node' }
if (-not (Test-Cmd 'npm'))  { $missing += 'npm' }

if ($missing.Count -gt 0) {
    Write-Warn2 ("Missing required tools: {0}" -f ($missing -join ', '))
    Write-Host ''
    Write-Host 'Please install the following, then re-run this installer:' -ForegroundColor Yellow
    if ($missing -contains 'git')  { Write-Host '  - Git for Windows:  https://git-scm.com/download/win' }
    if (($missing -contains 'node') -or ($missing -contains 'npm')) { Write-Host '  - Node.js LTS (includes npm):  https://nodejs.org/en/download' }
    Write-Host ''
    Read-Host 'Press Enter to close'
    exit 1
}

# --- 2. Clone or pull the repo ---
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Set-Location -LiteralPath $InstallDir

if (Test-Path (Join-Path $InstallDir '.git')) {
    Write-Step 'Existing checkout found. Pulling latest...'
    git pull --ff-only
} else {
    $entries = Get-ChildItem -Force -LiteralPath $InstallDir | Where-Object { $_.Name -ne '.env.worker' }
    if ($entries.Count -gt 0) {
        Write-Step 'Directory not empty and not a git repo. Cloning into a temp dir then merging...'
        git clone $Repo $InstallDir 2>$null
        if (-not $?) { Write-Step 'Cloning into current directory...'; git clone $Repo . }
    } else {
        Write-Step "Cloning $Repo ..."
        git clone $Repo .
    }
}
Write-Ok 'Repository ready.'

# --- 3. npm install ---
Write-Step 'Installing npm dependencies (this can take a minute)...'
npm install
if ($LASTEXITCODE -ne 0) { Write-Warn2 'npm install failed.'; Read-Host 'Press Enter to close'; exit 1 }
Write-Ok 'Dependencies installed.'

# --- 4. Redeem the pairing code for the worker bootstrap config ---
Write-Step 'Pairing this worker with the control server...'
$pairBody = @{ pairingCode = $PairCode; platform = 'windows'; hostname = $env:COMPUTERNAME } | ConvertTo-Json -Compress
try {
    $pair = Invoke-RestMethod -Method Post -Uri "$ControlUrl/api/bot/worker-pair" -ContentType 'application/json' -Body $pairBody
} catch {
    Write-Warn2 "Pairing failed: $($_.Exception.Message)"
    Write-Warn2 'The pairing code may be expired or already used. Generate a new one from the web app.'
    Read-Host 'Press Enter to close'
    exit 1
}
if (-not $pair.ok -or -not $pair.workerToken) {
    Write-Warn2 'Pairing response did not include a worker token. Generate a new pairing code and retry.'
    Read-Host 'Press Enter to close'
    exit 1
}
$WorkerToken = $pair.workerToken
$EffectiveControlUrl = if ($pair.controlUrl) { ([string]$pair.controlUrl).TrimEnd('/') } else { $ControlUrl }
Write-Ok ("Paired. Owner: {0}" -f ($pair.ownerEmail))

# --- 5. Prompt locally for Binance Spot Testnet API key/secret ---
Write-Host ''
Write-Host 'Enter your Binance SPOT TESTNET API credentials.' -ForegroundColor Cyan
Write-Host 'Get them at https://testnet.binance.vision (these are NOT your real keys).' -ForegroundColor Cyan
Write-Host 'They are stored only on this computer in .env.worker and never sent to the web.' -ForegroundColor Cyan
$BinanceApiKey = Read-Host 'Binance Spot Testnet API KEY'
$SecureSecret  = Read-Host 'Binance Spot Testnet API SECRET' -AsSecureString

# Convert the SecureString to plaintext only to write the local env file.
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureSecret)
try {
    $BinanceApiSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

if (-not $BinanceApiKey -or -not $BinanceApiSecret) {
    Write-Warn2 'API key and secret are required. Re-run the installer.'
    Read-Host 'Press Enter to close'
    exit 1
}

# --- 6. Write .env.worker (gitignored; never logged, never committed) ---
$envPath = Join-Path $InstallDir '.env.worker'
$envLines = @(
    'WORKER_MODE=testnet',
    "BOT_CONTROL_URL=$EffectiveControlUrl",
    "BOT_WORKER_TOKEN=$WorkerToken",
    'BINANCE_ENV=testnet',
    "BINANCE_API_KEY=$BinanceApiKey",
    "BINANCE_API_SECRET=$BinanceApiSecret",
    'MAX_POSITION_USD=10',
    'POLL_INTERVAL_MS=5000'
)
Set-Content -LiteralPath $envPath -Value $envLines -Encoding utf8
# Drop the plaintext secret from memory as soon as it is persisted locally.
$BinanceApiSecret = $null
Write-Ok '.env.worker written (local, gitignored).'

# --- 7. Register swingworker:// protocol + testnet preflight ---
Write-Step 'Registering swingworker:// protocol for this user...'
npm run worker:register:windows
if ($LASTEXITCODE -ne 0) { Write-Warn2 'Protocol registration reported an error. You can re-run: npm run worker:register:windows' }

Write-Step 'Running Binance Spot Testnet preflight...'
# Load .env.worker into this session so the preflight can sign a testnet request.
foreach ($raw in Get-Content -LiteralPath $envPath) {
    $line = $raw.Trim()
    if (-not $line -or $line.StartsWith('#')) { continue }
    $idx = $line.IndexOf('=')
    if ($idx -lt 1) { continue }
    $k = $line.Substring(0, $idx).Trim()
    $v = $line.Substring($idx + 1).Trim()
    Set-Item -Path ("env:{0}" -f $k) -Value $v
}
npm run bot:worker:preflight
if ($LASTEXITCODE -ne 0) { Write-Warn2 'Preflight failed. Check your testnet API key/secret in .env.worker.' }

Write-Host ''
Write-Ok 'Worker installed. Return to the web and click START BOT.'
Write-Host ''
Read-Host 'Press Enter to close'
exit 0
