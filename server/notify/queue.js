const crypto = require('crypto');
const store = require('./store');
const config = require('./config');
const providers = require('./providers');

// 轻量持久化队列：
//  - 入队即落盘，进程重启后未完成的推送继续重试；
//  - 失败按 retryDelaysSec 做退避重试，超过 maxAttempts 记为 failed；
//  - 每一次尝试（成功 / 重试 / 失败 / 跳过）都会写入 notify-log.json 便于追踪。

let timer = null;
let running = false;

function uid() {
  return crypto.randomUUID();
}

function log(entry) {
  return store.appendLog(Object.assign({ id: uid(), ts: new Date().toISOString() }, entry));
}

function enqueue(job) {
  const cfg = config.getConfig();
  const queue = store.loadQueue();
  queue.push({
    id: uid(),
    userId: job.userId || '',
    userName: job.userName || '',
    channel: job.channel,
    target: job.target || '',
    event: job.event || '',
    title: job.title || '',
    content: job.content || '',
    url: job.url || '',
    attempts: 0,
    maxAttempts: Number(cfg.maxAttempts) || 3,
    nextRunAt: new Date(Date.now()).toISOString(),
    createdAt: new Date().toISOString(),
    status: 'pending',
    lastError: '',
  });
  store.saveQueue(queue);
  return queue.length;
}

function preview(content) {
  return String(content || '').replace(/\s+/g, ' ').slice(0, 120);
}

async function processJob(job) {
  const cfg = config.getConfig();
  job.attempts = Number(job.attempts || 0) + 1;
  try {
    await providers.send(job.channel, { to: job.target, title: job.title, content: job.content, url: job.url });
    log({
      userId: job.userId,
      userName: job.userName,
      channel: job.channel,
      event: job.event,
      status: 'sent',
      attempt: job.attempts,
      target: job.target,
      title: job.title,
      preview: preview(job.content),
    });
    return { done: true };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    job.lastError = message;
    const max = Number(job.maxAttempts || cfg.maxAttempts || 3);
    if (job.attempts >= max) {
      log({
        userId: job.userId,
        userName: job.userName,
        channel: job.channel,
        event: job.event,
        status: 'failed',
        attempt: job.attempts,
        target: job.target,
        title: job.title,
        preview: preview(job.content),
        error: message,
      });
      return { done: true };
    }
    const delays = Array.isArray(cfg.retryDelaysSec) ? cfg.retryDelaysSec : [10, 60, 300];
    const delaySec = Number(delays[Math.min(job.attempts - 1, delays.length - 1)]) || 10;
    job.nextRunAt = new Date(Date.now() + delaySec * 1000).toISOString();
    job.status = 'retrying';
    log({
      userId: job.userId,
      userName: job.userName,
      channel: job.channel,
      event: job.event,
      status: 'retry',
      attempt: job.attempts,
      target: job.target,
      title: job.title,
      preview: preview(job.content),
      error: `${message}（${delaySec}s 后第 ${job.attempts + 1} 次尝试）`,
    });
    return { done: false };
  }
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const queue = store.loadQueue();
    const now = Date.now();
    let changed = false;
    const keep = [];
    for (const job of queue) {
      if (new Date(job.nextRunAt || 0).getTime() > now) {
        keep.push(job);
        continue;
      }
      // 跳过：渠道被全局关闭
      if (!config.channelEnabled(job.channel)) {
        log({
          userId: job.userId,
          userName: job.userName,
          channel: job.channel,
          event: job.event,
          status: 'skipped',
          attempt: job.attempts || 0,
          target: job.target,
          title: job.title,
          preview: preview(job.content),
          error: '该渠道已被全局关闭，投递取消',
        });
        changed = true;
        continue;
      }
      const { done } = await processJob(job);
      changed = true;
      if (!done) keep.push(job);
    }
    if (changed) store.saveQueue(keep);
  } catch (err) {
    console.error('[notify] 队列处理异常：', err.message);
  } finally {
    running = false;
  }
}

// 调试用：队列当前状态统计
function stats() {
  const queue = store.loadQueue();
  const now = Date.now();
  const byChannel = {};
  let retrying = 0;
  let overdue = 0;
  let nextRunAt = '';
  queue.forEach((job) => {
    byChannel[job.channel] = (byChannel[job.channel] || 0) + 1;
    if (job.status === 'retrying') retrying += 1;
    const at = new Date(job.nextRunAt || 0).getTime();
    if (at <= now) overdue += 1;
    if (!nextRunAt || at < new Date(nextRunAt).getTime()) nextRunAt = job.nextRunAt || '';
  });
  return {
    pending: queue.length,
    retrying,
    overdue,
    nextRunAt,
    byChannel,
    maxAttempts: Number(config.getConfig().maxAttempts) || 3,
    retryDelaysSec: config.getConfig().retryDelaysSec,
  };
}

// 调试用：把最近失败的推送重新入队（重置重试次数）
function requeueFailed(limit = 20) {
  const failed = store
    .loadLogs()
    .filter((row) => row.status === 'failed')
    .sort((a, b) => new Date(b.ts) - new Date(a.ts))
    .slice(0, limit);
  let count = 0;
  failed.forEach((row) => {
    enqueue({
      userId: row.userId,
      userName: row.userName,
      channel: row.channel,
      target: row.target,
      event: row.event,
      title: row.title,
      content: row.preview || '',
    });
    count += 1;
  });
  return count;
}

function startWorker(intervalMs = 3000) {
  if (timer) return;
  timer = setInterval(tick, intervalMs);
  tick();
  const pending = store.loadQueue().length;
  if (pending) console.log(`[notify] 推送队列已恢复，待处理 ${pending} 条`);
}

function stopWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { enqueue, startWorker, stopWorker, tick, log, stats, requeueFailed };
