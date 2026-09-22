/**
 * 视图：后台管理控制台
 *
 * 职责：五个标签页——概览、账号管理（增删改/停用/改权限）、角色权限（调整各角色默认权限）、
 * 登录日志、操作审计。所有按钮按当前账号权限显隐，后端仍会二次校验。
 */
import * as api from '../api.js';
import { esc, formatDateTime, toast, loading, empty, openModal } from '../ui.js';

// 后台管理控制台：概览 / 账号管理 / 角色权限 / 登录日志 / 操作审计

const TABS = [
  { key: 'overview', label: '概览' },
  { key: 'users', label: '账号管理' },
  { key: 'roles', label: '角色与权限' },
  { key: 'logs', label: '登录日志' },
  { key: 'audit', label: '操作审计' },
];

let state = {
  tab: 'overview',
  me: null,
  users: { items: [], total: 0, page: 1, pageSize: 10, keyword: '', role: '', status: '' },
  roles: null,
  logs: { items: [], summary: {} },
  audit: { items: [] },
  bootstrap: null,
};

function can(perm) {
  const me = state.me;
  if (!me) return false;
  if (me.isSuperAdmin || me.role === 'admin') return true;
  const perms = Array.isArray(me.permissions) ? me.permissions : [];
  return perms.includes('*') || perms.includes(perm);
}

/* ------------------------------ 片段渲染 ------------------------------ */

function overviewHtml(boot) {
  const o = boot.overview || {};
  const cards = [
    ['账号总数', o.users],
    ['超级管理员', o.admins],
    ['已停用', o.disabled],
    ['申请总数', o.applications],
    ['待审批', o.pending],
    ['已同意', o.approved],
    ['登录记录', o.logins],
    ['登录失败', o.loginFail],
  ];
  return `<div class="stat-grid">
    ${cards.map(([label, value]) => `<div class="stat"><div class="label">${esc(label)}</div><div class="value">${esc(value || 0)}</div></div>`).join('')}
  </div>
  <div class="card" style="margin-top:12px">
    <div class="card-title">最近注册账号</div>
    <table class="table"><thead><tr><th>姓名</th><th>账号</th><th>角色</th><th>注册时间</th></tr></thead><tbody>
      ${(boot.recentUsers || [])
        .map(
          (u) =>
            `<tr><td>${esc(u.name)}</td><td>${esc(u.username)}</td><td>${esc(u.roleLabel)}</td><td>${esc(
              formatDateTime(u.createdAt)
            )}</td></tr>`
        )
        .join('')}
    </tbody></table>
  </div>`;
}

