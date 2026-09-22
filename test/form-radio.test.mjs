/**
 * 表单单选/多选卡片回归测试（无头浏览器 + 真实指针点击，等同手指点按）
 *
 * 覆盖：
 *  1. 「是否有替代品」与「可见范围」两组互不干扰（组内互斥、组间独立）
 *  2. 原生 input 不再使用 hidden，可聚焦（键盘/读屏可用）
 *  3. 多选卡片（checkbox 语义）可同时选中多个，并能通过 FormData 取到数组
 *
 * 运行：npm test
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.TEST_PORT || 3007);
const LOCAL = `http://localhost:${PORT}`;
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
const dirs = [];
const cleanup = () => {
  for (const p of procs) try { p.kill(); } catch { /* ignore */ }
  for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
};

async function waitHttp(url, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch { /* retry */ }
    await sleep(300);
  }
  return false;
}

async function openBrowser() {
  const prof = mkdtempSync(path.join(tmpdir(), 'pa-radio-'));
  dirs.push(prof);
  const port = 9800 + Math.floor(Math.random() * 200);
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--remote-allow-origins=*',
    `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, 'about:blank',
  ], { stdio: 'ignore' });
  procs.push(edge);
  if (!(await waitHttp(`http://127.0.0.1:${port}/json/list`))) throw new Error('浏览器未就绪');
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  };
  const cmd = (method, params = {}) => new Promise((res, rej) => {
    const mid = (id += 1);
    pending.set(mid, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const ev = async (expression) => {
    const r = await cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || '').slice(0, 300));
    return r.result.value;
  };
  await cmd('Runtime.enable');
  await cmd('Page.enable');
  return { cmd, ev, ws };
}

