/**
 * 视图：申请详情
 *
 * 职责：展示单笔申请的完整信息（物品/价格/平台/理由/图片/审批规则），并按身份渲染操作区：
 * 被指派的投票人可投「同意/拒绝」并填写意见；申请人可在被拒后「修改并重新提交」或「撤回」；
 * 顶部用徽章标出每位投票人本轮的投票结果。
 */
import * as api from '../api.js';
import { esc, empty, loading, formatDateTime, formatMoney, statusBadge, toast, openModal } from '../ui.js';

// 投票人状态徽章（按名单顺序，标出每人本轮已投结果）
function voterChipsHtml(item) {
  if (!item.rule || !item.rule.voters || !item.rule.voters.length) return '';
  const votes = item.votes || [];
  const items = item.rule.voters
    .map((v) => {
      const vote = votes.find((x) => x.approverId === v.id);
      let cls = 'chip pending';
      let label = '待投票';
      let icon = '';
      if (vote) {
        if (vote.action === 'approve') {
          cls = 'chip voted-approve';
          label = `已同意${vote.comment ? '·' + vote.comment : ''}`;
          icon = '✓';
        } else {
          cls = 'chip voted-reject';
          label = `已拒绝${vote.comment ? '·' + vote.comment : ''}`;
          icon = '✕';
        }
      }
      const roleText = v.role === 'user' ? '（以申请人账号被指派为投票人）' : '';
      return `<span class="${cls}" title="${esc(v.name)}${roleText}（${esc(label)}）"><b>${icon}${esc(v.name)}</b><small>${esc(label)}</small></span>`;
    })
    .join('');
  return `<div class="chips voter-chips">${items}</div>`;
}

function ruleInfoHtml(item) {
  if (!item.rule) return '';
  const voters = item.rule.voters || [];
  const total = voters.length;
  const pass = Number(item.rule.passVotes) || 1;
  const counts = item.voteCounts || { approve: 0, reject: 0 };
  const cast = (counts.approve || 0) + (counts.reject || 0);
  return `<div class="rule-info">
    <div class="rule-line">
      <b>审批门槛</b>：${total} 名审批人中，至少 ${pass} 人同意即通过（${pass}/${total}）
      ${item.status === 'approved' ? ' · 已达成' : item.status === 'rejected' ? ' · 未达成' : ` · 已投 ${cast}/${total} 票`}
    </div>
    ${voterChipsHtml(item)}
  </div>`;
}

// 申请人查看自己发起的待审申请时的提示（不能参与本轮投票）
function selfVoteNote(item, user) {
  if (!user || !item.applicant || item.applicant.id !== user.id) return '';
  if (!['pending', 'resubmitted'].includes(item.status)) return '';
  return `<div style="margin-top:8px;font-size:13px;color:var(--muted)">
      您是该申请的发起人，不能参与本轮投票，需等待被指派的审批人处理。
    </div>`;
}

function decisionBoxHtml(item) {
  if (item.status === 'pending' || item.status === 'resubmitted') {
    const cls = item.status === 'resubmitted' ? 'resubmitted' : 'pending';
    const title = item.status === 'resubmitted' ? '已修改，等待再次审批投票' : '已提交，等待审批投票';
    const desc =
      item.status === 'resubmitted'
        ? `申请人已根据意见修改申请（第 ${item.submitCount} 次提交），等待本轮审批人投票。`
        : '已进入多人投票审批，达到设定门槛后自动通过；否则按规则处理。';
    return `<div class="decision-box ${cls}">
      <div class="title">${title}</div>
      ${ruleInfoHtml(item)}
      <div style="font-size:13px;color:var(--muted);margin-top:8px">${desc}</div>
      ${
        item.myVote
          ? `<div style="font-size:13px;margin-top:8px;color:var(--muted)">您已在本轮${
              item.myVote.action === 'approve' ? '同意' : '拒绝'
            }该申请，等待其他审批人投票。</div>`
          : ''
      }
    </div>`;
  }
  const title =
    item.status === 'approved'
      ? `已同意购买${item.submitCount > 1 ? `（第 ${item.submitCount} 次提交通过）` : ''}`
      : item.status === 'rejected'
      ? `审批未通过（第 ${item.submitCount} 次提交）`
      : '申请已撤回';
  const label = item.status === 'approved' ? '同意理由 / 备注' : item.status === 'rejected' ? '拒绝理由' : '说明';
  const actorText =
    item.status === 'approved' || item.status === 'rejected'
      ? item.rule
        ? `本轮由 ${(item.rule.voters || []).map((v) => esc(v.name)).join('、')} 共同投票，达到/未达到门槛后自动结束`
        : item.approver
        ? '审批人：' + esc(item.approver.name) + ' · ' + formatDateTime(item.decidedAt)
        : formatDateTime(item.decidedAt)
      : formatDateTime(item.decidedAt);
  return `<div class="decision-box ${item.status}">
    <div class="title">${title}</div>
    <div style="font-size:13px">${actorText}</div>
    ${item.rule ? ruleInfoHtml(item) : ''}
    <div style="margin-top:6px"><b>${label}：</b>${item.decisionComment ? esc(item.decisionComment) : '无'}</div>
  </div>`;
}

