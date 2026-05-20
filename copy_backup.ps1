$src = Join-Path $PSScriptRoot '..\deploy-69e626c7c329364d3066599e\index.html'
$dst = Join-Path $PSScriptRoot 'apps\edge\public\index.html'
Copy-Item -Path $src -Destination $dst -Force
Write-Host "Copied $src -> $dst"
