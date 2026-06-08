<#
.SYNOPSIS
  Removes the swingworker:// custom URL protocol for the current user (HKCU).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\unregister-windows-worker-protocol.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\unregister-windows-worker-protocol.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param()

$ErrorActionPreference = 'Stop'

$protocolRoot = 'HKCU:\Software\Classes\swingworker'

if (-not (Test-Path $protocolRoot)) {
    Write-Host 'swingworker:// protocol is not registered. Nothing to do.'
    exit 0
}

if ($PSCmdlet.ShouldProcess($protocolRoot, 'Remove swingworker:// protocol registry keys')) {
    Remove-Item -Path $protocolRoot -Recurse -Force -Confirm:$false
    Write-Host 'swingworker:// protocol removed.' -ForegroundColor Green
}
