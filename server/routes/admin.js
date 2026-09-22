/**
 * 后台管理路由 /api/admin
 *
 * 接口：GET bootstrap（一次性取账号/角色/权限字典）、users CRUD、GET roles、
 *       PUT roles/:key（调整角色默认权限）、GET logs（登录日志）、GET audit（操作审计）。
 * 要点：每个接口都用 requireAdmin('权限key') 守卫；涉及账号变更的操作同时写 adminLogs；
 * 超级管理员（SUPER_ADMINS）不可被删除或降权，避免把系统锁死。
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth, requireAdmin, hasPermission, isSuperAdmin } = require('../middleware');

const router = express.Router();
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

function fail(res, status, message) {
  return res.status(status).json({ error: message });
}

function clean(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

// 后台操作审计
function addAdminLog(state, { req, action, target = '', detail = '' }) {
  const actor = (req && req.session && req.session.user) || {};
  state.adminLogs.push({
    id: db.uid(),
    actorId: actor.id || '',
    actorName: actor.name || actor.username || '系统',
    action,
    target,
    detail,
    ip: req ? String(req.ip || '').slice(0, 60) : '',
    at: new Date().toISOString(),
  });
  if (state.adminLogs.length > 2000) state.adminLogs = state.adminLogs.slice(-2000);
}

function shapeUser(user, state) {
  const owned = state.applications.filter((item) => item.userId === user.id);
  const pending = owned.filter((item) => ['pending', 'resubmitted'].includes(item.status)).length;
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    roleLabel: (db.ROLES[user.role] && db.ROLES[user.role].label) || user.role,
    permissions: Array.isArray(user.permissions) ? user.permissions : [],
    isSuperAdmin: isSuperAdmin(user),
    disabled: user.disabled === true,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt || '',
    stats: { applications: owned.length, pending },
  };
}

/* ------------------------------ 后台初始化信息 ------------------------------ */

router.get('/bootstrap', requireAuth, (req, res) => {
  const me = req.session.user;
  if (!isSuperAdmin(me) && !hasPermission(me, 'account:view')) {
    return fail(res, 403, '无后台管理权限');
  }
  const state = db.load();
  const list = state.users.map((u) => shapeUser(u, state));
  return res.json({
    me: {
      id: me.id,
      username: me.username,
      name: me.name,
      role: me.role,
      isSuperAdmin: isSuperAdmin(me),
      permissions: me.permissions || [],
    },
    roles: Object.values(db.ROLES),
    permissions: db.PERMISSIONS,
    rolePerms: state.rolePerms,
    overview: {
      users: state.users.length,
      admins: state.users.filter((u) => isSuperAdmin(u)).length,
      disabled: state.users.filter((u) => u.disabled).length,
      applications: state.applications.length,
      pending: state.applications.filter((i) => ['pending', 'resubmitted'].includes(i.status)).length,
      approved: state.applications.filter((i) => i.status === 'approved').length,
      rejected: state.applications.filter((i) => i.status === 'rejected').length,
      logins: state.logins.length,
      loginFail: state.logins.filter((l) => l.result === 'fail').length,
    },
    recentUsers: list.slice(0, 5),
  });
});

/* ------------------------------ 账号管理 ------------------------------ */

router.get('/users', requireAdmin('account:view'), (req, res) => {
  const { keyword = '', role = '', status = '' } = req.query;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 10));
  const state = db.load();
  const kw = String(keyword).trim().toLowerCase();

  let list = state.users.slice();
  if (role && db.ROLES[role]) list = list.filter((u) => u.role === role);
  if (status === 'disabled') list = list.filter((u) => u.disabled);
  if (status === 'active') list = list.filter((u) => !u.disabled);
  if (kw) {
    list = list.filter((u) =>
      [u.username, u.name, u.role].join(' ').toLowerCase().includes(kw)
    );
  }
  list.sort((a, b) => {
    if (isSuperAdmin(a) !== isSuperAdmin(b)) return isSuperAdmin(a) ? -1 : 1;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  const total = list.length;
  const items = list.slice((page - 1) * pageSize, page * pageSize).map((u) => shapeUser(u, state));
  return res.json({ items, total, page, pageSize });
});

