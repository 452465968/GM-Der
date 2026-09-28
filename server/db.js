/**
 * 数据层（JSON 文件数据库）
 *
 * 职责：全系统唯一的数据读写入口，数据在内存中以 state 形式缓存，落盘到 data/db.json。
 *   · load()  首次调用时读盘并归一化；字段缺失的旧数据会就地迁移后回写；
 *   · save()  先写 .tmp 再 rename，保证原子性（进程被杀也不会写出半截 JSON）；
 *   · seed()  空库时写入演示账号（admin/123456 审批人、user/123456 申请人），
 *             并确保 SUPER_ADMINS 环境变量里的账号始终处于最高权限；
 *   · ROLES / PERMISSIONS / DEFAULT_ROLE_PERMS 定义角色与细粒度权限模型；
 *   · publicUser() 负责裁剪敏感字段（密码哈希永远不出库到前端）。
 * 集合说明：users 账号、applications 申请单、approvals 审批流水、logins 登录日志、
 * adminLogs 后台操作审计、rolePerms 各角色默认权限。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

let state = null;

// 通知设置默认值：三种渠道默认开启，但未填写接收地址时不投递
function defaultNotify() {
  return {
    email: '',
    qq: '',
    wechat: '',
    channels: { webpush: true, email: true, qq: true, wechat: true },
  };
}

function normalizeNotify(input) {
  const raw = input || {};
  const channels = Object.assign(
    { webpush: true, email: true, qq: true, wechat: true },
    raw.channels || {}
  );
  return {
    email: String(raw.email || '').trim(),
    qq: String(raw.qq || '').trim(),
    wechat: String(raw.wechat || '').trim(),
    channels: {
      webpush: channels.webpush !== false,
      email: channels.email !== false,
      qq: channels.qq !== false,
      wechat: channels.wechat !== false,
    },
  };
}

/* ------------------------------ 角色与权限模型 ------------------------------ */

// 基础角色（身份）：申请人 / 审批人 / 超级管理员
const ROLES = {
  user: { key: 'user', label: '申请人', desc: '提交购买申请、查看自己的申请与结果' },
  approver: { key: 'approver', label: '审批人', desc: '可被指派为投票人，审批/投票、查看全部申请' },
  admin: { key: 'admin', label: '超级管理员', desc: '拥有全部管理功能与数据访问权' },
};

// 细粒度权限目录（可在账号上单独授予/收回）
const PERMISSIONS = [
  { key: 'account:view', group: '账号管理', label: '查看账号列表' },
  { key: 'account:create', group: '账号管理', label: '创建账号' },
  { key: 'account:edit', group: '账号管理', label: '编辑账号' },
  { key: 'account:delete', group: '账号管理', label: '删除账号' },
  { key: 'role:manage', group: '角色权限', label: '角色与权限分配' },
  { key: 'log:view', group: '日志审计', label: '查看登录日志' },
  { key: 'audit:view', group: '日志审计', label: '查看操作审计' },
  { key: 'data:all', group: '数据权限', label: '查看全部申请与记录' },
];

const PERMISSION_KEYS = PERMISSIONS.map((item) => item.key);

// 各角色的默认权限（可由超级管理员在后台调整）
const DEFAULT_ROLE_PERMS = {
  user: [],
  approver: ['data:all'],
  admin: ['*'], // 通配：全部权限
};

// 返回 true 表示本次做了初始化迁移（调用方据此决定是否落盘）
function normalizeUser(user) {
  if (!user) return false;
  let initialized = false;
  if (!ROLES[user.role]) user.role = 'user';
  const perms = Array.isArray(user.permissions) ? user.permissions : [];
  // 首次迁移：沿用该角色的默认权限（之后以账号上的显式设置为准）
  if (user.permsInitialized !== true) {
    user.permissions = (DEFAULT_ROLE_PERMS[user.role] || []).slice();
    user.permsInitialized = true;
    initialized = true;
  } else {
    user.permissions = perms.filter((p) => p === '*' || PERMISSION_KEYS.includes(p));
  }
  if (user.role === 'admin' && !user.permissions.includes('*')) user.permissions = ['*'];
  user.isSuperAdmin = user.role === 'admin' || user.permissions.includes('*');
  user.disabled = user.disabled === true;
  if (!user.lastLoginAt) user.lastLoginAt = '';
  user.notify = normalizeNotify(user.notify);
  return initialized;
}

