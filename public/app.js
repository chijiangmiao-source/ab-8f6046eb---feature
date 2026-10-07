/* 副本回放台前端：零依赖原生 JS（ES module）。 */

import {
  GROUP_LABEL,
  REASON_LABEL,
  STATUS_LABEL,
  kindOf,
  reasonOf,
  statusAt,
  eventsAt,
} from './diff.js';
import { collectDiff, makeApi, CollectAborted, CollectFailed } from './collect.js';

const $ = (sel) => document.querySelector(sel);

const MAX_RANGE = 40;

const SAMPLE = {
  replicas: ['R1', 'R2'],
  steps: [
    { opId: 'p', type: 'insert', parent: null, seq: 0, title: '点火后初制导' },
    { opId: 'x', type: 'insert', parent: 'p', seq: 1, title: '并联通道 X' },
    { opId: 'y', type: 'insert', parent: 'p', seq: 1, title: '并联通道 Y' },
    { opId: 'g', type: 'insert', parent: null, seq: 2, title: '中段修正组（将撤销）' },
    { opId: 'c', type: 'insert', parent: 'g', seq: 0, title: '组内姿态校正（迟到合法子项）' },
    { opId: 'del-g', type: 'delete', target: 'g' },
    { opId: 'b', type: 'insert', parent: null, seq: 3, title: '末修段' },
    { opId: 'd', type: 'insert', parent: 'b', seq: 0, title: '末修子项（先于父项到达）' },
  ],
  scripts: {
    // R1：x 在 y 前投递；祖先 g 先撤销，合法子项 c 后到
    R1: [
      'p', 'x', 'y',
      'g', 'del-g', 'c',
      'd', 'b',
      'p', // 重复投递：幂等，不新增步骤
      { opId: 'x', type: 'insert', parent: 'p', seq: 1, title: '被篡改的 X 载荷' },
      { opId: 'oob-1', type: 'insert', parent: null, seq: 99, title: '序号越界' },
      { opId: 'orphan-1', type: 'insert', parent: 'ghost', seq: 0, title: '父项永缺' },
      { opId: 'del-ghost', type: 'delete', target: 'ghost' },
    ],
    // R2：同层并联步骤以相反顺序投递；g 的子项先到、撤销后到
    R2: [
      'p', 'y', 'x',
      'g', 'c', 'del-g',
      'd', 'b',
      'g',
      { opId: 'y', type: 'insert', parent: 'p', seq: 1, title: '被篡改的 Y 载荷' },
      { opId: 'oob-2', type: 'insert', parent: null, seq: -1, title: '序号越界' },
      { opId: 'orphan-2', type: 'insert', parent: 'ghost', seq: 1, title: '父项永缺' },
      { opId: 'del-ghost', type: 'delete', target: 'ghost' },
    ],
  },
};

let state = null;
let currentId = localStorage.getItem('drill-id') || null;

// 差异时间轴相关状态
let diffState = null; // { timeline, selectedTick, selectedOpId }
let diffGen = 0; // 代次令牌：过期采集的结果一律丢弃
let diffController = null;
let runningTask = null;
let collecting = false;

function esc(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.payload = data;
    throw err;
  }
  return data;
}

function showError(msg) {
  const box = $('#sheet-error');
  if (!msg) { box.hidden = true; box.textContent = ''; return; }
  box.hidden = false;
  box.textContent = msg;
}

function showDiffError(msg) {
  const box = $('#diff-error');
  if (!msg) { box.hidden = true; box.textContent = ''; return; }
  box.hidden = false;
  box.textContent = msg;
}

function setControls() {
  const active = !!state;
  const ended = state && (state.finished || state.sealed);
  $('#btn-step').disabled = !active || ended || collecting;
  $('#btn-all').disabled = !active || ended || collecting;
  $('#btn-reset').disabled = !active || collecting;
  $('#btn-seal').disabled = !active || state.sealed || collecting;
  $('#btn-deliver').disabled = !active || collecting;
  $('#extra-replica').innerHTML = active
    ? state.replicaIds.map((id) => `<option>${esc(id)}</option>`).join('')
    : '';
  $('#btn-diff').disabled = !active || collecting;
  $('#btn-diff-cancel').disabled = !collecting;
  for (const sel of ['#diff-replica-a', '#diff-replica-b']) $(sel).disabled = !active || collecting;
  $('#diff-from').disabled = $('#diff-to').disabled = !active || collecting;
}

