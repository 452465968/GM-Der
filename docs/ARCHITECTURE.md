# 买个Der · 架构说明

面向「接手项目的人」：讲清整体结构、每个模块干什么、数据怎么流动、三端（网页 / 安卓 / iOS）各自怎么跑起来与怎么构建。

---

## 0. 整体结构

```
        ┌───────────────┐   ┌────────────────┐   ┌──────────────┐
        │  浏览器网页    │   │ Android 原生壳  │   │ iOS 侧载壳    │
        │ public/*.html │   │ Capacitor+WebView│  │ Capacitor+WKWebView
        └───────┬───────┘   └────────┬───────┘   └──────┬───────┘
                │ 同源 HTTP │         │ server.url       │ server.url
                └───────────┴─────────┴──────────────────┘
                                    │
                        ┌───────────▼───────────┐
                        │  server/index.js      │  Express
                        │  ├ /api/auth          │
                        │  ├ /api/applications  │
                        │  ├ /api/admin         │
                        │  ├ /api/notify        │
                        │  └ /api/sync          │
                        └───────────┬───────────┘
                    ┌───────────────┼────────────────┐
              ┌─────▼─────┐  ┌─────▼──────┐  ┌──────▼───────┐
              │ server/db.js│ │notify/queue│  │ uploads/ 图片 │
              │ data/db.json│ │ 通知队列    │  └──────────────┘
              └────────────┘ └────────────┘
```

**关键设计**：业务逻辑只在后端一份。Android / iOS 壳不重写界面，而是通过 Capacitor 的 `server.url` 直接加载线上网页；原生层仅补网页做不到的事（Android 应用内下载安装 APK）。因此前端改一行代码，三端同时生效——但**壳需要重新打包的场景**只有：改原生插件、改版本号、改 `capacitor.config.json`。

---

## 1. 后端（server/）

### 1.1 启动流程（server/index.js）

```
加载 .env（如有） → express.json/urlencoded → express-session(pa.sid, 7d)
  → 挂载路由 /api/auth /api/applications /api/admin /api/notify /api/sync
  → 静态托管 public/ 、/uploads 、/sideload 、/sideload/downloads
  → /version.json 单独以 no-store 响应（供版本自检）
  → db.seed()：建库 / 字段迁移 / 提升 SUPER_ADMINS
  → notify 队列 worker 启动
  → listen(PORT || 3000)
```

### 1.2 模块职责

| 文件 | 职责 |
| --- | --- |
| `server/index.js` | 进程入口：中间件、路由、静态目录、种子与队列启动 |
| `server/db.js` | 唯一数据出入口。内存 `state` + 原子落盘（`data/db.json`）；角色/权限字典；字段迁移；`seed()` 演示账号与超管提升；`publicUser()` 裁剪敏感字段 |
| `server/middleware.js` | `requireAuth` / `requireApprover` / `requireAdmin(perm)`；`hasPermission` / `isSuperAdmin` / `isPrivileged` 判定 |
| `server/routes/auth.js` | 注册、登录、登出、当前用户、改昵称；写登录日志 |
| `server/routes/applications.js` | 核心业务：建单、列表、统计、记录、通知摘要、详情、投票审批、修改重提、撤回；图片上传；可见性裁剪 |
| `server/routes/admin.js` | 账号 CRUD、角色权限分配、登录日志、操作审计（逐接口权限守卫） |
| `server/routes/notify.js` | 个人通知设置、测试推送、Web Push 订阅管理、投递日志、`debug/*` 排障接口 |
| `server/routes/sync.js` | 增量同步 `GET /api/sync?since=`、心跳 `/ping` |
| `server/notify/index.js` | 编排层：业务事件 → 文案 → 入队（`onApplicationCreated` / `onApplicationDecided`） |
| `server/notify/queue.js` | 持久化队列：落盘、退避重试、日志、worker 定时驱动 |
| `server/notify/providers.js` | 四渠道真实投递：Web Push / 邮件 / QQ(OneBot) / 微信(企业微信、Server酱) |
| `server/notify/push.js` | Web Push 订阅存储与 VAPID 发送 |
| `server/notify/config.js` | 渠道开关与重试策略（`data/notify-config.json`） |
| `server/notify/store.js` | 队列与日志的 JSON 读写 |

