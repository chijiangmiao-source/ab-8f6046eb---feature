/* 副本回放台前端：零依赖原生 JS（ES 模块）。
 * 分歧时间轴的纯计算逻辑在 /timeline.mjs，页面与 node:test 共用。 */

import {
  buildTimeline,
  checkReplicaPair,
  checkCollectRange,
  hasExtraDeliveries,
  planRestore,
} from './timeline.mjs';

const $ = (sel) => document.querySelector(sel);

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

// ---- 分歧时间轴的页面状态 ----
let collecting = false; // 采集/复原进行中（禁用一切会改动演练的按钮）
let collectGen = 0; // 代际令牌：取消或重选副本后，旧采集的请求结果不得覆盖新选择
let timeline = null; // 采集结果 { ticks, rows, summary, selection, log }
let selectedCell = null; // 时间轴中选中的时刻 { row, tick }
let lastDrillId = null; // 演练切换时清空时间轴与范围默认值
let rangeAuto = true; // 范围“止”未手工改动时跟随当前 tick

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

function fillSelect(sel, ids, preferred) {
  const prev = sel.value;
  sel.innerHTML = ids.map((id) => `<option>${esc(id)}</option>`).join('');
  if (prev && ids.includes(prev)) sel.value = prev;
  else if (preferred && ids.includes(preferred)) sel.value = preferred;
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
  // 分歧时间轴控件：采集中锁定，避免与自动回放相互干扰
  const ids = active ? state.replicaIds : [];
  fillSelect($('#tl-a'), ids, ids[0]);
  fillSelect($('#tl-b'), ids, ids[1] ?? ids[0]);
  $('#tl-a').disabled = !active || collecting;
  $('#tl-b').disabled = !active || collecting;
  $('#tl-from').disabled = !active || collecting;
  $('#tl-to').disabled = !active || collecting;
  $('#btn-tl-collect').disabled = !active || collecting || state.tick < 1;
  $('#btn-tl-cancel').disabled = !collecting;
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

const REASON_TEXT = {
  BAD_SHAPE: '操作格式错误',
  BAD_OP_ID: '稳定操作标识非法',
  REPLAY_CONFLICT: '复用标识但载荷被篡改',
  MISSING_PARENT: '缺失父项',
  PARENT_REJECTED: '父项已被拒绝',
  SEQ_OUT_OF_RANGE: '序号越界',
  TARGET_MISSING: '撤销目标缺失',
  TARGET_TOMBSTONED: '目标已是墓碑',
  SEALED: '演练已封存',
};

function renderLog() {
  const tbody = $('#log-table tbody');
  tbody.innerHTML = state.log.map((e) =>
    `<tr>
      <td>${e.tick ?? '—'}</td>
      <td class="code">${esc(e.replica)}</td>
      <td>${esc(e.title)}${e.ref ? ` <span class="oid">${esc(e.ref)}</span>` : ''}</td>
      <td>${tag(e.status)}</td>
      <td class="tag-rejected">${e.reason ? esc(REASON_TEXT[e.reason] || e.reason) : ''}</td>
    </tr>`).join('');
}

// ---- 分歧时间轴渲染 ----

const TL_VALUE_TEXT = {
  visible: ['可见', '不可见'],
  waiting: ['等待中', '无等待'],
  tombstone: ['墓碑', '无墓碑'],
  applied: ['已应用', '未应用'],
};

function tlValueText(category, v) {
  if (category === 'rejection') return v ? `${REASON_TEXT[v] || v}（${v}）` : '无拒因';
  const [yes, no] = TL_VALUE_TEXT[category];
  return v != null && v !== false ? yes : no;
}

function tlStatus(msg, kind = '') {
  const el = $('#tl-status');
  if (!msg) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.className = `tl-status${kind ? ` ${kind}` : ''}`;
  el.textContent = msg;
}

function clearTimeline() {
  timeline = null;
  selectedCell = null;
  renderTimeline();
}

function intervalText(row) {
  const parts = [];
  row.intervals.forEach((iv, i) => {
    parts.push(`分歧 @${iv.from}${iv.to > iv.from ? `~${iv.to}` : ''}`);
    const conv = row.convergences[i];
    parts.push(conv != null ? `收敛 @${conv}` : '持续至范围末');
  });
  return parts.join(' · ');
}

function renderTimeline() {
  const grid = $('#tl-grid');
  const summaryEl = $('#tl-summary');
  if (!timeline) {
    grid.hidden = true;
    grid.innerHTML = '';
    summaryEl.textContent = '';
    renderDetails();
    return;
  }
  const { ticks, rows, summary, selection } = timeline;
  const selText = `第 ${selection.from}~${selection.to} 步 · ${esc(selection.a)} vs ${esc(selection.b)}`;
  if (!rows.length) {
    summaryEl.innerHTML =
      `${selText}：两副本逐步投影完全一致 ✓` +
      '<span class="tl-note">（投递顺序不同但结果相同，不记为分歧）</span>';
    grid.hidden = true;
    grid.innerHTML = '';
    renderDetails();
    return;
  }
  summaryEl.innerHTML =
    `${selText}：<span class="diverged">${summary.rows} 个标识类别出现分歧</span>` +
    `（共 ${summary.intervals} 段）· 已收敛 ${summary.converged} 段 · ` +
    `持续至范围末 ${summary.ongoing} 个标识`;

  const head = '<tr><th>稳定标识</th><th>类别</th>' +
    ticks.map((t) => `<th>${t}</th>`).join('') +
    '<th>分歧 / 收敛</th></tr>';
  const body = rows.map((row, ri) => {
    const cells = row.cells.map((cell) => {
      const isConv = row.convergences.includes(cell.tick);
      const cls = cell.divergent ? 'tl-div' : isConv ? 'tl-conv' : '';
      const mark = cell.divergent ? (cell.tick === row.firstAt ? '◆' : '●') : isConv ? '✓' : '·';
      const sel = selectedCell && selectedCell.row === ri && selectedCell.tick === cell.tick
        ? ' tl-sel' : '';
      const tip = cell.divergent
        ? `第 ${cell.tick} 步末分歧${cell.tick === row.firstAt ? '（首次分歧）' : ''}`
        : isConv ? `第 ${cell.tick} 步末重新一致（收敛点）` : `第 ${cell.tick} 步末一致`;
      return `<td class="tl-cell ${cls}${sel}" data-row="${ri}" data-tick="${cell.tick}" title="${tip}">${mark}</td>`;
    }).join('');
    return `<tr><td class="code">${esc(row.id)}</td><td>${row.categoryLabel}</td>${cells}` +
      `<td class="tl-iv">${intervalText(row)}</td></tr>`;
  }).join('');
  grid.innerHTML = `<table class="tl-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
  grid.hidden = false;
  renderDetails();
}

function renderDetails() {
  const box = $('#tl-details');
  if (!timeline || !selectedCell) { box.hidden = true; box.innerHTML = ''; return; }
  const row = timeline.rows[selectedCell.row];
  if (!row) { box.hidden = true; box.innerHTML = ''; return; }
  const cell = row.cells.find((c) => c.tick === selectedCell.tick);
  if (!cell) { box.hidden = true; box.innerHTML = ''; return; }
  const { a, b } = timeline.selection;
  const events = (timeline.log ?? []).filter(
    (e) => e.tick === cell.tick && (e.replica === a || e.replica === b),
  );
  const evHtml = [a, b].map((rid) => {
    const list = events.filter((e) => e.replica === rid);
    if (!list.length) return `<div class="tl-ev"><b>${esc(rid)}</b>：本步无投递</div>`;
    return list.map((e) =>
      `<div class="tl-ev"><b>${esc(rid)}</b> → ${esc(e.title)}` +
      `${e.ref ? ` <span class="oid">${esc(e.ref)}</span>` : ''} ${tag(e.status)}` +
      `${e.reason ? ` <span class="tag-rejected">${esc(REASON_TEXT[e.reason] || e.reason)}</span>` : ''}</div>`,
    ).join('');
  }).join('');
  box.innerHTML =
    `<div class="section-label">分歧详情 · 标识 <span class="oid">${esc(row.id)}</span>` +
    ` · ${row.categoryLabel} · 第 ${cell.tick} 步末${cell.divergent ? '（分歧）' : '（一致）'}</div>` +
    `<div class="tl-sides">` +
    `<div><b>${esc(a)}</b>：${esc(tlValueText(row.category, cell.a))}</div>` +
    `<div><b>${esc(b)}</b>：${esc(tlValueText(row.category, cell.b))}</div>` +
    `</div>` +
    `<div class="section-label">导致差异的投递动作（第 ${cell.tick} 步）</div>${evHtml}`;
  box.hidden = false;
}

function render() {
  if (!state) {
    $('#replicas').innerHTML = '';
  } else {
    $('#replicas').innerHTML = state.replicaIds
      .map((rid) => renderReplica(rid, state.replicas[rid])).join('');
  }
  // 切换演练：时间轴与范围默认值随之失效
  const drillId = state?.id ?? null;
  if (drillId !== lastDrillId) {
    lastDrillId = drillId;
    rangeAuto = true;
    $('#tl-from').value = 1;
    clearTimeline();
  }
  if (state && rangeAuto) $('#tl-to').value = state.tick;
  renderMeta();
  renderLog();
  setControls();
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
    render();
  }
}

// ---- 分歧时间轴采集：复用现有 重置 / 逐步回放 / 读取 流程 ----

async function runCollection() {
  if (collecting) return;
  // 直接提示类校验（不启动采集）
  if (!state || !currentId) return tlStatus('演练不存在或尚未加载，请先创建演练', 'err');
  const a = $('#tl-a').value;
  const b = $('#tl-b').value;
  const pairMsg = checkReplicaPair(a, b);
  if (pairMsg) return tlStatus(pairMsg, 'err');
  const from = Number($('#tl-from').value);
  const to = Number($('#tl-to').value);
  const rangeMsg = checkCollectRange(from, to, state.tick);
  if (rangeMsg) return tlStatus(rangeMsg, 'err');
  if (hasExtraDeliveries(state.log)) {
    return tlStatus('该演练已包含重开后零散投递，采集需重置演练且无法复原这些投递；请先重置或新建演练', 'err');
  }

  const gen = ++collectGen;
  collecting = true;
  clearTimeline();
  setControls();
  const saved = { tick: state.tick, sealed: state.sealed, log: state.log };
  const frames = [];
  let lastLog = [];
  let failure = null;

  // 取消或重选后，旧采集在下一个检查点中止，其结果不再写入页面
  const alive = () => {
    if (gen !== collectGen) {
      const err = new Error('已取消');
      err.cancelled = true;
      throw err;
    }
  };
  // 采集动作包装：记录失败位置（阶段 + 步骤号）
  const attempt = async (stage, stepNo, fn) => {
    try {
      return await fn();
    } catch (err) {
      err.stage = err.stage ?? stage;
      err.stepNo = err.stepNo ?? stepNo;
      throw err;
    }
  };

  try {
    await attempt('重置', 0, () => api('POST', `/api/drills/${currentId}/reset`));
    alive();
    for (let t = 1; t <= to; t += 1) {
      tlStatus(`采集中：第 ${t}/${to} 步…`, '');
      await attempt('回放', t, () => api('POST', `/api/drills/${currentId}/play`, { steps: 1 }));
      alive();
      if (t >= from) {
        const s = await attempt('读取', t, () => api('GET', `/api/drills/${currentId}`));
        alive();
        frames.push({ tick: t, a: s.replicas[a], b: s.replicas[b] });
        lastLog = s.log;
      }
    }
    alive();
    const result = buildTimeline(frames);
    timeline = { ...result, selection: { a, b, from, to }, log: lastLog };
    selectedCell = null;
    tlStatus(`采集完成：第 ${from}~${to} 步，演练已复原至第 ${saved.tick} 步。`, 'ok');
  } catch (err) {
    // 不留下部分时间轴
    timeline = null;
    selectedCell = null;
    if (err.cancelled) {
      tlStatus('已取消采集，演练已复原。', '');
    } else {
      failure = err;
      const where = err.stage ? `${err.stage}${err.stepNo ? `（第 ${err.stepNo} 步）` : ''}` : '采集';
      tlStatus(`采集失败于${where}：${err.message}。已尝试复原演练，未保留部分时间轴。`, 'err');
    }
  } finally {
    // 无论成功、失败或取消：复原演练到原步骤与封存状态
    try {
      await api('POST', `/api/drills/${currentId}/reset`);
      for (const act of planRestore(saved.tick, saved.sealed, saved.log)) {
        if (act.type === 'play') {
          await api('POST', `/api/drills/${currentId}/play`, { steps: act.steps });
        } else {
          await api('POST', `/api/drills/${currentId}/seal`);
        }
      }
      await refresh();
    } catch (err2) {
      tlStatus(`${failure ? '采集失败；' : ''}复原演练失败：${err2.message}，请检查服务状态后手动重置`, 'err');
    }
    collecting = false;
    setControls();
    renderTimeline();
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

// ---- 分歧时间轴事件 ----

$('#btn-tl-collect').addEventListener('click', () => {
  runCollection();
});

$('#btn-tl-cancel').addEventListener('click', () => {
  collectGen += 1; // 旧采集在下一个检查点中止；复原仍会继续
});

// 重选副本或改动范围：作废旧采集并清空旧时间轴，旧请求不得覆盖新选择
for (const sel of ['#tl-a', '#tl-b']) {
  $(sel).addEventListener('change', () => {
    collectGen += 1;
    clearTimeline();
    tlStatus('', '');
  });
}
$('#tl-from').addEventListener('change', () => {
  collectGen += 1;
  clearTimeline();
});
$('#tl-to').addEventListener('input', () => {
  rangeAuto = false;
  collectGen += 1;
  clearTimeline();
});

$('#tl-grid').addEventListener('click', (ev) => {
  const td = ev.target.closest('td.tl-cell');
  if (!td || !timeline) return;
  selectedCell = { row: Number(td.dataset.row), tick: Number(td.dataset.tick) };
  renderTimeline();
});

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
