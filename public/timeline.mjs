// 副本分歧时间轴的纯计算逻辑（无 DOM）：页面（app.js）与 node:test 共用。
// 输入为逐步采集到的两副本投影快照，输出按“稳定步骤标识 × 投影类别”的
// 首次分歧时刻、分歧区间与收敛点。只比较每步末尾的投影内容，
// 投递顺序不同但投影相同不会被记为分歧。

export const MAX_COLLECT_STEPS = 40; // 采集范围不超过 40 步（与单张步骤单动作上限一致）

export const CATEGORIES = [
  { key: 'visible', label: '可见项' },
  { key: 'waiting', label: '等待项' },
  { key: 'tombstone', label: '墓碑' },
  { key: 'applied', label: '已应用' },
  { key: 'rejection', label: '首个拒因' },
];

// 单个副本投影快照 → 各类别下「稳定步骤标识 → 状态值」。
// 状态值含内容（而非仅存在性），同标识但载荷/位置不同也算分歧。
export function projectionOf(snap) {
  const visible = new Map();
  for (const s of snap?.visible ?? []) {
    visible.set(s.opId, JSON.stringify([s.parent, s.seq, s.title, s.depth]));
  }
  const waiting = new Map();
  for (const w of snap?.waiting ?? []) {
    waiting.set(w.opId, JSON.stringify(w));
  }
  const tombstone = new Map();
  for (const t of snap?.tombstones ?? []) {
    tombstone.set(t.opId, JSON.stringify([t.parent, t.seq, t.title, t.deletedBy]));
  }
  const applied = new Map();
  for (const id of snap?.applied ?? []) applied.set(id, true);
  const rejection = new Map(); // 标识 -> 首个拒因代码
  for (const r of snap?.rejected ?? []) rejection.set(r.opId, r.reason);
  return { visible, waiting, tombstone, applied, rejection };
}

// frames: [{ tick, a, b }]，a/b 为两副本在该 tick 末尾的投影快照（须按 tick 升序）。
// 返回 {
//   ticks, rows,
//   summary: { rows, intervals, converged, ongoing }
// }；每行：
//   { id, category, categoryLabel, cells:[{tick,a,b,divergent}],
//     intervals:[{from,to}], convergences:[tick], firstAt, ongoing }
export function buildTimeline(frames) {
  const ticks = frames.map((f) => f.tick);
  const lastTick = ticks[ticks.length - 1];
  const projs = frames.map((f) => ({ a: projectionOf(f.a), b: projectionOf(f.b) }));

  // 各类别下出现过的全部标识，按首次出现顺序排列（展示顺序稳定）
  const idsByCat = new Map();
  for (const c of CATEGORIES) {
    const seen = new Set();
    const ids = [];
    for (const p of projs) {
      for (const id of [...p.a[c.key].keys(), ...p.b[c.key].keys()]) {
        if (!seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
    }
    idsByCat.set(c.key, ids);
  }

  const rows = [];
  for (const c of CATEGORIES) {
    for (const id of idsByCat.get(c.key)) {
      const cells = frames.map((f, i) => {
        const va = projs[i].a[c.key].get(id) ?? null;
        const vb = projs[i].b[c.key].get(id) ?? null;
        return { tick: f.tick, a: va, b: vb, divergent: va !== vb };
      });
      // 全程一致：投递顺序差异不影响结果，不记为分歧
      if (!cells.some((cell) => cell.divergent)) continue;

      const intervals = [];
      const convergences = [];
      let open = null;
      for (const cell of cells) {
        if (cell.divergent) {
          if (open) open.to = cell.tick;
          else open = { from: cell.tick, to: cell.tick };
        } else if (open) {
          intervals.push(open);
          convergences.push(cell.tick); // 重新一致的时刻：收敛点
          open = null;
        }
      }
      if (open) intervals.push(open);

      rows.push({
        id,
        category: c.key,
        categoryLabel: c.label,
        cells,
        intervals,
        convergences,
        firstAt: intervals[0].from,
        ongoing: intervals[intervals.length - 1].to === lastTick,
      });
    }
  }

  return {
    ticks,
    rows,
    summary: {
      rows: rows.length,
      intervals: rows.reduce((n, r) => n + r.intervals.length, 0),
      converged: rows.reduce((n, r) => n + r.convergences.length, 0),
      ongoing: rows.filter((r) => r.ongoing).length,
    },
  };
}

// ---- 采集前的直接校验（全部通过才允许启动采集）----

export function checkReplicaPair(a, b) {
  if (!a || !b) return '请选择要对比的两个副本';
  if (a === b) return '需选择两个不同的副本';
  return null;
}

export function checkCollectRange(from, to, currentTick, maxSteps = MAX_COLLECT_STEPS) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
    return '范围须为整数步骤且满足 1 ≤ 起始 ≤ 结束';
  }
  if (to > maxSteps) return `采集范围须在 ${maxSteps} 步以内`;
  if (to > currentTick) return `范围越过当前已回放步骤（当前第 ${currentTick} 步）`;
  return null;
}

// 含重开后零散投递的演练无法通过“重置+回放”精确复原，采集前直接提示
export function hasExtraDeliveries(log) {
  return (log ?? []).some((e) => e && (e.extra === true || e.tick == null));
}

// 规划复原动作（在 reset 之后按序执行），使演练回到原 tick 与封存状态。
// 若日志中存在 SEALED 拒绝事件，说明封存发生在某次回放之前：
// 须先回放到封存点、执行封存，再继续回放剩余步骤（复原封存后的拒绝记录）。
export function planRestore(savedTick, wasSealed, log) {
  const actions = [];
  let sealAt = null;
  for (const e of log ?? []) {
    if (e && e.tick != null && e.reason === 'SEALED') {
      sealAt = sealAt === null ? e.tick : Math.min(sealAt, e.tick);
    }
  }
  if (wasSealed && sealAt !== null && sealAt <= savedTick) {
    const pre = sealAt - 1;
    if (pre > 0) actions.push({ type: 'play', steps: pre });
    actions.push({ type: 'seal' });
    const rest = savedTick - pre;
    if (rest > 0) actions.push({ type: 'play', steps: rest });
  } else {
    if (savedTick > 0) actions.push({ type: 'play', steps: savedTick });
    if (wasSealed) actions.push({ type: 'seal' });
  }
  return actions;
}
