/**
 * 视图：新建申请 / 修改重提
 *
 * 职责：申请表单（物品名称、平台、链接、价格、是否有替代品、理由、附图）与审批规则设置：
 * 从候选人中选择最多 10 名投票人，并设定通过所需票数 M（1 ~ 投票人数）。
 * 校验规则与 server/routes/applications.js 的 readFields/readApprovalRule 保持一致。
 */
import * as api from '../api.js';
import { toast } from '../ui.js';
import { bindRadioCards, syncRadioCards, cardHtml } from './shared.js';

// 与后端限制保持一致：单笔申请最多选择 10 名审批人
const MAX_PASS_VOTERS = 10;

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// 常用通过比例快捷计算：返回满足条件的所需票数 M（1 <= M <= N）
function presetPassVotes(type, n) {
  if (type === 'all') return n;
  if (type === 'majority') return Math.floor(n / 2) + 1; // 超过半数
  if (type === 'twoThird') return Math.ceil((n * 2) / 3); // 至少 2/3
  return n;
}

function rulePresetLabel(type, n) {
  const m = presetPassVotes(type, n);
  if (type === 'all') return `全部通过（${n}/${n}）`;
  if (type === 'majority') return `超过半数（${m}/${n}）`;
  if (type === 'twoThird') return `至少 2/3（${m}/${n}）`;
  return '';
}

/**
 * 渲染“审批规则”区块：
 *  - 勾选本轮审批人（来自系统 approver 账号，排除本人）
 *  - 设置本轮所需通过票数（可点比例快捷或手动 1..N）
 * 回调提供 collect() 读取当前选择。
 */
