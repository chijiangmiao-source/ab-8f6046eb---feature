// 分歧时间轴验收：按稳定步骤标识定位首次分歧与收敛点、
// 顺序差异不误报为持续分歧、校验直接提示、复原动作规划。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSheet, Drill } from '../src/drill.mjs';
import {
  buildTimeline,
  checkReplicaPair,
  checkCollectRange,
  hasExtraDeliveries,
  planRestore,
  projectionOf,
} from '../public/timeline.mjs';

// 复用页面采集路径：重置后逐步回放，每步末尾取两副本投影
function collectFrames(drill, a, b) {
  drill.reset();
  const frames = [];
  while (!drill.finished) {
    drill.play(1);
    const s = drill.state();
    frames.push({ tick: s.tick, a: s.replicas[a], b: s.replicas[b] });
  }
  return frames;
}

function makeDrill(sheet, id = 'tl') {
  return new Drill(id, parseSheet(JSON.stringify(sheet)));
}

const rowOf = (tl, id, category) =>
  tl.rows.find((r) => r.id === id && r.category === category);

test('采集前校验：两个不同副本、范围落在已回放步骤内且不超过 40 步', () => {
  assert.equal(checkReplicaPair('', 'R2'), '请选择要对比的两个副本');
  assert.equal(checkReplicaPair('R1', 'R1'), '需选择两个不同的副本');
  assert.equal(checkReplicaPair('R1', 'R2'), null);

  assert.match(checkCollectRange(0, 3, 5), /1 ≤ 起始 ≤ 结束/);
  assert.match(checkCollectRange(4, 3, 5), /1 ≤ 起始 ≤ 结束/);
  assert.match(checkCollectRange(1.5, 3, 5), /整数/);
  assert.match(checkCollectRange(1, 41, 41), /40 步以内/);
  assert.match(checkCollectRange(1, 6, 5), /越过当前已回放步骤/);
  assert.equal(checkCollectRange(2, 5, 5), null);
});

test('投递顺序不同但结果相同：标出首次分歧与收敛点，不误报为持续分歧', () => {
  const sheet = {
    replicas: ['R1', 'R2'],
    steps: [
      { opId: 'p', type: 'insert', parent: null, seq: 0, title: '根' },
      { opId: 'x', type: 'insert', parent: 'p', seq: 1, title: '通道X' },
      { opId: 'y', type: 'insert', parent: 'p', seq: 1, title: '通道Y' },
    ],
    scripts: { R1: ['p', 'x', 'y'], R2: ['p', 'y', 'x'] },
  };
  const tl = buildTimeline(collectFrames(makeDrill(sheet), 'R1', 'R2'));

  // 第 2 步末 R1 已有 x、R2 已有 y：x/y 的可见项与已应用出现瞬时分歧
  for (const [id, cat] of [['x', 'visible'], ['x', 'applied'], ['y', 'visible'], ['y', 'applied']]) {
    const row = rowOf(tl, id, cat);
    assert.ok(row, `应存在 ${id}/${cat} 分歧行`);
    assert.equal(row.firstAt, 2, '首次分歧在第 2 步末');
    assert.deepEqual(row.intervals, [{ from: 2, to: 2 }]);
    assert.deepEqual(row.convergences, [3], '第 3 步末重新一致（收敛点）');
    assert.equal(row.ongoing, false, '不得误报为持续分歧');
  }
  // 根步骤 p 两副本同步到达：不产生分歧行
  assert.equal(rowOf(tl, 'p', 'visible'), undefined);
  assert.equal(tl.summary.ongoing, 0);
  assert.equal(tl.summary.converged, 4);
});

test('两副本逐步投影完全一致：零分歧行', () => {
  const sheet = {
    replicas: ['R1', 'R2'],
    steps: [
      { opId: 'p', type: 'insert', parent: null, seq: 0, title: '根' },
      { opId: 'x', type: 'insert', parent: 'p', seq: 1, title: 'X' },
    ],
    scripts: { R1: ['p', 'x'], R2: ['p', 'x'] },
  };
  const tl = buildTimeline(collectFrames(makeDrill(sheet), 'R1', 'R2'));
  assert.equal(tl.rows.length, 0);
  assert.equal(tl.summary.intervals, 0);
});