// 归一化旧审批记录：旧记录只有 action 字段（approved/rejected）
function logText(log) {
  switch (log.type) {
    case 'submit':
      return `<b>${esc(log.actorName)}</b> 提交了申请`;
    case 'resubmit':
      return `<b>${esc(log.actorName)}</b> 修改申请并重新提交（第 ${log.round} 次）`;
    case 'approve':
      return `审批人 <b>${esc(log.actorName)}</b> 投出同意票`;
    case 'reject':
      return `审批人 <b>${esc(log.actorName)}</b> 投出拒绝票`;
    case 'cancel':
      return `<b>${esc(log.actorName)}</b> 撤回了申请`;
    default:
      return `<b>${esc(log.actorName)}</b> ${log.type || ''}`;
  }
}

function timelineClass(log) {
  const map = { approve: 'approved', reject: 'rejected', cancel: 'cancel', resubmit: 'resubmitted', submit: 'submit' };
  return map[log.type] || 'submit';
}

function timelineHtml(logs) {
  if (!logs.length) return '<div style="color:var(--muted);font-size:13px">暂无操作记录</div>';
  return `<ul class="timeline">${logs
    .map(
      (log) => `<li class="${timelineClass(log)}">
        <div>${logText(log)}</div>
        <div class="meta">${formatDateTime(log.createdAt)}</div>
        ${
          log.comment
            ? `<div style="font-size:13px;margin-top:2px;color:var(--muted)">意见：${esc(log.comment)}</div>`
            : ''
        }
      </li>`
    )
    .join('')}</ul>`;
}

