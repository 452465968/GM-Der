/**
 * 前端入口：路由与外壳
 *
 * 职责：
 *   · hash 路由（#/apps、#/apps/new、#/apps/:id、#/apps/:id/edit、#/review、#/records、
 *     #/notify、#/admin）解析到对应视图模块；
 *   · 渲染应用外壳（侧边栏 / 顶栏 / 移动端底栏），未登录则渲染登录页；
 *   · 标签页（我的申请/审批工作台/审批记录/通知设置）保留 DOM 快照 10 分钟，
 *     tab↔tab 切换零请求；进入会改动数据的页面时丢弃快照，返回即重新拉取；
 *   · 启动后开启通知轮询、Web Push 授权引导、增量同步；
 *   · onSync 回调在收到变更数据时静默刷新当前列表页，不打断表单填写。
 * 执行顺序：bootstrap() → initAppShell() → checkForUpdate() → /api/auth/me → render()。
 */
import * as api from './api.js';
import { ICONS, esc, syncToastOffset } from './ui.js';
import { login } from './views/auth.js';
import { apps } from './views/apps.js';
import { review } from './views/review.js';
import { records } from './views/records.js';
import { newApp, editApp } from './views/form.js';
import { detail } from './views/detail.js';
import { notifySettings } from './views/notify.js';
import { adminConsole } from './views/admin.js';

// 是否可进入后台管理：超级管理员，或被授予任一后台权限
function canUseAdmin(currentUser) {
  if (!currentUser) return false;
  if (currentUser.role === 'admin' || currentUser.isSuperAdmin) return true;
  const perms = Array.isArray(currentUser.permissions) ? currentUser.permissions : [];
  return perms.includes('*') || perms.some((p) => /^(account|role|log|audit):/.test(p));
}
import { startNotificationPolling, stopNotificationPolling } from './notify.js';
import { initAppShell } from './offline.js';
import { ensurePushPermission } from './pushprompt.js';
import { checkForUpdate } from './updater.js';
import { startSync, stopSync, onSync, resetSync } from './sync.js';

const root = document.getElementById('app');
let user = null;

const NAV = [
  { hash: '#/apps', title: '我的申请', icon: ICONS.list },
  { hash: '#/apps/new', title: '新建申请', icon: ICONS.plus },
  // 被指派为某笔申请投票人的普通账号也需要入口，因此不再限定审批人身份
  { hash: '#/review', title: '审批工作台', icon: ICONS.review, badge: true },
  { hash: '#/records', title: '审批记录', icon: ICONS.history },
  { hash: '#/notify', title: '通知设置', icon: ICONS.bell },
  // 后台管理：仅对具备后台权限的账号显示
  { hash: '#/admin', title: '后台管理', icon: ICONS.shield, adminOnly: true }
];

const TITLES = {
  '#/apps': '我的申请',
  '#/apps/new': '新建申请',
  '#/review': '审批工作台',
  '#/records': '审批记录',
  '#/notify': '通知设置',
  '#/admin': '后台管理',
  '#/detail': '申请详情'
};

// 三大标签页属于纯只读页，可在 tab↔tab 之间保持已渲染的 DOM：
// 切换零请求、保留筛选/分页状态；一旦进入详情/新建/修改等可能改动数据的路由即整体丢弃缓存。
const TAB_KEYS = new Set(['#/apps', '#/review', '#/records', '#/notify']);
const TAB_CACHE_TTL = 10 * 60 * 1000; // 标签页快照最长复用 10 分钟，超时自动重新拉取
const tabHosts = new Map(); // routeKey -> { el, ts }
let layoutReady = false; // 应用外壳（侧边栏/顶栏/底栏）是否已挂载
let activeRoute = null; // 当前路由 { hash, title }

function navFor() {
  return NAV.filter((item) => !item.adminOnly || canUseAdmin(user));
}

// 非审批人账号只会被指派为投票人，菜单文案改为「待我投票」
function navTitle(item) {
  if (item.hash === '#/review' && user.role !== 'approver') return '待我投票';
  return item.title;
}

function isActive(hash, item) {
  if (item.hash === '#/apps') {
    return hash === '#/apps' || (hash.startsWith('#/apps/') && !hash.startsWith('#/apps/new'));
  }
  return hash === item.hash;
}

function linkActive(hash, linkHash) {
  if (linkHash === '#/apps') {
    return hash === '#/apps' || (hash.startsWith('#/apps/') && !hash.startsWith('#/apps/new'));
  }
  return hash === linkHash;
}

