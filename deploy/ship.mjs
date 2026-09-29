#!/usr/bin/env node
/**
 * 一键发版（macOS / Linux）：版本号自增 → 生成更新日志 → 提交 → 部署阿里云 → 线上验证 → 推送 GitHub
 *
 * 用法：
 *   node deploy/ship.mjs                 # 完整流程（patch 自增 + 打 v<name> 标签触发 APK 构建）
 *   node deploy/ship.mjs --bump minor    # patch | minor | major，默认 patch
 *   node deploy/ship.mjs --no-tag        # 不打标签（Web 版本照常自增，安卓版本保持不动）
 *   node deploy/ship.mjs --deploy-only   # 只把当前代码（含 apk-store 与 version.json）同步到服务器，不改号不提交
 *   node deploy/ship.mjs --no-deploy     # 只改号 + 提交 + 推送，不部署
 *   node deploy/ship.mjs --no-push       # 只改号 + 提交 + 部署，不推送 GitHub
 *   node deploy/ship.mjs --dry           # 只打印将要执行的内容，不落盘、不部署、不推送
 *   node deploy/ship.mjs --changelog "文本"   # 可重复传入，覆盖自动生成的更新日志
 *
 * 每次发版固定同步三件事：改号提交 → 部署服务器（pm2 重启）→ 推送 GitHub + 打 v 标签。
 * 打标签会触发 .github/workflows/android-release.yml：构建 APK → 提交回 main（apk-store/ 与
 * version.json 的 size/sha256）→ 发 GitHub Release。CI 回写后需再跑一次
 * `git pull && node deploy/ship.mjs --deploy-only`，服务器才会分发到新 APK。
 *
 * 环境变量（写在本机 .env 中，绝不入库；服务器地址与密钥不写死在脚本里）：
 *   PA_SERVER      服务器登录串，如 root@furry233.cn 或 root@<IP>
 *   PA_SSH_KEY     SSH 私钥路径，默认 ~/.ssh/aliyun_ecs
 *   PA_REMOTE      远端项目目录，默认 /opt/purchase-approval
 *   PA_PM2_APP     pm2 应用名，默认 purchase-approval
 *   GITHUB_TOKEN   推送 GitHub 用的 PAT；不设置则回退到本机 git 凭据（Keychain）
 *
 * 安全约定：
 *   - 打包只含 server public deploy apk-store README.md package.json package-lock.json CHANGELOG.md，
 *     **永不上传 data/（db.json）与 uploads/**，线上真实数据不会被覆盖。
 *   - .env / data/ 已被 .gitignore 忽略，不会被提交或推送。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');

/* ------------------------------- 参数 ------------------------------- */
const argv = process.argv.slice(2);
// 默认打标签：每次发版都同步「改号提交 / 部署 / 推送+APK 构建」
const opts = { bump: 'patch', changelog: [], tag: true };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--bump') opts.bump = argv[++i];
  else if (a === '--changelog') opts.changelog.push(argv[++i]);
  else if (a === '--tag') opts.tag = true;
  else if (a === '--no-tag') opts.tag = false;
  else if (a === '--deploy-only') opts.deployOnly = true;
  else if (a === '--no-deploy') opts.noDeploy = true;
  else if (a === '--no-push') opts.noPush = true;
  else if (a === '--dry') opts.dry = true;
  else if (a === '--help' || a === '-h') {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
    process.exit(0);
  }
}

/* --------------------------- 读取 .env（不入库） --------------------------- */
function loadEnvFile() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].replace(/^['"]|['"]$/g, '');
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnvFile();

const PA_SERVER = process.env.PA_SERVER || '';
const PA_SSH_KEY = process.env.PA_SSH_KEY || path.join(os.homedir(), '.ssh', 'aliyun_ecs');
const PA_REMOTE = process.env.PA_REMOTE || '/opt/purchase-approval';
const PA_PM2_APP = process.env.PA_PM2_APP || 'purchase-approval';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

/* ------------------------------- 工具 ------------------------------- */
const step = (n, t) => console.log(`\n\u001b[1m[${n}] ${t}\u001b[0m`);
const ok = (t) => console.log(`    \u001b[32mOK\u001b[0m   ${t}`);
const info = (t) => console.log(`         ${t}`);
const die = (t) => { console.error(`    \u001b[31m失败\u001b[0m ${t}`); process.exit(1); };
const git = (args, opts2 = {}) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts2 }).trim();

