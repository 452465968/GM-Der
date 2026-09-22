#!/usr/bin/env node
/**
 * 版本同步脚本：把「版本号」在一处修改、四处生效。
 *
 * 版本号散落在 4 个地方，手工改极易漏：
 *   1. android/app/build.gradle   versionCode / versionName（安卓包的真实版本）
 *   2. public/version.json        version、android.latestVersion、android.latestCode
 *   3. public/version.json        android.apkUrl / size / sha256（应用内更新要用）
 *   4. public/js/version.js       APP_VERSION（前端展示与自检）
 *
 * 两种用法：
 *   A）发版改号  node deploy/bump-version.mjs --code 7 --name 1.2.7
 *   B）同步其余  node deploy/bump-version.mjs [--apk-path apk-store/xxx.apk] [--changelog "说明"]
 *      —— 不带 --code/--name 时，以 build.gradle 为准，把 version.json / version.js 拉齐，
 *         CI 构建完 APK 后就是这么回填 size 与 sha256 的。
 *
 * 常用参数：
 *   --code <n>            新 versionCode
 *   --name <x.y.z>        新 versionName（如 1.2.7）
 *   --prefix <str>        前端版本前缀，默认沿用 version.json 现有前缀（如 beta）
 *   --apk-path <file>     计算该 APK 的 size / sha256 并写入 version.json
 *   --apk-url <url>       覆盖 APK 下载地址，默认 /sideload/downloads/<文件名>
 *   --changelog <文本>     可重复传入，替换更新说明
 *   --dry                 只打印将要写入的内容，不落盘（预览用）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const GRADLE = path.join(ROOT, 'android/app/build.gradle');
const VERSION_JSON = path.join(ROOT, 'public/version.json');
const VERSION_JS = path.join(ROOT, 'public/js/version.js');

// ---- 解析命令行参数 ----
const argv = process.argv.slice(2);
const opts = { changelog: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--code') opts.code = Number(argv[++i]);
  else if (a === '--name') opts.name = argv[++i];
  else if (a === '--prefix') opts.prefix = argv[++i];
  else if (a === '--apk-path') opts.apkPath = argv[++i];
  else if (a === '--apk-url') opts.apkUrl = argv[++i];
  else if (a === '--changelog') opts.changelog.push(argv[++i]);
  else if (a === '--dry') opts.dry = true;
  else if (a === '--help' || a === '-h') {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
    process.exit(0);
  }
}

// ---- 读取当前状态 ----
const gradleText = fs.readFileSync(GRADLE, 'utf8');
const versionJson = JSON.parse(fs.readFileSync(VERSION_JSON, 'utf8'));
const versionJsText = fs.readFileSync(VERSION_JS, 'utf8');

const readGradle = (key) => {
  const m = gradleText.match(new RegExp(key + '\\s+("?)([^\\s"]+)\\1'));
  return m ? m[2] : null;
};
let code = Number(readGradle('versionCode'));
let name = readGradle('versionName');
const before = { code, name, jsonVersion: versionJson.version, appVersion: (versionJsText.match(/APP_VERSION\s*=\s*'([^']+)'/) || [])[1] };

// ---- 应用新版本号 ----
if (opts.code) code = opts.code;
if (opts.name) name = opts.name;

// 前缀：优先 --prefix，否则沿用 version.json 现有前缀（beta1.2.6 - 1.2.6 => beta）
const oldName = before.name;
let prefix = opts.prefix;
if (prefix === undefined) {
  prefix = versionJson.version && oldName && versionJson.version.endsWith(oldName)
    ? versionJson.version.slice(0, versionJson.version.length - oldName.length)
    : 'beta';
}
const appVersion = prefix + name;

// ---- 写 build.gradle ----
let newGradle = gradleText;
if (opts.code || opts.name) {
  newGradle = newGradle
    .replace(/versionCode\s+\d+/, 'versionCode ' + code)
    .replace(/versionName\s+"[^"]+"/, 'versionName "' + name + '"');
}

// ---- 写 version.json ----
versionJson.version = appVersion;
versionJson.android = versionJson.android || {};
versionJson.android.latestVersion = appVersion;
versionJson.android.latestCode = code;
versionJson.updatedAt = new Date().toISOString();
versionJson.android.updatedAt = new Date().toISOString();
if (opts.changelog.length) versionJson.android.changelog = opts.changelog;

if (opts.apkPath) {
  const abs = path.isAbsolute(opts.apkPath) ? opts.apkPath : path.join(ROOT, opts.apkPath);
  if (!fs.existsSync(abs)) {
    console.error('找不到 APK:', abs);
    process.exit(1);
  }
  const buf = fs.readFileSync(abs);
  versionJson.android.apkUrl = opts.apkUrl || '/sideload/downloads/' + path.basename(abs);
  versionJson.android.size = buf.length;
  versionJson.android.sha256 = crypto.createHash('sha256').update(buf).digest('hex');
}

// ---- 写 version.js ----
const newVersionJs = versionJsText.replace(/APP_VERSION\s*=\s*'[^']+'/, "APP_VERSION = '" + appVersion + "'");

// ---- 落盘或预览 ----
const after = { code, name, jsonVersion: versionJson.version, appVersion };
console.log('版本号变更：');
console.log('  build.gradle   versionCode', before.code, '->', after.code);
console.log('  build.gradle   versionName', before.name, '->', after.name);
console.log('  version.json   version    ', before.jsonVersion, '->', after.jsonVersion);
console.log('  version.js     APP_VERSION', before.appVersion, '->', after.appVersion);
if (opts.apkPath) console.log('  APK 校验值已回填：size=' + versionJson.android.size + '  sha256=' + versionJson.android.sha256);
console.log('  APK 下载地址：' + versionJson.android.apkUrl);

if (opts.dry) {
  console.log('\n(--dry 模式，未写入文件)');
  process.exit(0);
}

fs.writeFileSync(GRADLE, newGradle);
fs.writeFileSync(VERSION_JSON, JSON.stringify(versionJson, null, 2) + '\n');
fs.writeFileSync(VERSION_JS, newVersionJs);
console.log('\n已写入：android/app/build.gradle、public/version.json、public/js/version.js');
