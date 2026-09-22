const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const LOG_FILE = path.join(DATA_DIR, 'notify-log.json');
const QUEUE_FILE = path.join(DATA_DIR, 'notify-queue.json');
const MAX_LOGS = 2000; // 日志上限，超出丢弃最旧的记录

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  ensureDir();
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error('[notify] 读取失败，已重置：', file, err.message);
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/* ------------------------------ 发送队列（待投递 / 重试中） ------------------------------ */

function loadQueue() {
  const list = readJson(QUEUE_FILE, []);
  return Array.isArray(list) ? list : [];
}

function saveQueue(list) {
  writeJson(QUEUE_FILE, list);
}

/* ------------------------------ 发送日志 ------------------------------ */

function loadLogs() {
  const list = readJson(LOG_FILE, []);
  return Array.isArray(list) ? list : [];
}

function appendLog(entry) {
  const logs = loadLogs();
  logs.push(entry);
  const trimmed = logs.length > MAX_LOGS ? logs.slice(logs.length - MAX_LOGS) : logs;
  writeJson(LOG_FILE, trimmed);
  return entry;
}

function listLogs({ userId, limit = 50, all = false } = {}) {
  let logs = loadLogs();
  if (!all && userId) logs = logs.filter((row) => row.userId === userId);
  logs = logs.slice().sort((a, b) => new Date(b.ts) - new Date(a.ts));
  return logs.slice(0, limit).map((row) => ({
    id: row.id,
    ts: row.ts,
    userId: row.userId,
    userName: row.userName,
    channel: row.channel,
    event: row.event,
    status: row.status, // sent | retry | failed | skipped
    attempt: row.attempt || 1,
    target: row.target || '',
    title: row.title || '',
    preview: row.preview || '',
    error: row.error || '',
  }));
}

module.exports = { loadQueue, saveQueue, appendLog, listLogs, loadLogs, LOG_FILE, QUEUE_FILE };
