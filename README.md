# 买个Der（purchase-approval）

> 申请提交 → 审批流转 → 记录查询 的一体化审批系统。
>
> 一套 Node + Express 后端、一套零框架原生前端；同一份前端代码再用 Capacitor 壳打包成 **Android 原生 App**，并提供 **iOS 侧载**方案。三端共用同一套后端与同一份数据。

---

## 一、三端一览

| 端 | 入口文件 | 运行/构建方式 | 产物 |
| --- | --- | --- | --- |
| **网页应用** | `public/index.html` + `public/js/app.js` | `npm start`（Express 直接托管 `public/`） | 访问 `http://localhost:3000` |
| **安卓应用** | `android/app/src/main/java/cn/furry233/purchase/MainActivity.java` | `npm run cap:sync` → `./gradlew assembleDebug` | `android/app/build/outputs/apk/debug/app-debug.apk` |
| **iOS 应用** | `ios-sideload/capacitor.config.json`（壳）+ `public/sideload/`（分发页） | GitHub Actions `Build iOS sideload`（macOS runner + xcodebuild） | 未签名 `.ipa` → 上传到分发页 |
| **后端服务** | `server/index.js` | `npm start`（`node server/index.js`） | 监听 `PORT`（默认 3000），数据落 `data/db.json` |

三端都**不各自实现业务逻辑**：Android/iOS 壳通过 Capacitor 的 `server.url` 加载线上网页（`https://furry233.cn`），原生层只补「应用内下载安装 APK」这类网页做不到的事。

---

## 二、5 分钟本地跑起来

```bash
node -v            # 需要 >= 18
npm install        # 安装依赖（sharp 为原生依赖，需联网编译/下载预编译包）
cp .env.example .env
npm start          # 等价 node server/index.js
```

打开 <http://localhost:3000>。

**首次启动会自动建库**：`data/db.json` 不存在时由 `server/db.js` 的 `seed()` 写入演示账号。

| 账号 | 密码 | 角色 | 能做什么 |
| --- | --- | --- | --- |
| `admin` | `123456` | 超级管理员 | 全部功能，含后台管理 |
| `user` | `123456` | 申请人 | 提交申请、查看自己的申请与结果 |

> 想从干净数据重来：删掉 `data/db.json` 再启动即可（该文件已被 `.gitignore` 排除，不会进仓库）。

---

## 三、目录结构

```
purchase-approval/
├── server/                     后端（Express，CommonJS）
│   ├── index.js                入口：装配中间件、挂载路由与静态目录、启动队列
│   ├── db.js                   数据层：JSON 文件库、角色/权限模型、迁移与种子
│   ├── middleware.js           认证与授权：requireAuth / requireApprover / requireAdmin
│   ├── routes/
│   │   ├── auth.js             /api/auth      注册、登录、登出、当前用户、改昵称
│   │   ├── applications.js     /api/applications  申请单 CRUD、投票审批、重提、撤回
│   │   ├── admin.js            /api/admin     账号、角色权限、登录日志、操作审计
│   │   ├── notify.js           /api/notify    通知设置、Web Push 订阅、投递日志
│   │   └── sync.js             /api/sync      多端增量同步（since 时间戳）
│   └── notify/                 通知子系统
│       ├── index.js            编排层：事件 → 文案 → 入队
│       ├── queue.js            持久化队列：重试退避、日志、worker
│       ├── providers.js        四渠道投递：Web Push / 邮件 / QQ / 微信
│       ├── push.js             Web Push 订阅存储与 VAPID 发送
│       ├── config.js           渠道开关与重试策略（data/notify-config.json）
│       └── store.js            队列与日志的 JSON 读写
├── public/                     网页前端（原生 JS，无框架，ES Module）
│   ├── index.html              唯一 HTML 入口（ES Module 方式引入 js/app.js）
│   ├── version.json            版本清单：前端版本、APK 地址/大小/SHA-256（no-store）
│   ├── sw.js                   Service Worker：预缓存 + 网络优先 + 离线兜底
│   ├── manifest.webmanifest    PWA 清单
│   ├── sideload/               iOS 分发页（ipa.json 描述包信息）
│   └── js/
│       ├── app.js              入口：hash 路由、外壳渲染、标签页快照、同步启动
│       ├── api.js              统一 fetch 封装（带会话 Cookie）
│       ├── ui.js               纯函数 UI 工具：转义、Toast、Modal、分页、徽章
│       ├── appupdate.js        应用内更新（原生插件下载安装 / 网页流式下载）
│       ├── notify.js           待办轮询、桌面通知、角标
│       ├── offline.js          Service Worker 注册、网络状态条、启动画面
│       ├── sync.js             /api/sync 客户端：15s 轮询 + 推送触发 + 离线补偿
│       ├── updater.js          列表静默刷新辅助
│       ├── refresh.js          数据变更后的重取逻辑
│       ├── pushclient.js       Web Push 订阅/退订/状态
│       ├── pushprompt.js       登录后推送授权引导
│       ├── credstore.js        「记住我」凭证加密存储（AES-GCM，非安全上下文降级）
│       ├── version.js          当前前端版本常量 APP_VERSION
│       └── views/              视图模块：apps / form / detail / review / records /
│                               notify / admin / auth / shared
├── android/                    Capacitor Android 壳（Gradle）
│   ├── app/src/main/java/cn/furry233/purchase/
│   │   ├── MainActivity.java   壳入口（继承 BridgeActivity）
│   │   └── plugins/apkinstaller/ApkInstallerPlugin.java  应用内下载安装 APK
│   └── app/build.gradle        versionCode / versionName / 签名配置位
├── ios-sideload/               iOS 壳（Capacitor，仅用于生成 ipa）
│   ├── capacitor.config.json   appId / 加载的服务器地址
│   └── www/index.html          壳内置启动页（重定向到服务器）
├── apk-store/                  最新安卓 APK（发版时由 CI 自动提交，仓库内始终只有一个）
├── deploy/                     运维
│   ├── bump-version.mjs        版本号同步脚本：一处改号，四处生效
│   ├── deploy-aliyun.ps1       增量同步到阿里云并重启 pm2（不含 data/ uploads/）
│   ├── ecosystem.config.cjs    pm2 配置与生产环境变量
│   ├── nginx.conf              Nginx 反向代理样例
│   └── repoint-sideload.ps1    切换分发页域名
├── docs/                       android-app.md、ios-sideload.md、ARCHITECTURE.md
├── test/                       回归测试（form-radio.test.mjs）
├── .github/workflows/          ios-build.yml（macOS runner 构建 iOS）
│                               android-release.yml（打 v* 标签自动构建 APK 并发布 Release）
├── .env.example                环境变量样例（仓库不含 .env）
└── package.json               依赖与脚本（engines: node >= 18）
```

