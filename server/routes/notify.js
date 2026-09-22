/**
 * 通知路由 /api/notify
 *
 * 接口：GET/PUT settings（个人通知设置）、POST test（给自己发测试推送）、GET logs（投递日志）、
 *       GET/PUT config（全局渠道开关与重试策略）、push/public-key、push/status、
 *       push/subscribe、push/unsubscribe，以及 debug/* 一组排障接口（模拟、订阅列表、广播、重投失败）。
 * 说明：本文件只负责参数校验与读写设置，真正的文案拼装与投递在 server/notify/* 中完成。
 */
const express = require('express');
const db = require('../db');
const { requireAuth, isSuperAdmin, hasPermission } = require('../middleware');

// 后台/调试能力：超级管理员、审批人、或被授予后台查看权限的账号
function canManage(user) {
  return Boolean(user) && (user.role === 'approver' || isSuperAdmin(user) || hasPermission(user, 'account:view'));
}
const config = require('../notify/config');
const notify = require('../notify');
const store = require('../notify/store');
const queue = require('../notify/queue');
const push = require('../notify/push');

const router = express.Router();

function fail(res, status, message) {
  return res.status(status).json({ error: message });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const QQ_RE = /^(g:)?\d{4,20}$/;

function clean(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

/* ------------------------------ 个人通知设置 ------------------------------ */

router.get('/settings', requireAuth, (req, res) => {
  const state = db.load();
  const user = state.users.find((u) => u.id === req.session.user.id);
  if (!user) return fail(res, 404, '用户不存在');
  return res.json({
    channels: config.channelStatus(),
    settings: notify.settingsOf(user),
  });
});

router.put('/settings', requireAuth, (req, res) => {
  const body = req.body || {};
  const patch = {};

  if (body.email !== undefined) {
    const email = clean(body.email, 120);
    if (email && !EMAIL_RE.test(email)) return fail(res, 400, '邮箱格式不正确');
    patch.email = email;
  }
  if (body.qq !== undefined) {
    const qq = clean(body.qq, 32);
    if (qq && !QQ_RE.test(qq)) return fail(res, 400, 'QQ 号需为数字，群消息请使用 g:群号');
    patch.qq = qq;
  }
  if (body.wechat !== undefined) {
    patch.wechat = clean(body.wechat, 120);
  }
  if (body.channels && typeof body.channels === 'object') {
    patch.channels = {
      email: body.channels.email !== false,
      qq: body.channels.qq !== false,
      wechat: body.channels.wechat !== false,
    };
  }

  const next = notify.updateSettings(req.session.user.id, patch);
  if (!next) return fail(res, 404, '用户不存在');
  return res.json({ settings: next, channels: config.channelStatus() });
});

/* ------------------------------ 测试推送 ------------------------------ */

router.post('/test', requireAuth, (req, res) => {
  const state = db.load();
  const user = state.users.find((u) => u.id === req.session.user.id);
  if (!user) return fail(res, 404, '用户不存在');
  const queued = notify.sendTest(user);
  return res.json({ queued });
});

/* ------------------------------ 发送日志 ------------------------------ */

router.get('/logs', requireAuth, (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const wantAll = String(req.query.all || '') === '1';
  const isApprover = canManage(req.session.user);
  const items = store.listLogs({
    userId: req.session.user.id,
    limit,
    all: wantAll && isApprover,
  });
  return res.json({ items, canViewAll: isApprover });
});

/* ------------------------------ 服务端渠道开关（仅审批人） ------------------------------ */

router.get('/config', requireAuth, (req, res) => {
  if (!canManage(req.session.user)) return fail(res, 403, '仅审批人可查看全局通知配置');
  return res.json({ config: config.getConfig(), channels: config.channelStatus() });
});

router.put('/config', requireAuth, (req, res) => {
  if (!canManage(req.session.user)) return fail(res, 403, '仅审批人可修改全局通知配置');
  const body = req.body || {};
  const cfg = config.getConfig();
  const next = { channels: Object.assign({}, cfg.channels) };

  if (body.channels && typeof body.channels === 'object') {
    Object.keys(next.channels).forEach((key) => {
      if (body.channels[key] && typeof body.channels[key].enabled === 'boolean') {
        next.channels[key] = { enabled: body.channels[key].enabled };
      }
    });
  }
  if (body.maxAttempts !== undefined) {
    const max = parseInt(body.maxAttempts, 10);
    if (!Number.isInteger(max) || max < 1 || max > 5) return fail(res, 400, '重试次数需为 1-5');
    next.maxAttempts = max;
  }
  if (Array.isArray(body.retryDelaysSec)) {
    const delays = body.retryDelaysSec.map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n) && n >= 0);
    if (delays.length) next.retryDelaysSec = delays.slice(0, 5);
  }
  if (body.baseUrl !== undefined) next.baseUrl = clean(body.baseUrl, 200);

  const saved = config.saveConfig(next);
  return res.json({ config: saved, channels: config.channelStatus() });
});