function renderRuleBox(host, { currentUser, initialVoters = [], initialPassVotes = 0 }) {
  host.innerHTML = `
    <div class="field full">
      <label>选择本轮审批人（可多选）<span class="req">*</span></label>
      <div class="chips" data-role="approver-chips">加载审批人账号中…</div>
      <div class="hint" data-role="approver-hint"></div>
    </div>
    <div class="field full" data-role="pass-field" hidden>
      <label>通过条件（所需同意票数）<span class="req">*</span></label>
      <div class="segmented compact" data-role="presets"></div>
      <div style="display:flex;align-items:center;gap:10px;margin-top:8px">
        <span style="font-size:13px;color:var(--muted)">或自定义：${'<span data-role="n-label"></span>'} 票中需</span>
        <select class="select" data-role="pass-select" style="width:auto;min-width:120px"></select>
        <span style="font-size:13px;color:var(--muted)">票同意即通过</span>
      </div>
      <div class="hint" data-role="pass-hint" style="margin-top:6px"></div>
    </div>`;

  const chipsEl = host.querySelector('[data-role="approver-chips"]');
  const approverHint = host.querySelector('[data-role="approver-hint"]');
  const passField = host.querySelector('[data-role="pass-field"]');
  const presetsEl = host.querySelector('[data-role="presets"]');
  const passSelect = host.querySelector('[data-role="pass-select"]');
  const nLabel = host.querySelector('[data-role="n-label"]');
  const passHint = host.querySelector('[data-role="pass-hint"]');
  const currentUserId = currentUser && currentUser.id;

  let approvers = [];
  const selected = new Set();
  initialVoters.forEach((v) => v && v.id && selected.add(v.id));
  let passVotes = initialPassVotes;

  function selectedCount() {
    return Array.from(selected).filter((id) => approvers.some((a) => a.id === id)).length;
  }

  function refreshPassPanel() {
    const n = selectedCount();
    if (n === 0) {
      passField.hidden = true;
      approverHint.textContent = '至少选择 1 名审批人（可勾选任意已注册账号，本人除外），以设置通过门槛（如 3 票中 2 票通过）。';
      return;
    }
    approverHint.textContent = '';
    passField.hidden = false;
    nLabel.textContent = n;

    // 若上次选择的通过票数超界，则自动回退为“超过半数”
    if (!passVotes || passVotes > n) passVotes = presetPassVotes('majority', n);

    // 不同预设可能算出相同票数（如 2 人时 majority/twoThird/all 都为 2），只保留首个
    const presets = [];
    ['majority', 'twoThird', 'all'].forEach((type) => {
      const m = presetPassVotes(type, n);
      if (!presets.some((p) => p.m === m)) presets.push({ type, m });
    });
    presetsEl.innerHTML = presets
      .map(({ type, m }) => {
        const active = passVotes === m ? 'active' : '';
        return `<button type="button" data-preset="${type}" data-votes="${m}" class="${active}">${rulePresetLabel(
          type,
          n
        )}</button>`;
      })
      .join('');

    passSelect.innerHTML = Array.from({ length: n }, (_, i) => i + 1)
      .map((m) => `<option value="${m}" ${m === passVotes ? 'selected' : ''}>${m} 票</option>`)
      .join('');
    refreshHint();
  }

  function refreshHint() {
    const n = selectedCount();
    const names = Array.from(selected)
      .map((id) => {
        const a = approvers.find((x) => x.id === id);
        return a ? a.name : '';
      })
      .filter(Boolean);
    const target =
      n > 0 && passVotes ? `${n} 名审批人中 ${passVotes} 票同意即通过（${passVotes}/${n}）` : '';
    const voterText = names.length ? `审批人：${names.join('、')}` : '';
    const hintEl = host.querySelector('[data-role="pass-hint"]');
    hintEl.textContent = [voterText, target].filter(Boolean).join('　');
  }

  // 绑定事件
  function bind() {
    presetsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-preset]');
      if (!btn) return;
      passVotes = Number(btn.dataset.votes);
      presetsEl.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
      passSelect.value = String(passVotes);
      refreshHint();
    });
    passSelect.addEventListener('change', () => {
      passVotes = Number(passSelect.value);
      presetsEl.querySelectorAll('button').forEach((b) => b.classList.toggle('active', Number(b.dataset.votes) === passVotes));
      refreshHint();
    });
  }

  async function loadApprovers() {
    let data;
    try {
      data = await api.get('/api/applications/approver-options');
    } catch (err) {
      chipsEl.innerHTML = `<div style="color:var(--danger);font-size:13px">加载审批人失败：${escapeHtml(
        err.message
      )}</div>`;
      return;
    }
    approvers = data.approvers || [];
    if (!approvers.length) {
      chipsEl.innerHTML = `<div style="font-size:13px;color:var(--muted)">系统暂无其他账号可选。请先注册更多账号，再来设置本轮审批规则。</div>`;
      return;
    }
    chipsEl.innerHTML = approvers
      .map(
        (a) =>
          `<button type="button" class="chip" data-id="${escapeHtml(a.id)}" title="${escapeHtml(a.name)}（@${escapeHtml(
            a.username
          )} · ${a.role === 'approver' ? '审批人' : '申请人'}）">${escapeHtml(a.name)}<small>@${escapeHtml(
            a.username
          )} · ${a.role === 'approver' ? '审批人' : '申请人'}</small></button>`
      )
      .join('');

    chipsEl.querySelectorAll('.chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const id = chip.dataset.id;
        if (selected.has(id)) {
          selected.delete(id);
        } else {
          if (selected.size >= MAX_PASS_VOTERS) {
            approverHint.textContent = `本轮最多选择 ${MAX_PASS_VOTERS} 名审批人，请先取消已选审批人`;
            return;
          }
          selected.add(id);
        }
        chip.classList.toggle('active', selected.has(id));
        refreshPassPanel();
      });
      // 注意：此处需取当前 chip 的 id（此前误用未定义变量会抛错，导致后续 chip 失去点击能力）
      chip.classList.toggle('active', selected.has(chip.dataset.id));
    });
    refreshPassPanel();
  }

  function collect() {
    const ids = Array.from(selected).filter((id) => approvers.some((a) => a.id === id));
    const n = ids.length;
    if (n === 0) return { error: '请至少选择 1 名审批人' };
    if (!passVotes || passVotes < 1 || passVotes > n) return { error: '请设置本轮通过所需票数' };
    return { approverIds: ids, passVotes };
  }

  bind();
  loadApprovers();

  // 供外层使用
  return { collect };
}