export async function detail({ container, params, rerender, user }) {
  container.innerHTML = `<div class="card">${loading()}</div>`;

  let payload;
  try {
    payload = await api.get(`/api/applications/${encodeURIComponent(params.id)}`);
  } catch (err) {
    container.innerHTML = `<div class="card">${empty(err.message)}</div>`;
    return;
  }

  const item = payload.application;
  const logs = payload.logs || [];
  // 审批人或本轮被指派的投票人从「待我审批 / 待我投票」进入，返回对应列表
  const backHref = user && (user.role === 'approver' || item.isAssignedVoter) ? '#/review' : '#/apps';

  container.innerHTML = `
    <div class="card">
      <div style="margin-bottom:12px"><a class="btn btn-sm" href="${backHref}">← 返回列表</a></div>
      <div class="detail-head">
        <h3>${esc(item.itemName)}</h3>
        ${statusBadge(item.status)}
        ${
          item.visibility === 'restricted'
            ? '<span class="badge vis-limited">仅审批人可见</span>'
            : '<span class="badge vis-public">公开</span>'
        }
      </div>
      <div style="color:var(--muted);font-size:13px;margin-bottom:14px">
        提交人：${esc(item.applicant.name)} · 第 ${item.submitCount} 次提交 · ${formatDateTime(item.createdAt)}
      </div>
      <div class="info-grid">
        <div class="info-item"><div class="label">购买价格</div>
          <div class="value" style="font-weight:700;color:#b91c1c">${formatMoney(item.price)}</div></div>
        <div class="info-item"><div class="label">购买平台</div><div class="value">${esc(item.platform)}</div></div>
        <div class="info-item"><div class="label">是否有替代品</div>
          <div class="value">${item.hasAlternative ? '有替代品' : '无替代品'}</div></div>
        <div class="info-item"><div class="label">商品链接</div><div class="value">${
          item.link ? `<a href="${esc(item.link)}" target="_blank" rel="noopener">${esc(item.link)}</a>` : '未填写'
        }</div></div>
        <div class="info-item"><div class="label">申请理由</div>
          <div class="value">${item.reason ? esc(item.reason) : '未填写'}</div></div>
        <div class="info-item"><div class="label">商品图片</div><div class="value">${
          item.image
            ? `<a href="${esc(item.image)}" target="_blank" rel="noopener"><img class="thumb" src="${esc(
                item.image
              )}" alt="商品图片" /></a>`
            : '未上传'
        }</div></div>
      </div>
      <div style="margin-top:18px">${decisionBoxHtml(item)}${selfVoteNote(item, user)}</div>
    </div>

    <div class="card">
      <div class="card-title">流转历史（${logs.length}）</div>
      ${timelineHtml(logs)}
    </div>

    ${
      item.canDecide || item.canCancel || item.canResubmit
        ? `<div class="card sticky-actions"><div class="actions">
            ${
              item.canDecide
                ? '<button class="btn btn-success" data-role="approve">同意购买</button>' +
                  '<button class="btn btn-danger" data-role="reject">拒绝购买</button>'
                : ''
            }
            ${
              item.canResubmit
                ? `<a class="btn btn-primary" href="#/apps/${encodeURIComponent(item.id)}/edit">修改并重新提交</a>`
                : ''
            }
            ${item.canCancel ? '<button class="btn" data-role="cancel" style="margin-left:auto">撤回申请</button>' : ''}
          </div></div>`
        : ''
    }`;

  function decide(action) {
    const isReject = action === 'reject';
    const isVoteMode = Boolean(item.rule);
    openModal({
      title: isReject ? '投出拒绝票' : '投出同意票',
      confirmText: isReject ? '确认拒绝' : '确认同意',
      danger: isReject,
      bodyHtml: `<div class="field">
          <label>${isReject ? '拒绝理由<span class="req">*</span>' : '意见 / 备注（选填）'}</label>
          <textarea class="textarea" data-role="comment" maxlength="500" placeholder="${
            isReject ? '请说明拒绝原因，便于申请人调整后再次提交' : '可填写采购建议、预算说明等'
          }"></textarea>
        </div>
        ${
          item.rule
            ? `<div style="font-size:13px;color:var(--muted)">本轮审批门槛：${
                (item.rule.voters || []).length
              } 名审批人中至少 ${item.rule.passVotes} 人同意即通过。您的投票提交后不可更改。</div>`
            : isReject
            ? '<div style="font-size:13px;color:var(--muted)">提示：拒绝后申请人仍可修改并重新提交。</div>'
            : ''
        }
        <div style="font-size:13px;color:var(--muted)">物品：${esc(item.itemName)} · ${formatMoney(item.price)}</div>`,
      onConfirm: async (mask) => {
        const comment = mask.querySelector('[data-role="comment"]').value.trim();
        if (isReject && !comment) throw new Error('请填写拒绝理由');
        const result = await api.post(`/api/applications/${encodeURIComponent(item.id)}/decision`, {
          action,
          comment,
        });
        toast(result.message || (isReject ? '已拒绝该申请' : '已同意该申请'), 'success');
        rerender();
      }
    });
  }

  const approveBtn = container.querySelector('[data-role="approve"]');
  if (approveBtn) approveBtn.addEventListener('click', () => decide('approve'));

  const rejectBtn = container.querySelector('[data-role="reject"]');
  if (rejectBtn) rejectBtn.addEventListener('click', () => decide('reject'));

  const cancelBtn = container.querySelector('[data-role="cancel"]');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      openModal({
        title: '撤回申请',
        confirmText: '确认撤回',
        danger: true,
        bodyHtml: `<div style="font-size:14px">撤回后将不再进入审批流程，确认撤回「${esc(item.itemName)}」吗？</div>`,
        onConfirm: async () => {
          await api.post(`/api/applications/${encodeURIComponent(item.id)}/cancel`);
          toast('申请已撤回', 'success');
          rerender();
        }
      });
    });
  }
}
