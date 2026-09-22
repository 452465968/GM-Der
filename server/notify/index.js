const db = require('../db');
const config = require('./config');
const queue = require('./queue');

// 事件 → 通知文案中的「审批类型」
const EVENT_LABEL = {
  new_application: '新审批单待处理',
  resubmit: '申请已修改并重新提交',
  decision: '审批结果更新',
  cancel: '申请已撤回',
  test: '推送测试',
};

const STATUS_LABEL = {
  pending: '待审批',
  resubmitted: '已修改待审批',
  approved: '已同意',
  rejected: '已拒绝',
  cancelled: '已撤回',
};

function defaultNotify() {
  return {
    email: '',
    qq: '',
    wechat: '',
    channels: { webpush: true, email: true, qq: true, wechat: true },
  };
}

// 归一化用户的通知设置（兼容旧账号缺失字段）
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

function settingsOf(user) {
  return normalizeNotify(user && user.notify);
}

function updateSettings(userId, patch) {
  const state = db.load();
  const user = state.users.find((u) => u.id === userId);
  if (!user) return null;
  const current = normalizeNotify(user.notify);
  const next = normalizeNotify({
    email: patch && patch.email !== undefined ? String(patch.email || '').trim() : current.email,
    qq: patch && patch.qq !== undefined ? String(patch.qq || '').trim() : current.qq,
    wechat: patch && patch.wechat !== undefined ? String(patch.wechat || '').trim() : current.wechat,
    channels: Object.assign({}, current.channels, (patch && patch.channels) || {}),
  });
  user.notify = next;
  db.save();
  return next;
}

function money(value) {
  return `¥${(Number(value) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtTime(iso) {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) return '-';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// 组装通知正文：包含审批类型、提交人、状态、金额、时间戳等关键信息
function buildContent({ event, application, actorName = '', comment = '' }) {
  const base = config.baseUrl().replace(/\/+$/, '');
  const lines = [];
  if (application) {
    lines.push(`物品名称：${application.itemName || '-'}`);
    lines.push(`价格：${money(application.price)}`);
    lines.push(`购买平台：${application.platform || '-'}`);
    lines.push(`提交人：${application.userName || '-'}`);
    lines.push(`审批类型：${EVENT_LABEL[event] || event}`);
    lines.push(`当前状态：${STATUS_LABEL[application.status] || application.status || '-'}`);
    lines.push(`提交轮次：第 ${application.submitCount || 1} 轮`);
    if (actorName) lines.push(`操作人：${actorName}`);
    if (comment) lines.push(`审批意见：${comment}`);
    const voters = application.approval && Array.isArray(application.approval.voters) ? application.approval.voters : [];
    if (voters.length) {
      lines.push(
        `通过条件：${Number(application.approval.passVotes) || 1}/${voters.length} 票同意`
      );
    }
    lines.push(`时间戳：${fmtTime(application.updatedAt || application.createdAt)}`);
    if (base) lines.push(`查看详情：${base}/#/apps/${application.id}`);
  } else {
    lines.push(`时间戳：${fmtTime(new Date().toISOString())}`);
  }
  return lines.join('\n');
}

function shouldSkip(user, channel, target) {
  if (!config.channelEnabled(channel)) return '该渠道已被全局关闭';
  const notify = normalizeNotify(user.notify);
  if (!notify.channels[channel]) return '用户已关闭该渠道';
  if (channel === 'webpush') {
    // 系统推送以「是否已订阅」为准，不由用户填写地址
    // eslint-disable-next-line global-require
    const pushStore = require('./push');
    if (!pushStore.has(user.id)) return '未订阅系统推送（需 HTTPS 且已授权）';
    return '';
  }
  if (!target) return '未配置该渠道的接收地址';
  return '';
}

function push({ user, channel, event, title, content, url = '' }) {
  const notify = normalizeNotify(user.notify);
  const target =
    channel === 'webpush'
      ? user.id
      : channel === 'email'
      ? notify.email
      : channel === 'qq'
      ? notify.qq
      : notify.wechat;
  const skipReason = shouldSkip(user, channel, target);
  if (skipReason) {
    queue.log({
      userId: user.id,
      userName: user.name,
      channel,
      event,
      status: 'skipped',
      attempt: 0,
      target,
      title,
      preview: String(content || '').replace(/\s+/g, ' ').slice(0, 120),
      error: skipReason,
    });
    return false;
  }
  queue.enqueue({
    userId: user.id,
    userName: user.name,
    channel,
    target,
    event,
    title,
    content,
    url,
  });
  return true;
}

