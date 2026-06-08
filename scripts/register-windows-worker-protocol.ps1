<#
.SYNOPSIS
  Registers the swingworker:// custom URL protocol for the current user (HKCU).

.DESCRIPTION
  Lets the web "START BOT" button hand off to a local launcher via
  swingworker://start and swingworker://stop. Writes only to the per-user
  registry hive (HKCU) - no admin rights required, no machine-wide changes.

  SECURITY: No secrets are ever written to the registry. Binance keys and the
  worker token live only in .env.worker (gitignored). The registry contains
  only the path to scripts\windows-launch-worker.ps1.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-windows-worker-protocol.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-windows-worker-protocol.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param()

$ErrorActionPreference = 'Stop'

if (-not $PSVersionTable -or -not $PSVersionTable.PSVersion) {
    Write-Error 'This installer must run under Windows PowerShell or PowerShell.'
    exit 1
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$launchScript = Join-Path $repoRoot 'scripts\windows-launch-worker.ps1'

if (-not (Test-Path $launchScript)) {
    Write-Error "Launcher not found: $launchScript"
    exit 1
}

$protocolRoot = 'HKCU:\Software\Classes\swingworker'
$commandKey = Join-Path $protocolRoot 'shell\open\command'
$psExe = Join-Path $PSHOME 'powershell.exe'
$commandValue = '"{0}" -NoProfile -ExecutionPolicy Bypass -File "{1}" "%1"' -f $psExe, $launchScript

Write-Host "Registering swingworker:// protocol for current user..."
Write-Host "  Repo root : $repoRoot"
Write-Host "  Launcher  : $launchScript"
Write-Host "  Command   : $commandValue"

if ($PSCmdlet.ShouldProcess($protocolRoot, 'Create swingworker:// protocol registry keys')) {
    New-Item -Path $protocolRoot -Force | Out-Null
    Set-ItemProperty -Path $protocolRoot -Name '(default)' -Value 'URL:SwingWorker Protocol'
    # The presence of an empty "URL Protocol" value marks this as a URL scheme handler.
    Set-ItemProperty -Path $protocolRoot -Name 'URL Protocol' -Value ''

    New-Item -Path $commandKey -Force | Out-Null
    Set-ItemProperty -Path $commandKey -Name '(default)' -Value $commandValue

    Write-Host ''
    Write-Host 'swingworker:// protocol registered.' -ForegroundColor Green
    Write-Host 'Next: copy .env.worker.example to .env.worker and fill in testnet keys + BOT_WORKER_TOKEN.'
}
