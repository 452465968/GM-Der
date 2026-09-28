# 买个Der · iOS 侧载版（Sideload）指南

买个Der是 Node.js + Web 前端的应用。本指南说明如何让它在 iPhone 上以
「类 App」乃至「原生壳 App（侧载 IPA）」的形态运行，全部版本共用同一套后端与数据。

服务器：`https://furry233.cn/`（阿里云）
分发中心：`https://furry233.cn/sideload/`

---

## 一、三条可用路径总览

| 路径 | 形态 | 是否签名 | 是否需要 HTTPS | 有效期 | 使用门槛 |
| --- | --- | --- | --- | --- | --- |
| ① 添加到主屏幕 | 网页全屏（WebClip 式） | 无需 | 否 | 永久 | 最低，Safari 点几下即可 |
| ② IPA 电脑侧载 | 原生壳 App | 免费 Apple ID 自动重签 | 否（电脑传输） | 7 天 | 需电脑 + 安装工具 |
| ③ 企业/开发者 OTA | 原生壳 App | 企业证书 / Ad Hoc | **必须** | 1 年/按证书 | 需证书与域名 |

> 说明：iOS 不允许任意程序直接安装。真·原生 App 只有三种合法来源——App Store、
> 签名 IPA（侧载/OTA）、以及设备描述文件信任。路径① 是 Apple 官方支持的主屏快捷方式，
> 不经过应用沙箱，因此无需签名；路径②③ 才是“完整侧载流程”。

数据互通：三条路径连接的都是同一个服务器、同一套数据库与账号体系
（申请、审批投票、通知完全一致），但在 iPhone 上各自独立存在、登录态互不影响。

---

## 二、服务器端分发中心（已上线）

线上静态目录 `public/sideload/`，对应 URL `/sideload/`：

| 文件 | 作用 |
| --- | --- |
| `index.html` | 中文下载安装页：自动展示产物状态、三类安装指引 |
| `manifest.plist` | OTA 安装清单（供 itms-services 调用），内含 `__DOMAIN__` 占位 |
| `ipa.json` | 构建产物元数据（版本/大小/SHA256/签名状态），安装页实时读取 |
| `PurchaseApproval.ipa` | 构建产物存放位（尚未上传时为占位） |

安装页还会展示应用图标：`/icons/pa-icon.png`。
Express 对 `.plist` 返回 `application/xml`、对 `.ipa` 返回 `application/octet-stream`，
并为 sideload 目录关闭缓存（`Cache-Control: no-store`），更新产物即时生效。

### 如何更新产物（本地手动）
在装有构建产物的 Windows/Mac 上执行：

```powershell
powershell -ExecutionPolicy Bypass -File deploy\upload-ios-artifact.ps1 `
  -Ipa C:\path\PurchaseApproval.ipa -Version 1.0.0 -Build 3
```

已用企业/Ad Hoc 证书签名的产物请加 `-Signed`，安装页将自动开放 OTA 安装按钮。
脚本会自动计算大小与 SHA256 并重写 `ipa.json`。

### 如何启用 HTTPS（仅 OTA 路径③需要）
1. 将域名解析到你的服务器 IP；
2. 服务器上执行 `certbot --nginx -d 你的域名`（或阿里云免费 DV 证书）；
3. 本地执行 `deploy\repoint-sideload.ps1 -Domain 你的域名`，把 `__DOMAIN__` 写入 manifest；
4. 修改 `deploy\ecosystem.config.cjs` 中 `COOKIE_SECURE=true`，重新部署并重启；
5. 重新部署：`powershell -ExecutionPolicy Bypass -File deploy\deploy-aliyun.ps1`。

之后路径③的按钮会点亮，iPhone 点开即装。

---

## 三、构建方式与签名矩阵（路径②③ 需要）

### 方式 A：本地 Mac + Xcode（推荐日常开发）
`ios-sideload/` 已内置 Capacitor 壳工程配置，原生壳指向 `https://furry233.cn`：

