// 一次性本地离线验证：启动 3005 服务 + 无头 Edge，登录预热 SW 缓存，模拟断网后刷新，
// 验证外壳仍能打开、核心视图有内容、离线提示出现。用后即删。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:3005';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const procs = [];
const dirs = [];
function cleanup() {
  for (const p of procs) try { p.kill(); } catch {}
  for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch {}
}

async function waitHttp(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return true; } catch {}
    await sleep(400);
  }
  return false;
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };
  return new Promise((resolve, reject) => {
    ws.onopen = () => {
      const cmd = (method, params = {}) =>
        new Promise((res2, rej2) => {
          const mid = ++id;
          pending.set(mid, { resolve: res2, reject: rej2 });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      resolve({ cmd, ws });
    };
    ws.onerror = (e) => { reject(new Error('ws error')); cleanup(); };
  });
}

async function main() {
  let server, edge, prof;
  try {
    // 1) 本地服务
    server = spawn('node', ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: '3005', COOKIE_SECURE: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(server);
    if (!(await waitHttp(BASE + '/'))) throw new Error('local server not ready');
    console.log('[1/6] local server ready');

    // 2) 无头 Edge
    prof = mkdtempSync(path.join(tmpdir(), 'pa-off-'));
    dirs.push(prof);
    edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-allow-origins=*', '--remote-debugging-port=9331', `--user-data-dir=${prof}`, 'about:blank'], { stdio: 'ignore' });
    procs.push(edge);
    if (!(await waitHttp('http://127.0.0.1:9331/json/list'))) throw new Error('edge not ready');
    const list = await (await fetch('http://127.0.0.1:9331/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    const { cmd, ws } = await cdp(page.webSocketDebuggerUrl);
    console.log('[2/6] headless edge attached');

    await cmd('Page.enable');
    await cmd('Runtime.enable');
    await cmd('Network.enable');

    const ev = async (expression) => {
      const r = await cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
      return r.result.value;
    };
    const waitUntil = async (expression, ms, label) => {
      const t0 = Date.now();
      let last = null;
      while (Date.now() - t0 < ms) {
        last = await ev(expression).catch(() => null);
        if (last) return last;
        await sleep(500);
      }
      throw new Error('timeout waiting: ' + label + ' last=' + JSON.stringify(last));
    };

    // 3) 首次在线加载（未登录）→ 预缓存外壳 + SW 注册
    await cmd('Page.navigate', { url: BASE + '/' });
    await waitUntil(`document.readyState==='complete' && !!document.querySelector('.auth-page')`, 15000, 'login page');
    await waitUntil(`(async()=>{ const reg=await navigator.serviceWorker.getRegistration(); return !!reg && !!navigator.serviceWorker.controller; })()`, 15000, 'sw controlling');
    console.log('[3/6] shell cached & SW controlling');

    // 4) 登录并预热业务缓存
    const login = await ev(`fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'123456'})}).then(r=>r.json())`);
    if (!login.user) throw new Error('login failed');
    await cmd('Page.reload', { ignoreCache: false });
    await waitUntil(`document.querySelector('#app') && document.querySelector('#app').className==='layout'`, 15000, 'app layout');
    await sleep(3000); // 等待通知轮询/列表等 GET 写入缓存
    console.log('[4/6] logged in, caches warmed');

    // 5) 断网后刷新
    await cmd('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0, connectionType: 'none' });
    await sleep(600);
    await cmd('Page.reload', { ignoreCache: false });
    await sleep(1500);

    // 6) 断言离线能力
    const pill = await waitUntil(`document.getElementById('net-pill') ? document.getElementById('net-pill').classList.contains('visible') : false`, 8000, 'offline pill');
    const layout = await waitUntil(`document.querySelector('#app') && document.querySelector('#app').className==='layout'`, 12000, 'offline layout shell');
    const summary = await ev(`({
      navText: (document.querySelector('.mobile-nav')?.innerText||'').slice(0,60),
      viewText: (document.getElementById('view')?.innerText||'').slice(0,80).replace(/\\n/g,' '),
      online: navigator.onLine,
      controller: !!navigator.serviceWorker.controller
    })`);
    const bootRemoved = await ev(`!document.getElementById('boot-splash')`);
    console.log('[5/6] offline assertions -> pill=' + pill + ' layout=' + layout + ' splashRemoved=' + bootRemoved);
    console.log('[6/6] offline summary:', JSON.stringify(summary));

    const pass = pill && layout && bootRemoved && summary.online === false;
    console.log(pass ? 'OFFLINE-TEST-PASS' : 'OFFLINE-TEST-FAIL');
    ws.close();
    cleanup();
    process.exit(pass ? 0 : 1);
  } catch (err) {
    console.error('OFFLINE-TEST-FAIL', err.message);
    cleanup();
    process.exit(1);
  }
}

main();
