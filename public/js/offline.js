// 轻应用外壳支持：
//  1. 注册 Service Worker（需 HTTPS 或 localhost 安全上下文，HTTP+IP 环境自动跳过）
//  2. 网络状态提示条：离线 / 弱网时提醒「展示的是已缓存数据」
//  3. 启动画面：在“添加到主屏幕/standalone”模式下展示品牌启动页（模拟原生 App 启动体验）
const SHELL_MIN_MS = 900; // 启动画面最短展示时长
const SHELL_MAX_MS = 3500; // 兜底最长展示时长（防止 load 事件异常）

export function initAppShell() {
  registerServiceWorker();
  setupNetworkPill();
  setupBootSplash();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (!window.isSecureContext) return; // http+IP 等非安全上下文无 SW；接入 HTTPS 后自动生效
  navigator.serviceWorker
    .register('/sw.js')
    .then(() => {})
    .catch(() => {});
}

function setupNetworkPill() {
  const pill = document.createElement('div');
  pill.id = 'net-pill';
  pill.setAttribute('data-pill', 'offline');
  pill.innerHTML =
    '<span class="net-pill-dot"></span><span id="net-pill-text">离线模式 · 展示已缓存内容，联网后自动刷新</span>';
  document.body.appendChild(pill);

  const show = (offline) => {
    const on = document.getElementById('net-pill-text');
    if (on) on.textContent = offline
      ? '离线模式 · 展示已缓存内容，联网后自动刷新'
      : '网络已恢复，正在刷新最新数据';
    pill.classList.toggle('visible', !!offline);
    if (!offline) {
      clearTimeout(pill._t);
      pill._t = setTimeout(() => pill.classList.remove('visible'), 1600);
    }
  };
  window.addEventListener('offline', () => show(true));
  window.addEventListener('online', () => show(false));
  if (typeof navigator.onLine === 'boolean' && !navigator.onLine) show(true);
}

function setupBootSplash() {
  const el = document.getElementById('boot-splash');
  if (!el) return;
  const standalone =
    window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  // 仅在「添加到主屏幕」场景显示启动画面；普通浏览器访问直接移除
  if (!standalone) {
    el.remove();
    return;
  }
  const t0 = Date.now();
  const finish = () => {
    if (!el.isConnected) return;
    el.classList.add('hide');
    setTimeout(() => el.remove(), 350);
  };
  window.addEventListener('load', () => {
    const wait = Math.max(0, SHELL_MIN_MS - (Date.now() - t0));
    setTimeout(finish, wait);
  });
  setTimeout(finish, SHELL_MAX_MS);
}
