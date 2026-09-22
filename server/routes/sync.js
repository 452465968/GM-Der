/**
 * 增量同步路由 /api/sync
 *
 * 接口：GET /api/sync?since=<ISO时间>、GET /api/sync/ping。
 * 用途：手机/平板/网页多端保持一致。客户端带上上次同步时间，服务端只返回
 * 「该用户可见 && updatedAt > since」的申请单，单页最多 200 条，超量用 hasMore 提示继续翻页。
 * 可见性判定复用 applications.canView()，保证与列表接口口径一致。
 */
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware');
const applications = require('./applications');

const router = express.Router();
const LIMIT = 200;

function fail(res, status, message) {
  return res.status(status).json({ error: message });
}

// 增量同步接口：客户端（Android / 平板 / 网页）带上 lastSyncAt，
// 只拉取之后发生变更且自己有权查看的数据，实现近实时一致。
// GET /api/sync?since=ISO  →  { serverTime, applications, deleted: [], total }
router.get('/', requireAuth, (req, res) => {
  const user = req.session.user;
  const state = db.load();
  const sinceRaw = String(req.query.since || '').trim();
  const since = sinceRaw ? new Date(sinceRaw) : null;
  const hasSince = since && !Number.isNaN(since.getTime());

  let list = state.applications.filter((item) => applications.canView(item, user));
  if (hasSince) {
    list = list.filter((item) => {
      const at = new Date(item.updatedAt || item.createdAt || 0).getTime();
      return at > since.getTime();
    });
  }
  list.sort((a, b) => new Date(a.updatedAt || a.createdAt) - new Date(b.updatedAt || b.createdAt));

  const total = list.length;
  const items = list.slice(0, LIMIT).map((item) => applications.shape(item, user));

  return res.json({
    serverTime: new Date().toISOString(),
    // 超过单页上限时提示客户端继续翻页（用最后一条的 updatedAt 作为下一轮 since）
    hasMore: total > items.length,
    total,
    applications: items,
    // 集中式存储下不做物理删除，撤回/删除账号仅变更状态，因此无需同步删除清单
    deleted: [],
  });
});

// 同步心跳：用于客户端探测在线状态与服务端时间（轻量）
router.get('/ping', requireAuth, (req, res) => {
  return res.json({ ok: true, serverTime: new Date().toISOString(), user: req.session.user.id });
});

module.exports = router;
