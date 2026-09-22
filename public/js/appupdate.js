/**
 * 应用内更新（Android 原生壳 / 网页通用）
 *
 * 流程：读取 /version.json（no-store）→ 与 APP_VERSION 比对 → 有新版则弹窗（版本/更新内容/大小）
 * → 用户确认后：
 *   · Android 壳：调用 ApkInstaller 插件原生下载 → SHA-256 校验 → 校验包名 → 拉起安装界面，
 *     并通过插件事件回传进度与结果（已安装/取消/失败可重试，最多 3 次）；
 *   · 网页：浏览器流式下载 + SHA-256 校验 + 手动安装引导。
 */
import { APP_VERSION } from './version.js';
import { esc } from './ui.js';

// 应用内检查更新（Android 原生壳 / 网页通用）：
//  - 请求更新接口（/version.json 的 android 段）获取最新版本、更新内容、大小、SHA-256
//  - 与当前运行版本对比
//  - 有新版本：弹窗展示版本号 / 更新内容 / 大小，提供「立即更新」「稍后提醒」
//  - 立即更新：
//      · Android 原生壳（ApkInstaller 插件可用）→ 原生下载 → SHA-256 完整性校验
//        → 校验包名 → 拉起系统安装界面 → 结果回调（已安装 / 用户取消 / 失败）→ 可重试
//      · 网页/无原生能力 → 浏览器流式下载 + SHA-256 校验 + 手动安装引导
//  - 失败可重试（最多 3 次），并给出明确错误提示

const MAX_RETRY = 3;
let lastPromptedVersion = '';

