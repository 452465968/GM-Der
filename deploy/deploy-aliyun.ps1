# Aliyun deploy script (idempotent): sync code to /opt/purchase-approval and restart pm2.
# NOTE: only syncs code; NEVER overwrite remote data/ (db.json) or uploads/ (production data).
# Usage: powershell -ExecutionPolicy Bypass -File deploy\deploy-aliyun.ps1
# 前置环境变量（服务器地址与密钥不写死，避免公开仓库泄露）：
#   $env:PA_SERVER  = 'root@<你的服务器IP或域名>'
#   $env:PA_SSH_KEY = '<私钥路径>'（可选，默认 ~/.ssh/id_ed25519）
#   $env:PA_REMOTE  = '/opt/purchase-approval'（可选）
$ErrorActionPreference = 'Stop'
$server = $env:PA_SERVER
if (-not $server) { throw '请先设置环境变量 PA_SERVER，例如：$env:PA_SERVER = "root@<你的服务器IP或域名>"' }
$key = if ($env:PA_SSH_KEY) { $env:PA_SSH_KEY } else { Join-Path $env:USERPROFILE '.ssh\id_ed25519' }
$remote = if ($env:PA_REMOTE) { $env:PA_REMOTE } else { '/opt/purchase-approval' }
$tarball = Join-Path $env:TEMP 'pa-src.tgz'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  Write-Host '[1/4] packaging code ...'
  tar -czf $tarball server public deploy apk-store README.md package.json package-lock.json
  if ($LASTEXITCODE -ne 0) { throw 'local tar failed' }

  Write-Host '[2/4] uploading tarball ...'
  scp -i $key -o BatchMode=yes $tarball "${server}:/tmp/pa-src.tgz"
  if ($LASTEXITCODE -ne 0) { throw 'scp failed' }

  Write-Host '[3/4] extracting on server ...'
  ssh -i $key -o BatchMode=yes $server "tar -xzf /tmp/pa-src.tgz -C $remote && rm -f /tmp/pa-src.tgz && echo EXTRACT-OK"
  if ($LASTEXITCODE -ne 0) { throw 'remote extract failed' }

  Write-Host '[4/4] restarting pm2 ...'
  ssh -i $key -o BatchMode=yes $server "cd $remote && pm2 restart purchase-approval && pm2 save"
  if ($LASTEXITCODE -ne 0) { throw 'restart failed' }
  Write-Host 'deploy done.'
} finally {
  Remove-Item -LiteralPath $tarball -Force -ErrorAction SilentlyContinue
  Pop-Location
}
