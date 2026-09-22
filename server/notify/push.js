const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const FILE = path.join(DATA_DIR, 'push-subscriptions.json');

// Web Push（系统级通知）：浏览器订阅端点持久化 + VAPID 发送
// 说明：Web Push 只能在 HTTPS（安全上下文）下工作；HTTP + IP 部署时浏览器不会注册 Service Worker，
// 订阅无法建立，界面会显示不可用原因。

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDir();
  if (!fs.existsSync(FILE)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    console.error('[push] 订阅文件解析失败，已重置：', err.message);
    return {};
  }
}

function save(data) {
  ensureDir();
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

function vapidReady() {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

function publicKey() {
  return process.env.VAPID_PUBLIC_KEY || '';
}

function list(userId) {
  const all = load();
  return Array.isArray(all[userId]) ? all[userId] : [];
}

function has(userId) {
  return list(userId).length > 0;
}

// 由端点判断设备/推送通道（用于排查「到底有没有 iOS 设备成功订阅」）
function platformOf(endpoint) {
  const url = String(endpoint || '');
  if (url.includes('web.push.apple.com')) return 'iOS / Safari';
  if (url.includes('fcm.googleapis.com')) return 'Android / Chrome';
  if (url.includes('updates.push.services.mozilla.com')) return 'Firefox';
  if (url.includes('.notify.windows.com')) return 'Windows / Edge';
  return '未知';
}

function add(userId, subscription) {
  if (!subscription || !subscription.endpoint) throw new Error('订阅信息缺少 endpoint');
  const all = load();
  const current = Array.isArray(all[userId]) ? all[userId] : [];
  const next = current.filter((item) => item.endpoint !== subscription.endpoint);
  next.push({
    endpoint: subscription.endpoint,
    keys: subscription.keys || {},
    createdAt: new Date().toISOString(),
    // origin 至关重要：切换域名/协议后，旧 origin 的订阅一律失效，必须重新订阅
    origin: String(subscription.origin || '').slice(0, 200),
    userAgent: String(subscription.userAgent || '').slice(0, 200),
    platform: platformOf(subscription.endpoint),
  });
  all[userId] = next.slice(-5); // 每个用户最多保留 5 个设备
  save(all);
  return next.length;
}

// 调试用：列出全部订阅（端点脱敏），便于判断 iOS 设备是否注册成功
function listDetailed() {
  const all = load();
  const out = [];
  Object.keys(all).forEach((userId) => {
    (all[userId] || []).forEach((item) => {
      out.push({
        userId,
        platform: item.platform || platformOf(item.endpoint),
        origin: item.origin || '(未知，旧记录)',
        endpoint: String(item.endpoint || '').length > 48 ? `${String(item.endpoint).slice(0, 48)}…` : item.endpoint,
        createdAt: item.createdAt || '',
        userAgent: String(item.userAgent || '').slice(0, 80),
      });
    });
  });
  return out.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// 清理「非当前站点来源」的失效订阅（例如换了域名或站点地址后的旧记录）
function removeStale(currentOrigin) {
  const all = load();
  let removed = 0;
  Object.keys(all).forEach((userId) => {
    const kept = (all[userId] || []).filter((item) => {
      const ok = !currentOrigin || !item.origin || item.origin === currentOrigin;
      if (!ok) removed += 1;
      return ok;
    });
    if (kept.length) all[userId] = kept;
    else delete all[userId];
  });
  save(all);
  return removed;
}

function remove(userId, endpoint) {
  const all = load();
  const current = Array.isArray(all[userId]) ? all[userId] : [];
  const next = endpoint ? current.filter((item) => item.endpoint !== endpoint) : [];
  if (next.length) all[userId] = next;
  else delete all[userId];
  save(all);
  return next.length;
}

function count(userId) {
  return list(userId).length;
}

function allUserIds() {
  return Object.keys(load());
}

function totalCount() {
  return allUserIds().reduce((sum, id) => sum + list(id).length, 0);
}

// iOS/APNs 对推送载荷体积敏感，统一做安全截断
function clip(text, max) {
  return String(text == null ? '' : text).slice(0, max);
}

// 向该用户的所有订阅设备推送；失效端点（404/410）自动清理
async function send(userId, { title, content, url = '' }) {
  if (!vapidReady()) throw new Error('服务端未配置 VAPID 密钥（VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY）');
  const subs = list(userId);
  if (!subs.length) throw new Error('该用户未订阅系统推送');

  let webpush;
  try {
    // eslint-disable-next-line global-require
    webpush = require('web-push');
  } catch (err) {
    throw new Error('推送依赖缺失，请在服务端执行 npm install web-push');
  }

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  const payload = JSON.stringify({ title: clip(title, 100), body: clip(content, 1500), url: clip(url, 300) });
  let sent = 0;
  let lastError = '';
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        payload,
        // TTL 7 天：设备离线/锁屏时推送服务可暂存更久（iOS 离线期间的送达依赖 TTL）
        { TTL: 604800, urgency: 'high' }
      );
      sent += 1;
    } catch (err) {
      const code = err && err.statusCode;
      lastError = `${err && err.message ? err.message : err}${code ? `（HTTP ${code}）` : ''}`;
      if (code === 404 || code === 410) {
        // 订阅已失效（用户清理浏览器数据 / 取消订阅 / 未在主屏幕内授权）→ 移除
        remove(userId, sub.endpoint);
      } else if (code === 401 || code === 403) {
        lastError += '（VAPID 鉴权失败：检查密钥是否匹配、服务器时间是否准确）';
      }
    }
  }
  if (!sent) throw new Error(lastError || '推送失败');
  return { ok: true, detail: `已推送 ${sent} 台设备` };
}

module.exports = {
  vapidReady,
  publicKey,
  has,
  add,
  remove,
  count,
  list,
  send,
  allUserIds,
  totalCount,
  listDetailed,
  removeStale,
  platformOf,
};
