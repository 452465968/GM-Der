/**
 * 新审批任务提醒
 *
 * 职责：每 30 秒轮询「待我投票」列表，首次轮询只建立基线（不打扰），
 * 出现新任务时在页面内弹窗 + 桌面通知 + 角标计数；页面在后台时先入队，回到前台再弹。
 */
import * as api from './api.js';
import { esc, formatMoney, openModal, toast } from './ui.js';

// 新审批任务提醒：轮询「待我投票」列表，出现新任务时自动弹出提醒窗口
const POLL_INTERVAL = 30000;

let timer = null;
let started = false;
let knownIds = null; // null 表示尚未初始化（首次轮询只记录基线，不打扰用户）
let queued = []; // 页面在后台时收到的新任务，等用户回到页面再弹窗

function onOnline() {
  poll();
}

function setBadge(count) {
  document.querySelectorAll('[data-role="pending-count"]').forEach((el) => {
    if (count > 0) {
      el.textContent = count;
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  });
}

function taskLine(task) {
  const ruleText = task.rule ? ` · ${task.rule.total} 票需 ${task.rule.passVotes} 票通过` : '';
  return `<li class="notify-item">
      <div class="notify-title">${esc(task.itemName)} <span class="notify-price">${formatMoney(task.price)}</span></div>
      <div class="notify-meta">${esc(task.applicant.name)} 提交 · ${esc(task.platform)}${ruleText}</div>
      <a class="notify-link" href="#/apps/${encodeURIComponent(task.id)}">查看详情 →</a>
    </li>`;
}

function showPopup(tasks) {
  const first = tasks[0];
  openModal({
    title: `您有 ${tasks.length} 个新的审批任务`,
    confirmText: '立即处理',
    cancelText: '稍后处理',
    bodyHtml: `<div style="font-size:13px;color:var(--muted);margin-bottom:10px">
        以下购买申请正等待您投票，请及时处理的申请：
      </div>
      <ul class="notify-list">${tasks.map(taskLine).join('')}</ul>`,
    onConfirm: () => {
      location.hash = `#/apps/${encodeURIComponent(first.id)}`;
    },
  });

  // 点击列表中的详情链接后关闭提醒窗口
  document.querySelectorAll('.modal-mask .notify-link').forEach((link) => {
    link.addEventListener('click', () => {
      const modalRoot = document.getElementById('modal-root');
      if (modalRoot) modalRoot.innerHTML = '';
    });
  });
}

function notifyDesktop(tasks) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const first = tasks[0];
  const title = `新的审批任务（${tasks.length}）`;
  const body =
    tasks.length === 1
      ? `${first.applicant.name} 提交了「${first.itemName}」，等待您投票`
      : `包含「${first.itemName}」等 ${tasks.length} 项申请，等待您投票`;
  try {
    new Notification(title, { body });
  } catch (err) {
    /* 部分浏览器在非安全上下文禁用 Notification，忽略 */
  }
}

function requestDesktopPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    // 仅在用户尚未选择过时才询问一次
    Notification.requestPermission().catch(() => {});
  }
}

async function poll() {
  if (navigator.onLine === false) return; // 离线时不轮询，恢复联网后由 online 事件补一轮
  let data;
  try {
    data = await api.get('/api/applications/notifications');
  } catch (err) {
    return; // 轮询失败静默处理，下一轮继续
  }

  const items = data.items || [];
  setBadge(data.count || 0);

  const ids = items.map((item) => item.id);
  if (knownIds === null) {
    knownIds = new Set(ids); // 首次只建立基线，避免登录即弹窗
    return;
  }

  const fresh = items.filter((item) => !knownIds.has(item.id));
  // 已结束或已投票的任务会被移出待办，因此以当前列表刷新基线：
  // 若同一申请被修改后重新提交，再次进入待办时会重新提醒
  knownIds = new Set(ids);

  if (!fresh.length) return;

  // 页面在后台时不打扰：先记录并发送系统通知，等用户回到页面后再弹窗
  if (document.hidden) {
    fresh.forEach((task) => {
      if (!queued.some((item) => item.id === task.id)) queued.push(task);
    });
    notifyDesktop(fresh);
    return;
  }

  showPopup(fresh);
  notifyDesktop(fresh);
  toast(`您有 ${fresh.length} 个新的审批任务`, 'success');
}

export function startNotificationPolling() {
  if (started) return;
  started = true;
  requestDesktopPermission();
  poll();
  // 恢复联网时立即补一轮，避免离线期间漏掉新任务提醒
  window.addEventListener('online', onOnline);
  timer = setInterval(poll, POLL_INTERVAL);
  // 页面重新可见时立即检查一次，并补弹后台期间收到的提醒
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    poll();
    if (!queued.length) return;
    const tasks = queued;
    queued = [];
    showPopup(tasks);
    toast(`您有 ${tasks.length} 个新的审批任务`, 'success');
  });
}

export function stopNotificationPolling() {
  if (timer) clearInterval(timer);
  timer = null;
  window.removeEventListener('online', onOnline);
  started = false;
  knownIds = null;
  queued = [];
}