/* ------------------------------ 系统推送（Web Push）订阅 ------------------------------ */

// 前端订阅时需要 VAPID 公钥（仅 HTTPS 场景可用）
router.get('/push/public-key', requireAuth, (req, res) => {
  return res.json({ publicKey: push.publicKey(), vapidReady: push.vapidReady() });
});

router.get('/push/status', requireAuth, (req, res) => {
  return res.json({ subscribed: push.count(req.session.user.id), vapidReady: push.vapidReady() });
});

router.post('/push/subscribe', requireAuth, (req, res) => {
  try {
    const count = push.add(req.session.user.id, req.body || {});
    return res.json({ subscribed: count });
  } catch (err) {
    return fail(res, 400, err.message || '订阅失败');
  }
});

router.post('/push/unsubscribe', requireAuth, (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  const count = push.remove(req.session.user.id, endpoint);
  return res.json({ subscribed: count });
});

/* ------------------------------ 调试面板（仅审批人） ------------------------------ */

// 服务端凭据状态（敏感值打码）、队列状态、全局配置
router.get('/debug', requireAuth, (req, res) => {
  if (!canManage(req.session.user)) return fail(res, 403, '仅审批人可使用调试面板');
  return res.json({
    config: config.getConfig(),
    debug: config.debugInfo(),
    queue: queue.stats(),
  });
});

// 模拟触发：按事件类型给自己发一条通知，验证渠道与内容格式
router.post('/debug/simulate', requireAuth, (req, res) => {
  if (!canManage(req.session.user)) return fail(res, 403, '仅审批人可使用调试面板');
  const state = db.load();
  const user = state.users.find((u) => u.id === req.session.user.id);
  if (!user) return fail(res, 404, '用户不存在');
  const event = String((req.body && req.body.event) || 'test');
  if (!notify.EVENT_LABEL[event]) return fail(res, 400, '不支持的事件类型');
  const queued = notify.sendSimulation(user, event);
  return res.json({ queued });
});

// 订阅明细：判断有没有 iOS 设备真正注册成功（端点脱敏 + 平台识别 + 来源域名）
router.get('/debug/subscriptions', requireAuth, (req, res) => {
  if (!canManage(req.session.user)) return fail(res, 403, '仅审批人可使用调试面板');
  return res.json({ items: push.listDetailed(), total: push.totalCount(), currentOrigin: config.baseUrl() });
});

// 清理「非当前域名来源」的失效订阅（如仍指向旧 http://IP 的记录）
router.post('/debug/clean-stale', requireAuth, (req, res) => {
  if (!canManage(req.session.user)) return fail(res, 403, '仅审批人可使用调试面板');
  const origin = (req.body && req.body.origin) || config.baseUrl() || '';
  const removed = push.removeStale(origin);
  return res.json({ removed, remaining: push.totalCount() });
});

// 广播：向所有已订阅设备推送，用于验证后台 / 未打开 App 时能否收到系统通知
router.post('/debug/broadcast', requireAuth, (req, res) => {
  if (!canManage(req.session.user)) return fail(res, 403, '仅审批人可使用调试面板');
  const title = String((req.body && req.body.title) || '').trim().slice(0, 100) || '【买个Der】广播测试';
  const body = String((req.body && req.body.body) || '').trim().slice(0, 500) || '这是一条广播测试推送，用于验证后台/未打开时能否收到系统通知。';
  const url = String((req.body && req.body.url) || '').trim().slice(0, 300);
  const queued = notify.broadcast({ title, body, url });
  return res.json({ queued, devices: push.totalCount() });
});

// 把最近失败的推送重新入队（重置重试次数）
router.post('/debug/retry-failed', requireAuth, (req, res) => {
  if (!canManage(req.session.user)) return fail(res, 403, '仅审批人可使用调试面板');
  const requeued = queue.requeueFailed(20);
  return res.json({ requeued });
});

module.exports = router;
