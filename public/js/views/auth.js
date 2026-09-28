/**
 * 视图：登录 / 注册
 *
 * 职责：登录表单（含「记住我」→ credstore 加密保存）、注册表单（注册即审批人身份）、
 * 登录后触发推送授权引导与版本自检。
 */
import * as api from '../api.js';
import { toast } from '../ui.js';
import { bindRadioCards } from './shared.js';
import { saveCredential, loadCredential, clearCredential, securityNote } from '../credstore.js';
import { ensurePushPermission } from '../pushprompt.js';
import { APP_VERSION } from '../version.js';
import { hardRefresh } from '../refresh.js';
import { checkAppUpdate } from '../appupdate.js';

export function login({ container, setUser, rerender }) {
  container.className = 'auth-page';
  container.innerHTML = `
    <div class="auth-card">
      <div class="auth-brand">
        <div class="logo">购</div>
        <div><h1>买个Der</h1><p>申请 · 审批 · 留痕，全流程在线化</p></div>
      </div>
      <div class="auth-tabs">
        <button data-tab="login" class="active">登录</button>
        <button data-tab="register">注册</button>
      </div>
      <form id="auth-form" novalidate>
        <div class="form-error" data-role="err"></div>
        <div class="field">
          <label>用户名<span class="req">*</span></label>
          <input class="input" name="username" autocomplete="username" placeholder="3-20 位字母、数字或下划线" />
        </div>
        <div class="field">
          <label>密码<span class="req">*</span></label>
          <input class="input" type="password" name="password" autocomplete="current-password" placeholder="至少 6 位" />
        </div>
        <div class="auth-remember" data-role="remember">
          <label class="remember-box">
            <input type="checkbox" name="remember" />
            <span>记住我</span>
          </label>
          <button type="button" class="remember-clear" data-role="clear-creds" hidden>清除已保存的账号</button>
          <div class="hint remember-hint" data-role="cred-hint" hidden></div>
        </div>
        <div class="field" data-role="name-field" style="display:none">
          <label>姓名<span class="req">*</span></label>
          <input class="input" name="name" placeholder="例如：张三" />
        </div>
        <div class="field" data-role="role-note" style="display:none">
          <div class="hint">注册账号为「审批人」身份，可提交自己的购买申请，也可参与他人申请的审批投票。</div>
        </div>
        <button class="btn btn-primary btn-block" type="submit" data-role="submit">登录</button>
      </form>
      <div class="auth-version-row">
        <span class="version-tag" title="当前版本">版本 ${APP_VERSION}</span>
        <button type="button" class="btn btn-sm" data-role="hard-refresh">刷新到最新版本</button>
        <button type="button" class="btn btn-sm" data-role="check-update">检查更新</button>
      </div>
      <div class="auth-demo">演示账号：<b>admin / 123456</b>（审批人）。系统仅开放审批人注册。勾选「记住我」后下次自动填充。</div>
      <div class="auth-admin-entry">
        <a href="#/admin">🛡 后台管理入口</a>
        <span class="hint">需具备后台权限的账号（超级管理员或被授权账号），登录后自动进入管理台</span>
      </div>
    </div>`;

  const form = container.querySelector('#auth-form');
  const errEl = container.querySelector('[data-role="err"]');
  const nameField = container.querySelector('[data-role="name-field"]');
  const roleNote = container.querySelector('[data-role="role-note"]');
  const submitBtn = container.querySelector('[data-role="submit"]');
  const rememberRow = container.querySelector('[data-role="remember"]');
  const rememberBox = container.querySelector('[name="remember"]');
  const clearBtn = container.querySelector('[data-role="clear-creds"]');
  const credHint = container.querySelector('[data-role="cred-hint"]');
  const usernameInput = form.elements.username;
  const passwordInput = form.elements.password;
  let mode = 'login';

  // 检查更新：请求更新接口对比版本，有新版则展示版本号/更新内容/大小并支持下载安装
  const updateBtn = container.querySelector('[data-role="check-update"]');
  if (updateBtn) {
    updateBtn.addEventListener('click', async () => {
      updateBtn.disabled = true;
      updateBtn.textContent = '检查中…';
      try {
        await checkAppUpdate({ manual: true });
      } finally {
        updateBtn.disabled = false;
        updateBtn.textContent = '检查更新';
      }
    });
  }

  // 手动刷新：清理缓存并重新加载，用于轻应用更新后免删图标拿到最新版本
  const refreshBtn = container.querySelector('[data-role="hard-refresh"]');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = '刷新中…';
      try {
        await hardRefresh();
      } catch (err) {
        refreshBtn.disabled = false;
        refreshBtn.textContent = '刷新到最新版本';
        toast('刷新失败，请手动下拉刷新页面', 'error');
      }
    });
  }

  // 本机「记住我」凭证自动填充（登录模式才展示该区块）
  async function applySavedCredential() {
    if (mode !== 'login') return;
    try {
      const saved = await loadCredential();
      if (saved) {
        usernameInput.value = saved.username || '';
        passwordInput.value = saved.password || '';
        rememberBox.checked = true;
        credHint.textContent = securityNote();
        credHint.hidden = false;
        clearBtn.hidden = false;
      } else {
        credHint.hidden = true;
        clearBtn.hidden = true;
      }
    } catch (err) {
      /* 静默：不阻塞登录 */
    }
  }

  clearBtn.addEventListener('click', async () => {
    try {
      await clearCredential();
      usernameInput.value = '';
      passwordInput.value = '';
      rememberBox.checked = false;
      clearBtn.hidden = true;
      credHint.hidden = true;
      toast('已清除本机保存的账号密码', 'success');
    } catch (err) {
      toast('清除失败，请重试', 'error');
    }
  });

  container.querySelectorAll('.auth-tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      mode = btn.dataset.tab;
      container.querySelectorAll('.auth-tabs button').forEach((b) => b.classList.toggle('active', b === btn));
      const isReg = mode === 'register';
      nameField.style.display = isReg ? '' : 'none';
      roleNote.style.display = isReg ? '' : 'none';
      rememberRow.style.display = isReg ? 'none' : '';
      submitBtn.textContent = isReg ? '注册审批人账号' : '登录';
      errEl.classList.remove('show');
      if (!isReg) applySavedCredential();
    });
  });

  bindRadioCards(container);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errEl.classList.remove('show');
    const data = Object.fromEntries(new FormData(form));
    // 系统仅开放审批人注册入口，身份固定为 approver
    if (mode === 'register') data.role = 'approver';
    submitBtn.disabled = true;
    try {
      const result = await api.post(mode === 'register' ? '/api/auth/register' : '/api/auth/login', data);
      toast(mode === 'register' ? '注册成功，欢迎使用' : '登录成功', 'success');
      if (mode === 'login') {
        // 「记住我」：勾选保存本机凭证，未勾选则清除历史凭证
        try {
          if (rememberBox.checked) await saveCredential(data.username, data.password);
          else await clearCredential();
        } catch (err) {
          /* 保存失败不影响登录 */
        }
      }
      await setUser(result.user);
      // 登录/注册成功后自动申请全局通知权限（内部去重，已授权不会重复请求）
      ensurePushPermission();
      // 登录后跳转默认页。从「后台管理入口」进入的、且具备后台权限的账号，登录后直接进入管理台。
      const canAdmin =
        result.user.role === 'admin' ||
        result.user.isSuperAdmin === true ||
        (Array.isArray(result.user.permissions) &&
          (result.user.permissions.includes('*') ||
            result.user.permissions.some((p) => String(p).startsWith('account:'))));
      const target =
        location.hash === '#/admin' && canAdmin
          ? '#/admin'
          : result.user.role === 'approver'
          ? '#/review'
          : '#/apps';
      if (location.hash === target) {
        location.hash = target;
        if (rerender) await rerender();
      } else {
        location.hash = target; // hash 变化 → hashchange 监听会自动重新渲染
      }
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.add('show');
    } finally {
      submitBtn.disabled = false;
    }
  });

  applySavedCredential();
}
