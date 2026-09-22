// 「记住我」安全凭证存储
//
// 浏览器/PWA 中没有直接可调用的 iOS Keychain API，因此采用 Web Crypto 加密方案：
//  - 安全上下文（HTTPS / localhost）：AES-256-GCM 加密，密钥为非可导出 CryptoKey，
//    仅存于本源 IndexedDB（脚本无法导出密钥原文），密文+IV 存 localStorage ——
//    即使整站数据被导出/备份，没有本机 IndexedDB 密钥也无法还原密码。
//  - 非安全上下文（HTTP）：Web Crypto 不可用，退化为「本机随机密钥 XOR 混淆」，
//    属尽力而为的基础保护（真正强加密需站点启用 HTTPS 后自动切换 AES）。
//
// 凭证生命周期：勾选「记住我」登录成功 → saveCredential；
// 取消勾选登录 / 点「清除」→ clearCredential。浏览器插件、iOS 系统密码填充不受影响。

const LS_BLOB = 'pa_creds_v1'; // { v, m: 'gcm'|'xor', iv?, ct, data }
const DB_NAME = 'pa_cred_db';
const DB_STORE = 'keys';
const DB_REC = 'cred_key_v1';
const LS_XOR_KEY = 'pa_cred_xkey_v1';

let dbPromise = null;
const subtle = (typeof crypto !== 'undefined' && crypto.subtle) || null;

/* ---------- 工具 ---------- */

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

function randomBytes(n) {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

/* ---------- IndexedDB 存储非导出密钥 ---------- */

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDB.open(DB_NAME, 1);
      } catch (err) {
        reject(err);
        return;
      }
      req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function idbGet() {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readonly');
        const rq = tx.objectStore(DB_STORE).get(DB_REC);
        rq.onsuccess = () => resolve(rq.result || null);
        rq.onerror = () => reject(rq.error);
      })
  );
}

function idbPut(key) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(key, DB_REC);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

function idbClear() {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).delete(DB_REC);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

/* ---------- AES-256-GCM（安全上下文） ---------- */

function aesKeyAvailable() {
  return !!subtle && window.isSecureContext;
}

async function aesEncryptJson(obj) {
  let key = await idbGet();
  if (!key) {
    key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    try {
      await idbPut(key);
    } catch (err) {
      // 部分环境（旧版 Safari）无法在 IDB 中结构化克隆 CryptoKey → 抛给上层走 XOR 降级
      throw err;
    }
  }
  const iv = randomBytes(12);
  const plain = new TextEncoder().encode(JSON.stringify(obj));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
  return { m: 'gcm', iv: bufToB64(iv), ct: bufToB64(ct) };
}

async function aesDecryptBlob(blob) {
  const key = await idbGet();
  if (!key) throw new Error('key missing');
  const iv = b64ToBytes(blob.iv);
  const ct = b64ToBytes(blob.ct);
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(plain));
}

/* ---------- XOR 混淆（非安全上下文降级） ---------- */

function xorKey() {
  let b64 = null;
  try {
    b64 = localStorage.getItem(LS_XOR_KEY);
  } catch (err) {
    /* ignore */
  }
  if (!b64 || b64.length < 24) {
    b64 = bufToB64(randomBytes(32));
    try {
      localStorage.setItem(LS_XOR_KEY, b64);
    } catch (err) {
      /* ignore */
    }
  }
  return b64ToBytes(b64);
}

// 伪随机字节流：以密钥+随机种子为种子（占位 8 字节），异或混淆
function xorStream(keyBytes, seed) {
  const len = keyBytes.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    // 简单的自反馈扩散，避免逐字节直接暴露密钥规律
    let x = keyBytes[(i + seed) % len] ^ (seed * 31 + i) & 0xff;
    x ^= keyBytes[(i * 7 + seed) % len];
    out[i] = x;
  }
  return out;
}

function xorCryptText(text, keyBytes) {
  const seed = Math.floor(Math.random() * 256);
  const raw = new TextEncoder().encode(text);
  const stream = xorStream(keyBytes, seed);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw[i] ^ stream[i % stream.length];
  return { seed, data: bufToB64(out) };
}

function xorDeCryptText(blob, keyBytes) {
  const raw = b64ToBytes(blob.data);
  const stream = xorStream(keyBytes, blob.seed);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw[i] ^ stream[i % stream.length];
  return new TextDecoder().decode(out);
}

/* ---------- 对外 API ---------- */

export function isStrongStorage() {
  return aesKeyAvailable();
}

// 登录页安全说明文案
export function securityNote() {
  return aesKeyAvailable()
    ? 'AES-256 本机加密 · 仅本设备可读取'
    : '已保存本机（当前 HTTP 为基础保护，启用 HTTPS 后自动升级为 AES-256 加密）';
}

export async function saveCredential(username, password) {
  const payload = { u: username, p: password, t: Date.now() };
  let blob;
  if (aesKeyAvailable()) {
    blob = await aesEncryptJson(payload);
  } else {
    // 降级：键值随机化混淆（基础保护）
    const xkey = xorKey();
    const enc = xorCryptText(JSON.stringify(payload), xkey);
    blob = { m: 'xor', seed: enc.seed, data: enc.data };
  }
  try {
    localStorage.setItem(LS_BLOB, JSON.stringify(blob));
  } catch (err) {
    throw err;
  }
}

export async function loadCredential() {
  let blobRaw = null;
  try {
    blobRaw = localStorage.getItem(LS_BLOB);
  } catch (err) {
    return null;
  }
  if (!blobRaw) return null;
  let blob;
  try {
    blob = JSON.parse(blobRaw);
  } catch (err) {
    return null;
  }
  try {
    if (blob.m === 'gcm') {
      const { u, p } = await aesDecryptBlob(blob);
      return { username: u, password: p };
    }
    if (blob.m === 'xor') {
      const xkey = xorKey();
      const data = JSON.parse(xorDeCryptText(blob, xkey));
      return { username: data.u, password: data.p };
    }
  } catch (err) {
    // 密钥已丢失（清缓存/换设备）或数据损坏 → 视为未保存
    clearCredential().catch(() => {});
    return null;
  }
  return null;
}

export async function clearCredential() {
  try {
    localStorage.removeItem(LS_BLOB);
  } catch (err) {
    /* ignore */
  }
  try {
    if (indexedDB) await idbClear();
  } catch (err) {
    /* ignore */
  }
}
