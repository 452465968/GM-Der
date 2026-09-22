/**
 * 通知渠道配置（持久化为 data/notify-config.json）
 *
 * 职责：描述三个渠道（webpush/email/qq/wechat）的元信息（名称、地址输入框提示），
 * 以及全局开关 channelEnabled、最大重试次数 maxAttempts、退避延迟 retryDelaysSec。
 * 设计意图：渠道是否启用是系统级开关，用户级开关在 user.notify.channels，两者都为真才投递。
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'notify-config.json');

// 三种通知渠道的元信息（前端设置页据此渲染开关与地址输入框）
const CHANNELS = [
  {
    key: 'webpush',
    label: '系统推送（Web Push）',
    desc: '手机/桌面系统级通知栏推送。需 HTTPS 安全上下文：iOS 16.4+ 且已「添加到主屏幕」，Android Chrome 支持（依赖 Google 推送通道）',
    targetField: 'webpush',
    placeholder: '无需填写，点下方按钮订阅',
    noInput: true,
  },
  {
    key: 'email',
    label: '邮件',
    desc: '通过 SMTP 发送，需配置 SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM，并安装 nodemailer',
    targetField: 'email',
    placeholder: 'you@example.com',
  },
  {
    key: 'qq',
    label: 'QQ',
    desc: '通过 QQ 机器人（OneBot v11 HTTP）发送私聊消息，需配置 QQ_ONEBOT_URL / QQ_ONEBOT_TOKEN',
    targetField: 'qq',
    placeholder: 'QQ 号，群消息填 g:群号',
  },
  {
    key: 'wechat',
    label: '微信',
    desc: '企业微信群机器人（WECHAT_MODE=wecom + WECHAT_WEBHOOK_URL）或 Server酱（WECHAT_MODE=serverchan + WECHAT_PUSH_URL）',
    targetField: 'wechat',
    placeholder: '企业微信手机号 / Server酱 SendKey',
  },
];

const DEFAULT_CONFIG = {
  channels: {
    webpush: { enabled: true },
    email: { enabled: true },
    qq: { enabled: true },
    wechat: { enabled: true },
  },
  maxAttempts: 3,
  retryDelaysSec: [10, 60, 300], // 第 1/2/3 次失败后的退避间隔
  baseUrl: '', // 通知内容里的详情链接前缀，留空则使用 APP_BASE_URL
};

let cache = null;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getConfig() {
  if (cache) return cache;
  ensureDir();
  let parsed = null;
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (err) {
      console.error('[notify] 配置文件解析失败，使用默认值：', err.message);
    }
  }
  cache = {
    channels: Object.assign({}, DEFAULT_CONFIG.channels, parsed && parsed.channels),
    maxAttempts: (parsed && Number(parsed.maxAttempts)) || DEFAULT_CONFIG.maxAttempts,
    retryDelaysSec: Array.isArray(parsed && parsed.retryDelaysSec)
      ? parsed.retryDelaysSec
      : DEFAULT_CONFIG.retryDelaysSec,
    baseUrl: (parsed && parsed.baseUrl) || '',
  };
  return cache;
}

function saveConfig(next) {
  ensureDir();
  const merged = Object.assign({}, getConfig(), next || {});
  cache = merged;
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
  return merged;
}

// 渠道是否在服务端启用（全局开关）
function channelEnabled(key) {
  const cfg = getConfig();
  const item = cfg.channels && cfg.channels[key];
  return Boolean(item && item.enabled !== false);
}

// 渠道的服务端凭据是否已配置（未配置则无法真正投递，仅记录日志）
function channelConfigured(key) {
  if (key === 'webpush') return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  if (key === 'email') return Boolean(process.env.SMTP_HOST);
  if (key === 'qq') return Boolean(process.env.QQ_ONEBOT_URL);
  if (key === 'wechat') return Boolean(process.env.WECHAT_WEBHOOK_URL || process.env.WECHAT_PUSH_URL);
  return false;
}

function baseUrl() {
  return getConfig().baseUrl || process.env.APP_BASE_URL || '';
}

// 各渠道依赖的环境变量（调试面板据此提示缺失项）
const ENV_KEYS = {
  webpush: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'],
  email: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'],
  qq: ['QQ_ONEBOT_URL', 'QQ_ONEBOT_TOKEN'],
  wechat: ['WECHAT_MODE', 'WECHAT_WEBHOOK_URL', 'WECHAT_PUSH_URL'],
};

function maskEnvValue(key, value) {
  if (!value) return '';
  if (/PASS|TOKEN|KEY|SECRET/i.test(key)) return '••••••';
  return value.length > 60 ? `${value.slice(0, 60)}…` : value;
}

// 调试信息：服务端凭据状态（敏感值打码）+ 依赖是否安装
function debugInfo() {
  let mailDeps = false;
  try {
    require.resolve('nodemailer');
    mailDeps = true;
  } catch (err) {
    mailDeps = false;
  }
  const channels = CHANNELS.map((ch) => ({
    key: ch.key,
    label: ch.label,
    enabled: channelEnabled(ch.key),
    configured: channelConfigured(ch.key),
    env: ENV_KEYS[ch.key].map((key) => ({ key, value: maskEnvValue(key, process.env[key] || '') })),
  }));
  return {
    channels,
    nodemailerInstalled: mailDeps,
    baseUrl: baseUrl(),
    nodeEnv: process.env.NODE_ENV || 'development',
  };
}

// 供前端展示的渠道状态
function channelStatus() {
  return CHANNELS.map((item) => ({
    key: item.key,
    label: item.label,
    desc: item.desc,
    targetField: item.targetField,
    placeholder: item.placeholder,
    enabled: channelEnabled(item.key),
    configured: channelConfigured(item.key),
  }));
}

module.exports = {
  CHANNELS,
  ENV_KEYS,
  getConfig,
  saveConfig,
  channelEnabled,
  channelConfigured,
  channelStatus,
  debugInfo,
  baseUrl,
};
