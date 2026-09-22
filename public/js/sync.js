import * as api from './api.js';

// 数据同步引擎（手机 / 平板 / 网页共用）：
//  - 增量拉取：GET /api/sync?since=<上次同步时间>，只取变更数据
//  - 推送触发：Service Worker 收到系统推送后 postMessage，立即触发一次同步
//  - 定时兜底：默认 15 秒轮询一次
//  - 离线补偿：断网时暂停并记录，恢复联网后立刻补一次
// 同步过程静默进行，仅在数据发生变化时通知界面刷新（对用户透明）

const POLL_INTERVAL = 15000;
const listeners = [];

let timer = null;
let started = false;
let lastSyncAt = '';
let syncing = false;
let online = true;

export function onSync(fn) {
  if (typeof fn === 'function') listeners.push(fn);
}

export function lastSyncTime() {
  return lastSyncAt;
}

export function isOnline() {
  return online;
}

function emit(items) {
  listeners.forEach((fn) => {
    try {
      fn(items);
    } catch (err) {
      /* 单个监听失败不影响其他监听 */
    }
  });
}

function fmtTime(iso) {
  if (!iso) return '--:--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function renderState(text) {
  document.querySelectorAll('[data-role="sync-state"]').forEach((el) => {
    el.textContent = text;
    el.title = text;
  });
}

export async function syncNow({ reason = 'auto' } = {}) {
  if (syncing) return { changed: 0 };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    online = false;
    renderState('离线 · 使用本地缓存');
    return { changed: 0, offline: true };
  }
  syncing = true;
  renderState('同步中…');
  try {
    const data = await api.get('/api/sync', { since: lastSyncAt });
    online = true;
    lastSyncAt = data.serverTime || new Date().toISOString();
    const items = data.applications || [];
    if (items.length) emit(items);
    renderState(`已同步 ${fmtTime(lastSyncAt)}`);
    return { changed: items.length, reason };
  } catch (err) {
    // 请求失败：保持上次同步时间，等待下一轮重试（离线时由 SW 缓存提供数据）
    online = false;
    renderState('离线 · 使用本地缓存');
    return { changed: 0, error: err && err.message ? err.message : String(err) };
  } finally {
    syncing = false;
  }
}

export function startSync(interval = POLL_INTERVAL) {
  if (started) return;
  started = true;
  syncNow({ reason: 'start' });
  timer = setInterval(() => syncNow(), interval);

  // 恢复联网立即补偿同步
  window.addEventListener('online', () => syncNow({ reason: 'online' }));
  window.addEventListener('offline', () => {
    online = false;
    renderState('离线 · 使用本地缓存');
  });

  // 服务端推送到达（Service Worker 转发）→ 立即同步，做到近实时
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const data = event.data || {};
      if (data.type === 'push' || data.type === 'sync') syncNow({ reason: 'push' });
    });
  }
}

export function stopSync() {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
  listeners.length = 0;
}

export function resetSync() {
  lastSyncAt = '';
}