function usersHtml() {
  const { items, total, page, pageSize } = state.users;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return `
    <div class="card">
      <div class="card-title">账号管理</div>
      <div class="toolbar" style="margin-bottom:10px">
        <input class="input" data-role="kw" placeholder="搜索姓名 / 账号" value="${esc(state.users.keyword)}" style="max-width:200px" />
        <select class="select" data-role="role" style="width:auto">
          <option value="">全部角色</option>
          ${(state.bootstrap?.roles || [])
            .map((r) => `<option value="${esc(r.key)}" ${state.users.role === r.key ? 'selected' : ''}>${esc(r.label)}</option>`)
            .join('')}
        </select>
        <select class="select" data-role="status" style="width:auto">
          <option value="">全部状态</option>
          <option value="active" ${state.users.status === 'active' ? 'selected' : ''}>正常</option>
          <option value="disabled" ${state.users.status === 'disabled' ? 'selected' : ''}>已停用</option>
        </select>
        <button class="btn btn-sm" data-role="search">搜索</button>
        ${can('account:create') ? '<button class="btn btn-sm btn-primary" data-role="create" style="margin-left:auto">+ 新建账号</button>' : ''}
      </div>
      ${
        items.length
          ? `<table class="table"><thead><tr><th>账号</th><th>姓名</th><th>角色</th><th>权限</th><th>状态</th><th>申请</th><th>最近登录</th><th>操作</th></tr></thead><tbody>
            ${items
              .map(
                (u) => `<tr>
                  <td>${esc(u.username)}${u.isSuperAdmin ? ' <span class="badge approved">超管</span>' : ''}</td>
                  <td>${esc(u.name)}</td>
                  <td>${esc(u.roleLabel)}</td>
                  <td style="font-size:12px">${u.permissions.includes('*') ? '全部权限' : esc((u.permissions || []).join(', ') || '—')}</td>
                  <td>${u.disabled ? '<span class="badge rejected">已停用</span>' : '<span class="badge approved">正常</span>'}</td>
                  <td>${esc(u.stats.applications)}（待办 ${esc(u.stats.pending)}）</td>
                  <td>${esc(formatDateTime(u.lastLoginAt))}</td>
                  <td>
                    ${can('account:edit') ? `<button class="btn btn-sm" data-edit="${esc(u.id)}">编辑</button>` : ''}
                    ${can('account:edit') ? `<button class="btn btn-sm" data-reset="${esc(u.id)}">重置密码</button>` : ''}
                    ${can('account:edit') ? `<button class="btn btn-sm" data-toggle="${esc(u.id)}">${u.disabled ? '启用' : '停用'}</button>` : ''}
                    ${can('account:delete') && !u.isSuperAdmin ? `<button class="btn btn-sm btn-danger" data-del="${esc(u.id)}">删除</button>` : ''}
                  </td>
                </tr>`
              )
              .join('')}
          </tbody></table>
          <div class="pager"><span>共 ${total} 条 · 第 ${page}/${totalPages} 页</span>
            <button class="btn btn-sm" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>上一页</button>
            <button class="btn btn-sm" data-page="${page + 1}" ${page >= totalPages ? 'disabled' : ''}>下一页</button>
          </div>`
          : empty('没有匹配的账号')
      }
    </div>`;
}

function rolesHtml() {
  if (!state.roles) return loading('加载角色权限…');
  return `<div class="card">
    <div class="card-title">角色与权限</div>
    <div class="hint" style="margin:-4px 0 12px">调整角色的默认权限后，新建该角色账号会自动带上这些权限；已有账号请在「账号管理 → 编辑」里单独调整。</div>
    ${(state.roles.roles || [])
      .map(
        (role) => `
        <div class="notify-channel" data-role-card="${esc(role.key)}">
          <div class="notify-channel-head">
            <div>
              <div class="notify-channel-title">${esc(role.label)} <span class="badge">${esc(role.users)} 人</span></div>
              <div class="hint">${esc(role.desc || '')}</div>
            </div>
          </div>
          ${
            role.key === 'admin'
              ? '<div class="hint">超级管理员固定拥有全部权限，不可修改。</div>'
              : `<div class="perm-grid">
                  ${(state.roles.permissions || [])
                    .map(
                      (p) =>
                        `<label class="switch"><input type="checkbox" data-role-perm="${esc(role.key)}" value="${esc(p.key)}" ${
                          (role.defaultPermissions || []).includes(p.key) ? 'checked' : ''
                        } /><span>${esc(p.label)}</span></label>`
                    )
                    .join('')}
                </div>
                ${can('role:manage') ? `<div class="actions" style="margin-top:10px"><button class="btn btn-sm btn-primary" data-save-role="${esc(role.key)}">保存该角色权限</button></div>` : ''}`
          }
        </div>`
      )
      .join('')}
  </div>`;
}

