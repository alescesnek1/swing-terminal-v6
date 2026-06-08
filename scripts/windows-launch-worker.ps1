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

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logDir = Join-Path $repoRoot 'logs'
$logFile = Join-Path $logDir 'local-binance-worker.log'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

function Write-Log([string]$msg) {
    $line = ('[{0}] {1}' -f (Get-Date -Format o), $msg)
    Add-Content -Path $logFile -Value $line -Encoding utf8
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
$envFile = Join-Path $repoRoot '.env.worker'
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

# --- Launch the worker in a visible window, teeing output to the log ---
$argList = @('--session', $sessionId)
$workerScript = Join-Path $repoRoot 'scripts\local-binance-worker.mjs'
$nodeCmd = 'node "{0}" {1} 2>&1 | Tee-Object -FilePath "{2}" -Append' -f $workerScript, ($argList -join ' '), $logFile
$inner = "Set-Location '$repoRoot'; Write-Host 'SwingWorker local testnet worker (session $sessionId)'; $nodeCmd"

Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') `
    -ArgumentList @('-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $inner) `
    -WorkingDirectory $repoRoot

Write-Log 'Worker launch dispatched.'
exit 0