function renderMeta() {
  const el = $('#stage-meta');
  if (!state) { el.textContent = '尚未创建演练'; return; }
  el.innerHTML =
    `tick <b>${state.tick}</b>/<b>${state.length}</b> · ` +
    (state.sealed
      ? '<span class="diverged">已封存</span>'
      : state.finished ? '<span class="diverged">脚本投递完毕（可封存或继续零散投递）</span>' : '进行中') +
    ' · 可见序列：' +
    (state.converged
      ? '<span class="converged">各副本已收敛一致 ✓</span>'
      : '<span class="diverged">副本间尚未收敛</span>');
}

function renderReplica(rid, snap) {
  const visible = snap.visible.map((s) =>
    `<div class="step" style="padding-left:${8 + s.depth * 16}px">` +
    `<span class="seq">[${s.seq}]</span>` +
    `<span>${esc(s.title)}</span>` +
    `<span class="oid">${esc(s.opId)}</span></div>`).join('') ||
    '<div class="empty">（暂无可见步骤）</div>';

  const tombs = snap.tombstones.map((t) =>
    `<div class="tomb-item">⚰ <s>${esc(t.title)}</s> ` +
    `<span class="oid">${esc(t.opId)}</span> 被 ${esc(t.deletedBy)} 撤销（不可见墓碑）</div>`).join('')
    || '<div class="empty">（无墓碑）</div>';

  const waiting = snap.waiting.map((w) =>
    `<div class="wait-item">⏳ ${esc(w.opId)} 等待依赖：${w.type === 'insert' ? `父项 ${esc(w.parent)}` : `撤销目标 ${esc(w.target)}`}</div>`).join('')
    || '<div class="empty">（无等待操作）</div>';

  const rejects = snap.rejected.length
    ? snap.rejected.map((r, i) =>
        `<div class="reject-item">${i === 0 ? '🚫 首个拒因 → ' : '· '}` +
        `<b>${esc(r.label)}</b> <span class="oid">${esc(r.opId)}</span></div>`).join('')
    : '<div class="empty">（无拒绝）</div>';

  return `<div class="replica">
    <h3>${esc(rid)}
      <span class="pill">可见 ${snap.visible.length}</span>
      <span class="pill">等待 ${snap.waiting.length}</span>
      <span class="pill">墓碑 ${snap.tombstones.length}</span>
      <span class="pill">已应用 ${snap.applied.length}</span>
    </h3>
    <div class="section-label">可见步骤（稳定序列）</div>${visible}
    <div class="section-label">等待操作</div>${waiting}
    <div class="section-label">墓碑</div>${tombs}
    <div class="section-label">拒绝记录</div>${rejects}
  </div>`;
}

function tag(status) {
  const cls = `tag-${status}`;
  const text = { applied: '已应用', duplicate: '重复·忽略', waiting: '进入等待', rejected: '已拒绝' }[status] || status;
  return `<span class="${cls}">${text}</span>`;
}

function renderLog() {
  const tbody = $('#log-table tbody');
  tbody.innerHTML = state.log.map((e) =>
    `<tr>
      <td>${e.tick ?? '—'}</td>
      <td class="code">${esc(e.replica)}</td>
      <td>${esc(e.title)}${e.ref ? ` <span class="oid">${esc(e.ref)}</span>` : ''}</td>
      <td>${tag(e.status)}</td>
      <td class="tag-rejected">${e.reason ? esc(REASON_LABEL[e.reason] || e.reason) : ''}</td>
    </tr>`).join('');
}

function render() {
  if (!state) {
    $('#replicas').innerHTML = '';
  } else {
    $('#replicas').innerHTML = state.replicaIds
      .map((rid) => renderReplica(rid, state.replicas[rid])).join('');
  }
  renderMeta();
  renderLog();
  syncDiffControls();
  setControls();
}

// ---------- 差异时间轴 ----------