function logsHtml() {
  const { items, summary } = state.logs;
  return `<div class="card">
    <div class="card-title">登录日志</div>
    <div class="toolbar" style="margin-bottom:10px">
      <select class="select" data-role="log-type" style="width:auto">
        <option value="">全部</option>
        <option value="success">登录成功</option>
        <option value="fail">登录失败</option>
        <option value="logout">退出登录</option>
      </select>
      <input class="input" data-role="log-kw" placeholder="账号 / IP / 原因" style="max-width:200px" />
      <button class="btn btn-sm" data-role="log-search">查询</button>
      <span class="hint" style="margin-left:auto">成功 ${esc(summary.success || 0)} · 失败 ${esc(summary.fail || 0)} · 退出 ${esc(summary.logout || 0)}</span>
    </div>
    ${
      items.length
        ? `<table class="table"><thead><tr><th>时间</th><th>账号</th><th>结果</th><th>原因</th><th>IP</th><th>客户端</th></tr></thead><tbody>
          ${items
            .map(
              (row) => `<tr>
                <td>${esc(formatDateTime(row.at))}</td>
                <td>${esc(row.username || '-')}</td>
                <td><span class="badge ${row.result === 'success' ? 'approved' : row.result === 'fail' ? 'rejected' : 'cancelled'}">${
                row.result === 'success' ? '成功' : row.result === 'fail' ? '失败' : '退出'
              }</span></td>
                <td>${esc(row.reason || '-')}</td>
                <td>${esc(row.ip || '-')}</td>
                <td style="font-size:12px">${esc(String(row.userAgent || '').slice(0, 60))}</td>
              </tr>`
            )
            .join('')}
        </tbody></table>`
        : empty('暂无登录日志')
    }
  </div>`;
}

function auditHtml() {
  return `<div class="card">
    <div class="card-title">操作审计</div>
    <div class="hint" style="margin:-4px 0 12px">记录后台的建号、改权限、停用、删除等操作。</div>
    ${
      state.audit.items.length
        ? `<table class="table"><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>详情</th><th>IP</th></tr></thead><tbody>
          ${state.audit.items
            .map(
              (row) => `<tr>
                <td>${esc(formatDateTime(row.at))}</td>
                <td>${esc(row.actorName || '-')}</td>
                <td>${esc(row.action)}</td>
                <td>${esc(row.target || '-')}</td>
                <td>${esc(row.detail || '-')}</td>
                <td>${esc(row.ip || '-')}</td>
              </tr>`
            )
            .join('')}
        </tbody></table>`
        : empty('暂无后台操作记录')
    }
  </div>`;
}

/* ------------------------------ 数据加载 ------------------------------ */

async function loadUsers(container) {
  const { page, pageSize, keyword, role, status } = state.users;
  const data = await api.get('/api/admin/users', { page, pageSize, keyword, role, status });
  state.users.items = data.items || [];
  state.users.total = data.total || 0;
  renderBody(container);
}

async function loadRoles(container) {
  state.roles = await api.get('/api/admin/roles');
  renderBody(container);
}

async function loadLogs(container, type, keyword) {
  state.logs = await api.get('/api/admin/logs', { limit: 100, type, keyword });
  renderBody(container);
}

async function loadAudit(container) {
  state.audit = await api.get('/api/admin/audit', { limit: 100 });
  renderBody(container);
}

function renderBody(container) {
  const host = container.querySelector('[data-role="admin-body"]');
  if (!host) return;
  if (state.tab === 'overview') host.innerHTML = overviewHtml(state.bootstrap);
  if (state.tab === 'users') host.innerHTML = usersHtml();
  if (state.tab === 'roles') host.innerHTML = rolesHtml();
  if (state.tab === 'logs') host.innerHTML = logsHtml();
  if (state.tab === 'audit') host.innerHTML = auditHtml();
}

/* ------------------------------ 弹窗：新建 / 编辑 ------------------------------ */