### 1.3 接口清单

| 模块 | 方法与路径 | 说明 |
| --- | --- | --- |
| 认证 | `POST /api/auth/register` | 注册（**只产出审批人身份**，忽略请求体中的 role） |
| | `POST /api/auth/login` / `logout` | 登录（bcrypt 校验 + 写登录日志）/ 登出 |
| | `GET /api/auth/me`、`PATCH /api/auth/profile` | 当前用户 / 修改昵称 |
| 申请 | `POST /api/applications` | 新建申请（含图片上传、投票规则） |
| | `GET /api/applications` | 我的申请列表（分页 + 关键字/状态筛选） |
| | `GET /api/applications/stats` | 顶部统计条 |
| | `GET /api/applications/records` | 审批记录（按状态分段） |
| | `GET /api/applications/notifications` | 通知页的活动摘要 |
| | `GET /api/applications/approver-options` | 可选投票人列表 |
| | `GET /api/applications/:id` | 详情（含本轮各投票人结果） |
| | `POST /api/applications/:id/decision` | 投票：同意 / 拒绝（带意见） |
| | `POST /api/applications/:id/resubmit` | 被拒后修改重提（可换图） |
| | `POST /api/applications/:id/cancel` | 申请人撤回 |
| 后台 | `GET /api/admin/bootstrap` | 一次性取账号/角色/权限字典 |
| | `GET /api/admin/users`、`POST /api/admin/users`、`PATCH /api/admin/users/:id`、`DELETE /api/admin/users/:id` | 账号管理（分别需 `account:view/create/edit/delete`） |
| | `GET /api/admin/roles`、`PUT /api/admin/roles/:key` | 角色默认权限（需 `role:manage`） |
| | `GET /api/admin/logs`、`GET /api/admin/audit` | 登录日志（需 `log:view`）/ 操作审计（需 `audit:view`） |
| 通知 | `GET` / `PUT /api/notify/settings` | 个人渠道开关与接收地址 |
| | `POST /api/notify/test` | 给自己发一条测试推送 |
| | `GET /api/notify/logs` | 投递日志（已发送/重试中/失败/已跳过） |
| | `GET` / `PUT /api/notify/config` | 全局渠道开关与重试策略 |
| | `GET /api/notify/push/public-key`、`GET /push/status`、`POST /push/subscribe`、`POST /push/unsubscribe` | Web Push 订阅生命周期 |
| | `GET /debug`、`POST /debug/simulate`、`GET /debug/subscriptions`、`POST /debug/clean-stale`、`POST /debug/broadcast`、`POST /debug/retry-failed` | 排障用：模拟事件、订阅列表、清理失效订阅、广播、重投失败 |
| 同步 | `GET /api/sync?since=<ISO>` | 返回「可见 && updatedAt > since」的变更（单页 ≤200，`hasMore` 提示翻页） |
| | `GET /api/sync/ping` | 心跳，用于探活与时钟对齐 |

### 1.4 数据模型（data/db.json）

| 集合 | 内容 | 关键字段 |
| --- | --- | --- |
| `users` | 账号 | `id/username/passwordHash/role/permissions[]/notify{channels,addresses}/disabled/lastLoginAt` |
| `applications` | 申请单 | `id/title/item/price/platform/link/reason/images[]/status/createdBy/approval{voters[],passVotes}/updatedAt` |
| `approvals` | 审批流水 | 每次状态流转与投票意见，供详情页时间线展示 |
| `logins` | 登录日志 | 账号、时间、IP、UA、结果（保留约 2000 条） |
| `adminLogs` | 操作审计 | 后台账号/权限变更记录 |
| `rolePerms` | 角色默认权限 | 可在后台「角色权限」页调整 |

`passwordHash` 永远不出现在任何响应中（`publicUser()` 统一裁剪）。

### 1.5 角色与权限

| 角色 | 默认权限 | 能力 |
| --- | --- | --- |
| `user` 申请人 | 无 | 提交申请、看自己的申请与结果 |
| `approver` 审批人 | `data:all` | 可被指派为投票人，查看全部申请 |
| `admin` 超级管理员 | `*` | 全部功能 |

