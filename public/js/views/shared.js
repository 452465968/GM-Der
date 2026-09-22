/**
 * 视图公共片段
 *
 * 职责：列表页复用件——状态筛选器、统计条、表格行/卡片 HTML、行点击绑定、
 * 单选/多选卡片（syncRadioCards/bindRadioCards/collectMulti）。
 * 表单里的「是否有替代品」等选项卡片由本模块的卡片逻辑驱动（有独立回归测试）。
 */
import { esc, formatDateTime, formatMoney, statusBadge, bindPager } from '../ui.js';

export const STATUS_FILTERS = [
  { value: '', label: '全部' },
  { value: 'pending', label: '待审批' },
  { value: 'resubmitted', label: '已修改待审批' },
  { value: 'approved', label: '已同意' },
  { value: 'rejected', label: '已拒绝' },
  { value: 'cancelled', label: '已撤回' },
];

export function statsHtml(stats, opts) {
  if (!stats) return '';
  const o = opts || {};
  // 审批人工作台用“待我审批”(myPending)，其他场景显示待审批总数
  const pendingLabel = o.pendingLabel || '待审批';
  const pendingValue = o.pendingValue != null ? o.pendingValue : stats.pending;
  return `<div class="stat"><div class="label">申请总数</div><div class="value">${stats.total}</div></div>
    <div class="stat pending"><div class="label">${esc(pendingLabel)}</div><div class="value">${pendingValue}</div></div>
    <div class="stat approved"><div class="label">已同意</div><div class="value">${stats.approved}</div></div>
    <div class="stat rejected"><div class="label">已拒绝</div><div class="value">${stats.rejected}</div></div>`;
}

export function toolbarHtml({ keyword = '', active = '', placeholder = '搜索物品名称 / 平台 / 申请人' } = {}) {
  return `<div class="toolbar">
      <div class="segmented" data-role="seg">
        ${STATUS_FILTERS.map(
          (i) => `<button data-status="${i.value}" class="${i.value === active ? 'active' : ''}">${i.label}</button>`
        ).join('')}
      </div>
      <input class="input" data-role="kw" style="max-width:240px" placeholder="${esc(placeholder)}" value="${esc(
    keyword
  )}" />
      <button class="btn" data-role="search">搜索</button>
      <div style="margin-left:auto"><a class="btn btn-primary" href="#/apps/new">+ 新建申请</a></div>
    </div>`;
}

export function bindToolbar(el, onSearch, onStatus) {
  const seg = el.querySelector('[data-role="seg"]');
  if (seg && onStatus) {
    seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => onStatus(b.dataset.status)));
  }
  const kw = el.querySelector('[data-role="kw"]');
  const search = () => onSearch(kw.value.trim());
  el.querySelector('[data-role="search"]').addEventListener('click', search);
  kw.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') search();
  });
}

// 投票制进度小字（待审状态）：如 “3 票需 2 票 · 已 1 票”
function voteProgress(item) {
  if (!item.rule || !['pending', 'resubmitted'].includes(item.status)) return '';
  const total = (item.rule.voters || []).length;
  const counts = item.voteCounts || { approve: 0, reject: 0 };
  const cast = (counts.approve || 0) + (counts.reject || 0);
  return `<div class="sub">${total} 票需 ${item.rule.passVotes} 票通过 · 已投 ${cast}/${total}</div>`;
}

export function rowHtml(item, o) {
  const showApplicant = !!(o && o.showApplicant);
  const showApprover = !!(o && o.showApprover);
  const showDecision = !!(o && o.showDecision);
  const comment = item.decisionComment
    ? `<div class="sub" title="${esc(item.decisionComment)}">${esc(item.decisionComment)}</div>`
    : '<div class="sub">-</div>';
  const approverNames = item.rule
    ? (item.rule.voters || [])
        .map((v, idx) => {
          const vote = (item.votes || []).find((x) => x.approverId === v.id);
          const mark = vote ? (vote.action === 'approve' ? '✓' : '✕') : '·';
          return `${esc(v.name)}${mark}`;
        })
        .join('、')
    : item.approver
    ? esc(item.approver.name)
    : '-';
  const visBadge =
    item.visibility === 'restricted'
      ? '<span class="badge vis-limited">仅审批人可见</span>'
      : '<span class="badge vis-public">公开</span>';
  return `<tr data-id="${item.id}" style="cursor:pointer">
      <td data-label="物品"><div class="item-name">${esc(item.itemName)}${visBadge}</div>
        <div class="sub">${esc(item.platform)} · ${item.hasAlternative ? '有替代品' : '无替代品'}</div></td>
      <td data-label="价格" class="price">${formatMoney(item.price)}</td>
      ${showApplicant ? `<td data-label="申请人">${esc(item.applicant.name)}</td>` : ''}
      ${showDecision ? `<td data-label="审批结果">${statusBadge(item.status)}</td>` : ''}
      ${showDecision ? `<td data-label="审批意见">${comment}</td>` : ''}
      ${showApprover ? `<td data-label="审批人" title="${approverNames}">${approverNames}</td>` : ''}
      ${
        showDecision
          ? `<td data-label="审批时间">${formatDateTime(item.decidedAt)}</td>`
          : `<td data-label="状态">${statusBadge(item.status)}${voteProgress(item)}</td><td data-label="提交时间">${formatDateTime(
              item.createdAt
            )}</td>`
      }
      <td class="cell-action" data-label="操作">
        ${
          item.canResubmit
            ? `<button class="btn btn-sm btn-primary" data-act="resubmit" data-id="${item.id}">修改重提</button>`
            : ''
        }
        <button class="btn btn-sm" data-id="${item.id}">查看详情</button></td>
    </tr>`;
}