function userFormHtml(user, permissionList, roleList) {
  const perms = user ? user.permissions || [] : [];
  return `
    <div class="field"><label>用户名</label>
      <input class="input" data-f="username" value="${esc(user ? user.username : '')}" ${user ? 'disabled' : ''} placeholder="3-20 位字母/数字/下划线" />
    </div>
    <div class="field"><label>姓名</label><input class="input" data-f="name" value="${esc(user ? user.name : '')}" /></div>
    <div class="field"><label>${user ? '重置密码（留空不改）' : '初始密码'}</label>
      <input class="input" type="password" data-f="password" placeholder="${user ? '留空则不修改' : '至少 6 位'}" />
    </div>
    <div class="field"><label>角色</label>
      <select class="select" data-f="role">
        ${(roleList || [])
          .map(
            (r) =>
              `<option value="${esc(r.key)}" ${user && user.role === r.key ? 'selected' : !user && r.key === 'user' ? 'selected' : ''}>${esc(r.label)}</option>`
          )
          .join('')}
      </select>
    </div>
    <div class="field full"><label>单独授予的权限（勾选即生效，超管自动拥有全部）</label>
      <div class="perm-grid">
        ${(permissionList || [])
          .map(
            (p) =>
              `<label class="switch"><input type="checkbox" data-perm="${esc(p.key)}" ${perms.includes(p.key) || perms.includes('*') ? 'checked' : ''} /><span>${esc(p.label)}</span></label>`
          )
          .join('')}
      </div>
    </div>`;
}

function openUserModal(container, user, onDone) {
  const permissionList = (state.bootstrap && state.bootstrap.permissions) || [];
  const roleList = (state.bootstrap && state.bootstrap.roles) || [];
  openModal({
    title: user ? `编辑账号：${user.username}` : '新建账号',
    bodyHtml: userFormHtml(user, permissionList, roleList),
    confirmText: user ? '保存' : '创建',
    onConfirm: async (mask) => {
      const get = (name) => {
        const el = mask.querySelector(`[data-f="${name}"]`);
        return el ? el.value.trim() : '';
      };
      const permissions = Array.from(mask.querySelectorAll('[data-perm]'))
        .filter((box) => box.checked)
        .map((box) => box.value);
      const body = { name: get('name'), role: get('role'), permissions };
      if (!body.name) {
        toast('请填写姓名', 'error');
        return false;
      }
      if (!user) {
        body.username = get('username');
        body.password = get('password');
        if (!body.username || !body.password) {
          toast('请填写用户名和密码', 'error');
          return false;
        }
        await api.post('/api/admin/users', body);
        toast('账号已创建', 'success');
      } else {
        const pwd = get('password');
        if (pwd) body.password = pwd;
        await api.patch(`/api/admin/users/${encodeURIComponent(user.id)}`, body);
        toast('账号已更新', 'success');
      }
      await onDone();
      return true;
    },
  });
}

/* ------------------------------ 主视图 ------------------------------ */

