/**
 * 视图：通知设置
 *
 * 职责：配置个人通知渠道（系统推送 / 邮件 / QQ / 微信）的开关与接收地址，
 * 可发送测试推送，并查看最近的投递日志（已发送/重试中/失败/已跳过）。
 */
import * as api from '../api.js';
import { esc, formatDateTime, toast, loading, empty } from '../ui.js';

const STATUS_META = {
  sent: { label: '已发送', cls: 'approved' },
  retry: { label: '重试中', cls: 'pending' },
  failed: { label: '失败', cls: 'rejected' },
  skipped: { label: '已跳过', cls: 'cancelled' },
};

const EVENT_LABEL = {
  new_application: '新审批单',
  resubmit: '重新提交',
  decision: '审批结果',
  cancel: '申请撤回',
  test: '推送测试',
};

const CHANNEL_LABEL = { email: '邮件', qq: 'QQ', wechat: '微信' };

function channelRows(channels, settings) {
  return channels
    .map((ch) => {
      const target = (settings && settings[ch.targetField]) || '';
      const on = !(settings && settings.channels && settings.channels[ch.key] === false);
      return `
        <div class="notify-channel">
          <div class="notify-channel-head">
            <div>
              <div class="notify-channel-title">${esc(ch.label)}</div>
              <div class="hint">${esc(ch.desc)}</div>
            </div>
            <label class="switch">
              <input type="checkbox" data-channel="${esc(ch.key)}" ${on ? 'checked' : ''} />
              <span>开启</span>
            </label>
          </div>
          ${
            ch.noInput
              ? ''
              : `<input class="input" data-target="${esc(ch.key)}" placeholder="${esc(ch.placeholder)}" value="${esc(target)}" />`
          }
          <div class="hint">${
            ch.configured
              ? '服务端已配置该渠道'
              : '服务端未配置该渠道的凭据，填写地址后仍会记录日志但无法真正投递'
          }${ch.enabled ? '' : ' · 已被全局关闭'}</div>
        </div>`;
    })
    .join('');
}

function envRows(env) {
  return (env || [])
    .map(
      (item) =>
        `<tr><td>${esc(item.key)}</td><td>${
          item.value ? `<code>${esc(item.value)}</code>` : '<span class="badge rejected">未设置</span>'
        }</td></tr>`
    )
    .join('');
}

