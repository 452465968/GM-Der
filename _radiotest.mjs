// 验证表单中两组单选（是否有替代品 / 可见范围）互不干扰：真实指针点击（等同手指点按）
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LOCAL = 'http://localhost:3006';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
const dirs = [];
const cleanup = () => { for (const p of procs) try { p.kill(); } catch {} for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch {} };
async function waitHttp(url, tries = 60) { for (let i = 0; i < tries; i++) { try { const r = await fetch(url); if (r.ok) return true; } catch {} await sleep(300); } return false; }

let portSeed = 9800;
async function open() {
  portSeed += 1;
  const prof = mkdtempSync(path.join(tmpdir(), 'pa-radio-'));
  dirs.push(prof);
  const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--remote-allow-origins=*', `--remote-debugging-port=${portSeed}`, `--user-data-dir=${prof}`, 'about:blank'], { stdio: 'ignore' });
  procs.push(edge);
  if (!(await waitHttp(`http://127.0.0.1:${portSeed}/json/list`))) throw new Error('edge not ready');
  const page = (await (await fetch(`http://127.0.0.1:${portSeed}/json/list`)).json()).find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
  const cmd = (method, params = {}) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
  const ev = async (expression) => { const r = await cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || '').slice(0, 200)); return r.result.value; };
  await cmd('Runtime.enable'); await cmd('Page.enable');
  return { cmd, ev, ws };
}

async function tap(b, labelText) {
  const box = await b.ev(`(()=>{
    const cards = Array.from(document.querySelectorAll('.radio-card'));
    const c = cards.find(x => x.textContent.trim().includes(${JSON.stringify(labelText)}));
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
  })()`);
  if (!box) throw new Error('card not found: ' + labelText);
  await b.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await b.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await b.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(250);
}

const state = `(()=>{
  const cards = Array.from(document.querySelectorAll('.radio-card')).map(c=>{
    const i = c.querySelector('input');
    return { text: c.textContent.trim(), name: i && i.name, value: i && i.value, checked: !!(i && i.checked), active: c.classList.contains('active') };
  });
  const f = document.querySelector('#app-form');
  const fd = f ? Object.fromEntries(new FormData(f)) : {};
  return { cards, fd: { hasAlternative: fd.hasAlternative, visibility: fd.visibility } };
})()`;

async function main() {
  try {
    const server = spawn('node', ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: '3006', COOKIE_SECURE: 'false' }, stdio: 'ignore' });
    procs.push(server);
    if (!(await waitHttp(LOCAL + '/'))) throw new Error('server not ready');
    const b = await open();
    await b.cmd('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
    await b.cmd('Page.navigate', { url: LOCAL + '/' });
    await sleep(2500);
    await b.ev(`(async()=>{
      const u=[...document.querySelectorAll('#auth-form input')];
      const set=(n,v)=>{const el=document.querySelector('#auth-form [name="'+n+'"]'); if(el){el.value=v; el.dispatchEvent(new Event('input',{bubbles:true}));}};
      document.querySelectorAll('.auth-tabs button')[0] && document.querySelectorAll('.auth-tabs button')[0].click();
      set('username','user'); set('password','123456');
      await new Promise(r=>setTimeout(r,200));
      document.querySelector('#auth-form button[type="submit"]').click();
      return true;
    })()`);
    await sleep(2500);
    await b.ev(`location.hash = '#/apps/new'`);
    await sleep(2500);
    const ready = await b.ev(`!!document.querySelector('#app-form')`);
    if (!ready) throw new Error('form not rendered');

    const results = {};

    // 场景 A：先点「无替代品」，再点「仅限指定审批人查看」
    await tap(b, '无替代品');
    await tap(b, '仅限指定审批人查看');
    let s = await b.ev(state);
    results.A = {
      altNo: s.cards.find((c) => c.value === 'no').active,
      visRestricted: s.cards.find((c) => c.value === 'restricted').active,
      fd: s.fd,
      activeCount: s.cards.filter((c) => c.active).length,
    };

    // 场景 B：切回「有替代品」，可见范围不应受影响
    await tap(b, '有替代品');
    s = await b.ev(state);
    results.B = {
      altYes: s.cards.find((c) => c.value === 'yes').active,
      altNo: s.cards.find((c) => c.value === 'no').active,
      visRestricted: s.cards.find((c) => c.value === 'restricted').active,
      fd: s.fd,
    };

    // 场景 C：切回「向所有人公开」，替代品选择不应受影响
    await tap(b, '向所有人公开');
    s = await b.ev(state);
    results.C = {
      altYes: s.cards.find((c) => c.value === 'yes').active,
      visPublic: s.cards.find((c) => c.value === 'public').active,
      visRestricted: s.cards.find((c) => c.value === 'restricted').active,
      fd: s.fd,
    };

    console.log(JSON.stringify(results, null, 2));
    const pass =
      results.A.altNo && results.A.visRestricted && results.A.activeCount === 2 &&
      results.A.fd.hasAlternative === 'no' && results.A.fd.visibility === 'restricted' &&
      results.B.altYes && !results.B.altNo && results.B.visRestricted &&
      results.B.fd.hasAlternative === 'yes' && results.B.fd.visibility === 'restricted' &&
      results.C.altYes && results.C.visPublic && !results.C.visRestricted &&
      results.C.fd.hasAlternative === 'yes' && results.C.fd.visibility === 'public';
    console.log(pass ? 'RADIO-TEST-PASS' : 'RADIO-TEST-FAIL');
    b.ws.close();
  } catch (err) {
    console.error('RADIO-TEST-ERR', err.message);
  } finally {
    cleanup();
    process.exit(0);
  }
}
main();
