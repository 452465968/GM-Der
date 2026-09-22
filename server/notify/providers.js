// 三种渠道的实际投递实现。
// 约定：成功返回 { ok: true }；失败抛 Error（错误信息会写入通知日志）。

const TIMEOUT_MS = 10000;

async function postJson(url, body, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (err) {
      data = null;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${String(text).slice(0, 200)}`);
    }
    return data || {};
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ 邮件（SMTP） ------------------------------ */

async function sendEmail({ to, title, content }) {
  if (!to) throw new Error('未填写邮箱地址');
  if (!process.env.SMTP_HOST) throw new Error('服务端未配置邮件服务（缺少 SMTP_HOST）');
  let nodemailer;
  try {
    // 懒加载：未安装依赖时不影响其他渠道
    // eslint-disable-next-line global-require
    nodemailer = require('nodemailer');
  } catch (err) {
    throw new Error('邮件依赖缺失，请在服务端执行 npm install nodemailer');
  }
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' }
      : undefined,
    // 465 端口若证书为自签名可设 SMTP_TLS_REJECT_UNAUTHORIZED=false
    tls:
      process.env.SMTP_TLS_REJECT_UNAUTHORIZED === 'false'
        ? { rejectUnauthorized: false }
        : undefined,
  });
  const info = await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@purchase-approval',
    to,
    subject: title,
    text: content,
  });
  return { ok: true, detail: info && info.messageId ? String(info.messageId) : '' };
}

/* ------------------------------ QQ（OneBot v11 HTTP） ------------------------------ */

async function sendQQ({ to, title, content }) {
  if (!to) throw new Error('未填写 QQ 号');
  const base = String(process.env.QQ_ONEBOT_URL || '').replace(/\/+$/, '');
  if (!base) throw new Error('服务端未配置 QQ 机器人（缺少 QQ_ONEBOT_URL）');
  const token = process.env.QQ_ONEBOT_TOKEN;
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const message = `${title}\n${content}`;
  const target = String(to).trim();
  let url = `${base}/send_private_msg`;
  let body = { user_id: Number(target), message };
  if (target.startsWith('g:')) {
    url = `${base}/send_group_msg`;
    body = { group_id: Number(target.slice(2)), message };
  }
  if (!Number.isFinite(body.user_id) && !Number.isFinite(body.group_id)) {
    throw new Error('QQ 号不合法（群消息请使用 g:群号）');
  }
  const data = await postJson(url, body, headers);
  if (data.retcode !== undefined && Number(data.retcode) !== 0) {
    throw new Error(`QQ 机器人返回错误：${data.wording || data.retcode}`);
  }
  return { ok: true, detail: data.message_id ? String(data.message_id) : '' };
}

/* ------------------------------ 微信（企业微信机器人 / Server酱） ------------------------------ */

async function sendWechat({ to, title, content }) {
  const mode = String(process.env.WECHAT_MODE || 'wecom').toLowerCase();
  if (mode === 'serverchan') {
    const url = process.env.WECHAT_PUSH_URL || (to ? `https://sctapi.ftqq.com/${to}.send` : '');
    if (!url) throw new Error('服务端未配置 Server酱（缺少 WECHAT_PUSH_URL）或未填写 SendKey');
    const data = await postJson(url, { title, desp: content });
    if (data && data.code !== undefined && Number(data.code) !== 0) {
      throw new Error(`Server酱返回错误：${data.message || data.code}`);
    }
    return { ok: true, detail: '' };
  }

  const url = process.env.WECHAT_WEBHOOK_URL;
  if (!url) throw new Error('服务端未配置微信推送（缺少 WECHAT_WEBHOOK_URL）');
  const mentioned = to && /^[\d@.\-+]+$/.test(String(to)) ? [String(to)] : [];
  const data = await postJson(url, {
    msgtype: 'text',
    text: { content: `${title}\n${content}`, mentioned_mobile_list: mentioned },
  });
  if (data && data.errcode !== undefined && Number(data.errcode) !== 0) {
    throw new Error(`企业微信返回错误：${data.errmsg || data.errcode}`);
  }
  return { ok: true, detail: '' };
}

/* ------------------------------ 系统推送（Web Push） ------------------------------ */

async function sendWebPush({ to, title, content, url }) {
  // to 为 userId：订阅端点保存在服务端，不由用户填写
  // eslint-disable-next-line global-require
  const push = require('./push');
  return push.send(to, { title, content, url });
}

const PROVIDERS = { email: sendEmail, qq: sendQQ, wechat: sendWechat, webpush: sendWebPush };

async function send(channel, payload) {
  const fn = PROVIDERS[channel];
  if (!fn) throw new Error(`未知的通知渠道：${channel}`);
  return fn(payload);
}

module.exports = { send, PROVIDERS };
