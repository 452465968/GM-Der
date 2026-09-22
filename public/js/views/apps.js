/**
 * 视图：我的申请
 *
 * 职责：当前登录账号提交的申请列表（分页 + 关键字/状态筛选），并提供 pagerOf() 给其他列表页复用。
 */
import * as api from '../api.js';
import { empty, loading, pagerHtml } from '../ui.js';
import { statsHtml, toolbarHtml, bindToolbar, tableHtml, bindRows } from './shared.js';

export function pagerOf(data, state, load) {
  return {
    page: data.page,
    pageSize: data.pageSize,
    total: data.total,
    onPage: (page) => {
      state.page = page;
      load();
    },
  };
}

export async function apps({ container }) {
  container.innerHTML = [
    '<div class="stat-grid" data-role="stats"></div>',
    '<div class="card">',
    '<div class="card-title">我的申请</div>',
    '<div data-role="toolbar"></div>',
    '<div data-role="list">' + loading() + '</div>',
    '</div>'
  ].join('');

  const statsEl = container.querySelector('[data-role="stats"]');
  const toolbarEl = container.querySelector('[data-role="toolbar"]');
  const listEl = container.querySelector('[data-role="list"]');
  const state = { status: '', keyword: '', page: 1 };

  function drawToolbar() {
    toolbarEl.innerHTML = toolbarHtml({ keyword: state.keyword, active: state.status });
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
    try {
      const statsReq = api.get('/api/applications/stats');
      const listReq = api.get('/api/applications', {
        scope: 'mine',
        status: state.status,
        keyword: state.keyword,
        page: state.page
      });
      const stats = await statsReq;
      const data = await listReq;
      statsEl.innerHTML = statsHtml(stats);
      if (!data.items.length) {
        listEl.innerHTML = empty('暂无申请记录', '点击「新建申请」提交你的第一条购买申请');
        return;
      }
      listEl.innerHTML = tableHtml(data.items) + pagerHtml(data.total, data.page, data.pageSize);
      bindRows(listEl, pagerOf(data, state, load));
    } catch (err) {
      listEl.innerHTML = empty(err.message);
    }
  }

  drawToolbar();
  await load();
}