function navHtml(hash) {
  return navFor()
    .map(
      (item) =>
        `<a class="nav-item ${isActive(hash, item) ? 'active' : ''}" href="${item.hash}">${item.icon}<span>${
          navTitle(item)
        }</span>${item.badge ? '<span class="badge-count" data-role="pending-count" hidden></span>' : ''}</a>`
    )
    .join('');
}

function shellHtml(hash, title) {
  const initial = esc(user.name.slice(0, 1));
  const roleLabel = user.role === 'approver' ? '审批人' : '申请人';
  return `
    <aside class="sidebar">
      <div class="brand">
        <div class="logo">购</div>
        <div><span>买个Der</span><small>MaiGeDer</small></div>
      </div>
      ${navHtml(hash)}
      <div class="sidebar-footer">
        <div class="user-chip" style="margin-bottom:10px">
          <div class="avatar" style="background:rgba(255,255,255,.1);color:#e2e8f0">${initial}</div>
          <div>
            <div style="color:#e2e8f0;font-weight:600">${esc(user.name)}</div>
            <div style="font-size:11px;color:#94a3b8">${esc(user.username)}</div>
          </div>
        </div>
        <button class="btn btn-block" data-role="logout" style="background:rgba(255,255,255,.08);border-color:transparent;color:#e2e8f0">退出登录</button>
      </div>
    </aside>
    <div class="main">
      <header class="topbar">
        <h2>${esc(title)}</h2>
        <div class="spacer"></div>
        <span class="sync-state" data-role="sync-state">同步中…</span>
        <div class="user-chip">
          <div class="avatar">${initial}</div>
          <div>
            <div class="user-name">${esc(user.name)}</div>
            <div class="user-id">${esc(user.username)}</div>
          </div>
          <span class="role-tag ${user.role === 'approver' ? 'approver' : ''}">${roleLabel}</span>
        </div>
        <button class="btn btn-sm" data-role="logout">退出</button>
      </header>
      <div class="content" id="view"></div>
    </div>
    <nav class="mobile-nav">${navHtml(hash)}</nav>`;
}

async function refreshPendingBadge() {
  if (!user) return;
  // 待我投票数对任何身份的账号都有意义（被指派为投票人即产生待办）
  try {
    const stats = await api.get('/api/applications/stats');
    const count = stats.myPending != null ? stats.myPending : stats.pending;
    root.querySelectorAll('[data-role="pending-count"]').forEach((el) => {
      if (count > 0) {
        el.textContent = count;
        el.hidden = false;
      } else {
        el.hidden = true;
      }
    });
  } catch (err) {
    /* 忽略徽标加载失败 */
  }
}

function resolve(hash) {
  if (hash === '#/apps') return { view: apps, title: TITLES['#/apps'] };
  if (hash === '#/apps/new') return { view: newApp, title: TITLES['#/apps/new'] };
  if (hash.startsWith('#/apps/')) {
    const rest = hash.slice('#/apps/'.length);
    // #/apps/:id/edit —— 被拒绝后的“修改并重新提交”页
    if (rest.endsWith('/edit')) {
      return {
        view: editApp,
        title: '修改申请',
        params: { id: rest.slice(0, -'/edit'.length) },
      };
    }
    return { view: detail, title: TITLES['#/detail'], params: { id: rest } };
  }
  // 审批工作台对所有人开放；非审批人只展示「待我投票」（由 review 视图内部按身份裁剪）
  if (hash === '#/review') {
    return { view: review, title: user.role === 'approver' ? TITLES['#/review'] : '待我投票' };
  }
  if (hash === '#/records') return { view: records, title: TITLES['#/records'] };
  if (hash === '#/notify') return { view: notifySettings, title: TITLES['#/notify'] };
  if (hash === '#/admin') return { view: adminConsole, title: TITLES['#/admin'] };
  return null;
}

/* ---------- 轻应用外壳：构建一次、后续只换内容 ---------- */

function buildShell(hash, title) {
  root.className = 'layout';
  root.innerHTML = shellHtml(hash, title);
  root.querySelectorAll('[data-role="logout"]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await api.post('/api/auth/logout', {});
      stopNotificationPolling();
      stopSync();
      resetSync();
      user = null;
      teardownLayout();
      location.hash = '#/login';
      render();
    })
  );
  layoutReady = true;
  activeRoute = null;
}

function updateChrome(hash, title) {
  const topTitle = root.querySelector('.topbar h2');
  if (topTitle) topTitle.textContent = title;
  root.querySelectorAll('.nav-item').forEach((a) => {
    a.classList.toggle('active', linkActive(hash, a.getAttribute('href')));
  });
  if (document.title !== `${title} · 买个Der`) document.title = `${title} · 买个Der`;
}