/* --------------------- 1. 计算新版本号 --------------------- */
step('1/7', '计算新版本号');
const gradleText = fs.readFileSync(path.join(ROOT, 'android/app/build.gradle'), 'utf8');
const versionJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/version.json'), 'utf8'));
const gradleVal = (k) => {
  const m = gradleText.match(new RegExp(k + '\\s+("?)([^\\s"]+)\\1'));
  return m ? m[2] : null;
};
const oldCode = Number(gradleVal('versionCode'));
const oldName = gradleVal('versionName');
const oldPrefix = versionJson.version && versionJson.version.endsWith(oldName)
  ? versionJson.version.slice(0, versionJson.version.length - oldName.length)
  : 'beta';

let newName;
const newCode = oldCode + 1;
let newAppVersion;
if (opts.deployOnly) {
  newAppVersion = versionJson.version;
  info(`(--deploy-only) 不改号，以当前版本 ${newAppVersion} 同步到服务器`);
} else {
  const [maj, min, pat] = oldName.split('.').map(Number);
  if (opts.bump === 'major') newName = `${maj + 1}.0.0`;
  else if (opts.bump === 'minor') newName = `${maj}.${min + 1}.0`;
  else newName = `${maj}.${min}.${pat + 1}`;
  newAppVersion = oldPrefix + newName;
  info(`versionName ${oldName} -> ${newName}；versionCode ${oldCode} -> ${newCode}；前端版本 -> ${newAppVersion}`);
}

/* --------------------- 2. 生成更新日志 --------------------- */
step('2/7', '生成更新日志');
let entries = opts.changelog.slice();
if (opts.deployOnly) {
  info('(--deploy-only 跳过)');
} else if (!entries.length) {
  const lastTag = git(['tag', '--list', 'v*', '--sort=-v:refname']).split('\n').filter(Boolean)[0] || '';
  const range = lastTag ? `${lastTag}..HEAD` : '-20';
  entries = git(['log', range, '--pretty=format:%s'])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    // 排除仓库元操作类提交（发版本身、历史重建等），只保留 feat / fix / docs / refactor 等
    .filter((s) => !/^chore(\(release\)|:)/.test(s));
}
if (!entries.length) entries = ['体验优化与问题修复'];
info(`更新日志 ${entries.length} 条：`);
entries.forEach((e) => info(`  · ${e}`));

/* --------------------- 3. 版本号落盘 --------------------- */
// 说明：不带 --tag 时 APK 不会重建，此时只自增 Web 版本号（version.json.version / APP_VERSION），
// android.latestVersion / latestCode / apkUrl / size / sha256 保持与现有 APK 一致，
// 否则安卓客户端会拿到「新版号 + 旧 APK」，反复提示更新却装不上。
step('3/7', opts.tag ? '版本号四处同步（含安卓）' : 'Web 版本号自增（安卓版本保持与现有 APK 一致）');
const VERSION_JSON = path.join(ROOT, 'public/version.json');
const VERSION_JS = path.join(ROOT, 'public/js/version.js');

if (opts.deployOnly) {
  info('(--deploy-only 跳过)');
} else if (opts.tag) {
  const bumpArgs = ['deploy/bump-version.mjs', '--code', String(newCode), '--name', newName, '--prefix', oldPrefix];
  for (const e of entries) bumpArgs.push('--changelog', e);
  if (opts.dry) bumpArgs.push('--dry');
  const bump = spawnSync('node', bumpArgs, { cwd: ROOT, encoding: 'utf8' });
  if (bump.status !== 0) die('版本号同步失败：' + (bump.stderr || bump.stdout));
  process.stdout.write(bump.stdout.split('\n').map((l) => '    ' + l).join('\n'));
} else {
  const vj = JSON.parse(fs.readFileSync(VERSION_JSON, 'utf8'));
  const oldVjVersion = vj.version;
  vj.version = newAppVersion;
  vj.updatedAt = new Date().toISOString();
  vj.android = vj.android || {};
  vj.android.changelog = entries;
  const vjs = fs.readFileSync(VERSION_JS, 'utf8');
  const oldAppVersion = (vjs.match(/APP_VERSION\s*=\s*'([^']+)'/) || [])[1];
  const newVjs = vjs.replace(/APP_VERSION\s*=\s*'[^']+'/, `APP_VERSION = '${newAppVersion}'`);
  if (opts.dry) {
    info(`version.json   version     ${oldVjVersion} -> ${vj.version}`);
    info(`version.js     APP_VERSION ${oldAppVersion} -> ${newAppVersion}`);
    info(`android.latestVersion 保持 ${vj.android.latestVersion}（APK 未重建，不抬高，避免客户端指向旧包）`);
  } else {
    fs.writeFileSync(VERSION_JSON, JSON.stringify(vj, null, 2) + '\n');
    fs.writeFileSync(VERSION_JS, newVjs);
    ok(`version.json / version.js => ${newAppVersion}；安卓版本保持 ${vj.android.latestVersion}`);
  }
}

