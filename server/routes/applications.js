/**
 * 核心业务路由 /api/applications
 *
 * 接口：GET /、GET /stats、GET /records、GET /notifications、GET /:id、GET /approver-options，
 *       POST /、POST /:id/decision、POST /:id/resubmit、POST /:id/cancel。
 * 核心模型：
 *   · 状态机 pending →（拒绝后修改重提）resubmitted → approved / rejected / cancelled；
 *   · 投票制：application.approval = { voters:[{id,name,role}], passVotes:M }，
 *     本轮累计 M 票同意即通过；拒绝数多到剩余票即使全同意也不足 M 时自动拒绝；
 *   · 图片上传走 multer，落到 uploads/，仅允许图片类型且 ≤5MB；
 *   · 每一次状态流转都会 pushLog() 写入 approvals 流水，并触发 notify 通知相关人；
 *   · canView()/shape() 实现按角色与可见性（public/restricted）的数据裁剪，
 *     sync.js 也复用这两个函数保证多端一致。
 */
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const notify = require('../notify');
const { requireAuth, isPrivileged } = require('../middleware');

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, db.UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|jpg|png|gif|webp|bmp)$/.test(file.mimetype)) return cb(null, true);
    return cb(new Error('商品图片仅支持 JPG/PNG/GIF/WEBP 格式'));
  },
});

// 状态机：
//   pending      已提交，等待审批（首次提交）
//   resubmitted  申请人被拒后修改并重新提交，等待再次审批
//   rejected     已拒绝（仅此状态允许申请人修改后重提）
//   approved     已同意（终态）
//   cancelled    已撤回（终态）
// 投票制说明：
//   application.approval = { voters: [{id,name,role}], passVotes: M }
//   本轮需 M 名投票人同意即通过；当拒绝数多到剩余投票人即使全部同意也无法凑够 M 时自动拒绝；
//   否则保持待审批，等待其余投票人投票。
// 投票权模型（按申请指派，而非全局身份）：
//   候选人 = 除申请人本人外的所有已注册账号（申请人身份的账号也可被指派为某一轮的投票人）；
//   被指派者即获得该申请的投票权，可查看该申请详情、投出本轮唯一一票；
//   旧版数据（无 approval 字段）维持单审制：仅系统审批人（role=approver）可直接决定。
const REVIEWABLE = ['pending', 'resubmitted']; // 待审批人处理
const STATUS_FLOW = ['pending', 'resubmitted', 'approved', 'rejected', 'cancelled'];
const MAX_VOTERS = 10;

function fail(res, status, message) {
  return res.status(status).json({ error: message });
}

