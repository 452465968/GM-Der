// 生产环境最终检查：登录 / 版本号 / 同步状态 / 更新弹窗 / 离线 / Android 下载入口
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ORIGIN = 'https://furry233.cn';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
const dirs = [];
const cleanup = () => { for (const p of procs) try { p.kill(); } catch {} for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch {} };
async function waitHttp(url, tries = 40) { for (let i = 0; i < tries; i++) { try { const r = await fetch(url); if (r.ok) return true; } catch {} await sleep(300); } return false; }

async function main() {
  try {
    const prof = mkdtempSync(path.join(tmpdir(), 'pa-final-'));
    dirs.push(prof);
    const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--remote-allow-origins=*', '--remote-debugging-port=9365', `--user-data-dir=${prof}`, 'about:blank'], { stdio: 'ignore' });
    procs.push(edge);
    if (!(await waitHttp('http://127.0.0.1:9365/json/list'))) throw new Error('edge not ready');
    const page = (await (await fetch('http://127.0.0.1:9365/json/list')).json()).find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
    const cmd = (method, params = {}) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
    const ev = async (expression) => { const r = await cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || '').slice(0, 200)); return r.result.value; };
    const waitUntil = async (expr, ms, label) => { const t0 = Date.now(); let last = null; while (Date.now() - t0 < ms) { last = await ev(expr).catch(() => null); if (last) return last; await sleep(500); } throw new Error('timeout ' + label + ' ' + JSON.stringify(last)); };

    await cmd('Runtime.enable'); await cmd('Page.enable'); await cmd('Network.enable');
    await cmd('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 3, mobile: true });
    await cmd('Page.navigate', { url: ORIGIN + '/' });
    await waitUntil(`!!document.querySelector('#auth-form')`, 25000, 'login');
    const ver = await ev(`(()=>{const el=document.querySelector('.version-tag'); return el? el.textContent.trim():'(none)';})()`);
    console.log('[1] 登录页版本号 =', ver);
    await ev(`(()=>{const f=document.querySelector('#auth-form'); f.querySelector('[name=username]').value='admin'; f.querySelector('[name=password]').value='123456'; f.requestSubmit(); return true;})()`);
    await waitUntil(`document.getElementById('app') && document.getElementById('app').className==='layout'`, 25000, 'layout');
    await sleep(4000);
    const state = await ev(`(()=>{const s=document.querySelector('[data-role="sync-state"]'); return s? s.textContent.trim():'(none)';})()`);
    const modal = await ev(`!!document.querySelector('.modal-mask')`);
    console.log('[2] 同步状态 =', state, '| 无更新弹窗 =', !modal);

    // Android 下载入口
    await cmd('Page.navigate', { url: ORIGIN + '/sideload/' });
    await sleep(2000);
    const apk = await ev(`(()=>{const a=Array.from(document.querySelectorAll('a')).find(x=>x.href.includes('.apk')); return a? a.getAttribute('href'):'(none)';})()`);
    console.log('[3] Android 下载链接 =', apk);

    // 离线可用
    await cmd('Page.navigate', { url: ORIGIN + '/#/apps' });
    await waitUntil(`document.getElementById('app').className==='layout'`, 25000, 'apps');
    await sleep(2500);
    await cmd('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await cmd('Page.navigate', { url: ORIGIN + '/#/apps' });
    await sleep(3500);
    const offline = await ev(`(()=>{const s=document.querySelector('[data-role="sync-state"]'); return JSON.stringify({ rendered: document.getElementById('app').className, state: s? s.textContent.trim():'(none)' });})()`);
    console.log('[4] 离线 =', offline);

    const o = JSON.parse(offline);
    const pass = String(ver).includes('beta1.2.3') && String(state).startsWith('已同步') && !modal && String(apk).includes('.apk') && String(o.state).includes('离线');
    console.log(pass ? 'FINAL-CHECK-PASS' : 'FINAL-CHECK-FAIL');
  } catch (err) {
    console.error('FINAL-CHECK-ERR', err.message);
  } finally {
    cleanup();
    process.exit(0);
  }
}
main();