> 运行期生成、不进仓库：`data/`（数据库、通知队列与日志）、`uploads/`（申请附图）、`node_modules/`、`android/build`、`apk-store/*.apk`。详见 `.gitignore`。

---

## 四、环境变量

复制 `.env.example` 为 `.env` 后按需修改（`.env` 已被忽略，不会被提交）。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 服务监听端口 |
| `NODE_ENV` | — | `production` 时会话 Cookie 默认加 `secure`（HTTPS 必需） |
| `COOKIE_SECURE` | 随 `NODE_ENV` | 强制开关会话 Cookie 的 `secure` 属性 |
| `SESSION_SECRET` | 内置占位值 | **生产必须替换**：`openssl rand -hex 32` 生成 |
| `SUPER_ADMINS` | `452465968` | 逗号分隔的账号名，每次启动自动提升为最高权限 |
| `APP_BASE_URL` | — | 站点对外地址，用于通知与推送链接 |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | — | Web Push 凭据，见下 |

**生成 VAPID 密钥**（Web Push 用，仅需一次）：

```bash
node -e "const w=require('web-push');console.log(w.generateVAPIDKeys())"
```

---

## 五、npm scripts

| 命令 | 作用 |
| --- | --- |
| `npm start` / `npm run dev` | 启动服务（`node server/index.js`） |
| `npm test` | 运行 `test/form-radio.test.mjs`（表单选项卡片回归，需可用浏览器） |
| `npm run cap:sync` | `npx cap sync android`：把 `public/` 同步进安卓壳 |
| `npm run cap:open:android` | 用 Android Studio 打开工程 |
| `npm run android:assemble` | `gradlew assembleDebug` 直接产出调试 APK |

---

## 六、构建与发布

### 6.1 网页 / 服务器

```bash
npm install --omit=dev      # 生产只需运行时依赖
# 用 pm2 守护（配置见 deploy/ecosystem.config.cjs）
pm2 start deploy/ecosystem.config.cjs --env production
pm2 save
```

Nginx 反代到 `127.0.0.1:3000` 的样例见 `deploy/nginx.conf`。
日常增量更新：`pwsh deploy/deploy-aliyun.ps1`（仅同步 `server/ public/ deploy/ package*.json` 等，**不会覆盖 `data/` 与 `uploads/`**）。

### 6.2 安卓

```bash
npm install
npm run cap:sync                 # 同步前端到 android/app/src/main/assets/public
cd android && ./gradlew assembleDebug
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`。

发版时**四处版本号必须同步**（详见 `docs/ARCHITECTURE.md`）：

1. `android/app/build.gradle` → `versionCode` / `versionName`
2. `public/version.json` → `version`、`android.latestVersion`、`android.latestCode`
3. `public/js/version.js` → `APP_VERSION`
4. `public/version.json` → `android.apkUrl` / `size` / `sha256`（APK 上传后回填）