// 超级管理员：来自环境变量 SUPER_ADMINS（逗号分隔，默认 452465968）
// 每次启动都会确保这些账号处于最高权限，避免手工改数据出错
function promoteSuperAdmins() {
  const list = String(process.env.SUPER_ADMINS || '452465968')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (!list.length) return [];
  const state = load();
  const promoted = [];
  list.forEach((name) => {
    const user = state.users.find((u) => String(u.username).toLowerCase() === name.toLowerCase());
    if (!user) return;
    const changed = user.role !== 'admin' || !user.permissions.includes('*');
    user.role = 'admin';
    user.permissions = ['*'];
    user.isSuperAdmin = true;
    if (changed) promoted.push(user.username);
  });
  if (promoted.length) {
    save();
    console.log(`[admin] 已提升为超级管理员：${promoted.join('、')}`);
  }
  return promoted;
}

function load() {
  if (state) return state;
  ensureDirs();
  let parsed = null;
  if (fs.existsSync(DB_FILE)) {
    try {
      parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (err) {
      console.error('[db] 数据文件解析失败，已使用空数据启动：', err.message);
    }
  }
  state = {
    users: Array.isArray(parsed && parsed.users) ? parsed.users : [],
    applications: Array.isArray(parsed && parsed.applications) ? parsed.applications : [],
    approvals: Array.isArray(parsed && parsed.approvals) ? parsed.approvals : [],
    // 登录日志（登录成功/失败/退出）
    logins: Array.isArray(parsed && parsed.logins) ? parsed.logins : [],
    // 后台操作审计
    adminLogs: Array.isArray(parsed && parsed.adminLogs) ? parsed.adminLogs : [],
    // 角色默认权限（可被超级管理员覆盖）
    rolePerms:
      parsed && parsed.rolePerms && typeof parsed.rolePerms === 'object'
        ? parsed.rolePerms
        : JSON.parse(JSON.stringify(DEFAULT_ROLE_PERMS)),
  };
  // 旧账号迁移：补齐角色/权限/通知等字段（有迁移则立即落盘）
  let migrated = false;
  state.users.forEach((user) => {
    if (normalizeUser(user)) migrated = true;
  });
  if (migrated) save();
  return state;
}

function save() {
  ensureDirs();
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

function uid() {
  return crypto.randomUUID();
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt,
    notify: normalizeNotify(user.notify),
    permissions: Array.isArray(user.permissions) ? user.permissions : [],
    isSuperAdmin: user.isSuperAdmin === true,
    disabled: user.disabled === true,
    lastLoginAt: user.lastLoginAt || '',
  };
}

function seed() {
  load();
  if (state.users.length === 0) {
    const demo = [
      { username: 'admin', password: '123456', name: '王审批', role: 'approver' },
      { username: 'user', password: '123456', name: '李申请', role: 'user' },
    ];
    demo.forEach((item) => {
      state.users.push({
        id: uid(),
        username: item.username,
        password: bcrypt.hashSync(item.password, 10),
        name: item.name,
        role: item.role,
        createdAt: new Date().toISOString(),
        notify: defaultNotify(),
      });
    });
    save();
    console.log('[db] 已初始化演示账号：admin/123456（审批人）、user/123456（申请人）');
  }
  // 确保超级管理员账号始终处于最高权限
  promoteSuperAdmins();
}

module.exports = {
  load,
  save,
  uid,
  publicUser,
  seed,
  defaultNotify,
  normalizeNotify,
  normalizeUser,
  promoteSuperAdmins,
  ROLES,
  PERMISSIONS,
  PERMISSION_KEYS,
  DEFAULT_ROLE_PERMS,
  UPLOAD_DIR,
  DATA_DIR,
  ROOT,
};