router.post('/users', requireAdmin('account:create'), (req, res) => {
  const { username, password, name, role = 'user', permissions } = req.body || {};
  const uname = clean(username, 20);
  const displayName = clean(name, 20);
  const pwd = String(password || '');

  if (!USERNAME_RE.test(uname)) return fail(res, 400, '用户名需为 3-20 位字母、数字或下划线');
  if (pwd.length < 6 || pwd.length > 64) return fail(res, 400, '密码长度需为 6-64 位');
  if (!displayName) return fail(res, 400, '请输入姓名');
  if (!db.ROLES[role]) return fail(res, 400, '角色不合法');
  if (role === 'admin' && !isSuperAdmin(req.session.user)) {
    return fail(res, 403, '仅超级管理员可创建管理员账号');
  }

  const state = db.load();
  if (state.users.some((u) => u.username.toLowerCase() === uname.toLowerCase())) {
    return fail(res, 409, '该用户名已被注册');
  }

  const perms = Array.isArray(permissions)
    ? permissions.filter((p) => p === '*' || db.PERMISSION_KEYS.includes(p))
    : (state.rolePerms[role] || []).slice();
  if (role === 'admin') {
    perms.length = 0;
    perms.push('*');
  }

  const user = {
    id: db.uid(),
    username: uname,
    password: bcrypt.hashSync(pwd, 10),
    name: displayName,
    role,
    permissions: perms,
    isSuperAdmin: role === 'admin',
    disabled: false,
    createdAt: new Date().toISOString(),
    lastLoginAt: '',
    notify: db.defaultNotify(),
  };
  state.users.push(user);
  addAdminLog(state, { req, action: 'create-user', target: uname, detail: `角色=${role}` });
  db.save();
  return res.status(201).json({ user: shapeUser(user, state) });
});

router.patch('/users/:id', requireAdmin('account:edit'), (req, res) => {
  const state = db.load();
  const user = state.users.find((u) => u.id === req.params.id);
  if (!user) return fail(res, 404, '用户不存在');
  const me = req.session.user;

  // 保护：超级管理员账号只能由自己调整，不能被他人降权/停用/删除
  if (isSuperAdmin(user) && user.id !== me.id) {
    return fail(res, 403, '不能修改其他超级管理员账号');
  }

  const body = req.body || {};
  const detail = [];

  if (body.name !== undefined) {
    const displayName = clean(body.name, 20);
    if (!displayName) return fail(res, 400, '姓名不能为空');
    user.name = displayName;
    detail.push(`姓名=${displayName}`);
  }
  if (body.role !== undefined) {
    if (!db.ROLES[body.role]) return fail(res, 400, '角色不合法');
    if (body.role === 'admin' && !isSuperAdmin(me)) return fail(res, 403, '仅超级管理员可设置管理员角色');
    if (user.id === me.id && body.role !== 'admin') {
      return fail(res, 400, '不能取消自己的超级管理员身份（避免把自己锁在后台外）');
    }
    user.role = body.role;
    detail.push(`角色=${body.role}`);
  }
  if (body.permissions !== undefined) {
    if (!Array.isArray(body.permissions)) return fail(res, 400, '权限需为数组');
    const perms = body.permissions.filter((p) => p === '*' || db.PERMISSION_KEYS.includes(p));
    if (user.id === me.id && !perms.includes('*') && user.role === 'admin') {
      return fail(res, 400, '超级管理员权限不可收回');
    }
    user.permissions = perms;
    detail.push(`权限=[${perms.join(', ') || '无'}]`);
  }
  if (body.disabled !== undefined) {
    if (body.disabled === true && user.id === me.id) {
      return fail(res, 400, '不能停用自己的账号');
    }
    user.disabled = body.disabled === true;
    detail.push(user.disabled ? '停用' : '启用');
  }
  if (body.password !== undefined && String(body.password).length) {
    const pwd = String(body.password);
    if (pwd.length < 6 || pwd.length > 64) return fail(res, 400, '密码长度需为 6-64 位');
    user.password = bcrypt.hashSync(pwd, 10);
    detail.push('重置密码');
  }

  db.normalizeUser(user);
  addAdminLog(state, { req, action: 'edit-user', target: user.username, detail: detail.join('；') });
  db.save();
  return res.json({ user: shapeUser(user, state) });
});

