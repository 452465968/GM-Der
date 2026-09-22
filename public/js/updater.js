import { APP_VERSION } from './version.js';
import { hardRefresh } from './refresh.js';
import { openModal } from './ui.js';

// 轻应用启动时自动检测版本：
//   读取服务端 /version.json（禁用缓存）与本地运行的 APP_VERSION 对比，
//   不一致则弹窗提示，用户点「刷新」即重新加载获取最新版本。
//   同一会话只提示一次，避免反复打扰。

const PROMPTED_KEY = 'pa_update_prompted_version';

export async function fetchLatestVersion() {
  const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('版本信息获取失败');
  const data = await res.json();
  return String(data.version || '').trim();
}

export async function checkForUpdate({ force = false } = {}) {
  try {
    const latest = await fetchLatestVersion();
    if (!latest) return { updated: false };
    const running = String(APP_VERSION || '').trim();
    if (latest === running) {
      sessionStorage.removeItem(PROMPTED_KEY);
      return { updated: true, latest, running };
    }
    if (!force && sessionStorage.getItem(PROMPTED_KEY) === latest) {
      return { updated: false, latest, running, skipped: true };
    }
    sessionStorage.setItem(PROMPTED_KEY, latest);
    openModal({
      title: '发现新版本',
      bodyHtml: `
        <div style="font-size:14px;line-height:1.7">
          当前运行版本：<b>${running || '未知'}</b><br />
          最新版本：<b style="color:var(--primary)">${latest}</b>
          <div style="margin-top:8px;color:var(--muted);font-size:13px">
            点击「刷新」重新加载轻应用，即可使用最新功能与修复（无需删除主屏幕图标）。
          </div>
        </div>`,
      confirmText: '刷新',
      cancelText: '稍后',
      onConfirm: async () => {
        await hardRefresh();
        return true;
      },
    });
    return { updated: false, latest, running, prompted: true };
  } catch (err) {
    // 版本检测失败不阻断应用使用
    return { updated: true, error: err && err.message ? err.message : String(err) };
  }
}