细粒度权限 key：`account:view/create/edit/delete`、`role:manage`、`log:view`、`audit:view`、`data:all`。
判定规则：`role === 'admin'` 或 `permissions` 含 `*` → 超管；否则按 key 匹配。`SUPER_ADMINS` 环境变量里的账号每次启动都会被提升为超管（防止改数据把自己锁死）。

### 1.6 申请状态机与投票制

```
                  ┌─────────────── 撤回 cancel ───────────────┐
                  ▼                                            │
  pending ──同意票达 M──▶ approved                              │
     │                                                         │
     ├──拒绝后修改重提 resubmit ──▶ resubmitted ──▶ pending ─────┘
     │
     └──剩余票数不足以凑够 M 时自动▶ rejected
```

- `approval.voters`：被指派的投票人（最多 10 人）；`approval.passVotes`：通过所需票数 M（1 ~ 投票人数）。
- 每次投票写入 `approvals` 流水，并实时重算：同意数 ≥ M → `approved`；已投反对数使得「剩余未投票数 + 已同意数 < M」→ `rejected`。
- 被拒后申请人可修改内容重新提交（`resubmitted` → 回到 `pending`，**清空本轮投票**）。

### 1.7 通知子系统

```
业务事件（建单 / 审批结果 / 撤回）
   → notify/index.js 拼文案、筛渠道（系统级开关 ∧ 用户级开关）
   → queue.js 入队落盘（data/notify-queue.json）
   → worker 定时取出 → providers.js 按渠道投递
        ├─ webpush（需 HTTPS + VAPID）
        ├─ email（SMTP）
        ├─ qq（OneBot HTTP）
        └─ wechat（企业微信机器人 / Server酱）
   → 成功/失败写日志；失败按 retryDelaysSec 退避重试，超过 maxAttempts 记为失败
```

### 1.8 增量同步

客户端带上上次同步时间 `since`，服务端用**与列表接口同一个 `canView()`** 过滤可见性后返回变更集，保证多端口径一致。客户端 `public/js/sync.js` 默认 15 秒轮询，断网暂停、恢复即补；Service Worker 收到系统推送时也会 `postMessage` 触发一次立即同步。

---

## 2. 网页应用（public/）

### 2.1 入口文件

| 文件 | 作用 |
| --- | --- |
| `public/index.html` | **唯一 HTML**。声明式引入 `<script type="module" src="./js/app.js">`，挂载 `#app` 容器与 PWA manifest |
| `public/js/app.js` | 前端入口：hash 路由、外壳渲染、登录态引导、启动同步/通知/版本自检 |
| `public/css/style.css` | 全站样式（无 CSS 框架） |
| `public/sw.js` | Service Worker（PWA 离线） |
| `public/manifest.webmanifest` | PWA 清单 |
| `public/version.json` | 版本清单（前端版本 + APK 下载地址/大小/SHA-256） |

### 2.2 核心模块职责

| 模块 | 职责 |
| --- | --- |
| `js/app.js` | hash 路由（`#/apps`、`#/apps/new`、`#/apps/:id`、`#/apps/:id/edit`、`#/review`、`#/records`、`#/notify`、`#/admin`）；侧边栏/顶栏/移动端底栏；**标签页快照缓存 10 分钟**（切换零请求，改动数据的页面离开时弃快照） |
| `js/api.js` | 统一 `fetch`：`get/post/put/patch/del/upload`，带 `credentials: same-origin`，统一错误提示 |
| `js/ui.js` | 纯函数 UI 工具：`esc` 转义、金额/时间格式化、状态徽章、Toast、Modal、分页器 |
| `js/views/*.js` | 9 个视图：`apps`（我的申请）、`form`（新建/重提）、`detail`（详情与投票、重提、撤回）、`review`（审批工作台/待我投票）、`records`（审批记录）、`notify`（通知设置与投递日志）、`admin`（后台五个标签页）、`auth`（登录注册）、`shared`（列表页公共片段与选项卡片） |
| `js/appupdate.js` | 应用内更新：比版本 → 原生插件下载安装（Android）或浏览器流式下载（网页） |
| `js/notify.js` | 待办轮询（30s）、桌面通知、角标；后台时入队，回前台再弹 |
| `js/offline.js` | 注册 Service Worker、网络状态提示条、启动画面 |
| `js/sync.js` | 增量同步客户端（15s 轮询 + 推送触发 + 离线补偿），数据变化时回调界面 |
| `js/updater.js` / `js/refresh.js` | 列表静默刷新辅助 |
| `js/pushclient.js` / `js/pushprompt.js` | Web Push 订阅/退订；登录后的授权引导浮窗 |
| `js/credstore.js` | 「记住我」：安全上下文用 AES-GCM（密钥存 IndexedDB），否则降级为混淆存储 |
| `js/version.js` | `APP_VERSION` 常量，与 `version.json` 的 `version` 保持一致 |