/* --------------------- 4. 追加 CHANGELOG.md --------------------- */
step('4/7', '写入 CHANGELOG.md');
const changelogPath = path.join(ROOT, 'CHANGELOG.md');
const dateStr = new Date().toISOString().slice(0, 10);
const block = `\n## ${newAppVersion}（${dateStr}）\n\n${entries.map((e) => `- ${e}`).join('\n')}\n`;
if (opts.deployOnly) {
  info('(--deploy-only 跳过)');
} else if (!opts.dry) {
  const old = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : '# 更新日志\n';
  const marker = '# 更新日志\n';
  const rest = old.startsWith(marker) ? old.slice(marker.length) : old;
  fs.writeFileSync(changelogPath, marker + block + rest);
  ok(`CHANGELOG.md 已更新（${newAppVersion}）`);
} else {
  info('(--dry 未写入) ' + block.trim().replace(/\n/g, ' | '));
}

/* --------------------- 5. 提交 --------------------- */
step('5/7', '提交改动');
if (opts.deployOnly) {
  info('(--deploy-only 跳过)');
} else if (!opts.dry) {
  git(['add', '-A']);
  const staged = git(['diff', '--cached', '--name-only']);
  if (!staged) {
    info('没有需要提交的改动，跳过提交');
  } else {
    const subject = `chore(release): ${newAppVersion}`;
    const body = entries.map((e) => `- ${e}`).join('\n');
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'CodeBuddy',
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'codebuddy@users.noreply.github.com',
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'CodeBuddy',
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'codebuddy@users.noreply.github.com',
    };
    execFileSync('git', ['commit', '-m', subject, '-m', body], { cwd: ROOT, encoding: 'utf8', env });
    ok(`${subject}（${staged.split('\n').length} 个文件）`);
  }
} else {
  info('(--dry 未提交)');
}

/* --------------------- 6. 部署阿里云 --------------------- */
step('6/7', '部署到阿里云');
if (opts.dry) {
  info('(--dry 未部署)');
} else if (opts.noDeploy) {
  info('(--no-deploy 跳过)');
} else {
  if (!PA_SERVER) die('未配置 PA_SERVER（在本机 .env 中设置，例如 PA_SERVER=root@your-host）');
  if (!fs.existsSync(PA_SSH_KEY)) die(`SSH 私钥不存在：${PA_SSH_KEY}`);

  const tarball = path.join(os.tmpdir(), `pa-src-${Date.now()}.tgz`);
  const pkg = ['server', 'public', 'deploy', 'apk-store', 'README.md', 'package.json', 'package-lock.json', 'CHANGELOG.md'];
  spawnSync('tar', ['-czf', tarball, ...pkg], { cwd: ROOT, encoding: 'utf8' });
  if (!fs.existsSync(tarball)) die('本地打包失败');
  ok(`打包完成（${(fs.statSync(tarball).size / 1024).toFixed(0)} KB，不含 data/ 与 uploads/）`);

  const sshBase = ['-i', PA_SSH_KEY, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];
  const target = `${PA_SERVER}`;

  const scp = spawnSync('scp', [...sshBase, tarball, `${target}:/tmp/pa-src.tgz`], { encoding: 'utf8' });
  if (scp.status !== 0) die('上传失败：' + (scp.stderr || ''));
  ok('已上传到服务器 /tmp/pa-src.tgz');

  const lockSha = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(ROOT, 'package-lock.json')))
    .digest('hex');

  const remoteCmd = [
    `set -e`,
    `mkdir -p ${PA_REMOTE}`,
    `tar -xzf /tmp/pa-src.tgz -C ${PA_REMOTE}`,
    `rm -f /tmp/pa-src.tgz`,
    // 依赖：仅当 lockfile 变化时才重装，避免每次发版都跑 npm ci
    `cd ${PA_REMOTE}`,
    `if [ ! -f .deploy-lock-sha ] || [ "$(cat .deploy-lock-sha)" != "${lockSha}" ]; then npm ci --omit=dev --no-audit --no-fund; echo "${lockSha}" > .deploy-lock-sha; fi`,
    `pm2 restart ${PA_PM2_APP} --update-env`,
    `pm2 save`,
    `sleep 2`,
    `curl -s http://127.0.0.1:3000/version.json`,
  ].join(' && ');
  const ssh = spawnSync('ssh', [...sshBase, target, remoteCmd], { encoding: 'utf8' });
  if (ssh.status !== 0) die('远端部署失败：' + (ssh.stderr || ssh.stdout));
  ok('已解包并重启 pm2');

  // 线上验证
  const out = (ssh.stdout || '').trim();
  const jsonStart = out.indexOf('{');
  if (jsonStart < 0) die('未取到线上 /version.json，输出：' + out.slice(-300));
  let online;
  try {
    online = JSON.parse(out.slice(jsonStart));
  } catch {
    die('线上 /version.json 解析失败：' + out.slice(-300));
  }
  if (online.version !== newAppVersion) die(`线上版本不一致：期望 ${newAppVersion}，实际 ${online.version}`);
  ok(`线上已生效：/version.json => ${online.version}（code ${online.android?.latestCode}）`);
}

