/**
 * 视图：审批记录
 *
 * 职责：按状态分段（全部/已同意/已拒绝/已撤回）查询历史申请，供事后追溯。
 */
import * as api from '../api.js';
import { esc, empty, loading, pagerHtml } from '../ui.js';
import { tableHtml, bindRows } from './shared.js';
import { pagerOf } from './apps.js';

const SEGMENTS = [
  { value: '', label: '全部记录' },
  { value: 'approved', label: '已同意' },
  { value: 'rejected', label: '已拒绝' },
  { value: 'cancelled', label: '已撤回' }
];

export async function records({ container, user }) {
  container.innerHTML =
    '<div class="card"><div class="card-title">审批记录</div>' +
    '<div data-role="toolbar"></div><div data-role="list">' +
    loading() +
    '</div></div>';

  const toolbarEl = container.querySelector('[data-role="toolbar"]');
  const listEl = container.querySelector('[data-role="list"]');
  const state = { status: '', keyword: '', page: 1, approver: '' };

  drawToolbar();
  await load();

  function drawToolbar() {
    const buttons = SEGMENTS.map(
      (i) => '<button data-status="' + i.value + '" class="' + (i.value === state.status ? 'active' : '') + '">' + i.label + '</button>'
    ).join('');
    const mineBox = user.role === 'approver'
      ? '<label class="btn" style="gap:6px"><input type="checkbox" data-role="mine"' + (state.approver === 'me' ? ' checked' : '') + ' />只看我审批的</label>'
      : '';
    toolbarEl.innerHTML =
      '<div class="toolbar"><div class="segmented" data-role="seg">' + buttons + '</div>' +
      '<input class="input" data-role="kw" style="max-width:240px" placeholder="搜索物品 / 申请人 / 审批意见" value="' + esc(state.keyword) + '" />' +
      '<button class="btn" data-role="search">搜索</button>' + mineBox +
      '<div style="margin-left:auto"><a class="btn btn-primary" href="#/apps/new">+ 新建申请</a></div></div>';
    toolbarEl.querySelectorAll('[data-role="seg"] button').forEach((b) => {
      b.addEventListener('click', () => onStatus(b.dataset.status));
    });
    const kw = toolbarEl.querySelector('[data-role="kw"]');
    toolbarEl.querySelector('[data-role="search"]').addEventListener('click', () => onSearch(kw.value.trim()));
    kw.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') onSearch(kw.value.trim());
    });
    const box = toolbarEl.querySelector('[data-role="mine"]');
    if (box) {
      box.addEventListener('change', () => {
        state.approver = box.checked ? 'me' : '';
        state.page = 1;
        load();
      });
    }
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
    try {
      const data = await api.get('/api/applications/records', {
        status: state.status,
        keyword: state.keyword,
        approver: state.approver,
        page: state.page
      });
      if (!data.items.length) {
        listEl.innerHTML = empty('暂无审批记录');
        return;
      }
      listEl.innerHTML =
        tableHtml(data.items, { showApplicant: true, showApprover: true, showDecision: true }) +
        pagerHtml(data.total, data.page, data.pageSize);
      bindRows(listEl, pagerOf(data, state, load));
    } catch (err) {
      listEl.innerHTML = empty(err.message);
    }
  }
}