### 2.3 渲染与交互过程

```
地址栏 hash 变化
  → app.js 解析路由，若未登录先渲染登录页
  → 命中标签页且快照未过期 → 直接复用 DOM（零请求）
  → 否则调用对应 views/*.js 的 render()
       → api.js 发请求
       → 拼 HTML 字符串（ui.js 转义防 XSS）
       → 事件委托绑定点击
  → 侧边栏角标、统计条由 notify.js / stats 接口驱动
  → sync.js 收到变更 → onSync 回调 → 当前列表静默重取（不打断表单）
```

没有虚拟 DOM、没有框架：一切都是「字符串模板 + 事件委托」。好处是零构建、改完刷新即生效；代价是需要注意 `esc()` 转义。

### 2.4 PWA 与离线（sw.js）

| 缓存层 | 策略 |
| --- | --- |
| 应用外壳 `SHELL` | 安装时预缓存（`/index.html`、核心 js/css），离线也能开壳 |
| 静态资源 `STATIC` | stale-while-revalidate（先用旧的后台更新） |
| 接口 `API` | 网络优先 + 4.5s 超时，超时/失败回退缓存副本 |
| 图片 `IMG`（`/uploads`、`/icons`） | 缓存优先，后台更新 |

改了外壳文件请递增 `SHELL_VERSION` 触发更新。注意：**PWA 与 Web Push 仅在 HTTPS（或 localhost）下生效**。

### 2.5 运行与构建方式

网页端**没有构建步骤**——`public/` 就是可直接托管的静态资源。

```bash
npm install && npm start     # 服务同时托管 public/，访问 http://localhost:3000
```

生产环境由 pm2 守护进程 + Nginx 反代（见 `deploy/`）。

---

## 3. 安卓应用（android/）

### 3.1 入口文件

| 文件 | 作用 |
| --- | --- |
| `android/app/src/main/java/cn/furry233/purchase/MainActivity.java` | **原生入口**，继承 `BridgeActivity`，把 WebView 指向 `capacitor.config.json` 的 `server.url` |
| `android/app/src/main/AndroidManifest.xml` | 权限声明：网络、安装未知应用、FileProvider |
| `android/app/src/main/res/xml/file_paths.xml` | 供安装器读取已下载 APK 的 FileProvider 路径 |
| `capacitor.config.json` | `appId: cn.furry233.purchase`、`server.url: https://furry233.cn` |
| `android/app/build.gradle` | `namespace/applicationId = cn.furry233.purchase`、`versionCode 6`、`versionName "1.2.6"` |
| `android/variables.gradle` | `minSdk 22`（Android 5.1）、`targetSdk 34`、`compileSdk 35` |

### 3.2 核心模块：`ApkInstallerPlugin`

路径：`android/app/src/main/java/cn/furry233/purchase/plugins/apkinstaller/ApkInstallerPlugin.java`
前端调用：`window.Capacitor.Plugins.ApkInstaller.*`

| 方法 | 作用 |
| --- | --- |
| `canInstall()` | 查询「允许安装未知来源应用」权限（Android 8+） |
| `requestPermission()` | 跳系统设置页请求该权限 |
| `install(url, sha256, packageName)` | 后台线程下载 → 计算 SHA-256 比对 → 校验 APK 包名 → FileProvider 拉起系统安装界面 |

事件：`progress`（百分比/已下载/总大小）、`result`（`installed` / `cancelled` / `failed` + 原因）。
安全约束：不做静默安装（必须用户确认）；完整性或包名校验失败立即中止并清理临时文件。

### 3.3 构建方式

前置：JDK 17、Android SDK（`ANDROID_HOME`），`platforms;android-35` + `build-tools;35.0.0`。

