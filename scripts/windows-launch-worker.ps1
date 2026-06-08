<#
.SYNOPSIS
  swingworker:// protocol handler for Windows. Launches the local testnet worker.

.DESCRIPTION
  Invoked by the registered swingworker:// protocol with the full URL as $Url:
    swingworker://start?session=<id>&control=<encoded control url>
    swingworker://stop?session=<id>&control=<encoded control url>

  start  -> loads .env.worker, sets session env, launches the worker in a visible
            PowerShell window so the user can watch logs; also tees to logs\.
  stop   -> no-op launcher. The already-running worker polls the control server,
            sees stopRequested, closes testnet positions, and exits on its own.
            (This is only a local fallback signal.)

  SECURITY: Secrets are read only from .env.worker (gitignored). They are never
  written to the registry, never put on the command line of the visible window
  beyond the environment block, and never logged.
#>
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Url
)

$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$LogDir = Join-Path $RepoRoot 'logs'
$OutLog = Join-Path $LogDir 'local-binance-worker.log'
$ErrLog = Join-Path $LogDir 'local-binance-worker.err.log'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Quote-PwshSingle([string]$s) {
    "'" + ($s -replace "'", "''") + "'"
}

function Write-Log([string]$msg) {
    $line = ('[{0}] {1}' -f (Get-Date -Format o), $msg)
    Add-Content -Path $OutLog -Value $line -Encoding utf8
}

# --- Parse the swingworker:// URL ---
$uri = $null
try { $uri = [System.Uri]$Url } catch { Write-Log "Invalid URL: $Url"; exit 1 }
$action = $uri.Host  # 'start' or 'stop'

$query = @{}
$rawQuery = $uri.Query.TrimStart('?')
if ($rawQuery) {
    foreach ($pair in $rawQuery.Split('&')) {
        if (-not $pair) { continue }
        $kv = $pair.Split('=', 2)
        $k = [System.Uri]::UnescapeDataString($kv[0])
        $v = if ($kv.Length -gt 1) { [System.Uri]::UnescapeDataString($kv[1]) } else { '' }
        $query[$k] = $v
    }
}

$sessionId = $query['session']
$control = $query['control']

Write-Log "Protocol invoked: action=$action session=$sessionId"

if ($action -eq 'stop') {
    Write-Log 'Stop signal received. Running worker will close testnet positions via control polling and exit.'
    exit 0
}

if ($action -ne 'start') {
    Write-Log "Unknown action '$action'. Expected start or stop."
    exit 1
}

# --- Load .env.worker ---
$envFile = Join-Path $RepoRoot '.env.worker'
if (-not (Test-Path $envFile)) {
    Write-Log ".env.worker not found at $envFile. Copy .env.worker.example and fill in testnet keys."
    [System.Windows.Forms.MessageBox]::Show("Missing .env.worker.`nCopy .env.worker.example to .env.worker and fill in your Binance TESTNET keys and BOT_WORKER_TOKEN.", 'SwingWorker setup required') 2>$null | Out-Null
    exit 1
}

foreach ($raw in Get-Content -Path $envFile) {
    $line = $raw.Trim()
    if (-not $line -or $line.StartsWith('#')) { continue }
    $idx = $line.IndexOf('=')
    if ($idx -lt 1) { continue }
    $name = $line.Substring(0, $idx).Trim()
    $value = $line.Substring($idx + 1).Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
    }
    Set-Item -Path ("env:{0}" -f $name) -Value $value
}

# Session + control values from the protocol URL take precedence.
$env:WORKER_LAUNCHED_BY_PROTOCOL = 'true'
if ($sessionId) { $env:WORKER_SESSION_ID = $sessionId }
if ($control) { $env:BOT_CONTROL_URL = $control }

Write-Log "Launching worker (control=$($env:BOT_CONTROL_URL) mode=$($env:WORKER_MODE))"
Write-Log "[LAUNCHER] Repo root: $RepoRoot"
Write-Log "[LAUNCHER] Session: $sessionId"
Write-Log "[LAUNCHER] Log: $OutLog"

# --- Launch the worker in a visible window, teeing output to the log ---
$safeSessionForFile = if ($sessionId) { ($sessionId -replace '[^A-Za-z0-9_.-]', '_') } else { 'missing-session' }
$runnerPath = Join-Path $LogDir ("run-worker-session-{0}.ps1" -f $safeSessionForFile)
$quotedRepoRoot = Quote-PwshSingle $RepoRoot
$quotedOutLog = Quote-PwshSingle $OutLog
$quotedErrLog = Quote-PwshSingle $ErrLog
$sessionArg = if ($sessionId) { $sessionId } else { '' }
$quotedSession = Quote-PwshSingle $sessionArg

$runner = @"
`$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $quotedRepoRoot
Write-Host '[LAUNCHER] Repo root: ' -NoNewline
Write-Host $quotedRepoRoot
Write-Host '[LAUNCHER] Session: ' -NoNewline
Write-Host $quotedSession
Write-Host '[LAUNCHER] Log: ' -NoNewline
Write-Host $quotedOutLog
try {
    npm run bot:worker -- --session $quotedSession 2>&1 | Tee-Object -FilePath $quotedOutLog -Append
} catch {
    `$msg = (`$_ | Out-String)
    Add-Content -LiteralPath $quotedErrLog -Value `$msg -Encoding utf8
    throw
}
"@
Set-Content -LiteralPath $runnerPath -Value $runner -Encoding utf8

Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') `
    -ArgumentList @('-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $runnerPath) `
    -WorkingDirectory $RepoRoot

Write-Log 'Worker launch dispatched.'
exit 0