function fillDiffSelects() {
  const ids = state ? state.replicaIds : [];
  const prevA = $('#diff-replica-a').value;
  const prevB = $('#diff-replica-b').value;
  const opts = ids.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join('');
  $('#diff-replica-a').innerHTML = opts;
  $('#diff-replica-b').innerHTML = opts;
  $('#diff-replica-a').value = ids.includes(prevA) ? prevA : ids[0] ?? '';
  $('#diff-replica-b').value = ids.includes(prevB) && ids.length > 1 ? prevB : ids[1] ?? ids[0] ?? '';
}

function syncDiffControls() {
  fillDiffSelects();
  const max = state ? Math.min(MAX_RANGE, state.tick) : 0;
  for (const input of ['#diff-from', '#diff-to']) {
    $(input).max = String(max);
  }
  if (state) {
    if (Number($('#diff-to').value) > max || !Number($('#diff-to').value)) {
      $('#diff-to').value = String(Math.max(1, max));
    }
    if (Number($('#diff-from').value) > max) $('#diff-from').value = '1';
    if (!Number($('#diff-from').value)) $('#diff-from').value = '1';
  }
}

function statusText(status) {
  const reason = reasonOf(status);
  return reason
    ? `${STATUS_LABEL[kindOf(status)] ?? '已拒绝'}（${REASON_LABEL[reason] ?? reason}）`
    : (STATUS_LABEL[status] ?? status);
}

function renderTickStrip() {
  const { timeline, selectedTick } = diffState;
  $('#diff-timeline').innerHTML = timeline.ticks.map((t) => {
    const cls = [
      'tick-cell',
      t.same ? 'same' : 'diff',
      t.tick === selectedTick ? 'sel' : '',
      t.convergedHere ? 'converged' : '',
    ].join(' ');
    const mark = t.convergedHere ? '<span class="conv-dot" title="收敛点">⇢</span>' : (t.same ? '' : '<span class="diff-dot" title="存在分歧">●</span>');
    return `<button type="button" class="${cls}" data-tick="${t.tick}" title="第 ${t.tick} 步末尾：${t.same ? '两侧一致' : '存在分歧'}${t.convergedHere ? '（收敛点）' : ''}">${mark}${t.tick}</button>`;
  }).join('');
  $('#diff-timeline').querySelectorAll('.tick-cell').forEach((btn) => {
    btn.addEventListener('click', () => {
      diffState.selectedTick = Number(btn.dataset.tick);
      renderDiff();
    });
  });
}

function renderEntries() {
  const { timeline, selectedOpId } = diffState;
  if (!timeline.entries.length) {
    $('#diff-entries').innerHTML =
      '<div class="empty">范围内两个副本在每个步骤末尾的投影完全一致，无任何分歧标识。</div>';
    return;
  }
  $('#diff-entries').innerHTML = timeline.entries.map((en) => {
    const stateCls = en.persistent ? 'persistent' : 'resolved';
    const resolveBadge = en.persistent
      ? '<span class="badge bad">持续分歧（窗口内未收敛）</span>'
      : `<span class="badge ok">第 ${en.resolvedTick} 步收敛</span>`;
    const rejectMark = (flag, side) =>
      flag ? `<span class="badge reject" title="${side} 侧该标识是首个拒因">${side} 首个拒因</span>` : '';
    return `<button type="button" class="diff-entry ${stateCls} ${en.opId === selectedOpId ? 'sel' : ''}" data-op="${esc(en.opId)}">
      <span class="cat cat-${en.category}">${esc(GROUP_LABEL[en.category] ?? en.category)}</span>
      <span class="op oid">${esc(en.opId)}</span>
      <span class="when">首次分歧：第 <b>${en.firstTick}</b> 步</span>
      ${resolveBadge}
      ${rejectMark(en.firstRejectA, timeline.idA)}
      ${rejectMark(en.firstRejectB, timeline.idB)}
      <span class="side-status"><span class="side-a">${esc(timeline.idA)}：${esc(statusText(en.firstA))}</span>
      <span class="side-b">${esc(timeline.idB)}：${esc(statusText(en.firstB))}</span></span>
    </button>`;
  }).join('');
  $('#diff-entries').querySelectorAll('.diff-entry').forEach((btn) => {
    btn.addEventListener('click', () => {
      const en = timeline.entries.find((x) => x.opId === btn.dataset.op);
      diffState.selectedOpId = en.opId;
      diffState.selectedTick = en.firstTick;
      renderDiff();
    });
  });
}