```bash
npm install
npm run cap:sync                                   # 把 public/ 同步进 android/app/src/main/assets/public
cd android
./gradlew assembleDebug                            # 调试包（zip 解压后需 chmod +x gradlew）
# ./gradlew assembleRelease                        # 发布包（需先配签名）
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`。

**发版时四处版本号必须同步**：

1. `android/app/build.gradle` → `versionCode`（递增）/ `versionName`
2. `public/version.json` → `version`、`android.latestVersion`、`android.latestCode`
3. `public/js/version.js` → `APP_VERSION`
4. `public/version.json` → `android.apkUrl` / `size` / `sha256`（APK 上传后回填：`shasum -a 256 xxx.apk`）

#### APK 自动进仓库与发版（`android-release.yml`）

APK 已纳入版本控制（`apk-store/`），发版时由 CI 自动替换，流程：

```
本地：node deploy/bump-version.mjs --code 7 --name 1.2.7   （改号，四处同步）
      git commit && git tag v1.2.7 && git push origin main && git push origin v1.2.7
        ↓
CI：  npm ci → npx cap sync android → gradlew assembleRelease（无 keystore 则 debug）
        ↓
      APK 写入 apk-store/ → 提交回 main → 回填 version.json 的 size/sha256/apkUrl
        ↓
      创建/更新 GitHub Release，附 APK 附件
```

签名策略：`build.gradle` 已是**条件签名**——提供 `ANDROID_KEYSTORE_FILE`（及密码/别名）就用正式签名，否则回落 debug 签名。CI 通过 Secrets 注入（`ANDROID_KEYSTORE_BASE64` 等）。注意：debug keystore 换机器后会变，可能导致旧版无法覆盖安装，正式分发务必配正式 keystore。

### 3.4 应用内更新流程

```
App 启动 → GET /version.json（no-store）
  → android.latestCode > 当前 versionCode ？
      → 弹窗展示版本/更新内容/大小
      → 确认 → ApkInstaller.install(url, sha256, packageName)
          → 原生下载（进度条）→ SHA-256 校验 → 包名校验 → 系统安装界面
          → 用户安装/取消/失败，前端收到 result 事件（失败可一键重试，最多 3 次）
```

---

## 4. iOS 应用（ios-sideload/ + public/sideload/）

本项目**不上架 App Store**，走侧载：产出**未签名 ipa**，由用户用 AltStore / Sideloadly / 爱思助手以自己的免费 Apple ID 重签名安装。

### 4.1 入口文件

| 文件 | 作用 |
| --- | --- |
| `ios-sideload/capacitor.config.json` | 壳配置：`appId: cn.purchaseapproval.sideload`、`server.url: https://furry233.cn`、`cleartext: true` |
| `ios-sideload/www/index.html` | 壳内置启动页（重定向到服务器） |
| `ios-sideload/package.json` | 壳依赖：`@capacitor/{core,cli,ios} ^6.3.0`；脚本 `cap:add` / `cap:sync` |
| `.github/workflows/ios-build.yml` | **构建入口**：macOS runner → `npx cap add/sync ios` → `xcodebuild archive` → 打包未签名 ipa → 上传服务器 |
| `public/sideload/index.html` | **分发页**：展示版本、大小、SHA-256、安装方式与注意事项 |
| `public/sideload/ipa.json` | 包描述（version/build/file/size/sha256/signed/available…），分发页读取它 |

### 4.2 构建方式

**方式 A：GitHub Actions（推荐，无需 Mac）**

1. 仓库 Settings → Secrets 添加 `SERVER_HOST`、`SERVER_USER`、`SERVER_PORT`、`SERVER_SSH_KEY`
2. Actions → **Build iOS sideload** → Run workflow（或推送 `ios-v*` 标签自动触发）
3. 产物：未签名 `.ipa` 作为 Actions artifact，同时 scp 到服务器 `public/sideload/` 并刷新 `ipa.json`

**方式 B：本地有 Mac + Xcode**

```bash
cd ios-sideload
npm ci
npx cap add ios
npx cap sync ios
xcodebuild -workspace ios/App/App.xcworkspace -scheme App -configuration Release \
  -archivePath build/PA.xcarchive -allowProvisioningUpdates CODE_SIGNING_ALLOWED=NO archive
mkdir -p build/Payload && cp -R build/PA.xcarchive/Products/Applications/App.app build/Payload/
cd build && zip -q -r PurchaseApproval-unsigned.ipa Payload -x '*.DS_Store'
```