async function tapCard(b, text) {
  const box = await b.ev(`(()=>{
    const form = document.querySelector('#app-form');
    const cards = Array.from(form.querySelectorAll('.radio-card'));
    const c = cards.find((x) => x.textContent.trim().includes(${JSON.stringify(text)}));
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (!box) throw new Error(`未找到卡片：${text}`);
  await b.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await b.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await b.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(200);
}

// 表单内两组单选的实时状态
const STATE_EXPR = `(()=>{
  const form = document.querySelector('#app-form');
  const cards = Array.from(form.querySelectorAll('.radio-card')).map((c) => {
    const i = c.querySelector('input');
    return { name: i && i.name, value: i && i.value, checked: !!(i && i.checked), active: c.classList.contains('active') };
  });
  const fd = Object.fromEntries(new FormData(form));
  return { cards, fd: { hasAlternative: fd.hasAlternative, visibility: fd.visibility } };
})()`;

async function scenarioABC(b) {
  await tapCard(b, '无替代品');
  await tapCard(b, '仅限指定审批人查看');
  const A = await b.ev(STATE_EXPR);

  await tapCard(b, '有替代品');
  const B = await b.ev(STATE_EXPR);

  await tapCard(b, '向所有人公开');
  const C = await b.ev(STATE_EXPR);

  const pick = (s, name, value) => s.cards.find((c) => c.name === name && c.value === value);
  return {
    A, B, C,
    pass: Boolean(
      pick(A, 'hasAlternative', 'no').active &&
      pick(A, 'visibility', 'restricted').active &&
      A.cards.filter((c) => c.active).length === 2 &&
      A.fd.hasAlternative === 'no' && A.fd.visibility === 'restricted' &&
      pick(B, 'hasAlternative', 'yes').active && !pick(B, 'hasAlternative', 'no').active &&
      pick(B, 'visibility', 'restricted').active &&
      B.fd.hasAlternative === 'yes' && B.fd.visibility === 'restricted' &&
      pick(C, 'hasAlternative', 'yes').active &&
      pick(C, 'visibility', 'public').active && !pick(C, 'visibility', 'restricted').active &&
      C.fd.hasAlternative === 'yes' && C.fd.visibility === 'public',
    ),
  };
}

async function a11yCheck(b) {
  return b.ev(`(()=>{
    const form = document.querySelector('#app-form');
    const inputs = Array.from(form.querySelectorAll('.radio-card input'));
    const hiddenCount = inputs.filter((i) => i.hasAttribute('hidden') || getComputedStyle(i).display === 'none').length;
    const first = inputs[0];
    first.focus();
    const focusable = document.activeElement === first;
    const groups = Array.from(form.querySelectorAll('.radio-row')).filter((g) => g.getAttribute('role') === 'radiogroup').length;
    return { total: inputs.length, hiddenCount, focusable, groups };
  })()`);
}

async function multiSelectCheck(b) {
  return b.ev(`(async () => {
    const m = await import('/js/views/shared.js');
    const form = document.createElement('form');
    form.id = 'multi-form';
    form.innerHTML = '<div class="radio-row">' +
      m.cardHtml({ name: 'tags[]', value: 'a', label: '选项A', multi: true }) +
      m.cardHtml({ name: 'tags[]', value: 'b', label: '选项B', multi: true }) +
      m.cardHtml({ name: 'tags[]', value: 'c', label: '选项C', multi: true }) +
      '</div>';
    document.body.appendChild(form);
    m.bindRadioCards(form);
    const cards = Array.from(form.querySelectorAll('.radio-card'));
    cards[0].click();
    cards[2].click();
    const fd = new FormData(form);
    const values = fd.getAll('tags[]');
    const active = cards.filter((c) => c.classList.contains('active')).length;
    const res = { values, active, total: cards.length };
    form.remove();
    return res;
  })()`);
}

async function main() {
  let failed = false;
  try {
    const server = spawn('node', ['server/index.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), COOKIE_SECURE: 'false' },
      stdio: 'ignore',
    });
    procs.push(server);
    if (!(await waitHttp(`${LOCAL}/`))) throw new Error('本地服务未启动');

    const b = await openBrowser();
    await b.cmd('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
    await b.cmd('Page.navigate', { url: `${LOCAL}/` });
    await sleep(2500);

    await b.ev(`(async () => {
      const set = (n, v) => {
        const el = document.querySelector('#auth-form [name="' + n + '"]');
        if (el) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }
      };
      set('username', 'user');
      set('password', '123456');
      await new Promise((r) => setTimeout(r, 200));
      document.querySelector('#auth-form button[type="submit"]').click();
      return true;
    })()`);
    await sleep(2500);

    await b.ev(`location.hash = '#/apps/new'`);
    await sleep(2500);
    if (!(await b.ev(`!!document.querySelector('#app-form')`))) throw new Error('表单未渲染');

    const groups = await scenarioABC(b);
    console.log('[1] 组内互斥 / 组间独立：', groups.pass ? 'PASS' : 'FAIL');
    console.log('     A:', JSON.stringify(groups.A.fd), '高亮数:', groups.A.cards.filter((c) => c.active).length);
    console.log('     B:', JSON.stringify(groups.B.fd), ' C:', JSON.stringify(groups.C.fd));

    const a11y = await a11yCheck(b);
    const a11yPass = a11y.hiddenCount === 0 && a11y.focusable && a11y.groups >= 2;
    console.log('[2] 可访问性（可聚焦/非 display:none/radiogroup）：', a11yPass ? 'PASS' : 'FAIL', JSON.stringify(a11y));

    const multi = await multiSelectCheck(b);
    const multiPass = multi.active === 2 && multi.values.length === 2 &&
      multi.values.includes('a') && multi.values.includes('c');
    console.log('[3] 多选卡片能力：', multiPass ? 'PASS' : 'FAIL', JSON.stringify(multi));

    failed = !(groups.pass && a11yPass && multiPass);
    console.log(failed ? 'FORM-RADIO-TEST-FAIL' : 'FORM-RADIO-TEST-PASS');
    b.ws.close();
  } catch (err) {
    failed = true;
    console.error('FORM-RADIO-TEST-ERR', err.message);
  } finally {
    cleanup();
    process.exit(failed ? 1 : 0);
  }
}

main();