function disposeTabs() {
  tabHosts.forEach((entry) => entry.el.remove());
  tabHosts.clear();
}

function teardownLayout() {
  disposeTabs();
  layoutReady = false;
  activeRoute = null;
}

/* ---------- 路由渲染 ---------- */

async function render() {
  let hash = location.hash || '';
  if (!user) {
    teardownLayout();
    root.className = 'auth-page';
    login({ container: root, setUser, rerender: render });
    return;
  }

  if (!hash || hash === '#/' || hash === '#/login') {
    const target = user.role === 'approver' ? '#/review' : '#/apps';
    if (location.hash !== target) location.replace(target);
    hash = target;
  }

  const route = resolve(hash);
  if (!route) {
    location.hash = '#/apps';
    return;
  }

  if (!layoutReady) buildShell(hash, route.title);
  else updateChrome(hash, route.title);
  // 顶栏渲染后校准浮层位置（顶栏高度随机型/内容变化）
  syncToastOffset();

  const view = root.querySelector('#view');
  // 移动端内容区为独立滚动容器：每次切换先回到顶部（恢复的标签页快照同理）
  if (view) view.scrollTop = 0;
  refreshPendingBadge();
  // 登录后开启新任务提醒（轮询 + 弹窗）；内部有去重
  startNotificationPolling();
  // 冷启动（已有会话直接打开）也检查一次通知权限；内部去重，已授权不会重复请求
  ensurePushPermission();
  // 启动数据同步（增量拉取 + 推送触发 + 离线补偿），多端数据保持一致
  startSync();

  const isTab = TAB_KEYS.has(hash);

  // 详情 / 新建 / 修改 / 编辑重提 等可能改动数据的页面：
  // 丢弃全部标签页快照 → 从这些页面返回时必然重新拉取最新数据
  if (!isTab) {
    disposeTabs();
    activeRoute = null;
    view.innerHTML = '';
    await route.view({ container: view, params: route.params || {}, user, rerender: render });
    return;
  }

  // 标签页：离开当前标签页时把其 DOM 摘下保留（供 tab↔tab 复用）
  if (activeRoute && activeRoute.hash !== hash && tabHosts.has(activeRoute.hash)) {
    const prev = tabHosts.get(activeRoute.hash);
    if (prev.el.parentNode === view) view.removeChild(prev.el);
  }
  // 清空 #view 中其他残留内容（详情/新建/修改等直接写入 #view 的页面）。
  // 若不清理，从新建申请/详情返回标签页时旧页面会叠在新页面之上，表现为“导航点了没反应”。
  view.innerHTML = '';

  // tab↔tab 直达：快照未过期 → 直接放回（保留筛选/分页/滚动，不再发起任何请求）
  const cached = tabHosts.get(hash);
  if (cached && cached.ts + TAB_CACHE_TTL > Date.now()) {
    view.appendChild(cached.el);
    activeRoute = { hash, title: route.title };
    return;
  }
  if (cached) cached.el.remove(); // 过期快照：移除并重新拉取

  const host = document.createElement('div');
  host.className = 'view-fresh';
  view.appendChild(host);
  await route.view({ container: host, params: route.params || {}, user, rerender: render });
  tabHosts.set(hash, { el: host, ts: Date.now() });
  activeRoute = { hash, title: route.title };
}

async function setUser(nextUser) {
  user = nextUser;
}

async function bootstrap() {
  initAppShell(); // 注册 Service Worker / 网络提示 / 启动画面（轻应用外壳）
  // 启动即自检版本：与服务端 /version.json 对比，有新版本则弹窗提示刷新
  checkForUpdate();
  try {
    const data = await api.get('/api/auth/me');
    user = data.user;
  } catch (err) {
    user = null;
  }
  // 同步到变更数据时静默刷新当前列表页（详情页/表单页不打断用户操作）
  onSync((items) => {
    if (!items || !items.length) return;
    if (activeRoute && TAB_KEYS.has(activeRoute.hash)) {
      disposeTabs();
      activeRoute = null;
      render();
    } else {
      refreshPendingBadge();
    }
  });

  window.addEventListener('hashchange', render);
  // 视口变化（旋转屏幕、地址栏收放）时重新校准浮层位置
  window.addEventListener('resize', syncToastOffset);
  window.addEventListener('orientationchange', syncToastOffset);
  await render();
}

bootstrap();
