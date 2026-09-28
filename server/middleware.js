/**
 * 认证与授权中间件
 *
 * 职责：统一的接口守卫，所有需要登录/权限的路由都在此取用。
 *   · requireAuth     仅要求已登录（req.session.user 存在）；
 *   · requireApprover 要求「特权身份」：审批人 / 超级管理员 / 具备 data:all 权限；
 *   · requireAdmin(p) 后台接口守卫，p 为所需权限 key（如 account:view）；
 *   · hasPermission / isSuperAdmin / isPrivileged 为纯函数判定，供业务代码复用。
 * 权限判定规则：超级管理员（role=admin 或 permissions 含 *）一律通过；
 * 其余账号按 permissions 数组匹配，含 * 或目标 key 即通过。
 */
function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: '请先登录' });
  }
  return next();
}

function requireApprover(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: '请先登录' });
  }
  if (!isPrivileged(req.session.user)) {
    return res.status(403).json({ error: '仅审批人可执行该操作' });
  }
  return next();
}

// 是否为「特权身份」：审批人或超级管理员（可看全部数据）
function isPrivileged(user) {
  if (!user) return false;
  return user.role === 'approver' || user.role === 'admin' || hasPermission(user, 'data:all');
}

// 是否为超级管理员（拥有全部权限）
function isSuperAdmin(user) {
  if (!user) return false;
  if (user.role === 'admin' || user.isSuperAdmin) return true;
  return Array.isArray(user.permissions) && user.permissions.includes('*');
}

// 权限判定：通配 * 或显式包含即通过
function hasPermission(user, perm) {
  if (!user || !perm) return false;
  if (isSuperAdmin(user)) return true;
  const list = Array.isArray(user.permissions) ? user.permissions : [];
  return list.includes(perm) || list.includes('*');
}

// 后台管理接口守卫：需要指定权限（不传则只要是管理员即可）
function requireAdmin(perm) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return res.status(401).json({ error: '请先登录' });
    }
    const user = req.session.user;
    if (!isSuperAdmin(user) && !hasPermission(user, 'account:view')) {
      // 没有任何后台查看权限
      if (!perm || !hasPermission(user, perm)) {
        return res.status(403).json({ error: '无后台管理权限' });
      }
    }
    if (perm && !hasPermission(user, perm)) {
      return res.status(403).json({ error: `缺少权限：${perm}` });
    }
    return next();
  };
}

module.exports = { requireAuth, requireApprover, requireAdmin, hasPermission, isSuperAdmin, isPrivileged };
