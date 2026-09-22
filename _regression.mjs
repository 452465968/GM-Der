// 全量回归：登录 / 版本 / 可见范围 / 增量同步 / 冲突检测 / 后台管理 / 通知设置与广播
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:3005';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitHttp(url, tries = 40) { for (let i = 0; i < tries; i++) { try { const r = await fetch(url); if (r.ok) return true; } catch {} await sleep(300); } return false; }

function session() {
  const jar = new Map();
  return async function call(method, url, body) {
    const cookie = Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    let target = url; let payload;
    if (method === 'GET' && body && typeof body === 'object') {
      const qs = new URLSearchParams();
      Object.keys(body).forEach((k) => { const v = body[k]; if (v !== '' && v !== null && v !== undefined) qs.append(k, String(v)); });
      const s = qs.toString(); if (s) target = `${url}?${s}`;
    } else if (body !== undefined) payload = JSON.stringify(body);
    const res = await fetch(BASE + target, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, cookie ? { Cookie: cookie } : {}),
      body: payload,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) sc.split(',').forEach((p) => { const kv = p.split(';')[0]; const i = kv.indexOf('='); if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim()); });
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { status: res.status, data };
  };
}

const server = spawn('node', ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: '3005', COOKIE_SECURE: 'false', SUPER_ADMINS: 'admin' },
  stdio: 'ignore',
});

async function main() {
  const r = {};
  try {
    if (!(await waitHttp(BASE + '/'))) throw new Error('server not ready');

    // 版本一致
    const vj = await (await fetch(BASE + '/version.json')).json();
    const vjs = await (await import('./public/js/version.js')).APP_VERSION;
    r.versionMatch = vj.version === vjs;
    console.log('[1] 版本一致 =', r.versionMatch, `(${vj.version})`);

    const admin = session();
    await admin('POST', '/api/auth/login', { username: 'admin', password: '123456' });
    const me = await admin('GET', '/api/auth/me');
    const adminId = me.data.user.id;
    r.login = me.data.user.username === 'admin' && me.data.user.isSuperAdmin === true;
    console.log('[2] 登录 + 超管身份 =', r.login);

    const user = session();
    await user('POST', '/api/auth/login', { username: 'user', password: '123456' });
    const t0 = new Date().toISOString();
    await sleep(1100);

    // 可见范围
    const pub = await user('POST', '/api/applications', { itemName: '回归-公开', price: 11, platform: '京东', hasAlternative: 'yes', approverIds: adminId, passVotes: 1, visibility: 'public' });
    const lim = await user('POST', '/api/applications', { itemName: '回归-受限', price: 22, platform: '天猫', hasAlternative: 'yes', approverIds: adminId, passVotes: 1, visibility: 'restricted' });
    const other = session();
    const reg = await other('POST', '/api/auth/register', { username: 'reg_tester', password: '123456', name: '回归旁观者' });
    if (reg.status === 409) await other('POST', '/api/auth/login', { username: 'reg_tester', password: '123456' });
    const rec = await other('GET', '/api/applications/records');
    const deniedDetail = await other('GET', `/api/applications/${lim.data.application.id}`);
    r.visibility = deniedDetail.status === 403;
    console.log('[3] 受限申请对旁观者 403 =', r.visibility);

    // 同步 + 冲突
    const sync = await admin('GET', '/api/sync', { since: t0 });
    r.syncHas = (sync.data.applications || []).some((i) => i.id === pub.data.application.id);
    const stale = await admin('POST', `/api/applications/${pub.data.application.id}/decision`, { action: 'approve', comment: '旧版本', expectedUpdatedAt: '2020-01-01T00:00:00.000Z' });
    r.conflict = stale.status === 409 && stale.data.conflict === true;
    const fresh = await admin('GET', `/api/applications/${pub.data.application.id}`);
    const okVote = await admin('POST', `/api/applications/${pub.data.application.id}/decision`, { action: 'approve', comment: '同意', expectedUpdatedAt: fresh.data.application.updatedAt });
    r.voteOk = okVote.status === 200;
    console.log('[4] 同步含变更 =', r.syncHas, '| 冲突 409 =', r.conflict, '| 正常投票 =', r.voteOk);

    // 后台管理
    const boot = await admin('GET', '/api/admin/bootstrap');
    const created = await admin('POST', '/api/admin/users', { username: 'reg_tmp', password: '123456', name: '临时', role: 'user', permissions: [] });
    const del = await admin('DELETE', `/api/admin/users/${created.data.user.id}`);
    const logs = await admin('GET', '/api/admin/logs', { limit: 10 });
    const audit = await admin('GET', '/api/admin/audit', { limit: 10 });
    r.admin = boot.status === 200 && created.status === 201 && del.status === 200 && (logs.data.total || 0) > 0 && (audit.data.total || 0) > 0;
    console.log('[5] 后台管理 =', r.admin, `(日志 ${logs.data.total} / 审计 ${audit.data.total})`);

    // 通知设置与广播
    const set = await admin('PUT', '/api/notify/settings', { wechat: '13800000000', channels: { wechat: true, email: true, qq: true, webpush: true } });
    const bc = await admin('POST', '/api/notify/debug/broadcast', { title: '回归广播', body: '回归测试' });
    const subs = await admin('GET', '/api/notify/debug/subscriptions');
    r.notify = set.status === 200 && bc.status === 200 && subs.status === 200;
    console.log('[6] 通知设置/广播/订阅 =', r.notify, `(广播 ${JSON.stringify(bc.data)})`);

    const pass = r.versionMatch && r.login && r.visibility && r.syncHas && r.conflict && r.voteOk && r.admin && r.notify;
    console.log(pass ? 'REGRESSION-PASS' : 'REGRESSION-FAIL');
  } catch (err) {
    console.error('REGRESSION-ERR', err.message);
  } finally {
    server.kill();
    process.exit(0);
  }
}
main();