**别手工改——用脚本**：

```bash
node deploy/bump-version.mjs --code 7 --name 1.2.7 --changelog "修了某个问题"
# 想先看效果：加 --dry
```

当前版本：`versionCode 6` / `versionName 1.2.6` / `APP_VERSION = beta1.2.6`。

### 6.2.1 APK 自动进仓库 + 自动更新（发版流水线）

APK 已纳入版本控制（`apk-store/`），**每次发版由 CI 自动更新**，无需手工上传：

```bash
# 1）改号并提交
node deploy/bump-version.mjs --code 7 --name 1.2.7
git add -A && git commit -m "chore(release): v1.2.7"

# 2）打标签并推送（这就是流水线触发条件）
git tag v1.2.7
git push origin main && git push origin v1.2.7
```

推送标签后 `android-release.yml` 会自动：

1. `npm ci` → `npx cap sync android` → `gradlew assembleRelease`（未提供 keystore 时回落 debug 包）
2. 把 APK 放进 `apk-store/` 并**提交回 `main`**（仓库内只保留当前版本一个 APK）
3. 回填 `public/version.json` 的 `size` / `sha256` / `apkUrl`（应用内更新靠它校验）
4. 创建/更新同名 **GitHub Release** 并附上 APK

也可以在 Actions 面板手动触发（可临时填 `versionCode` / `versionName`，不填则沿用 `build.gradle`）。

**正式签名**（可选）：仓库 Settings → Secrets 添加 `ANDROID_KEYSTORE_BASE64`（keystore 的 base64）、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`；配了就出 release 包，没配就出 debug 包。`build.gradle` 已支持条件签名（有 keystore 用正式签名，否则回落 debug 签名）。

### 6.3 iOS

iOS 走**侧载**：GitHub Actions 在 macOS runner 上用 `xcodebuild` 产出**未签名 ipa**，由用户用 AltStore / Sideloadly / 爱思助手用自己的 Apple ID 重签名安装。

1. 仓库 Settings → Secrets 添加 `SERVER_HOST`、`SERVER_USER`、`SERVER_PORT`、`SERVER_SSH_KEY`
2. Actions → **Build iOS sideload** → Run workflow（或推送 `ios-v*` 标签）
3. 工作流会把 ipa 与更新后的 `ipa.json` 传到服务器的 `public/sideload/`

分发页：`http://<服务器>/sideload/`。完整说明见 `docs/ios-sideload.md`。

---

## 七、测试

| 文件 | 验证内容 |
| --- | --- |
| `test/form-radio.test.mjs` | 表单「是否有替代品」等选项卡片的单选/多选行为（`npm test`） |
| `_smoke-p1.mjs` 等根目录脚本 | 端到端冒烟：登录、建单、投票、通知、同步（需浏览器，手工执行） |

---

## 八、注意事项

- **数据即文件**：全部业务数据在 `data/db.json`，备份 = 复制该文件；切勿把它提交进仓库。
- **图片**：申请附图存在 `uploads/`，同样不入库；迁移时需单独拷贝。
- **Web Push / PWA 离线**：仅在 HTTPS（或 localhost）下生效。域名需完成 ICP 备案后才可在大陆服务器启用 HTTPS。
- **密钥**：`SESSION_SECRET`、VAPID 私钥、SSH 私钥一律走环境变量或 CI Secrets，`deploy/ecosystem.config.cjs` 只从环境读取。
- **服务器信息不入库**：部署脚本不写死地址，统一从环境变量读取——本地:$env:PA_SERVER = 'root@<你的服务器IP或域名>'
    `$env:PA_SSH_KEY = '<私钥路径>'`（可选，默认 `~/.ssh/id_ed25519`）；
    CI 用 `SERVER_HOST` / `SERVER_USER` / `SERVER_PORT` / `SERVER_SSH_KEY` 四个 Secrets。
- **公开部署前必改**：`SESSION_SECRET`（`openssl rand -hex 32` 生成）、演示账号 `admin` / `user` 的默认密码 `123456`、VAPID 密钥。
- **站点地址**：`capacitor.config.json` 与 `ios-sideload/capacitor.config.json` 里的 `server.url` 需改成你自己的站点。
- **无 git 历史**：本项目此前未纳入版本控制，本仓库为首次提交。

---

## 九、文档索引

| 文档 | 内容 |
| --- | --- |
| `docs/ARCHITECTURE.md` | **整体结构、各模块职责、数据流与交互过程**；安卓 / 网页 / iOS 三端独立说明 |
| `docs/android-app.md` | 安卓壳构建、安装与更新细节 |
| `docs/ios-sideload.md` | iOS 侧载全流程、签名与分发页配置 |
| `deploy/README*` / `deploy/nginx.conf` | 服务器部署与反向代理 |