router.delete('/users/:id', requireAdmin('account:delete'), (req, res) => {
  const state = db.load();
  const user = state.users.find((u) => u.id === req.params.id);
  if (!user) return fail(res, 404, '用户不存在');
  if (user.id === req.session.user.id) return fail(res, 400, '不能删除自己的账号');
  if (isSuperAdmin(user)) return fail(res, 403, '不能删除超级管理员账号');

  const owned = state.applications.filter((item) => item.userId === user.id).length;
  state.users = state.users.filter((u) => u.id !== user.id);
  // 保留其申请数据，仅标记为已删除账号提交（避免历史记录丢失）
  state.applications.forEach((item) => {
    if (item.userId === user.id) item.userName = `${item.userName}（账号已删除）`;
  });
  addAdminLog(state, { req, action: 'delete-user', target: user.username, detail: `关联申请 ${owned} 条` });
  db.save();
  return res.json({ ok: true, removedApplications: owned });
});

/* ------------------------------ 角色与权限 ------------------------------ */

router.get('/roles', requireAdmin('account:view'), (req, res) => {
  const state = db.load();
  return res.json({
    roles: Object.values(db.ROLES).map((role) => ({
      ...role,
      defaultPermissions: (state.rolePerms[role.key] || []).slice(),
      users: state.users.filter((u) => u.role === role.key).length,
    })),
    permissions: db.PERMISSIONS,
  });
});

router.put('/roles/:key', requireAdmin('role:manage'), (req, res) => {
  const key = String(req.params.key || '');
  if (!db.ROLES[key]) return fail(res, 400, '角色不存在');
  if (key === 'admin') return fail(res, 400, '超级管理员角色固定拥有全部权限，不可修改');
  const perms = Array.isArray(req.body && req.body.permissions)
    ? req.body.permissions.filter((p) => db.PERMISSION_KEYS.includes(p))
    : [];
  const state = db.load();
  state.rolePerms[key] = perms;
  addAdminLog(state, { req, action: 'update-role', target: key, detail: `默认权限=[${perms.join(', ') || '无'}]` });
  db.save();
  return res.json({ rolePerms: state.rolePerms });
});

/* ------------------------------ 登录日志 / 操作审计 ------------------------------ */

router.get('/logs', requireAdmin('log:view'), (req, res) => {
  const { type = '', keyword = '' } = req.query;
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const state = db.load();
  const kw = String(keyword).trim().toLowerCase();
  let list = state.logins.slice().sort((a, b) => new Date(b.at) - new Date(a.at));
  if (type) list = list.filter((row) => row.result === type);
  if (kw) {
    list = list.filter((row) => [row.username, row.reason, row.ip].join(' ').toLowerCase().includes(kw));
  }
  const items = list.slice(0, limit);
  return res.json({
    items,
    total: list.length,
    summary: {
      success: state.logins.filter((r) => r.result === 'success').length,
      fail: state.logins.filter((r) => r.result === 'fail').length,
      logout: state.logins.filter((r) => r.result === 'logout').length,
    },
  });
});

router.get('/audit', requireAdmin('audit:view'), (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const state = db.load();
  const list = state.adminLogs.slice().sort((a, b) => new Date(b.at) - new Date(a.at));
  return res.json({ items: list.slice(0, limit), total: list.length });
});

module.exports = router;
