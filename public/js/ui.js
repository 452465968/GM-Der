/**
 * UI 工具集（无框架、纯函数）
 *
 * 职责：HTML 转义 esc、金额/时间格式化、状态徽章、Toast、Modal、分页器、加载/空态占位、
 * 图标常量 ICONS 等。前端不使用任何框架，所有视图都是「拼 HTML 字符串 + 事件委托」。
 */
export function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatDateTime(iso) {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

export function formatMoney(value) {
  const num = Number(value) || 0;
  return `¥${num.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const STATUS_MAP = {
  pending: { label: '待审批', className: 'pending' },
  resubmitted: { label: '已修改待审批', className: 'resubmitted' },
  approved: { label: '已同意', className: 'approved' },
  rejected: { label: '已拒绝', className: 'rejected' },
  cancelled: { label: '已撤回', className: 'cancelled' },
};

export function statusMeta(status) {
  return STATUS_MAP[status] || { label: status || '未知', className: 'cancelled' };
}

export function statusBadge(status) {
  const meta = statusMeta(status);
  return `<span class="badge ${meta.className}">${meta.label}</span>`;
}

// 依据顶栏实际高度校准浮层顶部位置：
// 顶栏在移动端已包含安全区内边距，因此「顶栏高度 + 间距」即可同时避开状态栏/灵动岛与控制栏，
// 浮层本身是 position:fixed，页面滚动时相对视口固定，始终可见。
export function syncToastOffset() {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const bar = document.querySelector('.topbar');
  const height = bar ? bar.getBoundingClientRect().height : 56;
  root.style.top = `${Math.max(12, Math.round(height) + 12)}px`;
}

export function toast(message, type = '') {
  syncToastOffset();
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

export function empty(text, sub = '') {
  return `<div class="empty"><div class="emoji">🗂️</div><div>${esc(text)}</div>${
    sub ? `<div style="font-size:12px;margin-top:4px">${esc(sub)}</div>` : ''
  }</div>`;
}

export function loading(text = '加载中…') {
  return `<div class="loading">${esc(text)}</div>`;
}

export function openModal({ title, bodyHtml, confirmText = '确定', cancelText = '取消', danger = false, onConfirm }) {
  syncToastOffset();
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-mask">
      <div class="modal">
        <h3>${esc(title)}</h3>
        <div class="modal-body">${bodyHtml}</div>
        <div class="form-error" data-role="modal-error"></div>
        <div class="modal-footer">
          <button class="btn" data-role="cancel">${esc(cancelText)}</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-role="confirm">${esc(confirmText)}</button>
        </div>
      </div>
    </div>`;

  const mask = root.querySelector('.modal-mask');
  const errorEl = root.querySelector('[data-role="modal-error"]');
  const confirmBtn = root.querySelector('[data-role="confirm"]');

  function close() {
    root.innerHTML = '';
  }

  mask.addEventListener('click', (event) => {
    if (event.target === mask) close();
  });
  root.querySelector('[data-role="cancel"]').addEventListener('click', close);
  document.addEventListener('keydown', function onEsc(event) {
    if (event.key === 'Escape') {
      close();
      document.removeEventListener('keydown', onEsc);
    }
  });

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    errorEl.classList.remove('show');
    try {
      const result = await onConfirm(mask);
      if (result === false) return;
      close();
    } catch (err) {
      errorEl.textContent = err.message || '操作失败';
      errorEl.classList.add('show');
    } finally {
      confirmBtn.disabled = false;
    }
  });

  const focusTarget = mask.querySelector('textarea, input');
  if (focusTarget) focusTarget.focus();
}

export const ICONS = {
  list:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
  plus:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  review:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/></svg>',
  history:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/></svg>',
  bell:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
  shield:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"/><path d="M9.5 12l1.8 1.8L15 10"/></svg>',
};

export function pagerHtml(total, page, pageSize) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const prevDisabled = page <= 1 ? 'disabled' : '';
  const nextDisabled = page >= totalPages ? 'disabled' : '';
  return `<div class="pager">
    <span>共 ${total} 条 · 第 ${page}/${totalPages} 页</span>
    <button class="btn btn-sm" data-page="${page - 1}" ${prevDisabled}>上一页</button>
    <button class="btn btn-sm" data-page="${page + 1}" ${nextDisabled}>下一页</button>
  </div>`;
}

export function bindPager(container, { page, pageSize, total, onPage }) {
  container.querySelectorAll('.pager button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = Number(btn.dataset.page);
      if (!target || target === page) return;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      if (target < 1 || target > totalPages) return;
      onPage(target);
    });
  });
}