function debugHtml(debug, cfg, queueStats) {
  const channelCards = (debug.channels || [])
    .map(
      (ch) => `
        <div class="notify-channel">
          <div class="notify-channel-head">
            <div class="notify-channel-title">${esc(ch.label)}</div>
            <span class="badge ${ch.configured ? 'approved' : 'rejected'}">${
        ch.configured ? '凭据已配置' : '凭据缺失'
      }</span>
          </div>
          <table class="table compact">
            <tbody>${envRows(ch.env)}</tbody>
          </table>
          <label class="switch" style="margin-top:8px">
            <input type="checkbox" data-global="${esc(ch.key)}" ${ch.enabled ? 'checked' : ''} />
            <span>全局启用该渠道</span>
          </label>
        </div>`
    )
    .join('');

  return `
    <div class="card" style="max-width:760px">
      <div class="card-title">调试面板（仅审批人）</div>
      <div class="hint" style="margin:-4px 0 12px">
        用于排查通知推送：查看服务端凭据、队列状态，模拟触发各类通知，重跑失败任务，并查看全量日志。敏感值已打码。
      </div>

      <div class="stat-grid" style="margin-bottom:12px">
        <div class="stat"><div class="label">队列待处理</div><div class="value">${esc(queueStats.pending || 0)}</div></div>
        <div class="stat"><div class="label">重试中</div><div class="value">${esc(queueStats.retrying || 0)}</div></div>
        <div class="stat"><div class="label">已到期待跑</div><div class="value">${esc(queueStats.overdue || 0)}</div></div>
        <div class="stat"><div class="label">下次执行</div><div class="value" style="font-size:13px">${esc(
          queueStats.nextRunAt ? formatDateTime(queueStats.nextRunAt) : '-'
        )}</div></div>
      </div>

      <div class="field"><label>邮件依赖 nodemailer</label>
        <div class="hint">${debug.nodemailerInstalled ? '已安装' : '未安装（服务端执行 npm install nodemailer）'}</div>
      </div>

      <div class="notify-channel-list">${channelCards}</div>

      <div class="form-grid" style="margin-top:12px">
        <div class="field">
          <label>失败重试次数（1-5）</label>
          <input class="input" data-role="max-attempts" type="number" min="1" max="5" value="${esc(
            (cfg && cfg.maxAttempts) || 3
          )}" />
        </div>
        <div class="field">
          <label>退避间隔（秒，逗号分隔）</label>
          <input class="input" data-role="delays" value="${esc(
            ((cfg && cfg.retryDelaysSec) || []).join(',')
          )}" />
        </div>
        <div class="field full">
          <label>详情链接前缀 baseUrl</label>
          <input class="input" data-role="base-url" placeholder="https://furry233.cn" value="${esc(
            (cfg && cfg.baseUrl) || ''
          )}" />
        </div>
      </div>

      <div class="actions" style="margin-top:12px">
        <button class="btn btn-primary" data-role="save-global">保存全局配置</button>
        <select class="select" data-role="sim-event" style="width:auto">
          ${Object.keys(EVENT_LABEL)
            .map((key) => `<option value="${esc(key)}">${esc(EVENT_LABEL[key])}</option>`)
            .join('')}
        </select>
        <button class="btn" data-role="simulate">模拟触发</button>
        <button class="btn" data-role="retry-failed">重跑失败任务</button>
      </div>
    </div>`;
}

function logRows(items) {
  if (!items.length) return empty('暂无通知发送记录');
  return `
    <table class="table">
      <thead>
        <tr><th>时间</th><th>渠道</th><th>事件</th><th>状态</th><th>说明</th></tr>
      </thead>
      <tbody>
        ${items
          .map((row) => {
            const meta = STATUS_META[row.status] || { label: row.status, cls: 'cancelled' };
            const detail = row.error || row.preview || '';
            return `<tr>
              <td>${esc(formatDateTime(row.ts))}</td>
              <td>${esc(CHANNEL_LABEL[row.channel] || row.channel)}</td>
              <td>${esc(EVENT_LABEL[row.event] || row.event || '-')}</td>
              <td><span class="badge ${meta.cls}">${esc(meta.label)}${
              row.attempt > 1 ? ` · 第${row.attempt}次` : ''
            }</span></td>
              <td>${esc(detail)}</td>
            </tr>`;
          })
          .join('')}
      </tbody>
    </table>`;
}