/* --------------------- 7. 推送 GitHub --------------------- */
step('7/7', '推送 GitHub');
if (opts.dry) {
  info('(--dry 未推送)');
} else if (opts.noPush || opts.deployOnly) {
  info(opts.deployOnly ? '(--deploy-only 跳过)' : '(--no-push 跳过)');
} else {
  const remote = git(['remote', 'get-url', 'origin']);
  const pushUrl = GITHUB_TOKEN ? remote.replace('https://', `https://${GITHUB_TOKEN}@`) : remote;

  // CI 回写的提交（apk-store/ 与 version.json）会让本地落后，推送前先并入远端
  const noPrompt = { cwd: ROOT, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } };
  const fetched = spawnSync('git', ['fetch', pushUrl, 'main'], noPrompt);
  if (fetched.status === 0) {
    const behind = Number(git(['rev-list', '--count', 'HEAD..FETCH_HEAD']) || '0');
    if (behind > 0) {
      const pr = spawnSync('git', ['pull', '--rebase', '--no-tags', pushUrl, 'main'], noPrompt);
      if (pr.status !== 0) die('本地落后于远端且自动 rebase 失败，请手动 `git pull --rebase origin main` 后重跑');
      info(`已并入远端 ${behind} 个提交（通常是 CI 回填的 APK 与版本信息）`);
    }
  }
  const pushEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  // 注意：不要加 -c http.version=HTTP/1.1，实测会让推送卡到 75s 连接超时；默认 HTTP/2 正常
  const runPush = () =>
    spawnSync('git', [
      '-c', 'credential.helper=',
      'push', pushUrl, 'HEAD:main',
    ], { cwd: ROOT, encoding: 'utf8', env: pushEnv });

  let push = runPush();
  // 本机访问 github.com 会间歇性连接超时，最多重试 3 次
  for (let i = 0; push.status !== 0 && i < 3; i++) {
    info(`推送失败，第 ${i + 1} 次重试…（本机到 github.com 会间歇性超时）`);
    push = runPush();
  }
  if (push.status !== 0) die('推送失败：' + ((push.stderr || '') + (push.stdout || '')).trim());
  ok('已推送到 origin/main');

  if (opts.tag) {
    const tagName = `v${newName}`;
    spawnSync('git', ['tag', '-f', tagName], { cwd: ROOT, encoding: 'utf8' });
    let tp = spawnSync('git', ['-c', 'credential.helper=', 'push', pushUrl, '-f', tagName],
      { cwd: ROOT, encoding: 'utf8', env: pushEnv });
    for (let i = 0; tp.status !== 0 && i < 3; i++) {
      info(`标签推送失败，第 ${i + 1} 次重试…`);
      tp = spawnSync('git', ['-c', 'credential.helper=', 'push', pushUrl, '-f', tagName],
        { cwd: ROOT, encoding: 'utf8', env: pushEnv });
    }
    if (tp.status !== 0) die('标签推送失败：' + ((tp.stderr || '') + (tp.stdout || '')).trim());
    ok(`已推送标签 ${tagName}（将触发 APK 构建流水线）`);
  }
}

console.log(`\n\u001b[1m完成\u001b[0m  版本 ${newAppVersion}`);
