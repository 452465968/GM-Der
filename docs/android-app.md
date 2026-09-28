# Android 客户端（手机 / 平板统一版）

## 架构

采用 **Capacitor** 将现有 Web 应用封装为 Android 原生壳：

```
Android App (Capacitor WebView)
        │  加载 https://furry233.cn（集中式服务器）
        ▼
Express + JSON 数据存储（唯一数据源）
        ▲
  网页 / iPhone 轻应用 / 平板 共用同一后端
```

- **同一套代码、同一套后端**：Android、iPhone 轻应用、网页完全一致的功能与界面，不存在两套实现
- **统一设计规范**：响应式布局 + 同一份 CSS 设计变量，手机（竖屏单列）与平板（≥1024 固定内容宽度 1100px、四列统计栅格）结构一致
- **集中式数据**：所有客户端读写同一数据库，不做本地数据库分叉

## 目录

```
capacitor.config.json   # Capacitor 配置（appId / appName / 服务器地址）
android/                # 由 npx cap add android 生成的原生工程（Gradle）
public/                 # Web 资源（webDir），同时服务网页与 App
```

## 构建步骤（需要 Android SDK）

```bash
npm install                 # 安装 Capacitor 依赖
npm run cap:add:android     # 首次生成 android/ 工程（已生成，可跳过）
npm run cap:sync            # 同步 Web 资源与插件到原生工程
npm run cap:open:android    # 用 Android Studio 打开
# 或在 Android Studio 中 Build → Build Bundle(s)/APK(s)
# 命令行：cd android && gradlew assembleDebug（需已安装 Android SDK）
```

要求：JDK 17+、Android SDK（compileSdk 34+）、Android Studio（可选）。

## 多端一致性

| 维度 | 实现 |
| --- | --- |
| 视觉 | 同一 CSS 变量（颜色/圆角/间距/字体），`@media (min-width:1024px)` 统一内容宽度与栅格 |
| 交互 | 同一套视图模块（登录、申请、审批、记录、通知设置、后台管理），无平台分支 |
| 功能 | 服务端接口唯一，端上不实现业务规则 |
| 平板适配 | 大屏下侧边栏常驻、内容居中限宽、统计卡四列；手机下底部导航 + 单列 |

## 数据同步机制

1. **集中式存储**：所有读写走同一后端，天然一致
2. **增量同步接口**：`GET /api/sync?since=<ISO>` 只返回之后变更且当前用户可见的数据；客户端保存 `serverTime` 作为下次 `since`
3. **推送触发**：服务端事件（新申请/审批结果）通过 Web Push 到达设备 → Service Worker `postMessage` → 前端立即同步（近实时）
4. **定时兜底**：默认 15 秒轮询一次
5. **离线补偿**：断网时暂停同步并显示「离线 · 使用本地缓存」，恢复联网立即补一次
6. **状态透明**：顶栏显示「已同步 时间 / 同步中 / 离线」，同步过程静默，仅在列表页自动刷新

## 离线场景

- **离线读**：Service Worker 对接口采用「网络优先 + 缓存兜底」，离线可打开已访问过的页面与数据
- **离线写（录入）**：表单内容自动存本机草稿（`localStorage`），断网或误关页面后可恢复，提交成功后清除
- **冲突解决（乐观锁）**：提交/审批/撤回时携带 `expectedUpdatedAt`（客户端读到的数据版本）；服务端发现已被其他设备改动则返回 **409 + 最新数据**，客户端提示「已在其他设备被更新」并载入最新内容，避免覆盖他人修改

## 主要接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/sync?since=ISO` | 增量同步（变更数据 + serverTime） |
| GET | `/api/sync/ping` | 心跳 / 在线探测 / 服务端时间 |
| POST | `/api/applications/:id/decision` | 投票（可带 `expectedUpdatedAt` 冲突检测） |
| POST | `/api/applications/:id/resubmit` | 重新提交（同上） |
| POST | `/api/applications/:id/cancel` | 撤回（同上） |