function toText(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

// 解析并校验申请表单字段（新建 / 修改重提共用）
function readFields(body) {
  const itemName = toText(body.itemName, 60);
  const platform = toText(body.platform, 40);
  const link = toText(body.link, 500);
  const reason = toText(body.reason, 500);
  const price = Number(body.price);
  const hasAlternative = String(body.hasAlternative) === 'yes';
  // 可见范围：public=向所有人公开；restricted=仅限本轮被指派的审批人（及申请人本人、超级管理员）查看
  const visibility = String(body.visibility || 'public') === 'restricted' ? 'restricted' : 'public';

  if (!itemName) return { error: '请填写物品名称' };
  if (!platform) return { error: '请填写购买平台' };
  if (!Number.isFinite(price) || price < 0 || price > 100000000) {
    return { error: '价格需为 0 - 100000000 之间的数字' };
  }
  if (link && !/^https?:\/\//i.test(link)) {
    return { error: '商品链接需以 http:// 或 https:// 开头' };
  }
  return {
    fields: {
      itemName,
      price: Math.round(price * 100) / 100,
      platform,
      hasAlternative,
      link,
      reason,
      visibility,
    },
  };
}

// 解析审批规则：从表单中取 approverIds(逗号分隔) + passVotes(需通过票数)
// excludeUserId 用于阻止申请人自审
// 说明：投票权按「单次申请指派」计算，候选人可以是任意已注册账号（不限全局身份）
function readApprovalRule(body, state, excludeUserId) {
  const raw = String(body.approverIds == null ? '' : body.approverIds)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (!raw.length) return { error: '请至少选择一名审批人' };
  if (raw.length > MAX_VOTERS) return { error: `单笔申请最多选择 ${MAX_VOTERS} 名审批人` };
  const idSet = Array.from(new Set(raw));
  if (idSet.length !== raw.length) return { error: '审批人选择存在重复，请检查' };
  if (idSet.includes(excludeUserId)) return { error: '不能指定自己作为本申请的审批人' };
  const voters = idSet.map((id) => state.users.find((u) => u.id === id)).filter(Boolean);
  if (voters.length !== raw.length) return { error: '所选审批人不存在，请刷新页面后重试' };
  const passVotes = Math.round(Number(body.passVotes));
  if (!Number.isInteger(passVotes) || passVotes < 1 || passVotes > voters.length) {
    return { error: `通过所需票数需为 1 - ${voters.length} 之间的整数` };
  }
  return {
    approval: {
      voters: voters.map((u) => ({ id: u.id, name: u.name, role: u.role })),
      passVotes,
    },
  };
}

// 把一次操作追加进审批历史
function pushLog(state, item, { type, actorRole, actorId, actorName, comment = '', round }) {
  state.approvals.push({
    id: db.uid(),
    applicationId: item.id,
    applicationName: item.itemName,
    applicantId: item.userId,
    applicantName: item.userName,
    actorRole,
    actorId,
    actorName,
    type, // approve | reject | submit | resubmit | cancel | vote
    comment,
    round: round || item.submitCount || 1,
    createdAt: new Date().toISOString(),
  });
}

// 归一化历史日志（兼容旧数据：旧记录只有 action 无 type）
function normalizeLog(log) {
  let type = log.type;
  if (!type) {
    type = log.action === 'approved' ? 'approve' : log.action === 'rejected' ? 'reject' : 'approve';
  }
  const actorName =
    log.actorName || log.approverName || log.applicantName || '系统';
  const actorRole = log.actorRole || (type === 'approve' || type === 'reject' ? 'approver' : 'applicant');
  return {
    id: log.id,
    type,
    actorName,
    actorRole,
    comment: log.comment || '',
    round: log.round || 1,
    createdAt: log.createdAt,
  };
}

function getVotes(item) {
  return Array.isArray(item.votes) ? item.votes : [];
}

function countVotes(item) {
  const votes = getVotes(item);
  return {
    approve: votes.filter((v) => v.action === 'approve').length,
    reject: votes.filter((v) => v.action === 'reject').length,
    total: votes.length,
  };
}

// 统计当前状态：是否已通过 / 是否已不可能通过 / 是否仍待投
function evaluateVotes(item) {
  if (!item.approval) return { pass: false, impossible: false };
  const passVotes = Number(item.approval.passVotes) || 1;
  const voters = Array.isArray(item.approval.voters) ? item.approval.voters : [];
  const { approve, reject } = countVotes(item);
  return {
    pass: approve >= passVotes,
    impossible: reject > voters.length - passVotes, // 即使剩余全同意也凑不够 passVotes
  };
}

// 一次性设置当前轮到终态（旧版单审批人直接决定，直接复用）
function finalizeLegacy(item, user, action, comment, now) {
  item.status = action === 'approve' ? 'approved' : 'rejected';
  item.decisionComment = comment;
  item.decidedAt = now;
  item.updatedAt = now;
  item.approverId = user.id;
  item.approverName = user.name;
}

// 投票计数后更新终态；返回 { final, status }
function applyVoteOutcome(item, lastVote, now) {
  if (!item.approval) return { final: false };
  const res = evaluateVotes(item);
  if (res.pass) {
    item.status = 'approved';
    item.decisionComment = lastVote.comment || '';
    item.decidedAt = now;
    item.updatedAt = now;
    item.approverId = lastVote.approverId;
    item.approverName = lastVote.approverName;
    return { final: true, status: 'approved' };
  }
  if (res.impossible) {
    item.status = 'rejected';
    item.decisionComment = lastVote.comment || '';
    item.decidedAt = now;
    item.updatedAt = now;
    item.approverId = lastVote.approverId;
    item.approverName = lastVote.approverName;
    return { final: true, status: 'rejected' };
  }
  item.updatedAt = now;
  return { final: false, status: item.status };
}

function shapeApplication(item, currentUser) {
  const isOwner = Boolean(currentUser && currentUser.id === item.userId);
  const voters = item.approval && Array.isArray(item.approval.voters) ? item.approval.voters : [];
  const votes = getVotes(item);
  const counts = countVotes(item);
  const assigned = voters.some((v) => v.id === (currentUser && currentUser.id));
  const myVote = votes.find((v) => v.approverId === (currentUser && currentUser.id)) || null;

  return {
    id: item.id,
    itemName: item.itemName,
    price: item.price,
    platform: item.platform,
    hasAlternative: item.hasAlternative,
    link: item.link,
    image: item.image,
    reason: item.reason,
    status: item.status,
    visibility: item.visibility || 'public',
    submitCount: item.submitCount || 1,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    decidedAt: item.decidedAt || null,
    decisionComment: item.decisionComment || '',
    applicant: { id: item.userId, name: item.userName },
    // 兼容旧字段：单审批人视图（有 votes 时返回最终决定者，无则返回 null）
    approver: item.approverId ? { id: item.approverId, name: item.approverName } : null,
    // 审批规则
    rule: item.approval
      ? {
          voters: voters.map((v) => ({ id: v.id, name: v.name, role: v.role || 'approver' })),
          passVotes: Number(item.approval.passVotes),
        }
      : null,
    votes: votes.map((v) => ({
      approverId: v.approverId,
      approverName: v.approverName,
      action: v.action,
      comment: v.comment || '',
      createdAt: v.createdAt,
      round: v.round,
    })),
    voteCounts: { ...counts, total: voters.length },
    // 是否被指派为本轮投票人（新版投票制）；旧版单审制对系统审批人为 true
    isAssignedApprover: currentUser ? isInInbox(item, currentUser) : false,
    isAssignedVoter: Boolean(currentUser && assigned),
    myVote,
    canDecide: currentUser ? canVoteOn(item, currentUser) : false,
    canCancel: Boolean(isOwner && REVIEWABLE.includes(item.status)),
    canResubmit: Boolean(isOwner && item.status === 'rejected'),
  };
}

function sortByUpdatedAtDesc(list) {
  return list.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
}

// 是否被指派为本申请的投票人（新版投票制）
function isAssignedVoter(item, userId) {
  if (!item.approval) return false;
  const voters = Array.isArray(item.approval.voters) ? item.approval.voters : [];
  return voters.some((v) => v.id === userId);
}

// 乐观锁：客户端提交时带上自己读到的 updatedAt，
// 若服务端数据已被其他设备/用户改动，返回 409 + 最新数据，由客户端提示刷新后重试（冲突解决）
function conflictResponse(res, item, user, expectedUpdatedAt) {
  if (!expectedUpdatedAt) return false;
  if (String(expectedUpdatedAt) === String(item.updatedAt || '')) return false;
  res.status(409).json({
    error: '该申请已在其他设备被更新，已载入最新数据，请确认后重试',
    conflict: true,
    application: shapeApplication(item, user),
  });
  return true;
}

// 可见范围判定：
//   public（默认，向所有人公开）—— 所有已登录用户可见
//   restricted（仅限指定审批人）—— 仅申请人本人、本轮被指派的审批人、超级管理员可见
function canView(item, user) {
  if (!user) return false;
  if (user.role === 'admin' || user.isSuperAdmin) return true;
  if (item.userId === user.id) return true;
  if (isAssignedVoter(item, user.id)) return true;
  return (item.visibility || 'public') !== 'restricted';
}

// 该申请是否应出现在某人的待办中：
//   新版（有 voters）—— 被指派即进待办，与被指派者的全局身份无关
//   旧版（无 voters，历史单审制数据）—— 仅系统审批人可见
function isInInbox(item, user) {
  if (!user) return false;
  if (item.approval) return isAssignedVoter(item, user.id);
  return isPrivileged(user);
}

// 是否可对该申请投票 / 作出决定：
//   新版 —— 被指派为投票人，且本轮尚未投票
//   旧版 —— 系统审批人（单审制，一人决定）
function canVoteOn(item, user) {
  if (!user || !REVIEWABLE.includes(item.status)) return false;
  if (item.approval) {
    return isAssignedVoter(item, user.id) && !getVotes(item).some((v) => v.approverId === user.id);
  }
  return user.role === 'approver';
}

function isDecidedBy(item, userId) {
  if (item.approverId === userId) return true;
  return getVotes(item).some((v) => v.approverId === userId);
}

// 多图上传统一错误处理包装（单图、可选）
function uploadSingleImage(req, res, next) {
  upload.single('image')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return fail(res, 400, '图片大小不能超过 5MB');
    }
    return fail(res, 400, err.message || '图片上传失败');
  });
}

