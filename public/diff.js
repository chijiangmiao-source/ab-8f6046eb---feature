// 双副本差异时间轴纯计算（无 DOM / 无网络请求），页面与 node:test 共用。
//
// 输入：逐步回放采集到的两侧副本快照（与 GET /api/drills/:id 的 replicas 同构）。
// 输出：按稳定操作标识（opId / 派生拒因键）给出的首次分歧步、重新收敛步与分类。
//
// 可见序列本身按 (seq, opId) 稳定排序（见引擎 visibleSequence），因此两侧只是
// 投递顺序不同、最终投影相同时，只会得到“临时分歧 + 收敛点”，不会被误报为持续分歧。

export const REASON_LABEL = {
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

// 分类优先级：拒因（首个拒因）> 等待 > 墓碑 > 可见 > 仅已应用
export const GROUP_ORDER = ['rejected', 'waiting', 'tomb', 'visible', 'applied'];

export const GROUP_LABEL = {
  rejected: '首个拒因 / 拒绝记录',
  waiting: '等待项',
  tomb: '墓碑',
  visible: '可见项',
  applied: '已应用记录',
};

export const STATUS_LABEL = {
  absent: '未出现',
  visible: '可见',
  waiting: '等待中',
  tomb: '墓碑（不可见）',
  applied: '已应用',
};

// 拒因状态串：rejected:<REASON>
export function kindOf(status) {
  return typeof status === 'string' && status.startsWith('rejected:')
    ? 'rejected'
    : status;
}

export function reasonOf(status) {
  return typeof status === 'string' && status.startsWith('rejected:')
    ? status.slice('rejected:'.length)
    : null;
}

// 由副本快照推导“稳定标识 -> 状态”。
// 一个标识在同一时刻只会落到一种投影上，优先级：
// 拒因 > 等待 > 墓碑 > 可见 > 已应用（如 delete 操作本身）> 未出现。
export function projectionOf(snap) {
  const map = new Map();
  for (const opId of snap.applied ?? []) map.set(opId, 'applied');
  for (const s of snap.visible ?? []) map.set(s.opId, 'visible');
  for (const t of snap.tombstones ?? []) map.set(t.opId, 'tomb');
  for (const w of snap.waiting ?? []) map.set(w.opId, 'waiting');
  for (const r of snap.rejected ?? []) map.set(r.opId, `rejected:${r.reason}`);
  return map;
}

export function statusOf(proj, opId) {
  return proj.get(opId) ?? 'absent';
}

// 整个投影的稳定签名：任一部分不同即视为分歧。
// 可见/墓碑按引擎的稳定树序列比较（与投递顺序无关）；
// 等待、已应用是集合语义，排序后比较；拒因按出现先后比较（首项即首个拒因）。
export function signatureOf(snap) {
  return JSON.stringify({
    visible: (snap.visible ?? []).map((s) => s.opId),
    tombs: (snap.tombstones ?? []).map((t) => t.opId),
    waiting: (snap.waiting ?? []).map((w) => w.opId).sort(),
    applied: [...(snap.applied ?? [])].sort(),
    rejected: (snap.rejected ?? []).map((r) => [r.opId, r.reason]),
  });
}

// 投递事件是否涉及某个差异标识。篡改事件以派生键留痕（x#tampered#<fp>），
// 其事件本体的 opId/ref 仍是原标识，需要按前缀关联。
export function eventTouches(event, opId) {
  if (!event || opId == null) return false;
  if (event.opId === opId || event.ref === opId) return true;
  return (
    typeof opId === 'string' &&
    opId.includes('#tampered#') &&
    event.opId != null &&
    opId.startsWith(`${event.opId}#tampered#`)
  );
}

// samples: [{ tick, snapA, snapB, events }]，tick 从 1 起连续。
// opts: { idA, idB, fromTick, toTick } 仅 [fromTick, toTick] 计入分析窗口。
export function buildTimeline(samples, opts) {
  const { idA, idB, fromTick, toTick } = opts;
  const byTick = new Map(samples.map((s) => [s.tick, s]));

  const enriched = samples
    .filter((s) => s.tick >= fromTick - 1 && s.tick <= toTick)
    .map((s) => {
      const pa = projectionOf(s.snapA);
      const pb = projectionOf(s.snapB);
      return {
        tick: s.tick,
        pa,
        pb,
        events: s.events ?? [],
        snapA: s.snapA,
        snapB: s.snapB,
        same: signatureOf(s.snapA) === signatureOf(s.snapB),
      };
    });
  const enrichedByTick = new Map(enriched.map((s) => [s.tick, s]));

  // 窗口内逐 tick 的一致/分歧与整体收敛点（分歧后首次重新一致）
  const ticks = [];
  for (let t = fromTick; t <= toTick; t += 1) {
    const cur = enrichedByTick.get(t);
    const prev = enrichedByTick.get(t - 1);
    const same = !!cur && cur.same;
    ticks.push({
      tick: t,
      same,
      convergedHere: same && !!prev && !prev.same,
    });
  }

  // 窗口内任一侧出现过的全部稳定标识
  const ids = new Set();
  for (let t = fromTick; t <= toTick; t += 1) {
    const s = enrichedByTick.get(t);
    if (!s) continue;
    for (const id of s.pa.keys()) ids.add(id);
    for (const id of s.pb.keys()) ids.add(id);
  }

  const entries = [];
  for (const opId of ids) {
    let firstTick = null;
    let firstA = null;
    let firstB = null;
    for (let t = fromTick; t <= toTick; t += 1) {
      const s = enrichedByTick.get(t);
      const a = statusOf(s.pa, opId);
      const b = statusOf(s.pb, opId);
      if (a !== b) {
        firstTick = t;
        firstA = a;
        firstB = b;
        break;
      }
    }
    if (firstTick === null) continue;

    // 重新一致：首次分歧之后第一处两侧状态相同的 tick
    let resolvedTick = null;
    for (let t = firstTick + 1; t <= toTick; t += 1) {
      const s = enrichedByTick.get(t);
      if (statusOf(s.pa, opId) === statusOf(s.pb, opId)) {
        resolvedTick = t;
        break;
      }
    }

    const kinds = [kindOf(firstA), kindOf(firstB)];
    const category = GROUP_ORDER.find((g) => kinds.includes(g));

    const first = enrichedByTick.get(firstTick);
    const firstRejectA = first.snapA.rejected?.[0]?.opId === opId;
    const firstRejectB = first.snapB.rejected?.[0]?.opId === opId;
    const causes = {
      a: first.events.filter((ev) => ev.replica === idA && eventTouches(ev, opId)),
      b: first.events.filter((ev) => ev.replica === idB && eventTouches(ev, opId)),
    };

    entries.push({
      opId,
      category,
      firstTick,
      firstA,
      firstB,
      resolvedTick,
      persistent: resolvedTick === null,
      firstRejectA,
      firstRejectB,
      causes,
    });
  }

  entries.sort((x, y) => {
    if (x.firstTick !== y.firstTick) return x.firstTick - y.firstTick;
    const gx = GROUP_ORDER.indexOf(x.category);
    const gy = GROUP_ORDER.indexOf(y.category);
    if (gx !== gy) return gx - gy;
    return x.opId < y.opId ? -1 : x.opId > y.opId ? 1 : 0;
  });

  return {
    idA,
    idB,
    fromTick,
    toTick,
    ticks,
    entries,
    samples: enriched.filter((s) => s.tick >= fromTick),
  };
}

export function statusAt(timeline, tick, opId) {
  const s = timeline.samples.find((x) => x.tick === tick);
  if (!s) return { a: 'absent', b: 'absent' };
  return { a: statusOf(s.pa, opId), b: statusOf(s.pb, opId) };
}

export function sampleAt(timeline, tick) {
  return timeline.samples.find((x) => x.tick === tick) ?? null;
}

export function eventsAt(timeline, tick) {
  return sampleAt(timeline, tick)?.events ?? [];
}
