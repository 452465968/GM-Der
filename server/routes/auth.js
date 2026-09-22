/**
 * 认证路由 /api/auth
 *
 * 接口：POST register / login / logout，GET me，PATCH profile。
 * 要点：
 *   · 注册入口只产出「审批人」身份（忽略请求体中的 role，防止前端被绕过）；
 *   · 用户名 3-20 位字母数字下划线，密码 6-64 位，bcrypt 加盐哈希存储；
 *   · 登录失败/停用/登出都会写入 state.logins（后台「登录日志」数据源，仅保留 2000 条）；
 *   · 登录后把 publicUser(user) 写入 session，后续接口以 session 判定身份。
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');

const router = express.Router();
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

function fail(res, status, message) {
  return res.status(status).json({ error: message });
}

// 登录日志：成功 / 失败 / 退出，供后台「登录日志」模块查看
function addLoginLog(state, { userId = '', username = '', result, reason = '', req }) {
  state.logins.push({
    id: db.uid(),
    userId,
    username,
    result, // success | fail | logout
    reason,
    ip: req ? String(req.ip || '').slice(0, 60) : '',
    userAgent: req ? String(req.headers['user-agent'] || '').slice(0, 200) : '',
    at: new Date().toISOString(),
  });
  // 只保留最近 2000 条
  if (state.logins.length > 2000) state.logins = state.logins.slice(-2000);
}

// 系统只开放审批人注册入口：所有新注册账号统一为「审批人」身份
// （请求体里的 role 一律忽略，避免绕过前端注册出申请人账号）
router.post('/register', (req, res) => {
  const { username, password, name } = req.body || {};
  const uname = String(username || '').trim();
  const displayName = String(name || '').trim();
  const pwd = String(password || '');
  const userRole = 'approver';

  if (!USERNAME_RE.test(uname)) return fail(res, 400, '用户名需为 3-20 位字母、数字或下划线');
  if (pwd.length < 6 || pwd.length > 64) return fail(res, 400, '密码长度需为 6-64 位');
  if (!displayName || displayName.length > 20) return fail(res, 400, '请输入 1-20 个字符的姓名');

  const state = db.load();
  if (state.users.some((u) => u.username.toLowerCase() === uname.toLowerCase())) {
    return fail(res, 409, '该用户名已被注册');
  }

  const user = {
    id: db.uid(),
    username: uname,
    password: bcrypt.hashSync(pwd, 10),
    name: displayName,
    role: userRole,
    createdAt: new Date().toISOString(),
    notify: db.defaultNotify(),
  };
  state.users.push(user);
  db.save();

  req.session.user = db.publicUser(user);
  return res.status(201).json({ user: db.publicUser(user) });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const uname = String(username || '').trim();
  const pwd = String(password || '');
  if (!uname || !pwd) return fail(res, 400, '请输入用户名和密码');

  const state = db.load();
  const user = state.users.find((u) => u.username.toLowerCase() === uname.toLowerCase());
  if (!user || !bcrypt.compareSync(pwd, user.password)) {
    addLoginLog(state, { username: uname, result: 'fail', reason: '用户名或密码错误', req });
    db.save();
    return fail(res, 401, '用户名或密码错误');
  }
  if (user.disabled) {
    addLoginLog(state, { userId: user.id, username: user.username, result: 'fail', reason: '账号已被停用', req });
    db.save();
    return fail(res, 403, '账号已被停用，请联系管理员');
  }
  user.lastLoginAt = new Date().toISOString();
  addLoginLog(state, { userId: user.id, username: user.username, result: 'success', req });
  db.save();
  req.session.user = db.publicUser(user);
  return res.json({ user: db.publicUser(user) });
});

router.post('/logout', (req, res) => {
  if (!req.session || !req.session.user) return res.json({ ok: true });
  const state = db.load();
  addLoginLog(state, {
    userId: req.session.user.id,
    username: req.session.user.username,
    result: 'logout',
    req,
  });
  db.save();
  return req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  return res.json({ user: (req.session && req.session.user) || null });
});

router.patch('/profile', (req, res) => {
  if (!req.session || !req.session.user) return fail(res, 401, '请先登录');
  const displayName = String((req.body && req.body.name) || '').trim();
  if (!displayName || displayName.length > 20) return fail(res, 400, '请输入 1-20 个字符的姓名');
  const state = db.load();
  const user = state.users.find((u) => u.id === req.session.user.id);
  if (!user) return fail(res, 404, '用户不存在');
  user.name = displayName;
  db.save();
  req.session.user = db.publicUser(user);
  return res.json({ user: db.publicUser(user) });
});

module.exports = router;