export async function notifySettings({ container, user }) {
  container.innerHTML = `<div class="card">${loading('加载通知设置…')}</div>`;

  const isApprover = Boolean(user && user.role === 'approver');

  let payload;
  try {
    payload = await api.get('/api/notify/settings');
  } catch (err) {
    container.innerHTML = `<div class="card">${esc(err.message)}</div>`;
    return;
  }

  let debugData = null;
  if (isApprover) {
    try {
      debugData = await api.get('/api/notify/debug');
    } catch (err) {
      debugData = null;
    }
  }

  const channels = payload.channels || [];
  let settings = payload.settings || { channels: {} };

  container.innerHTML = `
    <div class="card" style="max-width:760px">
      <div class="card-title">通知渠道设置</div>
      <div class="hint" style="margin:-4px 0 12px">
        开启后，系统会在「新审批单提交」和「审批结果更新」时通过所选渠道推送通知，内容包含审批类型、提交人、状态与时间戳。
      </div>
      <div class="notify-channel-list">${channelRows(channels, settings)}</div>
      <div class="actions" style="margin-top:14px">
        <button class="btn btn-primary" data-role="save">保存设置</button>
        <button class="btn" data-role="test">发送测试通知</button>
      </div>
    </div>
    <div class="card" style="max-width:760px">
      <div class="card-title">系统推送（手机 / 桌面通知栏）</div>
      <div class="hint" style="margin:-4px 0 12px">
        通过 Web Push 在 iPhone / Android 的系统通知栏弹出提醒。需要 <b>HTTPS</b> 安全上下文：iOS 16.4+ 且已「添加到主屏幕」的轻应用；Android Chrome 可直接支持。
      </div>
      <div data-role="push-state">${loading('检测推送支持情况…')}</div>
      <div class="actions" style="margin-top:12px">
        <button class="btn btn-primary" data-role="push-enable">开启系统通知</button>
        <button class="btn" data-role="push-disable">关闭系统通知</button>
        <button class="btn" data-role="push-test">发一条测试推送</button>
        ${isApprover ? '<button class="btn" data-role="push-broadcast">广播到所有设备</button>' : ''}
        <button class="btn" data-role="push-resubscribe">重新订阅本设备</button>
        ${isApprover ? '<button class="btn" data-role="push-clean">清理旧域名订阅</button>' : ''}
      </div>
      <div data-role="push-devices" style="margin-top:12px"></div>
      <div class="hint" style="margin-top:8px">
        iOS 注意：通知权限必须在「添加到主屏幕」后的轻应用内授予，Safari 标签页里授予的权限对轻应用无效；系统版本需 iOS 16.4+。
      </div>
    </div>
    ${debugData ? debugHtml(debugData.debug, debugData.config, debugData.queue) : ''}
    <div class="card" style="max-width:760px">
      <div class="card-title">通知发送日志</div>
      <div class="hint" style="margin:-4px 0 12px">记录每一次推送尝试（成功 / 重试 / 失败 / 跳过），失败按退避策略重试。</div>
      <div class="toolbar" style="margin-bottom:10px">
        <select class="select" data-role="log-status" style="width:auto">
          <option value="">全部状态</option>
          <option value="sent">已发送</option>
          <option value="retry">重试中</option>
          <option value="failed">失败</option>
          <option value="skipped">已跳过</option>
        </select>
        ${isApprover ? '<label class="switch"><input type="checkbox" data-role="log-all" /><span>查看所有人</span></label>' : ''}
        <button class="btn btn-sm" data-role="refresh-logs">刷新</button>
      </div>
      <div data-role="logs">${loading('加载日志…')}</div>
    </div>`;

  async function loadLogs() {
    const host = container.querySelector('[data-role="logs"]');
    const statusEl = container.querySelector('[data-role="log-status"]');
    const allEl = container.querySelector('[data-role="log-all"]');
    const wantAll = Boolean(allEl && allEl.checked);
    try {
      const data = await api.get('/api/notify/logs', { limit: 100, all: wantAll ? 1 : '' });
      let items = data.items || [];
      const status = statusEl ? statusEl.value : '';
      if (status) items = items.filter((row) => row.status === status);
      host.innerHTML = logRows(items);
    } catch (err) {
      host.innerHTML = `<div class="hint">日志加载失败：${esc(err.message)}</div>`;
    }
  }

  container.querySelector('[data-role="save"]').addEventListener('click', async () => {
    const body = { channels: {} };
    channels.forEach((ch) => {
      const box = container.querySelector(`[data-channel="${ch.key}"]`);
      const input = container.querySelector(`[data-target="${ch.key}"]`);
      body.channels[ch.key] = Boolean(box && box.checked);
      body[ch.targetField] = input ? input.value.trim() : '';
    });
    try {
      const data = await api.put('/api/notify/settings', body);
      settings = data.settings;
      toast('通知设置已保存', 'success');
      loadLogs();
    } catch (err) {
      toast(err.message || '保存失败', 'error');
    }
  });

  container.querySelector('[data-role="test"]').addEventListener('click', async () => {
    try {
      const data = await api.post('/api/notify/test', {});
      toast(
        data.queued > 0 ? `已加入推送队列 ${data.queued} 条，稍后查看日志` : '没有可推送的渠道，请先开启渠道并填写接收地址',
        data.queued > 0 ? 'success' : 'error'
      );
      setTimeout(loadLogs, 1200);
    } catch (err) {
      toast(err.message || '测试推送失败', 'error');
    }
  });

  const refreshBtn = container.querySelector('[data-role="refresh-logs"]');
  if (refreshBtn) refreshBtn.addEventListener('click', loadLogs);
  const statusSel = container.querySelector('[data-role="log-status"]');
  if (statusSel) statusSel.addEventListener('change', loadLogs);
  const allBox = container.querySelector('[data-role="log-all"]');
  if (allBox) allBox.addEventListener('change', loadLogs);

  /* ---------------- 调试面板事件 ---------------- */
  const saveGlobal = container.querySelector('[data-role="save-global"]');
  if (saveGlobal) {
    saveGlobal.addEventListener('click', async () => {
      const channelsPatch = {};
      channels.forEach((ch) => {
        const box = container.querySelector(`[data-global="${ch.key}"]`);
        channelsPatch[ch.key] = { enabled: Boolean(box && box.checked) };
      });
      const delays = String(container.querySelector('[data-role="delays"]').value || '')
        .split(',')
        .map((n) => parseInt(n.trim(), 10))
        .filter((n) => Number.isInteger(n) && n >= 0);
      const body = {
        channels: channelsPatch,
        maxAttempts: parseInt(container.querySelector('[data-role="max-attempts"]').value, 10) || 3,
        retryDelaysSec: delays.length ? delays : [10, 60, 300],
        baseUrl: container.querySelector('[data-role="base-url"]').value.trim(),
      };
      try {
        await api.put('/api/notify/config', body);
        toast('全局通知配置已保存', 'success');
      } catch (err) {
        toast(err.message || '保存失败', 'error');
      }
    });
  }

  const simBtn = container.querySelector('[data-role="simulate"]');
  if (simBtn) {
    simBtn.addEventListener('click', async () => {
      const event = container.querySelector('[data-role="sim-event"]').value;
      try {
        const data = await api.post('/api/notify/debug/simulate', { event });
        toast(
          data.queued > 0 ? `模拟通知已入队 ${data.queued} 条` : '无可推送渠道，请检查开关与接收地址',
          data.queued > 0 ? 'success' : 'error'
        );
        setTimeout(loadLogs, 1500);
      } catch (err) {
        toast(err.message || '模拟触发失败', 'error');
      }
    });
  }

  const retryBtn = container.querySelector('[data-role="retry-failed"]');
  if (retryBtn) {
    retryBtn.addEventListener('click', async () => {
      try {
        const data = await api.post('/api/notify/debug/retry-failed', {});
        toast(data.requeued > 0 ? `已重新入队 ${data.requeued} 条失败任务` : '最近没有失败任务', data.requeued > 0 ? 'success' : '');
        setTimeout(loadLogs, 1500);
      } catch (err) {
        toast(err.message || '重跑失败', 'error');
      }
    });
  }

  /* ---------------- 系统推送（Web Push） ---------------- */
  const pushState = container.querySelector('[data-role="push-state"]');
  const secureCtx = Boolean(window.isSecureContext);
  const swOk = 'serviceWorker' in navigator;
  const pushOk = typeof PushManager !== 'undefined';
  const perm = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
  // iOS：只有「添加到主屏幕」后的独立窗口才支持网页版系统推送
  const standalone =
    window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // 提前取公钥：订阅时不再 await 网络请求，保证仍在用户手势上下文中（iOS 要求）
  let vapidKey = '';
  let vapidReady = false;
  api
    .get('/api/notify/push/public-key')
    .then((data) => {
      vapidKey = data.publicKey || '';
      vapidReady = Boolean(data.vapidReady);
    })
    .catch(() => {});

  async function refreshPushState() {
    let server = { subscribed: 0, vapidReady: false };
    try {
      server = await api.get('/api/notify/push/status');
    } catch (err) {
      /* ignore */
    }
    let existing = null;
    if (swOk && pushOk) {
      try {
        const reg = await navigator.serviceWorker.ready;
        existing = await reg.pushManager.getSubscription();
      } catch (err) {
        /* ignore */
      }
    }
    const reasons = [];
    if (!secureCtx) reasons.push('当前不是 HTTPS 安全上下文（HTTP + IP 无法注册 Service Worker）');
    if (!swOk) reasons.push('浏览器不支持 Service Worker');
    if (!pushOk) reasons.push('浏览器不支持 Web Push');
    if (perm === 'denied') reasons.push('通知权限已被拒绝，请在系统设置中允许');
    if (!server.vapidReady) reasons.push('服务端尚未配置 VAPID 密钥');
    pushState.innerHTML = `
      <div class="stat-grid">
        <div class="stat"><div class="label">安全上下文</div><div class="value" style="font-size:14px">${secureCtx ? '是' : '否'}</div></div>
        <div class="stat"><div class="label">通知权限</div><div class="value" style="font-size:14px">${esc(perm)}</div></div>
        <div class="stat"><div class="label">已订阅设备</div><div class="value">${esc(server.subscribed || 0)}</div></div>
        <div class="stat"><div class="label">本机订阅</div><div class="value" style="font-size:14px">${existing ? '已订阅' : '未订阅'}</div></div>
      </div>
      ${
        reasons.length
          ? `<div class="hint" style="margin-top:8px">不可用原因：${reasons.map(esc).join('；')}</div>`
          : '<div class="hint" style="margin-top:8px">环境满足，可点击「开启系统通知」完成订阅。</div>'
      }
      <div class="hint" style="margin-top:6px">
        独立窗口（已添加到主屏幕）：<b>${standalone ? '是' : '否'}</b>${
          isIOS && !standalone
            ? '　→ iOS 需先「分享 → 添加到主屏幕」，再从轻应用内开启，才能在后台收到系统通知'
            : ''
        }；订阅后即使关闭 / 退到后台，系统通知栏仍会收到推送。
      </div>`;
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
  }

  container.querySelector('[data-role="push-enable"]').addEventListener('click', async () => {
    if (!secureCtx || !swOk || !pushOk) {
      toast('当前环境不支持系统推送（需 HTTPS）', 'error');
      return;
    }
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        await Notification.requestPermission();
      }
      if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
        toast('通知权限未授予', 'error');
        return;
      }
      // 用预取的公钥；缺失时再取一次（手势已用于授权，后续 await 不影响 iOS）
      let publicKey = vapidKey;
      let ready = vapidReady;
      if (!publicKey || !ready) {
        const data = await api.get('/api/notify/push/public-key');
        publicKey = data.publicKey || '';
        ready = Boolean(data.vapidReady);
      }
      if (!ready || !publicKey) {
        toast('服务端未配置 VAPID 密钥，无法订阅', 'error');
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
      }
      const data = await api.post('/api/notify/push/subscribe', {
        endpoint: sub.endpoint,
        keys: sub.toJSON().keys,
        userAgent: navigator.userAgent,
        origin: location.origin,
      });
      toast(`已订阅系统推送（${data.subscribed} 台设备）`, 'success');
      refreshPushState();
      if (typeof refreshDevices === 'function') refreshDevices();
      loadLogs();
    } catch (err) {
      toast(err.message || '订阅失败', 'error');
    }
  });

  container.querySelector('[data-role="push-disable"]').addEventListener('click', async () => {
    try {
      if (swOk && pushOk) {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await api.post('/api/notify/push/unsubscribe', { endpoint: sub.endpoint });
          await sub.unsubscribe();
        }
      }
      await api.post('/api/notify/push/unsubscribe', {});
      toast('已关闭系统推送', 'success');
      refreshPushState();
    } catch (err) {
      toast(err.message || '关闭失败', 'error');
    }
  });

  container.querySelector('[data-role="push-test"]').addEventListener('click', async () => {
    try {
      const data = await api.post('/api/notify/test', {});
      toast(data.queued > 0 ? `已入队 ${data.queued} 条，稍后查看日志` : '没有可推送的渠道，请先订阅系统通知', data.queued > 0 ? 'success' : 'error');
      setTimeout(loadLogs, 1500);
    } catch (err) {
      toast(err.message || '测试失败', 'error');
    }
  });

  const bcBtn = container.querySelector('[data-role="push-broadcast"]');
  if (bcBtn) {
    bcBtn.addEventListener('click', async () => {
      try {
        const data = await api.post('/api/notify/debug/broadcast', {
          title: '【买个Der】后台推送测试',
          body: '这是后台/未打开 App 时的系统通知测试，点按可直达申请列表。',
          url: '/#/apps',
        });
        toast(
          data.queued > 0 ? `已向 ${data.queued} 个账号（${data.devices} 台设备）广播，请查看手机通知栏` : '暂无已订阅设备，请先在本机开启系统通知',
          data.queued > 0 ? 'success' : 'error'
        );
        setTimeout(loadLogs, 1500);
      } catch (err) {
        toast(err.message || '广播失败', 'error');
      }
    });
  }

  /* 订阅明细 + 重新订阅 + 旧订阅清理 */
  const devicesBox = container.querySelector('[data-role="push-devices"]');

  async function refreshDevices() {
    if (!devicesBox) return;
    if (!isApprover) {
      devicesBox.innerHTML = '';
      return;
    }
    try {
      const data = await api.get('/api/notify/debug/subscriptions');
      const items = data.items || [];
      devicesBox.innerHTML = items.length
        ? `<div class="hint" style="margin-bottom:6px">已注册设备 ${items.length} 台（当前站点来源：${esc(
            data.currentOrigin || '-'
          )}）</div>
           <table class="table"><thead><tr><th>平台</th><th>来源</th><th>订阅时间</th><th>端点</th></tr></thead><tbody>
           ${items
             .map(
               (row) =>
                 `<tr><td>${esc(row.platform)}</td><td>${esc(row.origin)}</td><td>${esc(
                   formatDateTime(row.createdAt)
                 )}</td><td><code>${esc(row.endpoint)}</code></td></tr>`
             )
             .join('')}
           </tbody></table>`
        : '<div class="hint">暂无已订阅设备。</div>';
    } catch (err) {
      devicesBox.innerHTML = '';
    }
  }

  const reBtn = container.querySelector('[data-role="push-resubscribe"]');
  if (reBtn) {
    reBtn.addEventListener('click', async () => {
      try {
        if (swOk && pushOk) {
          const reg = await navigator.serviceWorker.ready;
          const sub = await reg.pushManager.getSubscription();
          if (sub) {
            await api.post('/api/notify/push/unsubscribe', { endpoint: sub.endpoint });
            await sub.unsubscribe();
          }
        }
        container.querySelector('[data-role="push-enable"]').click();
        setTimeout(refreshDevices, 1500);
      } catch (err) {
        toast(err.message || '重新订阅失败', 'error');
      }
    });
  }

  const cleanBtn = container.querySelector('[data-role="push-clean"]');
  if (cleanBtn) {
    cleanBtn.addEventListener('click', async () => {
      try {
        const data = await api.post('/api/notify/debug/clean-stale', {});
        toast(`已清理 ${data.removed} 条失效订阅，剩余 ${data.remaining} 台设备`, 'success');
        refreshDevices();
        refreshPushState();
      } catch (err) {
        toast(err.message || '清理失败', 'error');
      }
    });
  }

  // 状态刷新时同步刷新设备明细
  const originalRefresh = refreshPushState;
  const wrappedRefresh = async () => {
    await originalRefresh();
    await refreshDevices();
  };
  wrappedRefresh();
  loadLogs();
}