function causeEventsHtml(events, sideId, opId) {
  if (!events.length) {
    return `<div class="empty">该侧在首次分歧步没有针对此标识的直接投递（可能由依赖齐备后的链式收敛间接触发）。</div>`;
  }
  return events.map((ev) =>
    `<div class="cause-event">
      <span class="tag-${ev.status}">${esc({ applied: '已应用', duplicate: '重复·忽略', waiting: '进入等待', rejected: '已拒绝' }[ev.status] ?? ev.status)}</span>
      ${esc(ev.title ?? '')}
      ${ev.ref ? `<span class="oid">${esc(ev.ref)}</span>` : ''}
      ${ev.reason ? `<span class="tag-rejected">${esc(REASON_LABEL[ev.reason] ?? ev.reason)}</span>` : ''}
    </div>`).join('');
}

function renderDetail() {
  const { timeline, selectedTick, selectedOpId } = diffState;
  const tickInfo = timeline.ticks.find((t) => t.tick === selectedTick);
  const head =
    `第 <b>${selectedTick}</b> 步末尾：` +
    (tickInfo.same
      ? '<span class="converged">两侧投影一致 ✓</span>'
      : '<span class="diverged">两侧投影存在分歧</span>') +
    (tickInfo.convergedHere ? ' <span class="badge ok">收敛点</span>' : '');

  if (!selectedOpId) {
    $('#diff-detail').innerHTML =
      `<div class="detail-head">${head}</div>` +
      '<div class="empty">请在下方分歧项中选择一个稳定标识，查看两侧各时刻状态与导致差异的投递动作。</div>';
    return;
  }

  const en = timeline.entries.find((x) => x.opId === selectedOpId);
  const { a, b } = statusAt(timeline, selectedTick, selectedOpId);
  const atCause = selectedTick === en.firstTick;

  const side = (sideId, status, causes) =>
    `<div class="detail-side">
      <h4>${esc(sideId)}</h4>
      <div class="detail-status ${kindOf(status)}">此刻状态：<b>${esc(statusText(status))}</b></div>
      <div class="section-label">导致差异的投递动作（首次分歧 · 第 ${en.firstTick} 步）</div>
      ${causeEventsHtml(causes, sideId, selectedOpId)}
    </div>`;

  $('#diff-detail').innerHTML =
    `<div class="detail-head">${head}
      <span class="meta">标识 <span class="oid">${esc(selectedOpId)}</span>
      （${esc(GROUP_LABEL[en.category] ?? en.category)}）
      首次分歧第 ${en.firstTick} 步 · ${en.persistent ? '窗口内未再一致' : `第 ${en.resolvedTick} 步重新一致`}</span>
    </div>
    <div class="detail-sides">
      ${side(timeline.idA, a, en.causes.a)}
      ${side(timeline.idB, b, en.causes.b)}
    </div>
    <div class="section-label">第 ${selectedTick} 步全部投递动作${atCause ? '（即首次分歧时刻）' : ''}</div>
    <div class="cause-list">${(eventsAt(timeline, selectedTick) || []).map((ev) =>
      `<div class="cause-event"><span class="oid">${esc(ev.replica)}</span>
        ${esc(ev.title ?? '')}${ev.ref ? ` <span class="oid">${esc(ev.ref)}</span>` : ''}
        ${tag(ev.status)}
        ${ev.reason ? `<span class="tag-rejected">${esc(REASON_LABEL[ev.reason] ?? ev.reason)}</span>` : ''}</div>`).join('')}</div>`;
}

function renderDiff() {
  if (!diffState) {
    $('#diff-view').hidden = true;
    return;
  }
  $('#diff-view').hidden = false;
  const tl = diffState.timeline;
  const resolved = tl.entries.filter((e) => !e.persistent).length;
  $('#diff-view-meta').textContent =
    `${tl.idA} ⇄ ${tl.idB} · 第 ${tl.fromTick}–${tl.toTick} 步 · ` +
    `${tl.entries.length} 个标识曾分歧，${resolved} 个在窗口内收敛`;
  renderTickStrip();
  renderEntries();
  renderDetail();
}