export function tableHtml(items, o) {
  const showApplicant = !!(o && o.showApplicant);
  const showApprover = !!(o && o.showApprover);
  const showDecision = !!(o && o.showDecision);
  return `<table class="table"><thead><tr>
      <th>物品</th><th>价格</th>
      ${showApplicant ? '<th>申请人</th>' : ''}
      ${showDecision ? '<th>审批结果</th><th>审批意见</th>' : ''}
      ${showApprover ? '<th>审批人</th>' : ''}
      ${showDecision ? '<th>审批时间</th>' : '<th>状态</th><th>提交时间</th>'}
      <th>操作</th>
    </tr></thead><tbody>${items.map((i) => rowHtml(i, o)).join('')}</tbody></table>`;
}

export function bindRows(el, pager) {
  el.querySelectorAll('tr[data-id]').forEach((tr) => {
    tr.addEventListener('click', (event) => {
      // 点击空白行区域才进入详情；按钮由各自处理器接管
      if (event.target.closest('button,a')) return;
      location.hash = `#/apps/${tr.dataset.id}`;
    });
  });
  el.querySelectorAll('button[data-id]').forEach((btn) =>
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (btn.dataset.act === 'resubmit') location.hash = `#/apps/${btn.dataset.id}/edit`;
      else location.hash = `#/apps/${btn.dataset.id}`;
    })
  );
  if (pager) bindPager(el, pager);
}

// 单选卡片：仅同步「同一 name 分组」内的高亮。
// 注意：不能清空整个 root 的高亮——一个表单里可能存在多组单选（如「是否有替代品」和「可见范围」），
// 跨组清空会让用户在其他分组的选择看起来被取消。
function cardsOfGroup(root, input) {
  const list = [];
  root.querySelectorAll('.radio-card').forEach((card) => {
    const el = card.querySelector('input');
    if (el && el.name && input.name && el.name === input.name) list.push(card);
  });
  return list;
}

// 按 input 的真实 checked 状态同步高亮（外部赋值、草稿恢复后也能对齐视觉）
export function syncRadioCards(root) {
  root.querySelectorAll('.radio-card').forEach((card) => {
    const input = card.querySelector('input');
    if (input && input.type === 'checkbox') card.classList.toggle('active', input.checked);
  });
  const done = new Set();
  root.querySelectorAll('.radio-card input[type="radio"]').forEach((input) => {
    if (!input.name || done.has(input.name)) return;
    if (!input.checked) return; // 只依据真正选中的项
    done.add(input.name);
    cardsOfGroup(root, input).forEach((card) => {
      const el = card.querySelector('input');
      card.classList.toggle('active', Boolean(el && el.checked));
    });
  });
}

const escapeAttr = (v) =>
  String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/**
 * 生成单/多选卡片。
 * 统一使用 .sr-only 隐藏原生 input（而非 hidden 属性）：
 *  - hidden 会让 input 失去焦点能力，键盘 Tab / 空格 与读屏都无法操作；
 *  - .sr-only 仅视觉隐藏，仍可被聚焦并由 :focus-within 反馈焦点环。
 * @param {string} name      分组名（单选同组互斥；多选建议使用 name[] 并在取值时用 FormData.getAll）
 * @param {string} value     选项值
 * @param {string} label     显示文案
 * @param {boolean} checked  是否选中（会同步渲染 active 高亮）
 * @param {boolean} multi    true → checkbox 多选语义；false → radio 单选语义
 */
export function cardHtml({ name, value, label, checked = false, multi = false }) {
  return `<label class="radio-card${multi ? ' multi' : ''}${checked ? ' active' : ''}">
      <input type="${multi ? 'checkbox' : 'radio'}" name="${escapeAttr(name)}" value="${escapeAttr(value)}" class="sr-only"${checked ? ' checked' : ''} />
      <span>${label}</span>
    </label>`;
}

/** 多选卡片组取值（name 需 [] 结尾） */
export function collectMulti(form, name) {
  const fd = new FormData(form);
  return fd.getAll(name.endsWith('[]') ? name : `${name}[]`);
}

export function bindRadioCards(root) {
  root.querySelectorAll('.radio-card').forEach((card) => {
    const input = card.querySelector('input');
    if (!input) return;
    card.addEventListener('click', () => {
      // 复选框保留多选语义；单选按分组互斥
      if (input.type === 'checkbox') {
        input.checked = !input.checked;
      } else {
        input.checked = true;
      }
      syncRadioCards(root);
    });
  });
  syncRadioCards(root);
}