/* ------------------------------ 审批人候选 ------------------------------ */

// 返回可被指派为投票审批人的账号：除本人外的所有已注册账号（不限全局身份）
// 被指派者即获得该申请的投票权，因此普通申请人账号也可被勾选为某一轮的审批人
router.get('/approver-options', requireAuth, (req, res) => {
  const state = db.load();
  const me = req.session.user.id;
  const list = state.users
    .filter((u) => u.id !== me)
    .map((u) => ({ id: u.id, name: u.name, username: u.username, role: u.role }))
    .sort((a, b) => {
      if ((a.role === 'approver') !== (b.role === 'approver')) return a.role === 'approver' ? -1 : 1;
      return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
    });
  return res.json({ approvers: list });
});

/* ------------------------------ 提交申请 ------------------------------ */

router.post('/', requireAuth, uploadSingleImage, (req, res) => {
  const { error, fields } = readFields(req.body || {});
  if (error) return fail(res, 400, error);

  const state = db.load();
  const ruleResult = readApprovalRule(req.body || {}, state, req.session.user.id);
  if (ruleResult.error) return fail(res, 400, ruleResult.error);

  const now = new Date().toISOString();
  const application = {
    id: db.uid(),
    userId: req.session.user.id,
    userName: req.session.user.name,
    itemName: fields.itemName,
    price: fields.price,
    platform: fields.platform,
    hasAlternative: fields.hasAlternative,
    link: fields.link,
    image: req.file ? `/uploads/${req.file.filename}` : '',
    reason: fields.reason,
    status: 'pending',
    visibility: fields.visibility,
    submitCount: 1,
    createdAt: now,
    updatedAt: now,
    decidedAt: null,
    decisionComment: '',
    approverId: null,
    approverName: '',
    approval: ruleResult.approval,
    votes: [],
  };
  state.applications.push(application);
  pushLog(state, application, {
    type: 'submit',
    actorRole: 'applicant',
    actorId: req.session.user.id,
    actorName: req.session.user.name,
    round: 1,
  });
  db.save();
  // 通知本轮投票人：有新审批单待处理（异步入队，不阻塞响应）
  notify.onApplicationCreated(application);
  return res.status(201).json({ application: shapeApplication(application, req.session.user) });
});