function validateRange(idA, idB) {
  if (!state || !currentId) return '演练不存在，请先新建或恢复一个演练。';
  if (!state.replicaIds.includes(idA) || !state.replicaIds.includes(idB)) {
    return '所选副本不在当前演练中。';
  }
  if (idA === idB) return '请选择两个不同的副本。';
  const from = Number($('#diff-from').value);
  const to = Number($('#diff-to').value);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > MAX_RANGE || from > to) {
    return `步骤范围须为 1~${MAX_RANGE} 的整数，且起点不晚于终点。`;
  }
  if (state.tick < 1) return '当前尚未回放任何步骤，请先按步或整段回放后再采集。';
  if (to > state.tick) {
    return `范围越过当前步骤：演练当前停在第 ${state.tick} 步，不能采集到第 ${to} 步。`;
  }
  if (Array.isArray(state.log) && state.log.some((e) => e.extra)) {
    return '该演练含重开后的零散投递，重置会使其无法自动复原；请在仅脚本回放的演练上采集。';
  }
  return null;
}

async function runDiff() {
  showDiffError('');
  const idA = $('#diff-replica-a').value;
  const idB = $('#diff-replica-b').value;
  const invalid = validateRange(idA, idB);
  if (invalid) { showDiffError(invalid); return; }
  const fromTick = Number($('#diff-from').value);
  const toTick = Number($('#diff-to').value);

  // 重选副本/再次采集时，若上一次仍在进行：先取消并等待其（含恢复）彻底结束，
  // 避免两次 reset/play 在同一演练上交错；旧请求受代次令牌保护不会刷新 UI。
  if (runningTask) {
    diffController?.abort();
    try { await runningTask; } catch { /* 旧任务结果将被丢弃 */ }
  }

  const gen = ++diffGen;
  const controller = new AbortController();
  diffController = controller;
  collecting = true;
  setControls();
  $('#diff-view').hidden = true;
  $('#diff-progress').hidden = false;
  $('#diff-progress').textContent = `采集中：0/${toTick} 步…`;

  const task = collectDiff({
    drillId: currentId,
    idA,
    idB,
    fromTick,
    toTick,
    api: makeApi(fetch),
    signal: controller.signal,
    onTick: ({ done, total }) => {
      if (gen === diffGen) $('#diff-progress').textContent = `采集中：${done}/${total} 步…`;
    },
  });
  const done = task.finally(() => {
    if (runningTask === done) {
      runningTask = null;
      diffController = null;
      collecting = false;
      setControls();
      // 过期任务（取消 / 重选副本）：收掉进度条并提示；新采集若已启动会覆盖这些 UI
      if (gen !== diffGen) {
        $('#diff-progress').hidden = true;
        showDiffError('采集已取消；演练步骤与内容已恢复。');
      }
    }
  });
  runningTask = done;

  try {
    const { timeline, restoredTick } = await task;
    if (gen !== diffGen) return; // 已被更新的选择取代：不得覆盖新选择
    // 以服务端恢复后的权威状态刷新主舞台；即使刷新失败，采集结果仍展示
    try {
      state = await api('GET', `/api/drills/${currentId}`);
    } catch { /* 保留旧视图，时间轴仍可用 */ }
    const firstDiff = timeline.ticks.find((t) => !t.same);
    diffState = {
      timeline,
      selectedTick: firstDiff ? firstDiff.tick : fromTick,
      selectedOpId: timeline.entries[0]?.opId ?? null,
    };
    $('#diff-progress').hidden = false;
    $('#diff-progress').textContent = `采集完成，演练已恢复到第 ${restoredTick} 步。`;
    showDiffError('');
    render();
    renderDiff();
    setTimeout(() => { if (gen === diffGen) $('#diff-progress').hidden = true; }, 3000);
  } catch (err) {
    const stale = gen !== diffGen; // 取消或重选副本使本次采集作废
    $('#diff-progress').hidden = true;
    collecting = false;
    setControls();
    // 无论失败还是取消，主舞台都回到服务端恢复后的真实状态；
    // 过期任务（取消/重选）只静默同步 state，不渲染，以免与新采集竞态。
    try {
      const restored = await api('GET', `/api/drills/${currentId}`);
      state = restored;
      if (!stale) render();
    } catch { /* 读取失败则保留旧视图 */ }

    if (stale) {
      // 取消反馈已由 finally 收尾给出；若新采集已经在跑则一切 UI 由它接管。
      return;
    }

    if (err instanceof CollectAborted) {
      showDiffError('采集已取消；演练步骤与内容已恢复。');
    } else if (err instanceof CollectFailed) {
      const stageText = { read: '读取', reset: '重置', play: '逐步回放', restore: '恢复' }[err.stage] ?? err.stage;
      let msg = `采集失败（位置：${stageText}）：${err.message}`;
      if (err.restoreError) msg += `；另外自动恢复也失败：${err.restoreError.message}，请手动点击“重置”。`;
      // 不展示半成品时间轴
      diffState = null;
      $('#diff-view').hidden = true;
      showDiffError(msg);
    } else {
      showDiffError(`采集失败：${err.message}`);
    }
  }
}