### 4.3 安装与限制

- 未签名 ipa **不能**直接装，也**不能**用 OTA（`itms-services`）安装；需侧载工具重签名（免费 Apple ID 签名有效期 7 天，到期重签）。
- 若要 OTA 安装，必须改用 Enterprise 或 Ad Hoc 签名导出，且服务器启用 HTTPS。
- 壳内 `server.url` 指向生产域名；**域名未完成 ICP 备案时服务器 HTTPS 不可用**，此时 iOS 端需先把域名指向可访问的地址。
- 详见 `docs/ios-sideload.md`。

---

## 5. 端到端数据流（一次完整业务）

```
① 登录   浏览器 → POST /api/auth/login → bcrypt 校验 → session(pa.sid) → publicUser
         前端把它存进 app.js 状态；勾选「记住我」则经 credstore.js 加密保存

② 建单   form.js 选投票人 + 设定通过票数 M
         → POST /api/applications（multipart，含图片）
         → multer 落 uploads/ → 校验字段与投票规则
         → 写 applications（status=pending，approval={voters,passVotes:M}）
         → pushLog 写 approvals 流水
         → notify.onApplicationCreated → 队列 → 四渠道通知投票人

③ 投票   detail.js / review.js → POST /api/applications/:id/decision
         → 校验「我是本轮投票人且未投过」
         → 记录同意/拒绝 + 意见 → 重算：
             agrees >= M                     → approved
             rejects 使剩余票凑不够 M        → rejected
             否则                            → 仍 pending
         → pushLog → notify.onApplicationDecided → 通知申请人

④ 重提/撤回  被拒后 resubmit（清空本轮投票，回到 pending）/ 申请人 cancel（cancelled）

⑤ 多端同步   sync.js 每 15s：GET /api/sync?since=lastSyncAt
         → 服务端 canView + shape 裁剪 → 变更集 → 前端静默刷新列表

⑥ 更新   appupdate.js 读 /version.json → 与 APP_VERSION / versionCode 比对
         → Android 走 ApkInstaller 原生安装；网页走浏览器下载
```

---

## 6. 部署与运维

| 环节 | 做法 |
| --- | --- |
| 进程 | pm2 托管 `server/index.js`，配置见 `deploy/ecosystem.config.cjs`（`--env production`） |
| 反代 | Nginx 反代 `127.0.0.1:3000`，样例见 `deploy/nginx.conf` |
| 更新 | `pwsh deploy/deploy-aliyun.ps1`：仅同步 `server/ public/ deploy/ package*.json` 等，**绝不覆盖 `data/` 与 `uploads/`**，然后 `pm2 restart --update-env` |
| 备份 | 备份 = 复制 `data/db.json` + `uploads/`（全部业务数据与图片在这两处） |
| 密钥 | `SESSION_SECRET`、VAPID 私钥、SSH 私钥一律走环境变量 / CI Secrets |

生产环境必做检查：`SESSION_SECRET` 换成随机值、`COOKIE_SECURE=true`、`APP_BASE_URL` 指向 HTTPS 地址、Node ≥ 18。

---

## 7. 约定与常见坑

1. **改前端不用重新打包 App**：改 `public/` 后三端刷新即生效；只有改原生插件/版本号才需要重新构建壳。
2. **`version.json` 必须 no-store**：已被 `server/index.js` 特殊处理，改缓存策略会导致更新自检失效。
3. **可见性只有一处判定**：列表、同步、详情都复用 `applications.js` 的 `canView()`，新增过滤条件只改这里。
4. **图片不入库**：`uploads/` 与 `data/` 都被 `.gitignore` 排除；换机器要单独迁移。
5. **PWA/推送依赖 HTTPS**：本地开发用 `localhost` 也行；生产需先完成域名备案与证书签发。
6. **安卓签名**：`build.gradle` 已支持条件签名（有 keystore 用正式签名，否则回落 debug 签名）；正式分发请配置 keystore 并注入 CI Secrets，否则换机构建会导致旧版无法覆盖安装。
7. **无历史包袱也无 Git 历史**：本项目此前未纳入版本控制，建议从现在起每个改动都提交，并在发版时打标签。
