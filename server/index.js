/**
 * 服务端入口
 *
 * 职责：装配 Express 应用并启动进程。
 *   1. 解析 JSON/表单请求体；
 *   2. 配置会话（Cookie 名 pa.sid，7 天有效，生产默认 secure）；
 *   3. 挂载 5 组业务路由：/api/auth、/api/applications、/api/notify、/api/admin、/api/sync；
 *   4. 挂载静态资源：public（前端）、/uploads（申请附图）、/sideload（iOS 分发页）、
 *      /sideload/downloads（APK 分发，刻意放在 public 之外以免被打包进 App）；
 *   5. /version.json 单独以 no-store 响应，供前端/原生壳做版本自检；
 *   6. 启动前执行 db.seed()（建库/迁移/提升超管），并启动通知队列 worker。
 * 数据流：浏览器/原生壳 → Express 路由 → server/db.js 读写 data/db.json → 响应 JSON；
 * 业务变更（新建/审批/撤回）会调用 server/notify 入队通知，由队列异步投递。
 */
const path = require('path');
const express = require('express');
const session = require('express-session');
const db = require('./db');
const authRoutes = require('./routes/auth');
const applicationRoutes = require('./routes/applications');
const notifyRoutes = require('./routes/notify');
const adminRoutes = require('./routes/admin');
const syncRoutes = require('./routes/sync');
const notifyQueue = require('./notify/queue');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
// 默认生产环境启用 secure cookie（需 HTTPS）；用 HTTP + IP 部署时设 COOKIE_SECURE=false
const COOKIE_SECURE = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : IS_PROD;

if (IS_PROD) {
  app.set('trust proxy', 1);
  if (!process.env.SESSION_SECRET) {
    console.warn('[warn] 生产环境未设置 SESSION_SECRET，正在使用默认密钥，请务必配置后重启');
  }
}

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    name: 'pa.sid',
    secret: process.env.SESSION_SECRET || 'purchase-approval-dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: COOKIE_SECURE,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

// 版本清单：供轻应用启动自检（必须禁用缓存，否则检测不到新版本）
app.get('/version.json', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.sendFile(path.join(db.ROOT, 'public', 'version.json'));
});

app.use('/api/auth', authRoutes);
app.use('/api/applications', applicationRoutes);
app.use('/api/notify', notifyRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/sync', syncRoutes);

app.use('/uploads', express.static(db.UPLOAD_DIR, { maxAge: '7d' }));

// APK 分发目录（不在 public/webDir 内，避免被 Capacitor 打进应用包）
app.use(
  '/sideload/downloads',
  express.static(path.join(db.ROOT, 'apk-store'), {
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-store');
    },
  })
);

// iOS sideload center: make sure .plist gets application/xml for itms-services,
// .ipa gets octet-stream, and assets are not cached between deployments.
app.use(
  '/sideload',
  express.static(path.join(db.ROOT, 'public', 'sideload'), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.plist')) res.type('application/xml');
      if (filePath.endsWith('.ipa')) res.type('application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
    },
  })
);

app.use(express.static(path.join(db.ROOT, 'public')));

app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

db.seed();
// 启动通知推送队列（含失败退避重试，进程重启后继续处理未完成的任务）
notifyQueue.startWorker();

app.listen(PORT, () => {
  console.log(`买个Der已启动： http://localhost:${PORT}`);
});