```bash
cd ios-sideload
npm install
npx cap add ios      # 首次生成 ios/ 原生工程
npx cap sync ios     # 同步配置与占位资源
open ios/App/App.xcworkspace
```

在 Xcode 中：
1. 修改 Signing & Capabilities → Team 选择你的 Apple ID（免费即可）；
2. 真机运行调试，或 Product → Archive 打正式包；
3. 归档后在 Organizer 导出 IPA（详见下方签名矩阵）；
4. 上传到服务器：`deploy\upload-ios-artifact.ps1`。

> 工程要点：`capacitor.config.json` 设 `server.url` + `cleartext=true`
> （iOS 端自动写入 ATS 例外，允许访问 HTTP 内网/公网明文地址）；
> `appId=cn.purchaseapproval.sideload` 为独立应用标识，与网页版互不冲突。

### 方式 B：GitHub Actions（无需本地 Mac）
仓库已含 `.github/workflows/ios-build.yml`：
1. 将仓库推送到 GitHub；
2. 添加 Secrets：`SERVER_SSH_KEY`（你的服务器登录私钥内容）等（可选，用于自动回传服务器）；
3. Actions → Build iOS sideload → Run workflow；
4. 产物 `PurchaseApproval-unsigned.ipa` 存于 Actions Artifact，配置 Secrets 后会自动
   上传到服务器 `/sideload/` 并刷新 `ipa.json`。

CI 默认产出**未签名 IPA**（`CODE_SIGNING_ALLOWED=NO`）——侧载工具会在你电脑上用你的
Apple ID 重新签名，无需把证书放进 CI。

### 签名矩阵与有效期

| 签名方式 | 证书 | 设备限制 | 有效期 | 分发方式 | 适用 |
| --- | --- | --- | --- | --- | --- |
| 免费 Apple ID（Personal Team） | 无，用你的账号 | 每设备每年上限，最多 3 个 App | 7 天需重签 | AltStore / Sideloadly / 爱思助手 | 个人测试、小范围试用 |
| 开发者证书（$99/年） | Development / Distribution | 开发者证书 100 台真机 | 1 年 | Xcode 直装 / Ad Hoc / TestFlight | 团队内部测试 |
| TestFlight（App Store Connect 通道） | 由苹果托管分发 | 外部测试 90 天，最多 10000 人 | 随构建 90 天 | TestFlight App 内安装 | 广域测试但需审核上架流程 |
| 企业证书（$299/年） | In-House Distribution | 不限设备（仅限企业内部） | 1 年 | **OTA 无线安装**（路径③，itms-services） | 企业内部全员分发 |

> TestFlight 可视为“侧载的苹果官方替代品”：上架审核压力小、真机可装，但用户需
> 安装 TestFlight 且构建 90 天过期；本方案把 OTA（路径③）作为企业场景的等效通道。

### 用 Sideloadly / AltStore 安装（路径②）
1. iPhone 连接电脑（AltStore 需先安装 AltServer）；
2. 选择下载的 `PurchaseApproval.ipa` 导入；
3. 登录 Apple ID → 自动签名安装；
4. 手机上 设置 → 通用 → VPN 与设备管理 → 信任开发者；
5. 打开 App，用现有账号登录即可（与网页版同一套数据）。

---

## 四、数据互通与独立存在（设计说明）

- **同一后端**：侧载版原生壳通过 HTTP 直接加载线上系统，浏览器/主屏/原生壳三者操作
  的都是同一服务器同一数据库，申请、投票、状态实时一致。
- **会话独立**：WKWebView 的 Cookie/存储与 Safari 相互隔离，因此 App 内登录不干扰
  网页登录（如一方退出另一方不受影响）。
- **应用独立**：原生壳拥有独立 `bundle id` 与图标，与主屏快捷方式、浏览器各自独立
  占用主屏；可同时安装三者。
- **版本独立**：IPA 产物拥有独立版本号与 `ipa.json` 元数据；`manifest.plist` 仅描述
  侧载版自身，不影响 Web 版本发布节奏。

