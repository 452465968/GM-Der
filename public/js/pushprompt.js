import { pushSupported, permissionState, requestPermission, subscribeCurrentDevice } from './pushclient.js';

// 登录后自动申请全局通知权限：
//  - 已授权：不重复请求，直接完成订阅并提示
//  - 未决定：尝试请求；iOS/Safari 非手势场景会静默失败，此时给出「可点击授权」的浮窗
//  - 已拒绝：提示前往系统设置手动开启
//  - 冷启动（带会话直接打开）与热启动（登录成功）均会执行，且每次会话只处理一次

let handled = false;

function toastEl() {
  return document.getElementById('toast-root') || document.body;
}

function showFloat({ type = '', title, text, actionText, onAction, duration = 5200 }) {
  const host = toastEl();
  const el = document.createElement('div');
  el.className = `perm-toast ${type}`;
  el.innerHTML = `
    <div class="perm-toast-main">
      <div class="perm-toast-title">${title}</div>
      <div class="perm-toast-text">${text}</div>
      ${actionText ? `<button class="perm-toast-action" type="button">${actionText}</button>` : ''}
    </div>
    <button class="perm-toast-close" type="button" aria-label="关闭通知提示">×</button>`;
  host.appendChild(el);

  const remove = () => {
    if (el.parentNode) el.parentNode.removeChild(el);
  };
  el.querySelector('.perm-toast-close').addEventListener('click', remove);
  const actionBtn = el.querySelector('.perm-toast-action');
  if (actionBtn && onAction) {
    actionBtn.addEventListener('click', async () => {
      actionBtn.disabled = true;
      await onAction();
      remove();
    });
  }
  setTimeout(remove, duration);
  return el;
}

const SHOWN_KEY = 'pa_perm_toast_at';
const DAY = 24 * 60 * 60 * 1000;

// 带超时：iOS/Safari 非手势场景、无头浏览器可能永不回调，超时按「未决定」处理
function requestPermissionWithTimeout(ms = 4000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    setTimeout(() => done('pending'), ms);
    requestPermission().then(done).catch(() => done(Notification.permission));
  });
}

async function onGranted() {
  let res;
  try {
    res = await subscribeCurrentDevice();
  } catch (err) {
    res = { ok: false, error: err && err.message ? err.message : String(err) };
  }
  // 本次刚授权 → 必提示；此前已授权 → 最多 24 小时提示一次，避免每次冷启动都打扰
  const fresh = sessionStorage.getItem('pa_perm_new') === '1';
  const last = Number(localStorage.getItem(SHOWN_KEY) || 0);
  if (!fresh && Date.now() - last < DAY) return;
  localStorage.setItem(SHOWN_KEY, String(Date.now()));
  sessionStorage.removeItem('pa_perm_new');
  showFloat({
    type: 'success',
    title: '已获取通知权限',
    text: res.ok
      ? `系统通知已开启（${res.subscribed} 台设备），新审批单与审批结果会实时提醒，退到后台也能收到。`
      : `权限已开启，但订阅未完成：${res.error}`,
  });
}

function onDenied() {
  showFloat({
    type: 'warn',
    title: '通知权限未开启',
    text: '你之前拒绝了通知权限。请前往 系统设置 → 通知 → 本网站/应用，手动允许通知，即可收到审批提醒。',
    actionText: '查看通知设置',
    onAction: async () => {
      location.hash = '#/notify';
    },
    duration: 8000,
  });
}

export async function ensurePushPermission() {
  if (handled) return;
  if (!pushSupported()) {
    handled = true;
    return;
  }
  handled = true; // 无论结果，本次会话只处理一次，避免反复打扰

  const perm = permissionState();
  if (perm === 'granted') {
    await onGranted();
    return;
  }
  if (perm === 'denied') {
    onDenied();
    return;
  }

  // default：先直接尝试（Chrome/Android/桌面无需手势即可弹窗）
  const result = await requestPermissionWithTimeout();
  if (result === 'granted') {
    sessionStorage.setItem('pa_perm_new', '1');
    await onGranted();
    return;
  }
  if (result === 'denied') {
    onDenied();
    return;
  }
  // iOS/Safari：非用户手势的请求会被静默忽略，改用「点击按钮授权」的浮窗（点击即为用户手势）
  showFloat({
    type: 'info',
    title: '开启系统通知',
    text: '点击「开启」授权后，新审批单与审批结果会以系统通知提醒（退到后台也能收到）。',
    actionText: '开启',
    onAction: async () => {
      const again = await requestPermissionWithTimeout(8000);
      if (again === 'granted') {
        sessionStorage.setItem('pa_perm_new', '1');
        await onGranted();
      } else {
        onDenied();
      }
    },
    duration: 10000,
  });
}

// 供测试或账号切换后重新触发
export function resetPushPrompt() {
  handled = false;
}