export async function adminConsole({ container }) {
  container.innerHTML = `<div class="card">${loading('加载后台管理…')}</div>`;

  let boot;
  try {
    boot = await api.get('/api/admin/bootstrap');
  } catch (err) {
    container.innerHTML = `<div class="card"><div class="card-title">后台管理</div><div class="hint">${esc(err.message)}</div></div>`;
    return;
  }
  state.bootstrap = boot;
  state.me = boot.me;
  state.users.pageSize = 10;

  container.innerHTML = `
    <div class="card" style="max-width:1100px">
      <div class="card-title">后台管理</div>
      <div class="hint" style="margin:-4px 0 12px">
        当前身份：${esc(boot.me.name)}（${esc(boot.me.username)}） · ${
    boot.me.isSuperAdmin ? '<span class="badge approved">超级管理员 · 全部权限</span>' : esc((boot.me.permissions || []).join(', ') || '无额外权限')
  }
      </div>
      <div class="segmented" data-role="admin-tabs">
        ${TABS.map((t) => `<button data-tab="${t.key}" class="${t.key === state.tab ? 'active' : ''}">${esc(t.label)}</button>`).join('')}
      </div>
      <div data-role="admin-body" style="margin-top:14px">${loading('加载中…')}</div>
    </div>`;

  const tabs = container.querySelector('[data-role="admin-tabs"]');
  tabs.querySelectorAll('button[data-tab]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      state.tab = btn.dataset.tab;
      tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
      const body = container.querySelector('[data-role="admin-body"]');
      body.innerHTML = loading('加载中…');
      try {
        if (state.tab === 'users') await loadUsers(container);
        else if (state.tab === 'roles') await loadRoles(container);
        else if (state.tab === 'logs') await loadLogs(container, '', '');
        else if (state.tab === 'audit') await loadAudit(container);
        else renderBody(container);
      } catch (err) {
        body.innerHTML = `<div class="hint">加载失败：${esc(err.message)}</div>`;
      }
    });
  });

  // 事件委托：账号表格操作、角色保存、日志查询
  container.addEventListener('click', async (event) => {
    const btn = event.target.closest('button');
    if (!btn) return;
    try {
      if (btn.dataset.page) {
        const target = Number(btn.dataset.page);
        const totalPages = Math.max(1, Math.ceil(state.users.total / state.users.pageSize));
        if (target < 1 || target > totalPages || target === state.users.page) return;
        state.users.page = target;
        await loadUsers(container);
        return;
      }
      if (btn.dataset.role === 'search' || btn.hasAttribute('data-role') === false) {
        // noop，避免误判
      }
      if (btn.dataset.create !== undefined) {
        await openUserModal(container, null, () => loadUsers(container));
        return;
      }
      if (btn.dataset.edit) {
        const user = state.users.items.find((u) => u.id === btn.dataset.edit);
        if (user) await openUserModal(container, user, () => loadUsers(container));
        return;
      }
      if (btn.dataset.reset) {
        const user = state.users.items.find((u) => u.id === btn.dataset.reset);
        if (!user) return;
        openModal({
          title: `重置密码：${user.username}`,
          bodyHtml: `<div class="field"><label>新密码</label><input class="input" type="password" data-f="password" placeholder="至少 6 位" /></div>`,
          confirmText: '重置',
          onConfirm: async (mask) => {
            const pwd = mask.querySelector('[data-f="password"]').value.trim();
            if (pwd.length < 6) {
              toast('密码至少 6 位', 'error');
              return false;
            }
            await api.patch(`/api/admin/users/${encodeURIComponent(user.id)}`, { password: pwd });
            toast('密码已重置', 'success');
            await loadAudit(container);
            return true;
          },
        });
        return;
      }
      if (btn.dataset.toggle) {
        const user = state.users.items.find((u) => u.id === btn.dataset.toggle);
        if (!user) return;
        await api.patch(`/api/admin/users/${encodeURIComponent(user.id)}`, { disabled: !user.disabled });
        toast(user.disabled ? '账号已启用' : '账号已停用', 'success');
        await loadUsers(container);
        return;
      }
      if (btn.dataset.del) {
        const user = state.users.items.find((u) => u.id === btn.dataset.del);
        if (!user) return;
        openModal({
          title: `删除账号：${user.username}`,
          bodyHtml: `<div class="hint">删除后该账号无法登录，其历史申请会保留并标注「账号已删除」。确认继续？</div>`,
          confirmText: '确认删除',
          danger: true,
          onConfirm: async () => {
            await api.del(`/api/admin/users/${encodeURIComponent(user.id)}`);
            toast('账号已删除', 'success');
            await loadUsers(container);
            return true;
          },
        });
        return;
      }
      if (btn.dataset.saveRole) {
        const key = btn.dataset.saveRole;
        const perms = Array.from(container.querySelectorAll(`[data-role-perm="${key}"]`))
          .filter((box) => box.checked)
          .map((box) => box.value);
        await api.put(`/api/admin/roles/${encodeURIComponent(key)}`, { permissions: perms });
        toast('角色权限已保存', 'success');
        await loadRoles(container);
        return;
      }
      if (btn.dataset.role === 'log-search') {
        const type = container.querySelector('[data-role="log-type"]').value;
        const kw = container.querySelector('[data-role="log-kw"]').value.trim();
        await loadLogs(container, type, kw);
      }
    } catch (err) {
      toast(err.message || '操作失败', 'error');
    }
  });

  // 账号筛选
  container.addEventListener('change', async (event) => {
    const el = event.target;
    if (el.dataset.role === 'role') state.users.role = el.value;
    if (el.dataset.role === 'status') state.users.status = el.value;
  });

  await loadUsers(container);
  state.tab = 'overview';
  renderBody(container);
}
