/* 买个Der · 轻应用 Service Worker
 *
 * 缓存策略（弱网 / 离线友好）：
 *  - SHELL  应用外壳：安装时预缓存，始终可用（打开即核心页面）
 *  - STATIC 其余静态资源（css/js/图片/图标）：stale-while-revalidate
 *  - API    GET 接口（列表/详情/统计/通知）：网络优先 + 4.5s 超时，失败回退缓存副本
 *  - 图片（/uploads、/icons）：缓存优先，后台更新
 * 变更外壳文件后请递增 SHELL_VERSION 以触发更新。
 */
const SHELL_VERSION = 'pa-shell-v22';
const SHELL_CACHE = SHELL_VERSION;
const STATIC_CACHE = 'pa-static-v21';
const API_CACHE = 'pa-api-v1';
const IMG_CACHE = 'pa-img-v1';
const ACTIVE = [SHELL_CACHE, STATIC_CACHE, API_CACHE, IMG_CACHE];

const SHELL_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/css/style.css',
  '/js/api.js',
  '/js/app.js',
  '/js/ui.js',
  '/js/notify.js',
  '/js/offline.js',
  '/js/credstore.js',
  '/js/views/apps.js',
  '/js/views/auth.js',
  '/js/views/detail.js',
  '/js/views/form.js',
  '/js/views/notify.js',
  '/js/views/admin.js',
  '/js/pushclient.js',
  '/js/pushprompt.js',
  '/js/version.js',
  '/js/refresh.js',
  '/js/updater.js',
  '/js/sync.js',
  '/js/appupdate.js',
  '/js/views/records.js',
  '/js/views/review.js',
  '/js/views/shared.js',
  '/icons/pa-icon.png'
];

const API_TIMEOUT = 4500;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => Promise.allSettled(SHELL_URLS.map((u) => cache.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !ACTIVE.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function fetchWithTimeout(req, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(req, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function networkFirstApi(req) {
  const cache = await caches.open(API_CACHE);
  try {
    const res = await fetchWithTimeout(req.clone(), API_TIMEOUT);
    // 只缓存成功响应；401/4xx/5xx 属权威结果，直接透传
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw err;
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const refresh = () =>
    fetch(req)
      .then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      })
      .catch(() => null);
  if (cached) {
    refresh(); // 后台更新，不阻塞当前
    return cached;
  }
  const res = await refresh();
  if (res) return res;
  throw new Error('offline');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 版本清单：必须直连网络，不能被缓存，否则检测不到新版本
  if (url.pathname === '/version.json') {
    event.respondWith(fetch(req, { cache: 'no-store' }));
    return;
  }

  // 页面导航：网络优先，离线回退到已缓存外壳（保证核心页面可打开）
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const clone = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put('/index.html', clone)).catch(() => {});
          return res;
        })
        .catch(async () => {
          const cached = await caches.match('/index.html');
          if (cached) return cached;
          return new Response('<!DOCTYPE html><meta charset="utf-8"><title>离线</title><body style="font-family:sans-serif;display:grid;place-items:center;height:90vh;color:#334155"><div style="text-align:center"><h2>暂时无法连接服务器</h2><p>请联网后重新打开</p></div></body>', {
            status: 503,
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        })
    );
    return;
  }

  // API GET：网络优先 + 缓存兜底
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirstApi(req));
    return;
  }

  // 图片（商品图 / 图标）：缓存优先，后台更新
  if (url.pathname.startsWith('/uploads/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(staleWhileRevalidate(req, IMG_CACHE));
    return;
  }

  // 其余静态资源：缓存优先 + 后台更新
  event.respondWith(staleWhileRevalidate(req, STATIC_CACHE));
});

/* ------------------------------ 系统级推送（Web Push） ------------------------------ */

// 收到服务器推送：在系统通知栏弹出（需 HTTPS 且用户已授权/订阅）
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (err) {
    payload = { title: '买个Der', body: event.data ? event.data.text() : '' };
  }
  const title = payload.title || '买个Der';
  const options = {
    body: payload.body || '',
    icon: '/icons/pa-icon.png',
    badge: '/icons/pa-icon.png',
    tag: payload.url || 'purchase-approval',
    data: { url: payload.url || '/#/apps' },
  };
  // 通知所有打开的客户端：立即与服务端同步（近实时一致性）
  const notifyClients = self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then((list) => {
      list.forEach((client) => client.postMessage({ type: 'push', url: payload.url || '' }));
    })
    .catch(() => {});

  event.waitUntil(
    Promise.all([
      notifyClients,
      self.registration.showNotification(title, options).then(() => {
      // 图标角标（支持 Badging API 的桌面/部分 iOS 版本）；失败不影响通知本身
      try {
        if (typeof navigator !== 'undefined' && navigator.setAppBadge) navigator.setAppBadge(1);
      } catch (err) {
        /* ignore */
      }
      }),
    ])
  );
});

// 点击系统通知：打开/聚焦到对应页面
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  try {
    if (typeof navigator !== 'undefined' && navigator.clearAppBadge) navigator.clearAppBadge();
  } catch (err) {
    /* ignore */
  }
  const targetUrl = (event.notification.data && event.notification.data.url) || '/#/apps';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
      return null;
    })
  );
});