/* ------------------------------ 申请列表 ------------------------------ */

router.get('/', requireAuth, (req, res) => {
  const user = req.session.user;
  const { scope = 'mine', status = '', keyword = '', approver = '' } = req.query;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize, 10) || 10));

  const state = db.load();
  let list = state.applications.slice();

  if (scope === 'mine') {
    list = list.filter((item) => item.userId === user.id);
  } else if (scope === 'pending') {
    // 待我投票：新版看是否被指派为本轮投票人（不限全局身份），旧版单审制仍仅系统审批人可见
    list = list.filter(
      (item) =>
        REVIEWABLE.includes(item.status) &&
        isInInbox(item, user) &&
        // 已投过票的不再出现在自己的待办中
        !(item.approval && getVotes(item).some((v) => v.approverId === user.id))
    );
  } else if (scope === 'all') {
    // 审批人、超级管理员、或拥有 data:all 权限的账号
    if (!isPrivileged(user)) return fail(res, 403, '仅审批人/管理员可查看全部申请');
  }

  if (status && STATUS_FLOW.includes(status)) {
    list = list.filter((item) => item.status === status);
  }
  if (approver === 'me') {
    list = list.filter((item) => isDecidedBy(item, user.id));
  }
  const kw = String(keyword || '').trim().toLowerCase();
  if (kw) {
    list = list.filter((item) =>
      [item.itemName, item.platform, item.userName, item.reason].join(' ').toLowerCase().includes(kw)
    );
  }

  // 「全部申请」列表同样受可见范围约束（受限申请只对相关人员展示）
  list = list.filter((item) => canView(item, user));

  sortByUpdatedAtDesc(list);
  const total = list.length;
  const items = list.slice((page - 1) * pageSize, page * pageSize);
  return res.json({
    items: items.map((item) => shapeApplication(item, user)),
    total,
    page,
    pageSize,
  });
});

