// 差异时间轴纯计算验收：
//  - 相反投递顺序只产生临时分歧，投影一致后标出收敛点，不误报为持续分歧；
//  - 可见 / 等待 / 墓碑 / 已应用 / 首个拒因各自的首次分歧时刻与分类；
//  - 拒因状态串、等待集合顺序无关、篡改派生键的事件关联。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTimeline,
  projectionOf,
  signatureOf,
  statusAt,
  eventTouches,
  kindOf,
  reasonOf,
  GROUP_ORDER,
} from '../public/diff.js';

const vis = (opId, parent = null, seq = 0, depth = 0) => ({ opId, parent, seq, depth, title: opId });
const wait = (opId, parent = null) => ({ opId, type: 'insert', parent, seq: 0, title: opId });
const tomb = (opId, deletedBy = `del-${opId}`) => ({ opId, parent: null, seq: 0, title: opId, deletedBy });
const rej = (opId, reason) => ({ opId, reason, label: reason, op: { opId } });

function snap({ visible = [], waiting = [], tombstones = [], rejected = [], applied = [] } = {}) {
  return {
    id: 'snap', sealed: false, deliveryCount: 0,
    visible, waiting, tombstones, rejected, applied,
  };
}

const ev = (tick, replica, opId, extra = {}) => ({
  tick, replica, ref: opId, opId, title: `动作 ${opId}`, status: 'applied', ...extra,
});

test('相反顺序投递：临时分歧后在结果一致处收敛，不标记为持续分歧', () => {
  // tick1：两侧都只有 p —— 一致
  // tick2：R1 先有 x，R2 先有 y —— x/y 首次分歧
  // tick3：两侧都为 p,x,y（稳定排序）—— 收敛
  const samples = [
    { tick: 1, snapA: snap({ visible: [vis('p')], applied: ['p'] }),
      snapB: snap({ visible: [vis('p')], applied: ['p'] }),
      events: [ev(1, 'A', 'p'), ev(1, 'B', 'p')] },
    { tick: 2, snapA: snap({ visible: [vis('p'), vis('x', 'p', 1)], applied: ['p', 'x'] }),
      snapB: snap({ visible: [vis('p'), vis('y', 'p', 1)], applied: ['p', 'y'] }),
      events: [ev(2, 'A', 'x'), ev(2, 'B', 'y')] },
    { tick: 3,
      snapA: snap({ visible: [vis('p'), vis('x', 'p', 1), vis('y', 'p', 1)], applied: ['p', 'x', 'y'] }),
      snapB: snap({ visible: [vis('p'), vis('x', 'p', 1), vis('y', 'p', 1)], applied: ['p', 'y', 'x'] }),
      events: [ev(3, 'A', 'y'), ev(3, 'B', 'x')] },
  ];
  const tl = buildTimeline(samples, { idA: 'A', idB: 'B', fromTick: 1, toTick: 3 });

  assert.deepEqual(tl.ticks.map((t) => t.same), [true, false, true]);
  assert.equal(tl.ticks[2].convergedHere, true);
  assert.equal(tl.ticks[1].convergedHere, false);

  const byId = Object.fromEntries(tl.entries.map((e) => [e.opId, e]));
  assert.deepEqual(Object.keys(byId).sort(), ['x', 'y']);
  for (const opId of ['x', 'y']) {
    assert.equal(byId[opId].firstTick, 2);
    assert.equal(byId[opId].resolvedTick, 3, `${opId} 第 3 步重新一致`);
    assert.equal(byId[opId].persistent, false);
    assert.equal(byId[opId].category, 'visible');
  }
  // 导致差异的投递动作按侧归因
  assert.deepEqual(byId.x.causes.a.map((e) => e.opId), ['x']);
  assert.deepEqual(byId.x.causes.b.map((e) => e.opId), []);
  assert.deepEqual(byId.y.causes.b.map((e) => e.opId), ['y']);

  // 选中第 3 步时两侧状态一致
  assert.deepEqual(statusAt(tl, 3, 'x'), { a: 'visible', b: 'visible' });
  assert.deepEqual(statusAt(tl, 2, 'x'), { a: 'visible', b: 'absent' });
});

test('窗口内始终未一致 => 持续分歧；分类按 拒因>等待>墓碑>可见>已应用 取最高优先级', () => {
  const samples = [
    { tick: 1,
      snapA: snap({ visible: [vis('p')], applied: ['p'] }),
      snapB: snap({ visible: [vis('p')], applied: ['p'] }),
      events: [ev(1, 'A', 'p'), ev(1, 'B', 'p')] },
    { tick: 2,
      // A：z 被拒（越界）；B：z 进入等待
      snapA: snap({ visible: [vis('p')], rejected: [rej('z', 'SEQ_OUT_OF_RANGE')], applied: ['p'] }),
      snapB: snap({ visible: [vis('p')], waiting: [wait('z', 'q')], applied: ['p'] }),
      events: [ev(2, 'A', 'z', { status: 'rejected', reason: 'SEQ_OUT_OF_RANGE' }),
        ev(2, 'B', 'z', { status: 'waiting' })] },
  ];
  const tl = buildTimeline(samples, { idA: 'A', idB: 'B', fromTick: 1, toTick: 2 });
  const z = tl.entries.find((e) => e.opId === 'z');
  assert.equal(z.firstTick, 2);
  assert.equal(z.resolvedTick, null);
  assert.equal(z.persistent, true);
  assert.equal(z.category, 'rejected');
  assert.equal(kindOf(z.firstA), 'rejected');
  assert.equal(reasonOf(z.firstA), 'SEQ_OUT_OF_RANGE');
  assert.equal(z.firstB, 'waiting');
});

