/**
 * Web Push 订阅客户端
 *
 * 职责：取服务端 VAPID 公钥 → 订阅/退订当前设备 → 查询订阅状态。
 * 登录引导浮窗与通知设置页共用本模块，避免重复订阅。Web Push 仅在 HTTPS 安全上下文可用。
 */
import * as api from './api.js';

// 统一的「系统推送订阅」客户端：登录引导浮窗与通知设置页共用同一套逻辑

let keyCache = { publicKey: '', vapidReady: false, loaded: false };

export function pushSupported() {
  return (
    typeof Notification !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof PushManager !== 'undefined' &&
    Boolean(window.isSecureContext)
  );
}

export function permissionState() {
  return typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
}

export async function loadPublicKey(force = false) {
  if (keyCache.loaded && !force) return keyCache;
  const data = await api.get('/api/notify/push/public-key');
  keyCache = {
    publicKey: data.publicKey || '',
    vapidReady: Boolean(data.vapidReady),
    loaded: true,
  };
  return keyCache;
}

export function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

// 兼容性写法：老浏览器用回调，新浏览器用 Promise
export function requestPermission() {
  return new Promise((resolve) => {
    try {
      const ret = Notification.requestPermission((res) => resolve(res || Notification.permission));
      if (ret && typeof ret.then === 'function') {
        ret.then(resolve).catch(() => resolve(Notification.permission));
      }
    } catch (err) {
      resolve(Notification.permission);
    }
  });
}

// 订阅当前设备（需已授权）；返回 { ok, subscribed?, error? }
export async function subscribeCurrentDevice() {
  if (!pushSupported()) return { ok: false, error: '当前环境不支持系统推送（需 HTTPS）' };
  if (permissionState() !== 'granted') return { ok: false, error: '尚未授予通知权限' };
  const { publicKey, vapidReady } = await loadPublicKey();
  if (!vapidReady || !publicKey) return { ok: false, error: '服务端未配置推送密钥' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    } catch (err) {
      // 冷启动瞬间 Service Worker 可能尚未就绪，稍后重试一次
      await sleep(1500);
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }
  }
  const data = await api.post('/api/notify/push/subscribe', {
    endpoint: sub.toJSON().endpoint,
    keys: sub.toJSON().keys,
    userAgent: navigator.userAgent,
    origin: location.origin,
  });
  return { ok: true, subscribed: data.subscribed };
}