---

## 五、安全与限制提示

1. 当前为 **HTTP + IP**，明文传输，仅适合测试环境；正式使用请启用 HTTPS（见上文），
   并把 `COOKIE_SECURE` 置为 `true`。
2. 免费 Apple ID 签名每 7 天需重签一次，重签不会丢失服务器数据（数据都在云端）。
3. 企业证书只可用于本企业分发，违规广域分发会被 Apple 吊销。
4. 上传 IPA 前请确认来源可信；`sha256` 会在安装页展示用于校验。
5. 若 iOS 拦截“未受信任的开发者”，按第四步信任描述文件即可；若使用 OTA，
   请确保 manifest 中的域名与签名描述文件匹配。

---

## 六、iOS 轻应用（Web Clip / 添加到主屏幕 / PWA 增强）

在「路径① 添加到主屏幕」基础上，主站已升级为可安装的轻应用（无需新装任何东西，
iPhone Safari 打开系统首页 → 分享 → 添加到主屏幕 即获得接近原生 App 的体验）：

| 能力 | 实现 | 生效条件 |
| --- | --- | --- |
| 自定义图标 | `apple-touch-icon` + `manifest.webmanifest`（`/icons/pa-icon.png`） | 所有 iOS 版本 |
| 全屏独立运行 | `display: standalone` + `apple-mobile-web-app-capable` | iOS 全版本 |
| 启动画面 | 自绘品牌 Boot-Splash（standalone 启动时展示图标+名称+加载环，≥0.9s 后淡出） | 所有版本（兼容新旧 iOS 对 `apple-touch-startup-image` 支持不一致的问题） |
| 离线可用 | `sw.js`：外壳预缓存 + 静态 SWR + API 网络优先超时回退 + 图片缓存 | **HTTPS（或 localhost）**，因为 iOS 只在安全上下文启用 Service Worker |
| 弱网加速 | API 4.5s 超时回退缓存、静态资源后台更新 | 同上 |
| 离线状态提示 | 断网显示「离线模式 · 展示已缓存内容」小胶囊，恢复联网自动刷新 | 同上 |
| 数据互通与独立 | 与网页版同源同库；主屏 App 拥有独立存储/会话（WKWebView 与 Safari 隔离） | 所有版本 |

离线能力已在本地 `http://localhost`（安全上下文）用无头浏览器全流程实测通过：
**断网后刷新，App 外壳、导航、审批工作台缓存数据均可正常打开/浏览**，联网恢复即自动同步。

> 当前服务器是 `http + IP`，iOS Safari 不会注册 Service Worker，因此离线缓存需在
> 接入 HTTPS 域名后自动生效（操作见本文档「如何启用 HTTPS」），其余图标/全屏/启动画面
> 能力现在即可体验。

## 七、验收 Checklist

- [x] `/sideload/` 安装页可访问（200）
- [x] `/sideload/manifest.plist` 返回 `application/xml` 且含软件包地址
- [x] `/sideload/ipa.json` 元数据接口可访问
- [x] `/icons/pa-icon.png` 图标可访问
- [x] 主页包含 `apple-mobile-web-app-capable`、`manifest.webmanifest`、`apple-touch-icon` 与 Boot-Splash，支持“添加到主屏幕”
- [x] `/manifest.webmanifest` 返回 `application/manifest+json`；`/sw.js` 可访问
- [x] 本地 `localhost` 离线验证通过：断网后外壳/导航/工作台缓存数据可用
- [ ] （接入 HTTPS 后）真机 iPhone 添加主屏幕 → 飞行模式验证离线打开与缓存数据
- [ ] 在 Mac 上构建 `ios-sideload` 产出真实 IPA（或用 GitHub Actions）
- [ ] 执行 `deploy\upload-ios-artifact.ps1` 上传产物，安装页显示“可下载”
- [ ] （可选）接入域名 + HTTPS + 企业签名，点亮 OTA 无线安装