test('墓碑分歧后重新一致；可见与墓碑的状态优先级正确', () => {
  const samples = [
    { tick: 1,
      snapA: snap({ visible: [vis('g')], tombstones: [], applied: ['g'] }),
      snapB: snap({ visible: [vis('g')], tombstones: [], applied: ['g'] }),
      events: [ev(1, 'A', 'g'), ev(1, 'B', 'g')] },
    { tick: 2,
      snapA: snap({ visible: [], tombstones: [tomb('g')], applied: ['g', 'del-g'] }),
      snapB: snap({ visible: [vis('g')], applied: ['g'] }),
      events: [ev(2, 'A', 'del-g'), ev(2, 'B', 'dup', { status: 'duplicate' })] },
    { tick: 3,
      snapA: snap({ visible: [], tombstones: [tomb('g')], applied: ['g', 'del-g'] }),
      snapB: snap({ visible: [], tombstones: [tomb('g')], applied: ['g', 'del-g'] }),
      events: [ev(3, 'B', 'del-g')] },
  ];
  const tl = buildTimeline(samples, { idA: 'A', idB: 'B', fromTick: 1, toTick: 3 });
  const g = tl.entries.find((e) => e.opId === 'g');
  assert.equal(g.category, 'tomb');
  assert.equal(g.firstTick, 2);
  assert.equal(g.firstA, 'tomb');
  assert.equal(g.firstB, 'visible');
  assert.equal(g.resolvedTick, 3);
  assert.equal(g.persistent, false);
  assert.equal(tl.ticks[2].convergedHere, true);
});

test('等待项顺序不同但集合相同不算分歧；已应用记录差异可被识别', () => {
  const a = snap({ waiting: [wait('b'), wait('a')] });
  const b = snap({ waiting: [wait('a'), wait('b')] });
  assert.equal(signatureOf(a), signatureOf(b));

  const samples = [
    { tick: 1,
      snapA: snap({ applied: ['p'], visible: [vis('p')] }),
      snapB: snap({ visible: [vis('p')], applied: ['p'] }),
      events: [] },
    { tick: 2,
      // A 收到一个 delete 并生效（目标可见性两侧恰好相同的场景用 applied 差异体现）
      snapA: snap({ visible: [vis('p')], applied: ['p', 'undo-p'] }),
      snapB: snap({ visible: [vis('p')], applied: ['p'] }),
      events: [ev(2, 'A', 'undo-p')] },
  ];
  const tl = buildTimeline(samples, { idA: 'A', idB: 'B', fromTick: 1, toTick: 2 });
  const undo = tl.entries.find((e) => e.opId === 'undo-p');
  assert.ok(undo, '已应用集合差异应产生条目');
  assert.equal(undo.category, 'applied');
  assert.equal(undo.firstA, 'applied');
  assert.equal(undo.firstB, 'absent');
});

test('首个拒因标记：拒因列表首项与本标识一致时该侧标记 firstReject', () => {
  const samples = [
    { tick: 1, snapA: snap(), snapB: snap(), events: [] },
    { tick: 2,
      snapA: snap({ rejected: [rej('z', 'SEQ_OUT_OF_RANGE')] }),
      snapB: snap({ waiting: [wait('z', 'q')], rejected: [rej('w', 'MISSING_PARENT')] }),
      events: [
        ev(2, 'A', 'z', { status: 'rejected', reason: 'SEQ_OUT_OF_RANGE' }),
        ev(2, 'B', 'w', { status: 'rejected', reason: 'MISSING_PARENT' }),
        ev(2, 'B', 'z', { status: 'waiting' }),
      ] },
  ];
  const tl = buildTimeline(samples, { idA: 'A', idB: 'B', fromTick: 1, toTick: 2 });
  const z = tl.entries.find((e) => e.opId === 'z');
  assert.equal(z.firstRejectA, true); // z 是 A 的首个拒因
  assert.equal(z.firstRejectB, false); // B 的首拒因是 w
});

test('投影优先级与篡改派生键事件关联', () => {
  const p = projectionOf(snap({
    visible: [vis('x')],
    tombstones: [tomb('x')],
    waiting: [wait('x', 'q')],
    rejected: [rej('x', 'REPLAY_CONFLICT')],
    applied: ['x'],
  }));
  assert.equal(p.get('x'), 'rejected:REPLAY_CONFLICT');

  assert.ok(GROUP_ORDER.indexOf('rejected') < GROUP_ORDER.indexOf('visible'));

  const tamperKey = 'x#tampered#abcdef123456';
  assert.ok(eventTouches({ opId: 'x', ref: 'x' }, tamperKey));
  assert.ok(eventTouches({ opId: 'x', ref: null }, tamperKey));
  assert.ok(!eventTouches({ opId: 'y', ref: 'y' }, tamperKey));
  assert.ok(!eventTouches(null, tamperKey));
});

test('fromTick 之前的分歧不计入窗口；但窗口起点恰好重新一致时仍标出收敛点', () => {
  const samples = [
    { tick: 1, snapA: snap({ visible: [vis('x')] }), snapB: snap(), events: [] },
    { tick: 2, snapA: snap({ visible: [vis('x')] }), snapB: snap({ visible: [vis('x')] }), events: [] },
  ];
  // 只分析第 2 步：窗口内 x 两侧始终一致 -> 无分歧条目；
  // 但第 1 步（窗口前一拍）不一致、第 2 步一致，故第 2 步仍标记为收敛点
  const tl = buildTimeline(samples, { idA: 'A', idB: 'B', fromTick: 2, toTick: 2 });
  assert.equal(tl.entries.length, 0);
  assert.equal(tl.ticks[0].convergedHere, true);
  assert.equal(tl.ticks[0].same, true);
});
