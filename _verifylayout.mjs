// 顶栏对齐验证（修复后，正确处理嵌套元素）：三种安卓视口
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

let portSeed = 9530;
async function open() {
  portSeed += 1;
  const prof = mkdtempSync(path.join(tmpdir(), 'pa-v2-'));
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
  const waitUntil = async (expr, ms, label) => { const t0 = Date.now(); let last = null; while (Date.now() - t0 < ms) { last = await ev(expr).catch(() => null); if (last) return last; await sleep(500); } throw new Error('timeout ' + label + ' ' + JSON.stringify(last)); };
  await cmd('Runtime.enable'); await cmd('Page.enable');
  return { cmd, ev, waitUntil, ws };
}

// 只检测「兄弟元素」之间的重叠；垂直居中对齐按同一行的兄弟元素计算
const probe = `(()=>{
  const rect=(el)=>{if(!el)return null;const r=el.getBoundingClientRect();return{top:Math.round(r.top),bottom:Math.round(r.bottom),left:Math.round(r.left),right:Math.round(r.right),h:Math.round(r.height),cy:Math.round((r.top+r.bottom)/2)};};
  const bar=document.querySelector('.topbar'); const br=rect(bar);
  const nodes={
    h2:document.querySelector('.topbar h2'),
    sync:document.querySelector('.topbar .sync-state'),
    chip:document.querySelector('.topbar .user-chip'),
    btn:document.querySelector('.topbar [data-role="logout"]'),
    avatar:document.querySelector('.topbar .avatar'),
    tag:document.querySelector('.topbar .role-tag'),
  };
  const rects={}; Object.keys(nodes).forEach(k=>rects[k]=rect(nodes[k]));
  // 兄弟元素：h2 / sync / chip / btn（name、uid、tag 均为 chip 的子元素）
  const sibs=['h2','sync','chip','btn'];
  const overlaps=[];
  for(let i=0;i<sibs.length;i++)for(let j=i+1;j<sibs.length;j++){
    const a=rects[sibs[i]],b=rects[sibs[j]];
    if(!a||!b) continue;
    const ox=Math.min(a.right,b.right)-Math.max(a.left,b.left);
    const oy=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top);
    if(ox>2&&oy>2) overlaps.push(sibs[i]+'x'+sibs[j]);
  }
  const allInside=sibs.every(k=>rects[k] && rects[k].left>=br.left-2 && rects[k].right<=br.right+2 && rects[k].top>=br.top-2 && rects[k].bottom<=br.bottom+2);
  // 第二行（chip 与 btn）垂直居中对齐；角色标签单行
  const rowAligned = rects.chip && rects.btn ? Math.abs(rects.chip.cy-rects.btn.cy)<=3 : false;
  const tagSingleLine = rects.tag ? rects.tag.h<=22 : true;
  const titleSingleLine = rects.h2 ? rects.h2.h<=30 : true;
  return JSON.stringify({
    viewport:[window.innerWidth,window.innerHeight], topbarH: br.h,
    rects: { h2: rects.h2, sync: rects.sync, chip: rects.chip, btn: rects.btn },
    overlaps, allInside, rowAligned, tagSingleLine, titleSingleLine,
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth+1,
  });
})()`;

async function main() {
  const out = {};
  try {
    for (const [label, w, h] of [['phone360', 360, 800], ['pixel412', 412, 915], ['tablet800', 800, 1280]]) {
      const b = await open();
      await b.cmd('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 768 });
      await b.cmd('Page.navigate', { url: ORIGIN + '/' });
      await b.waitUntil(`!!document.querySelector('#auth-form') || document.getElementById('app').className==='layout'`, 25000, 'page ' + label);
      if (await b.ev(`!!document.querySelector('#auth-form')`)) {
        await b.ev(`(()=>{const f=document.querySelector('#auth-form'); f.querySelector('[name=username]').value='admin'; f.querySelector('[name=password]').value='123456'; f.requestSubmit(); return true;})()`);
      }
      await b.waitUntil(`document.getElementById('app') && document.getElementById('app').className==='layout'`, 25000, 'layout ' + label);
      await sleep(3000);
      out[label] = JSON.parse(await b.ev(probe));
      console.log(`[${label}]`, JSON.stringify(out[label]));
      b.ws.close();
    }
    const ok = [out.phone360, out.pixel412, out.tablet800].every((r) =>
      r.overlaps.length === 0 && r.allInside && r.rowAligned && r.tagSingleLine && r.titleSingleLine && !r.horizontalOverflow);
    console.log(ok ? 'LAYOUT-FIX-VERIFIED' : 'LAYOUT-FIX-FAILED');
  } catch (err) {
    console.error('VERIFY-ERR', err.message);
  } finally {
    cleanup();
    process.exit(0);
  }
}
main();
