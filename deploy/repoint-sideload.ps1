# Point the sideload center at an HTTPS domain, then upload it to the server.
#
# OTA wireless install (manifest.plist + itms-services) requires HTTPS + a domain.
# Run this AFTER you have enabled HTTPS (e.g. certbot --nginx) on the server and
# pointed your domain at the server.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File deploy\repoint-sideload.ps1 -Domain pa.example.com
param(
  [Parameter(Mandatory = $true)][string]$Domain
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$plist = Join-Path $root 'public\sideload\manifest.plist'
$content = Get-Content -LiteralPath $plist -Raw
$content = $content -replace 'https://__DOMAIN__', ("https://" + $Domain.Trim().TrimEnd('/'))
Set-Content -LiteralPath $plist -Value $content -Encoding UTF8 -NoNewline
Write-Host "manifest.plist now points to https://$Domain"
Write-Host 'Then sync to server and restart:'
Write-Host '  powershell -ExecutionPolicy Bypass -File deploy\deploy-aliyun.ps1'
