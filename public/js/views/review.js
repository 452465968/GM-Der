/**
 * 视图：审批工作台 / 待我投票
 *
 * 职责：审批人视角展示全部申请并可处理；非审批人但被指派为投票人的账号，
 * 只展示「待我投票」子集（由后端可见性规则裁剪，前端不再二次判断权限）。
 */
import * as api from '../api.js';
import { empty, loading, pagerHtml } from '../ui.js';
import { statsHtml, toolbarHtml, bindToolbar, tableHtml, bindRows } from './shared.js';
import { pagerOf } from './apps.js';

export async function review({ container, user }) {
  // 非审批人账号可能只是被指派为某笔申请的投票人，此时只展示「待我投票」
  const isApprover = Boolean(user && user.role === 'approver');
  const pendingLabel = isApprover ? '待我审批' : '待我投票';
  container.innerHTML = [
    '<div class="stat-grid" data-role="stats"></div>',
    '<div class="card">',
    `<div class="card-title">${isApprover ? '审批工作台' : '待我投票'}</div>`,
    '<div class="toolbar" data-role="tabs"><div class="segmented">',
    `<button data-tab="pending" class="active">${pendingLabel}</button>`,
    isApprover ? '<button data-tab="all">全部申请</button>' : '',
    isApprover ? '<button data-tab="mine">我审批过的</button>' : '',
    '</div></div>',
    '<div data-role="toolbar"></div>',
    '<div data-role="list">' + loading() + '</div>',
    '</div>'
  ].join('');

  const statsEl = container.querySelector('[data-role="stats"]');
  const tabsEl = container.querySelector('[data-role="tabs"]');
  const toolbarEl = container.querySelector('[data-role="toolbar"]');
  const listEl = container.querySelector('[data-role="list"]');
  const state = { tab: 'pending', status: '', keyword: '', page: 1 };

  function drawToolbar() {
    toolbarEl.innerHTML = toolbarHtml({
      keyword: state.keyword,
      active: state.tab === 'pending' ? '' : state.status
    });
    if (state.tab === 'pending') {
      const seg = toolbarEl.querySelector('[data-role="seg"]');
      if (seg) seg.style.display = 'none';
    }
    bindToolbar(toolbarEl, onSearch, onStatus);
  }

  function onSearch(keyword) {
    state.keyword = keyword;
    state.page = 1;
    load();
  }

  function onStatus(status) {
    state.status = status;
    state.page = 1;
    drawToolbar();
    load();
  }

  async function load() {
    listEl.innerHTML = loading();
    const params = { keyword: state.keyword, page: state.page };
    let request;
    let columns = { showApplicant: true };
    if (state.tab === 'pending') {
      // 待我审批 = 首次提交(pending) + 修改重提(resubmitted)，均需审批人处理
      request = api.get('/api/applications', { scope: 'pending', ...params });
    } else if (state.tab === 'all') {
      request = api.get('/api/applications', { scope: 'all', status: state.status, ...params });
    } else {
      request = api.get('/api/applications/records', { approver: 'me', status: state.status, ...params });
      columns = { showApplicant: true, showApprover: true, showDecision: true };
    }
    try {
      const stats = await api.get('/api/applications/stats');
      const data = await request;
      statsEl.innerHTML = statsHtml(stats, {
        pendingLabel,
        pendingValue: stats.myPending != null ? stats.myPending : stats.pending,
      });
      if (!data.items.length) {
        listEl.innerHTML = empty(
          state.tab === 'pending' ? `太棒了，暂无${pendingLabel}的申请` : '暂无符合条件的申请'
        );
        return;
      }
      listEl.innerHTML = tableHtml(data.items, columns) + pagerHtml(data.total, data.page, data.pageSize);
      bindRows(listEl, pagerOf(data, state, load));
    } catch (err) {
      listEl.innerHTML = empty(err.message);
    }
  }

  tabsEl.querySelectorAll('button[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.tab = btn.dataset.tab;
      state.status = '';
      state.page = 1;
      tabsEl.querySelectorAll('button[data-tab]').forEach((b) => b.classList.toggle('active', b === btn));
      drawToolbar();
      load();
    });
  });

  drawToolbar();
  await load();
}