/* ------------------------------ 统计概览 ------------------------------ */

router.get('/stats', requireAuth, (req, res) => {
  const user = req.session.user;
  const state = db.load();
  const base = isPrivileged(user)
    ? state.applications
    : state.applications.filter((item) => item.userId === user.id);

  const count = (fn) => base.filter(fn).length;
  return res.json({
    total: base.length,
    pending: count((item) => REVIEWABLE.includes(item.status)),
    resubmitted: count((item) => item.status === 'resubmitted'),
    approved: count((item) => item.status === 'approved'),
    rejected: count((item) => item.status === 'rejected'),
    cancelled: count((item) => item.status === 'cancelled'),
    // 待我投票：被指派为本轮投票人且尚未投票。
    // 注意基于全量申请统计——被指派为投票人的申请属于他人提交，不在 base 内。
    myPending: state.applications.filter(
      (item) =>
        REVIEWABLE.includes(item.status) &&
        isInInbox(item, user) &&
        !(item.approval && getVotes(item).some((v) => v.approverId === user.id))
    ).length,
    myDecided: state.applications.filter((item) => isDecidedBy(item, user.id)).length,
    approvedAmount: base
      .filter((item) => item.status === 'approved')
      .reduce((sum, item) => sum + (Number(item.price) || 0), 0),
  });
});

/* ------------------------------ 审批记录（已处理完） ------------------------------ */

router.get('/records', requireAuth, (req, res) => {
  const user = req.session.user;
  const { status = '', keyword = '', approver = '' } = req.query;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize, 10) || 10));

  const state = db.load();
  // 记录仅含已结束的申请（同意 / 拒绝 / 撤回）
  let list = state.applications.filter((item) => ['approved', 'rejected', 'cancelled'].includes(item.status));
  // 审批记录：公开的对所有人展示；受限的仅申请人/被指派审批人/超管可见
  list = list.filter((item) => canView(item, user));
  if (status && ['pending', 'resubmitted'].includes(status)) {
    list = [];
  } else if (status && STATUS_FLOW.includes(status)) {
    list = list.filter((item) => item.status === status);
  }
  if (approver === 'me') {
    list = list.filter((item) => isDecidedBy(item, user.id));
  }
  const kw = String(keyword || '').trim().toLowerCase();
  if (kw) {
    list = list.filter((item) =>
      [item.itemName, item.platform, item.userName, item.approverName, item.decisionComment]
        .join(' ')
        .toLowerCase()
        .includes(kw)
    );
  }
  list.sort((a, b) => new Date(b.decidedAt || b.updatedAt) - new Date(a.decidedAt || a.updatedAt));

  const total = list.length;
  const items = list.slice((page - 1) * pageSize, page * pageSize);
  return res.json({
    items: items.map((item) => shapeApplication(item, user)),
    total,
    page,
    pageSize,
  });
});

/* ------------------------------ 新任务提醒（前端轮询） ------------------------------ */

// 返回「待我投票」的精简列表与数量，供前端轮询并在出现新任务时弹出提醒
router.get('/notifications', requireAuth, (req, res) => {
  const user = req.session.user;
  const state = db.load();
  const list = state.applications
    .filter(
      (item) =>
        REVIEWABLE.includes(item.status) &&
        isInInbox(item, user) &&
        !(item.approval && getVotes(item).some((v) => v.approverId === user.id))
    )
    .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));

  return res.json({
    count: list.length,
    serverTime: new Date().toISOString(),
    items: list.slice(0, 20).map((item) => ({
      id: item.id,
      itemName: item.itemName,
      price: item.price,
      platform: item.platform,
      applicant: { id: item.userId, name: item.userName },
      status: item.status,
      submitCount: item.submitCount || 1,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      rule: item.approval
        ? {
            passVotes: Number(item.approval.passVotes),
            total: Array.isArray(item.approval.voters) ? item.approval.voters.length : 0,
          }
        : null,
    })),
  });
});

