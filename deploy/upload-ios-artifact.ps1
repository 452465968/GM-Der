# Upload an iOS .ipa artifact to the server sideload center and refresh ipa.json.
#
# The sideload center lives in the web-visible folder:
#   /opt/purchase-approval/public/sideload/  ->  https://furry233.cn/sideload/
#
# Usage (on Windows):
#   powershell -ExecutionPolicy Bypass -File deploy\upload-ios-artifact.ps1 -Ipa C:\path\to\PurchaseApproval.ipa [-Version 1.0.0] [-Build 3] [-Signed]
#
# Notes:
#   * Existing users install the old build too; replace keeps the same file name so
#     already-shared links keep working.
#   * If the .ipa is already signed with an Enterprise/Ad Hoc profile, pass -Signed
#     so the OTA manifest section is enabled on the install page.
$ErrorActionPreference = 'Stop'
param(
  [Parameter(Mandatory = $true)][string]$Ipa,
  [string]$Version = '1.0.0',
  [int]$Build = 0,
  [switch]$Signed
)
if (-not (Test-Path -LiteralPath $Ipa)) { throw "IPA not found: $Ipa" }

# 服务器地址与密钥走环境变量（公开仓库不含真实地址）：
#   $env:PA_SERVER / $env:PA_SSH_KEY / $env:PA_SIDELOAD_HOME
$server = $env:PA_SERVER
if (-not $server) { throw '请先设置环境变量 PA_SERVER，例如：$env:PA_SERVER = "root@<你的服务器IP或域名>"' }
$key = if ($env:PA_SSH_KEY) { $env:PA_SSH_KEY } else { Join-Path $env:USERPROFILE '.ssh\id_ed25519' }
$homeUrl = if ($env:PA_SIDELOAD_HOME) { $env:PA_SIDELOAD_HOME } else { "https://$($server -replace '^.*@','')/" }
$remote = '/opt/purchase-approval/public/sideload'

$size = (Get-Item -LiteralPath $Ipa).Length
$sha = (Get-FileHash -LiteralPath $Ipa -Algorithm SHA256).Hash.ToLowerInvariant()
$sizeText = if ($size -ge 1MB) { ('{0:N1} MB' -f ($size / 1MB)) } else { ('{0:N0} KB' -f ($size / 1KB)) }
$now = (Get-Date).ToUniversalTime().ToString('o')

Write-Host '[1/3] uploading ipa ...'
scp -i $key -o BatchMode=yes $Ipa "${server}:${remote}/PurchaseApproval.ipa"
if ($LASTEXITCODE -ne 0) { throw 'scp ipa failed' }

$meta = [ordered]@{
  appName    = 'Purchase Approval (Sideload)'
  appId      = 'cn.purchaseapproval.sideload'
  bundleId   = 'cn.purchaseapproval.sideload'
  version    = $Version
  build      = $Build
  file       = 'PurchaseApproval.ipa'
  size       = $size
  sizeText   = $sizeText
  sha256     = $sha
  signed     = [bool]$Signed
  signMode   = if ($Signed) { 'enterprise/ad-hoc' } else { 'unsigned (resign by sideload tools)' }
  available  = $true
  updatedAt  = $now
  homepage   = $homeUrl
  serverRegion = 'Aliyun'
  note       = ''
}
$metaJson = $meta | ConvertTo-Json -Depth 4
$tmpMeta = Join-Path $env:TEMP 'pa-ipa.json'
Set-Content -LiteralPath $tmpMeta -Value $metaJson -Encoding UTF8
Write-Host '[2/3] uploading metadata ...'
scp -i $key -o BatchMode=yes $tmpMeta "${server}:${remote}/ipa.json"
if ($LASTEXITCODE -ne 0) { throw 'scp ipa.json failed' }
Remove-Item -LiteralPath $tmpMeta -Force -ErrorAction SilentlyContinue

Write-Host '[3/3] flushing CDN-free static cache (nginx/express) ...'
ssh -i $key -o BatchMode=yes $server "nginx -t >/dev/null 2>&1 && echo nginx-ok; curl -s -o /dev/null -w 'install-page:%{http_code}\n' http://127.0.0.1/sideload/; curl -s -o /dev/null -w 'ipa:%{http_code}\n' http://127.0.0.1/sideload/PurchaseApproval.ipa"
if ($LASTEXITCODE -ne 0) { throw 'remote check failed' }

Write-Host "Done. Install page: $homeUrl/sideload/"