function renderAppForm(container, { existing, reasonNote, currentUser, onSubmit }) {
  const isEdit = Boolean(existing);
  const hasImage = Boolean(existing && existing.image);
  const value = (name) => (existing ? existing[name] : '');
  const initialVoters = existing && existing.rule ? existing.rule.voters : [];
  const initialPassVotes = existing && existing.rule ? Number(existing.rule.passVotes) : 0;
  // 单选字段初值：编辑时取原申请，新建时取默认（有替代品 / 向所有人公开）
  const hasAlt = existing ? Boolean(existing.hasAlternative) : true;
  const restricted = Boolean(existing && existing.visibility === 'restricted');

  container.innerHTML = `
    <div class="card" style="max-width:760px">
      <div class="card-title">${isEdit ? '修改申请并重新提交' : '新建购买申请'}</div>
      ${isEdit ? '<div style="font-size:13px;color:var(--muted);margin:-4px 0 12px">仅被拒绝的申请可修改，重新提交后将再次进入审批流程。</div>' : ''}
      ${
        reasonNote
          ? `<div class="decision-box rejected" style="margin-bottom:16px">
              <div class="title">上次审批意见（拒绝理由）</div>
              <div style="font-size:13px">${reasonNote}</div>
            </div>`
          : ''
      }
      <form id="app-form" novalidate>
        <div class="form-error" data-role="err"></div>
        <div class="form-grid">
          <div class="field">
            <label>物品名称<span class="req">*</span></label>
            <input class="input" name="itemName" maxlength="60" placeholder="例如：人体工学办公椅" value="${escapeHtml(value('itemName'))}" />
          </div>
          <div class="field">
            <label>价格（元）<span class="req">*</span></label>
            <input class="input" name="price" type="number" min="0" step="0.01" placeholder="例如：1299.00" value="${escapeHtml(value('price'))}" />
          </div>
          <div class="field">
            <label>购买平台<span class="req">*</span></label>
            <input class="input" name="platform" maxlength="40" placeholder="例如：京东 / 天猫 / 拼多多" value="${escapeHtml(value('platform'))}" />
          </div>
          <div class="field">
            <label>是否有替代品<span class="req">*</span></label>
            <div class="radio-row" role="radiogroup" aria-label="是否有替代品">
              ${cardHtml({ name: 'hasAlternative', value: 'yes', label: '有替代品', checked: hasAlt })}
              ${cardHtml({ name: 'hasAlternative', value: 'no', label: '无替代品', checked: !hasAlt })}
            </div>
          </div>
          <div class="field full">
            <label>可见范围<span class="req">*</span></label>
            <div class="radio-row" role="radiogroup" aria-label="可见范围">
              ${cardHtml({ name: 'visibility', value: 'public', label: '向所有人公开', checked: !restricted })}
              ${cardHtml({ name: 'visibility', value: 'restricted', label: '仅限指定审批人查看', checked: restricted })}
            </div>
            <div class="hint">「向所有人公开」：所有登录用户都能在审批记录中看到并打开详情；「仅限指定审批人查看」：只有你、本轮被勾选的审批人和超级管理员可见。</div>
          </div>
          <div class="field full">
            <label>商品链接</label>
            <input class="input" name="link" placeholder="https://item.jd.com/xxxxx.html" value="${escapeHtml(value('link'))}" />
          </div>
          <div class="field full">
            <label>申请理由</label>
            <textarea class="textarea" name="reason" maxlength="500" placeholder="说明购买用途、必要性等（选填）">${escapeHtml(value('reason'))}</textarea>
          </div>
          <div class="field full">
            <label>商品图片</label>
            <div class="uploader">
              <label class="upload-box">
                <span data-role="placeholder" style="${hasImage ? 'display:none' : ''}">＋<br />点击上传${isEdit ? '<small style="font-weight:400">（不选则保留原图）</small>' : ''}</span>
                <img data-role="preview" alt="商品图片预览" src="${hasImage ? escapeHtml(existing.image) : ''}" style="${hasImage ? '' : 'display:none'}" />
                <input type="file" name="image" accept="image/png,image/jpeg,image/gif,image/webp" />
              </label>
              <div>
                <div class="hint">支持 JPG / PNG / GIF / WEBP，大小不超过 5MB</div>
                <button type="button" class="btn btn-sm" data-role="remove" style="margin-top:8px;${
                  hasImage ? '' : 'display:none'
                }">${isEdit ? '移除图片并保留空图' : '移除图片'}</button>
              </div>
            </div>
          </div>
        </div>
        <div style="border-top:1px dashed var(--border);margin:4px 0 14px;padding-top:14px">
          <div style="font-size:14px;font-weight:600;margin-bottom:10px">审批规则</div>
          <div data-role="rule-box"></div>
        </div>
        <div class="actions" style="margin-top:6px">
          <button type="submit" class="btn btn-primary" data-role="submit">${isEdit ? '重新提交审批' : '提交申请'}</button>
          <a class="btn" href="${isEdit ? `#/apps/${existing.id}` : '#/apps'}">取消</a>
        </div>
        <div class="hint" data-role="draft-hint" style="margin-top:8px"></div>
      </form>
    </div>`;

  const form = container.querySelector('#app-form');
  const errEl = container.querySelector('[data-role="err"]');
  const fileInput = form.querySelector('input[type="file"]');
  const preview = form.querySelector('[data-role="preview"]');
  const placeholder = form.querySelector('[data-role="placeholder"]');
  const removeBtn = form.querySelector('[data-role="remove"]');
  const submitBtn = form.querySelector('[data-role="submit"]');
  let removedImage = false;
  let chosenUrl = null;

  bindRadioCards(form);

  // 离线本地缓存：录入内容自动存草稿，断网/误关页面后可恢复，提交成功后清除
  const draftKey = isEdit ? `pa_draft_edit_${existing.id}` : 'pa_draft_new';
  const draftHint = container.querySelector('[data-role="draft-hint"]');
  function saveDraft(showTime) {
    try {
      const data = Object.fromEntries(new FormData(form));
      delete data.image;
      localStorage.setItem(draftKey, JSON.stringify({ at: Date.now(), data }));
      if (draftHint && showTime) {
        draftHint.textContent = `草稿已保存到本机（${new Date().toLocaleTimeString('zh-CN')}），断网也不会丢失`;
      }
    } catch (err) {
      /* 忽略存储失败（隐私模式等） */
    }
  }
  let draftTimer = null;
  form.addEventListener('input', () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => saveDraft(true), 600);
  });
  // 恢复本地草稿（仅新建表单自动回填，避免覆盖已保存数据）
  if (!isEdit) {
    try {
      const raw = localStorage.getItem(draftKey);
      if (raw) {
        const draft = JSON.parse(raw);
        const d = draft.data || {};
        ['itemName', 'price', 'platform', 'link', 'reason'].forEach((name) => {
          const el = form.elements[name];
          if (el && d[name] !== undefined && !el.value) el.value = d[name];
        });
        // 恢复单选类字段（是否有替代品 / 可见范围），并同步卡片高亮
        ['hasAlternative', 'visibility'].forEach((name) => {
          const target = d[name];
          if (!target) return;
          form.querySelectorAll(`input[name="${name}"]`).forEach((r) => {
            r.checked = r.value === target;
          });
        });
        syncRadioCards(form);
        if (draftHint) {
          draftHint.textContent = `已恢复本机草稿（${new Date(draft.at || Date.now()).toLocaleString('zh-CN')}）`;
        }
      }
    } catch (err) {
      /* 草稿损坏则忽略 */
    }
  }

  const ruleCtl = renderRuleBox(container.querySelector('[data-role="rule-box"]'), {
    currentUser,
    initialVoters,
    initialPassVotes,
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast('图片大小不能超过 5MB', 'error');
      fileInput.value = '';
      return;
    }
    if (chosenUrl) URL.revokeObjectURL(chosenUrl);
    chosenUrl = URL.createObjectURL(file);
    preview.src = chosenUrl;
    preview.style.display = 'block';
    placeholder.style.display = 'none';
    removeBtn.style.display = '';
    removedImage = false;
  });

  removeBtn.addEventListener('click', () => {
    fileInput.value = '';
    if (chosenUrl) {
      URL.revokeObjectURL(chosenUrl);
      chosenUrl = null;
    }
    preview.src = '';
    preview.style.display = 'none';
    removeBtn.style.display = 'none';
    placeholder.style.display = '';
    placeholder.innerHTML = '＋<br />点击上传<small style="font-weight:400">（不选则无图）</small>';
    removedImage = true;
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errEl.classList.remove('show');

    const rule = ruleCtl.collect();
    if (rule.error) {
      errEl.textContent = rule.error;
      errEl.classList.add('show');
      return;
    }

    const formData = new FormData(form);
    formData.set('approverIds', rule.approverIds.join(','));
    formData.set('passVotes', String(rule.passVotes));
    if (isEdit) formData.set('removeImage', removedImage ? '1' : '0');
    submitBtn.disabled = true;
    try {
      await onSubmit(formData);
      toast(isEdit ? '已修改并重新提交，等待审批' : '申请提交成功，等待审批', 'success');
      try {
        localStorage.removeItem(draftKey); // 提交成功后清除本地草稿
      } catch (err) {
        /* ignore */
      }
      location.hash = isEdit ? `#/apps/${existing.id}` : '#/apps';
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.add('show');
    } finally {
      submitBtn.disabled = false;
    }
  });
}

export async function newApp({ container, user }) {
  renderAppForm(container, {
    currentUser: user,
    onSubmit: (formData) => api.upload('/api/applications', formData),
  });
}

export async function editApp({ container, params, rerender, user }) {
  container.innerHTML = `<div class="card">加载中…</div>`;
  let application;
  try {
    const payload = await api.get(`/api/applications/${encodeURIComponent(params.id)}`);
    application = payload.application;
  } catch (err) {
    container.innerHTML = `<div class="card">${err.message}</div>`;
    return;
  }

  if (!application.canResubmit) {
    container.innerHTML = `<div class="card">
      <div style="margin-bottom:12px"><a class="btn btn-sm" href="#/apps">← 返回列表</a></div>
      <div>该申请当前状态（${application.status}）不可修改。仅被拒绝的申请可以修改并重新提交。</div>
    </div>`;
    return;
  }

  renderAppForm(container, {
    existing: application,
    currentUser: user,
    reasonNote: escapeHtml(application.decisionComment || '审批人未填写拒绝理由'),
    onSubmit: (formData) => api.upload(`/api/applications/${encodeURIComponent(application.id)}/resubmit`, formData),
  });
}