async function refresh() {
  if (!currentId) return;
  try {
    state = await api('GET', `/api/drills/${currentId}`);
    render();
  } catch {
    state = null;
    currentId = null;
    localStorage.removeItem('drill-id');
    diffState = null;
    render();
  }
}

$('#btn-sample').addEventListener('click', () => {
  $('#sheet').value = JSON.stringify(SAMPLE, null, 2);
  showError('');
});

$('#btn-create').addEventListener('click', async () => {
  try {
    const created = await api('POST', '/api/drills', { sheet: $('#sheet').value });
    currentId = created.id;
    localStorage.setItem('drill-id', currentId);
    state = created;
    diffState = null;
    diffGen += 1;
    $('#diff-view').hidden = true;
    showError('');
    render();
  } catch (err) {
    showError(`${err.message}${err.payload?.code ? `（${err.payload.code}）` : ''}`);
  }
});

$('#btn-step').addEventListener('click', async () => {
  const r = await api('POST', `/api/drills/${currentId}/play`, { steps: 1 });
  state = r.state; render();
});

$('#btn-all').addEventListener('click', async () => {
  const r = await api('POST', `/api/drills/${currentId}/play`, { steps: 'all' });
  state = r.state; render();
});

$('#btn-reset').addEventListener('click', async () => {
  state = await api('POST', `/api/drills/${currentId}/reset`);
  render();
});

$('#btn-seal').addEventListener('click', async () => {
  state = await api('POST', `/api/drills/${currentId}/seal`);
  render();
});

$('#btn-deliver').addEventListener('click', async () => {
  let op;
  try {
    op = JSON.parse($('#extra-op').value);
  } catch {
    showError('零散投递的操作不是合法 JSON');
    return;
  }
  try {
    const r = await api('POST', `/api/drills/${currentId}/deliver`, {
      replica: $('#extra-replica').value,
      op,
    });
    state = r.state;
    showError('');
    render();
  } catch (err) {
    showError(err.message);
  }
});

$('#btn-diff').addEventListener('click', () => { void runDiff(); });
$('#btn-diff-cancel').addEventListener('click', () => {
  diffGen += 1; // 取消后任何迟到响应都不得再写入
  diffController?.abort();
});
// 采集中途重选副本：作废当前采集（恢复仍在后台完成），旧请求不得覆盖新选择
for (const sel of ['#diff-replica-a', '#diff-replica-b']) {
  $(sel).addEventListener('change', () => {
    if (collecting) {
      diffGen += 1;
      diffController?.abort();
    }
  });
}

async function pollHealth() {
  const el = $('#health');
  try {
    const h = await api('GET', '/healthz');
    el.textContent = `健康检查：正常（已保存演练 ${h.drills} 个）`;
    el.className = 'health ok';
  } catch {
    el.textContent = '健康检查：失败';
    el.className = 'health bad';
  }
}

async function boot() {
  $('#sheet').value = JSON.stringify(SAMPLE, null, 2);
  await pollHealth();
  setInterval(pollHealth, 5000);
  try {
    const list = await api('GET', '/api/drills');
    if (list.drills.length) {
      currentId = list.drills[list.drills.length - 1].id;
      localStorage.setItem('drill-id', currentId);
      await refresh();
      return;
    }
  } catch { /* 全新启动 */ }
  render();
}

boot();