/* ------------------------------ 申请详情 ------------------------------ */

router.get('/:id', requireAuth, (req, res) => {
  const state = db.load();
  const item = state.applications.find((row) => row.id === req.params.id);
  if (!item) return fail(res, 404, '申请不存在');

  const user = req.session.user;
  // 本人、系统审批人、本轮被指派的投票人均可查看详情
  if (!canView(item, user)) {
    return fail(res, 403, '该申请为「仅限指定审批人查看」，您不在可见范围内');
  }
  const logs = state.approvals
    .filter((row) => row.applicationId === item.id)
    .map(normalizeLog)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return res.json({ application: shapeApplication(item, user), logs });
});

/* ------------------------------ 审批操作（同意 / 拒绝，投票制） ------------------------------ */

router.post('/:id/decision', requireAuth, (req, res) => {
  const { action, comment } = req.body || {};
  const text = toText(comment, 500);
  if (!['approve', 'reject'].includes(action)) return fail(res, 400, '审批动作不合法');
  if (action === 'reject' && !text) return fail(res, 400, '拒绝时必须填写拒绝理由');

  const state = db.load();
  const item = state.applications.find((row) => row.id === req.params.id);
  if (!item) return fail(res, 404, '申请不存在');
  if (!REVIEWABLE.includes(item.status)) return fail(res, 409, '该申请当前状态不可审批');

  const user = req.session.user;
  // 申请人不能审批自己发起的申请（即便其账号具备审批人身份）
  if (item.userId === user.id) return fail(res, 403, '不能审批自己发起的申请');
  if (conflictResponse(res, item, user, req.body && req.body.expectedUpdatedAt)) return;
  const now = new Date().toISOString();

  // ---- 新版（投票制）：仅被指派的投票人可投，且每人本轮一票 ----
  if (item.approval) {
    if (!isAssignedVoter(item, user.id)) return fail(res, 403, '您未被指派为该申请的投票人，无法投票');
    if (getVotes(item).some((v) => v.approverId === user.id)) {
      return fail(res, 409, '您已对该申请投过票，不可重复投票');
    }
  } else if (user.role !== 'approver') {
    // 旧版单审制数据：仅系统审批人可直接决定
    return fail(res, 403, '仅审批人可执行该操作');
  }

  // ---- 旧版申请（无 approval 配置）：单审批人直接作出终态决定 ----
  if (!item.approval) {
    finalizeLegacy(item, user, action, text, now);
    pushLog(state, item, {
      type: action, // approve / reject
      actorRole: 'approver',
      actorId: user.id,
      actorName: user.name,
      comment: text,
    });
    db.save();
    // 旧版单审制：直接产生终态，通知申请人审批结果
    notify.onApplicationDecided(item, { actorName: user.name, comment: text });
    return res.json({ application: shapeApplication(item, user) });
  }

  // ---- 新版（投票制）：记录本轮这一票 ----
  const voters = Array.isArray(item.approval.voters) ? item.approval.voters : [];
  const votes = getVotes(item);

  const vote = {
    id: db.uid(),
    approverId: user.id,
    approverName: user.name,
    action,
    comment: text,
    round: item.submitCount || 1,
    createdAt: now,
  };
  item.votes = votes.concat(vote);
  pushLog(state, item, {
    type: action, // approve / reject（单人单票）
    actorRole: 'approver',
    actorId: user.id,
    actorName: user.name,
    comment: text,
  });

  const outcome = applyVoteOutcome(item, vote, now);
  db.save();

  // 票数凑够 / 已不可能通过 → 终态，通知申请人审批结果；中间投票不打扰申请人
  if (outcome.final) {
    notify.onApplicationDecided(item, {
      actorName: user.name,
      comment: item.decisionComment || text,
    });
  }

  const message =
    outcome.status === 'approved'
      ? '投票通过，申请已同意'
      : outcome.status === 'rejected'
      ? '已不可能达到通过票数，申请自动拒绝'
      : `已记录投票（当前 ${item.votes.length}/${voters.length} 票），等待其余审批人投票`;
  return res.json({ application: shapeApplication(item, user), message });
});

