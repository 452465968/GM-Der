// pm2 进程管理配置
// 使用：pm2 start deploy/ecosystem.config.cjs --env production
// 注意：JSON 文件存储 + 内存会话，务必保持 instances=1、exec_mode=fork
module.exports = {
  apps: [
    {
      name: 'purchase-approval',
      script: './server/index.js',
      cwd: '/opt/purchase-approval',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '512M',
      error_file: '/opt/purchase-approval/logs/error.log',
      out_file: '/opt/purchase-approval/logs/out.log',
      merge_logs: true,
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        // 域名已接入 HTTPS（furry233.cn），启用 secure Cookie（IP + HTTP 直连将无法登录，属预期）
        COOKIE_SECURE: 'true',
        // 部署前请替换为随机密钥：openssl rand -hex 32
        SESSION_SECRET: 'CHANGE_ME_PLEASE_USE_OPENSSL_RAND_HEX_32',
        // 通知内容里的「查看详情」链接前缀
        APP_BASE_URL: 'https://furry233.cn',
        // Web Push（系统级通知）：仅在 HTTPS 生效，接入 HTTPS 后即可工作。
        // 密钥严禁写进仓库，这里从进程环境读取（由 .env / CI Secrets 注入）。
        // 生成：node -e "const w=require('web-push');console.log(w.generateVAPIDKeys())"
        VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY || '',
        VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY || '',
        VAPID_SUBJECT: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
      },
    },
  ],
};