const CHANNEL_KEYS = ['webpush', 'email', 'qq', 'wechat'];

// 向一批用户推送（每个用户按自己开启的渠道分别入队）
function pushToUsers({ users, event, application, actorName = '', comment = '' }) {
  let queued = 0;
  users.filter(Boolean).forEach((user) => {
    const title = `【买个Der】${EVENT_LABEL[event] || event}${
      application ? `：${application.itemName || ''}` : ''
    }`;
    const content = buildContent({ event, application, actorName, comment });
    const base = config.baseUrl().replace(/\/+$/, '');
    const url = application && application.id && application.id !== 'debug-sample' && base ? `${base}/#/apps/${application.id}` : '';
    CHANNEL_KEYS.forEach((channel) => {
      if (push({ user, channel, event, title, content, url })) queued += 1;
    });
  });
  return queued;
}

/* ------------------------------ 业务触发点 ------------------------------ */

// 新建申请 / 重新提交：通知本轮所有投票人
function onApplicationCreated(application) {
  try {
    const state = db.load();
    const voters = (application.approval && application.approval.voters) || [];
    const users = voters
      .map((v) => state.users.find((u) => u.id === v.id))
      .filter(Boolean);
    return pushToUsers({
      users,
      event: application.submitCount > 1 ? 'resubmit' : 'new_application',
      application,
      actorName: application.userName,
    });
  } catch (err) {
    console.error('[notify] 新申请通知失败：', err.message);
    return 0;
  }
}

// 审批结果更新（同意 / 拒绝 / 撤回）：通知申请人本人
function onApplicationDecided(application, { actorName = '', comment = '', event = 'decision' } = {}) {
  try {
    const state = db.load();
    const applicant = state.users.find((u) => u.id === application.userId);
    if (!applicant) return 0;
    return pushToUsers({ users: [applicant], event, application, actorName, comment });
  } catch (err) {
    console.error('[notify] 审批结果通知失败：', err.message);
    return 0;
  }
}

// 测试推送：按当前用户开启的渠道发一条测试消息
function sendTest(user) {
  const content = [
    `这是一条来自买个Der的测试通知。`,
    `接收人：${user.name || ''}（${user.username || ''}）`,
    `时间戳：${fmtTime(new Date().toISOString())}`,
  ].join('\n');
  let queued = 0;
  CHANNEL_KEYS.forEach((channel) => {
    if (push({ user, channel, event: 'test', title: '【买个Der】通知推送测试', content })) {
      queued += 1;
    }
  });
  return queued;
}

// 调试用样本：不必真的创建申请即可验证通知内容与投递链路
function sampleApplication(event, user) {
  const now = new Date().toISOString();
  return {
    id: 'debug-sample',
    itemName: '（调试样本）人体工学办公椅',
    price: 1299,
    platform: '京东',
    userName: (user && user.name) || '调试账号',
    userId: (user && user.id) || '',
    status: event === 'decision' ? 'approved' : event === 'cancel' ? 'cancelled' : 'pending',
    submitCount: event === 'resubmit' ? 2 : 1,
    createdAt: now,
    updatedAt: now,
    approval: { voters: [{ id: (user && user.id) || '', name: (user && user.name) || '' }], passVotes: 1 },
  };
}

// 调试用：按指定事件类型给自己发一条通知
function sendSimulation(user, event = 'test') {
  const application = event === 'test' ? null : sampleApplication(event, user);
  const title = `【买个Der】${EVENT_LABEL[event] || event}（调试）`;
  const content = buildContent({ event, application, actorName: (user && user.name) || '调试', comment: '这是一条调试通知，用于验证渠道配置与内容格式。' });
  let queued = 0;
  CHANNEL_KEYS.forEach((channel) => {
    if (push({ user, channel, event, title, content })) queued += 1;
  });
  return queued;
}

// 广播：向所有已订阅系统推送的设备发一条消息（用于验证后台/离线可达性）
function broadcast({ title, body, url = '' }) {
  // eslint-disable-next-line global-require
  const pushStore = require('./push');
  const dbState = db.load();
  let queued = 0;
  pushStore.allUserIds().forEach((userId) => {
    const user = dbState.users.find((u) => u.id === userId);
    if (!user) return;
    if (push({ user, channel: 'webpush', event: 'test', title, content: body, url })) queued += 1;
  });
  return queued;
}

module.exports = {
  normalizeNotify,
  settingsOf,
  updateSettings,
  onApplicationCreated,
  onApplicationDecided,
  sendTest,
  sendSimulation,
  broadcast,
  EVENT_LABEL,
  STATUS_LABEL,
};