export function formatSize(bytes) {
  const size = Number(bytes) || 0;
  if (size <= 0) return '未知';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

// 版本号比较：支持 beta1.2.3 / 1.2.3 形式
export function compareVersion(a, b) {
  const parts = (v) =>
    String(v || '')
      .replace(/^[a-zA-Z]+/, '')
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export async function fetchUpdateInfo() {
  const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('更新信息获取失败');
  return res.json();
}

/** Android 原生安装插件（Capacitor WebView 内可用） */
function nativeInstaller() {
  if (typeof window === 'undefined') return null;
  const C = window.Capacitor;
  if (!C) return null;
  try {
    if (typeof C.isPluginAvailable === 'function' && !C.isPluginAvailable('ApkInstaller')) return null;
    return (C.Plugins && C.Plugins.ApkInstaller) || null;
  } catch (err) {
    return null;
  }
}

function absoluteUrl(url) {
  try {
    return new URL(String(url || ''), window.location.origin).href;
  } catch (err) {
    return String(url || '');
  }
}

function modalRoot() {
  return document.getElementById('modal-root') || document.body;
}

// 轻量自定义弹窗（复用现有 .modal-mask / .modal 样式，居中固定定位，不影响页面布局）
function showModal({ title, bodyHtml, actions }) {
  const host = modalRoot();
  host.innerHTML = `
    <div class="modal-mask">
      <div class="modal">
        <h3>${esc(title)}</h3>
        <div class="modal-body">${bodyHtml}</div>
        <div class="modal-footer" data-role="update-actions"></div>
      </div>
    </div>`;
  const footer = host.querySelector('[data-role="update-actions"]');
  const render = (next) => {
    footer.innerHTML = '';
    (next || []).forEach((action) => {
      const btn = document.createElement('button');
      btn.className = `btn ${action.variant || ''}`;
      btn.textContent = action.text;
      btn.addEventListener('click', () => action.onClick && action.onClick());
      footer.appendChild(btn);
    });
  };
  render(actions);
  return {
    close: () => {
      host.innerHTML = '';
    },
    setBody: (html) => {
      const body = host.querySelector('.modal-body');
      if (body) body.innerHTML = html;
    },
    setActions: render,
    root: host,
  };
}

function progressModal(fileName) {
  return showModal({
    title: '正在下载更新',
    bodyHtml: `
      <div class="update-progress">
        <div class="update-bar"><span data-role="update-bar" style="width:0%"></span></div>
        <div class="hint" data-role="update-status">准备下载 ${esc(fileName)}…</div>
      </div>`,
    actions: [{ text: '取消', onClick: () => { modalRoot().innerHTML = ''; } }],
  });
}

function setProgress(modal, percent, received, total) {
  const bar = modal.root.querySelector('[data-role="update-bar"]');
  const status = modal.root.querySelector('[data-role="update-status"]');
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, Number(percent) || 0))}%`;
  if (status) {
    status.textContent = total
      ? `已下载 ${percent}%（${formatSize(received)} / ${formatSize(total)}）`
      : `已下载 ${formatSize(received)}`;
  }
}

async function sha256Hex(buffer) {
  if (!window.crypto || !window.crypto.subtle) return '';
  const digest = await window.crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/* ------------------------------ 原生安装路径 ------------------------------ */

async function nativeUpdate(android, attempt = 1) {
  const plugin = nativeInstaller();
  const fileName = `purchase-approval-${android.latestVersion}.apk`;
  const modal = progressModal(fileName);
  const handles = [];

  const cleanup = () => {
    handles.forEach((h) => {
      try {
        if (h && typeof h.remove === 'function') h.remove();
      } catch (err) {
        /* ignore */
      }
    });
  };

  const can = await plugin.canInstall();
  if (!can.canInstall) {
    modal.setBody(`
      <div class="hint">系统尚未授予「安装未知应用」权限（${esc(can.reason || '')}）。<br />
      请点击下方按钮，在系统设置中允许本应用的安装权限，然后返回重试。</div>`);
    modal.setActions([
      { text: '取消', onClick: () => { cleanup(); modalRoot().innerHTML = ''; } },
      {
        text: '去授权',
        variant: 'btn-primary',
        onClick: async () => {
          await plugin.requestPermission();
          modal.setBody('<div class="hint">已打开系统设置，授权后请返回本页重试安装。</div>');
          modal.setActions([
            { text: '重试安装', variant: 'btn-primary', onClick: () => nativeUpdate(android, attempt) },
          ]);
        },
      },
    ]);
    return;
  }

  handles.push(await plugin.addListener('progress', (data) => {
    setProgress(modal, data.percent, data.received, data.total);
  }));
  handles.push(await plugin.addListener('installResult', (data) => {
    const st = modal.root.querySelector('[data-role="update-status"]');
    if (st) st.textContent = data.message || '';
  }));

  let result;
  try {
    result = await plugin.install({
      url: absoluteUrl(android.apkUrl),
      sha256: android.sha256 || '',
      fileName,
    });
  } catch (err) {
    result = { status: 'failed', message: err && err.message ? err.message : String(err) };
  }
  cleanup();

  if (result && result.status === 'permission-required') {
    modal.close();
    await nativeUpdate(android, attempt); // 内部会走「去授权」分支
    return;
  }

  if (result && result.status === 'installed') {
    modal.setBody(`<div class="hint">安装完成，应用已更新到 <b>${esc(android.latestVersion)}</b>。</div>`);
    modal.setActions([
      { text: '立即重启', variant: 'btn-primary', onClick: () => window.location.reload() },
      { text: '稍后', onClick: () => { modalRoot().innerHTML = ''; } },
    ]);
    return;
  }

  if (result && result.status === 'cancelled') {
    modal.setBody('<div class="hint">你取消了安装。更新包已下载并通过校验，可随时重新安装。</div>');
    modal.setActions([
      { text: '关闭', onClick: () => { modalRoot().innerHTML = ''; } },
      { text: '重新提示安装', variant: 'btn-primary', onClick: () => nativeUpdate(android, attempt) },
    ]);
    return;
  }

  // failed
  const msg = (result && result.message) || '安装失败';
  if (attempt < MAX_RETRY) {
    modal.setBody(`<div class="hint">${esc(msg)}<br />正在进行第 ${attempt + 1} 次尝试…</div>`);
    modal.setActions([]);
    await new Promise((r) => setTimeout(r, 1500));
    await nativeUpdate(android, attempt + 1);
    return;
  }
  modal.setBody(`<div class="hint">${esc(msg)}<br />已重试 ${MAX_RETRY} 次仍未成功，可稍后重试或前往下载页手动安装。</div>`);
  modal.setActions([
    { text: '关闭', onClick: () => { modalRoot().innerHTML = ''; } },
    { text: '再试一次', variant: 'btn-primary', onClick: () => nativeUpdate(android, 1) },
  ]);
}

/* ------------------------------ 网页降级路径 ------------------------------ */

async function webUpdate(android, attempt = 1) {
  const fileName = `purchase-approval-${android.latestVersion}.apk`;
  const modal = progressModal(fileName);
  try {
    const res = await fetch(absoluteUrl(android.apkUrl), { cache: 'no-store' });
    if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);
    const total = Number(res.headers.get('content-length')) || Number(android.size) || 0;
    const reader = res.body ? res.body.getReader() : null;
    const chunks = [];
    let received = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        setProgress(modal, total ? Math.round((received / total) * 100) : 50, received, total);
      }
    } else {
      chunks.push(new Uint8Array(await res.arrayBuffer()));
      received = chunks[0].length;
    }

    const status = modal.root.querySelector('[data-role="update-status"]');
    if (status) status.textContent = '下载完成，正在校验安装包完整性…';

    const blob = new Blob(chunks, { type: 'application/vnd.android.package-archive' });
    // 完整性校验：与更新接口返回的 SHA-256 比对
    if (android.sha256) {
      const hex = await sha256Hex(await blob.arrayBuffer());
      if (hex && hex.toLowerCase() !== String(android.sha256).toLowerCase()) {
        throw new Error('安装包校验失败（SHA-256 不匹配），已停止安装');
      }
    }

    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();

    modal.setBody(`
      <div class="hint">更新包下载完成并通过完整性校验（${formatSize(blob.size)}）。<br />
      请在通知栏或「下载管理」中点击安装包完成安装；若提示未知来源，允许本次安装即可。</div>`);
    modal.setActions([{ text: '知道了', variant: 'btn-primary', onClick: () => { modalRoot().innerHTML = ''; } }]);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (attempt < MAX_RETRY) {
      setProgress(modal, 0, 0, 0);
      const st = modal.root.querySelector('[data-role="update-status"]');
      if (st) st.textContent = `${msg}，正在进行第 ${attempt + 1} 次尝试…`;
      await new Promise((r) => setTimeout(r, 1500));
      await webUpdate(android, attempt + 1);
      return;
    }
    modal.setBody(`<div class="hint">${esc(msg)}<br />已重试 ${MAX_RETRY} 次仍未成功，请检查网络后重试。</div>`);
    modal.setActions([
      { text: '关闭', onClick: () => { modalRoot().innerHTML = ''; } },
      { text: '重新下载', variant: 'btn-primary', onClick: () => webUpdate(android, 1) },
    ]);
  }
}

/* ------------------------------ 入口 ------------------------------ */

export async function checkAppUpdate({ manual = false } = {}) {
  let info;
  try {
    info = await fetchUpdateInfo();
  } catch (err) {
    if (manual) {
      showModal({
        title: '检查更新失败',
        bodyHtml: `<div class="hint">${esc(err && err.message ? err.message : String(err))}</div>`,
        actions: [{ text: '知道了', variant: 'btn-primary', onClick: () => { modalRoot().innerHTML = ''; } }],
      });
    }
    return { error: true };
  }

  const android = info.android || {};
  const latest = String(android.latestVersion || '').trim();
  const current = String(APP_VERSION || '').trim();
  if (!latest) return { error: true, reason: 'no-android-info' };

  const newer = compareVersion(latest, current) > 0;

  if (!newer) {
    if (manual) {
      showModal({
        title: '已是最新版本',
        bodyHtml: `<div class="hint">当前版本 <b>${esc(current)}</b>，无需更新。</div>`,
        actions: [{ text: '知道了', variant: 'btn-primary', onClick: () => { modalRoot().innerHTML = ''; } }],
      });
    }
    return { upToDate: true, current, latest };
  }

  if (!manual && lastPromptedVersion === latest) return { skipped: true, current, latest };
  lastPromptedVersion = latest;

  const changes = (android.changelog || []).map((line) => `<li>${esc(line)}</li>`).join('');
  const viaNative = !!nativeInstaller();
  showModal({
    title: '发现新版本',
    bodyHtml: `
      <div style="font-size:14px;line-height:1.7">
        当前版本：<b>${esc(current)}</b><br />
        最新版本：<b style="color:var(--primary)">${esc(latest)}</b><br />
        安装包大小：<b>${esc(formatSize(android.size))}</b>
        ${android.sha256 ? `<br />完整性校验：<b>SHA-256（已启用）</b>` : ''}
      </div>
      <div class="hint" style="margin-top:8px">更新内容：</div>
      <ul class="notify-list" style="margin-top:6px">${changes}</ul>
      ${viaNative ? '<div class="hint">检测到原生更新能力：下载完成后会自动校验并拉起安装。</div>' : ''}`,
    actions: [
      { text: '稍后提醒', onClick: () => { modalRoot().innerHTML = ''; } },
      {
        text: '立即更新',
        variant: 'btn-primary',
        onClick: () => {
          modalRoot().innerHTML = '';
          if (viaNative) nativeUpdate(android, 1);
          else webUpdate(android, 1);
        },
      },
    ],
  });
  return { hasUpdate: true, current, latest };
}