test('单侧故障注入：首个拒因分歧持续至范围末并标记未收敛', () => {
  const sheet = {
    replicas: ['R1', 'R2'],
    steps: [
      { opId: 'p', type: 'insert', parent: null, seq: 0, title: '根' },
      { opId: 'x', type: 'insert', parent: 'p', seq: 1, title: 'X' },
    ],
    scripts: {
      R1: ['p', { opId: 'oob', type: 'insert', parent: null, seq: 99, title: '越界' }, 'x'],
      R2: ['p', 'x'],
    },
  };
  const tl = buildTimeline(collectFrames(makeDrill(sheet), 'R1', 'R2'));

  const rej = rowOf(tl, 'oob', 'rejection');
  assert.ok(rej, '越界注入应产生首个拒因分歧行');
  assert.equal(rej.firstAt, 2);
  assert.equal(rej.ongoing, true, '范围末仍分歧');
  assert.deepEqual(rej.convergences, []);
  const cell2 = rej.cells.find((c) => c.tick === 2);
  assert.equal(cell2.a, 'SEQ_OUT_OF_RANGE');
  assert.equal(cell2.b, null);

  // x 在 R1 第 3 步才到：已应用在第 2 步末瞬时分歧、第 3 步末收敛
  const applied = rowOf(tl, 'x', 'applied');
  assert.equal(applied.firstAt, 2);
  assert.deepEqual(applied.convergences, [3]);
  assert.equal(applied.ongoing, false);
});

test('墓碑与等待类别：撤销不同步产生墓碑分歧，滞留等待单侧可见', () => {
  const sheet = {
    replicas: ['R1', 'R2'],
    steps: [
      { opId: 'p', type: 'insert', parent: null, seq: 0, title: '根' },
      { opId: 'x', type: 'insert', parent: 'p', seq: 1, title: 'X' },
      { opId: 'del-x', type: 'delete', target: 'x' },
    ],
    scripts: {
      R1: ['p', 'x', 'del-x'],
      R2: ['p', { opId: 'w', type: 'insert', parent: 'ghost', seq: 0, title: '滞留' }, 'x'],
    },
  };
  const tl = buildTimeline(collectFrames(makeDrill(sheet), 'R1', 'R2'));

  const tomb = rowOf(tl, 'x', 'tombstone');
  assert.ok(tomb, 'R1 第 3 步撤销 x，R2 未撤销：墓碑分歧');
  assert.equal(tomb.firstAt, 3);
  assert.equal(tomb.ongoing, true);

  const wait = rowOf(tl, 'w', 'waiting');
  assert.ok(wait, 'R2 的滞留等待项应产生等待分歧');
  assert.equal(wait.firstAt, 2);
  assert.equal(wait.ongoing, true);
});

test('复原规划与零散投递检测', () => {
  // 未封存：直接回放到原 tick
  assert.deepEqual(planRestore(5, false, []), [{ type: 'play', steps: 5 }]);
  assert.deepEqual(planRestore(0, false, []), []);
  // 封存发生在全部回放之后：回放后封存
  assert.deepEqual(
    planRestore(7, true, [{ tick: 3, reason: 'SEQ_OUT_OF_RANGE' }]),
    [{ type: 'play', steps: 7 }, { type: 'seal' }],
  );
  // 封存发生在第 5 步之前（日志中第 5 步起出现 SEALED 拒绝）：
  // 先回放 4 步、封存、再回放剩余 3 步，复原封存后的拒绝记录
  const log = [
    { tick: 5, reason: 'SEALED' },
    { tick: 6, reason: 'SEALED' },
    { tick: 7, reason: 'SEALED' },
  ];
  assert.deepEqual(planRestore(7, true, log), [
    { type: 'play', steps: 4 },
    { type: 'seal' },
    { type: 'play', steps: 3 },
  ]);

  assert.equal(hasExtraDeliveries([{ tick: 1 }, { tick: 2 }]), false);
  assert.equal(hasExtraDeliveries([{ tick: 1 }, { tick: null, extra: true }]), true);
});

test('投影提取：同标识载荷不同也算分歧；拒因按标识取值', () => {
  const snap = {
    visible: [{ opId: 'x', parent: 'p', seq: 1, title: 'X1', depth: 1 }],
    waiting: [{ opId: 'w', type: 'insert', parent: 'g', seq: 0, title: 'W' }],
    tombstones: [{ opId: 'g', parent: null, seq: 2, title: 'G', deletedBy: 'd1' }],
    applied: ['x', 'd1'],
    rejected: [{ opId: 'bad', reason: 'SEQ_OUT_OF_RANGE' }],
  };
  const p1 = projectionOf(snap);
  const p2 = projectionOf({
    ...snap,
    visible: [{ opId: 'x', parent: 'p', seq: 1, title: 'X2-篡改', depth: 1 }],
  });
  assert.notEqual(p1.visible.get('x'), p2.visible.get('x'), '同标识不同载荷应判分歧');
  assert.equal(p1.rejection.get('bad'), 'SEQ_OUT_OF_RANGE');
  assert.equal(p1.applied.get('x'), true);
  assert.equal(p1.waiting.has('w'), true);
  assert.equal(p1.tombstone.has('g'), true);
});