/* ------------------------------ 修改并重新提交（仅被拒绝的申请） ------------------------------ */

router.post('/:id/resubmit', requireAuth, uploadSingleImage, (req, res) => {
  const state = db.load();
  const item = state.applications.find((row) => row.id === req.params.id);
  if (!item) return fail(res, 404, '申请不存在');
  if (item.userId !== req.session.user.id) return fail(res, 403, '只能修改本人提交的申请');
  if (item.status !== 'rejected') return fail(res, 409, '仅被拒绝的申请可以修改并重新提交');
  if (conflictResponse(res, item, req.session.user, req.body && req.body.expectedUpdatedAt)) return;

  const { error, fields } = readFields(req.body || {});
  if (error) return fail(res, 400, error);

  // 图片处理：选了新图则替换；标记移除则清空；否则保留原图
  let image = item.image || '';
  if (req.file) image = `/uploads/${req.file.filename}`;
  else if (String(req.body.removeImage) === '1') image = '';

  // 审批规则：表单可重新指定审批人与通过票数；未传则沿用原有规则（旧版申请首次重提必须配置）
  let approval = item.approval;
  const rawApprover = String(req.body.approverIds == null ? '' : req.body.approverIds).trim();
  if (rawApprover) {
    const ruleResult = readApprovalRule(req.body || {}, state, req.session.user.id);
    if (ruleResult.error) return fail(res, 400, ruleResult.error);
    approval = ruleResult.approval;
  } else if (!approval) {
    return fail(res, 400, '请选择本轮审批人并设置通过票数');
  }

  const now = new Date().toISOString();
  item.itemName = fields.itemName;
  item.price = fields.price;
  item.platform = fields.platform;
  item.hasAlternative = fields.hasAlternative;
  item.link = fields.link;
  item.reason = fields.reason;
  item.image = image;
  item.visibility = fields.visibility; // 重新提交时可再次调整可见范围
  item.status = 'resubmitted';
  item.submitCount = (item.submitCount || 1) + 1;
  item.updatedAt = now;
  item.decidedAt = null;
  item.decisionComment = '';
  item.approverId = null;
  item.approverName = '';
  item.approval = approval;
  item.votes = [];

  pushLog(state, item, {
    type: 'resubmit',
    actorRole: 'applicant',
    actorId: req.session.user.id,
    actorName: req.session.user.name,
    comment: '',
  });
  db.save();
  // 重新提交：通知新一轮投票人
  notify.onApplicationCreated(item);
  return res.json({ application: shapeApplication(item, req.session.user) });
});

/* ------------------------------ 撤回申请（待审 / 已修改待审可撤回） ------------------------------ */

router.post('/:id/cancel', requireAuth, (req, res) => {
  const state = db.load();
  const item = state.applications.find((row) => row.id === req.params.id);
  if (!item) return fail(res, 404, '申请不存在');
  if (item.userId !== req.session.user.id) return fail(res, 403, '只能撤回本人提交的申请');
  if (!REVIEWABLE.includes(item.status)) return fail(res, 409, '仅待审批的申请可以撤回');
  if (conflictResponse(res, item, req.session.user, req.body && req.body.expectedUpdatedAt)) return;

  const now = new Date().toISOString();
  item.status = 'cancelled';
  item.updatedAt = now;
  item.decidedAt = now;
  item.decisionComment = '';
  item.approverId = null;
  item.approverName = '';
  item.votes = getVotes(item); // 保留已投记录用于留痕展示

  pushLog(state, item, {
    type: 'cancel',
    actorRole: 'applicant',
    actorId: req.session.user.id,
    actorName: req.session.user.name,
  });
  db.save();
  // 撤回也是状态变更，通知申请人（用于多端同步留痕）
  notify.onApplicationDecided(item, { event: 'cancel', actorName: req.session.user.name });
  return res.json({ application: shapeApplication(item, req.session.user) });
});

module.exports = router;
// 供同步接口复用（同一份可见性规则与数据整形，保证各端数据一致）
module.exports.shape = shapeApplication;
module.exports.canView = canView;
