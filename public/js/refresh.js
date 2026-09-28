// 手动「刷新到最新版本」：
// iPhone 轻应用（WebClip）删除重建图标成本很高，版本更新后只需点一下即可拿到最新前端。
// 处理顺序：清缓存 → 注销 Service Worker → 带时间戳重新加载（绕过任何中间缓存）。
export async function hardRefresh() {
  try {
    if (window.caches && typeof caches.keys === 'function') {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch (err) {
    /* 忽略清缓存失败 */
  }

  try {
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((reg) => reg.unregister()));
    }
  } catch (err) {
    /* 忽略注销失败 */
  }

  // 带随机参数重新加载，确保取到服务器上的最新资源
  const url = new URL(window.location.href);
  url.searchParams.set('_r', String(Date.now()));
  window.location.replace(url.toString());
}
