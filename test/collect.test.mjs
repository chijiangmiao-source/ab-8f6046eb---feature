// 采集编排验收（假 API，不触网）：
//  - 正常流程：读取 -> reset -> 逐步 play 到 toTick -> 再 reset + 逐步恢复原 tick；
//  - 读取/重置/回放失败：报告失败位置，仍尽力恢复，且不返回半成品时间轴；
//  - 取消：后续请求不再发出，恢复流程仍执行完；
//  - makeApi 把 AbortError 映射为 CollectAborted。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectDiff, makeApi, CollectAborted, CollectFailed } from '../public/collect.js';

const vis = (opId, parent = null, seq = 0) => ({ opId, parent, seq, depth: 0, title: opId });

function stateAt(tick, idA, idB) {
  // R1 先 x 后 y；R2 先 y 后 x；第 3 步稳定排序收敛
  const mk = (schedule) => {
    const visible = [];
    if (tick >= 1) visible.push(vis('p'));
    for (const { at, op } of schedule) if (tick >= at) visible.push(vis(op, 'p', 1));
    visible.sort((a, b) => a.seq - b.seq || (a.opId < b.opId ? -1 : a.opId > b.opId ? 1 : 0));
    return {
      id: 'x', sealed: false, deliveryCount: tick,
      visible, waiting: [], tombstones: [], rejected: [],
      applied: visible.map((v) => v.opId),
    };
  };
  const xFirst = [{ at: 2, op: 'x' }, { at: 3, op: 'y' }];
  const yFirst = [{ at: 2, op: 'y' }, { at: 3, op: 'x' }];
  return {
    tick,
    length: 3,
    finished: tick >= 3,
    sealed: false,
    replicaIds: [idA, idB],
    replicas: { [idA]: mk(xFirst), [idB]: mk(yFirst) },
    log: [],
  };
}

// 记录调用序列的假 api
function fakeApi(opts = {}) {
  const { idA = 'R1', idB = 'R2', savedTick = 3, failAt = {}, abortErrorAt = new Set() } = opts;
  const calls = [];
  let readTick = savedTick;
  let phase = 'read'; // read -> collect -> restore
  const api = async (method, url, body, signal) => {
    calls.push({ method, url, body });
    if (signal?.aborted) throw new CollectAborted('signal');

    if (method === 'GET' && url.endsWith('/d1')) {
      if (failAt.read) throw new Error('boom-read');
      return stateAt(readTick, idA, idB);
    }
    if (method === 'POST' && url.endsWith('/reset')) {
      phase = phase === 'read' ? 'collect' : 'restore';
      if (failAt.reset && phase === 'collect') throw new Error('boom-reset');
      readTick = 0;
      return stateAt(0, idA, idB);
    }
    if (method === 'POST' && url.endsWith('/play')) {
      readTick += 1;
      if (phase === 'collect') {
        if (failAt.play === readTick) throw new Error(`boom-play-${readTick}`);
        if (abortErrorAt.has(readTick)) throw new CollectAborted('play');
      }
      const st = stateAt(readTick, idA, idB);
      return {
        advanced: 1,
        tick: readTick,
        events: [
          { tick: readTick, replica: idA, ref: 'p', title: 'a', status: 'applied' },
          { tick: readTick, replica: idB, ref: 'p', title: 'b', status: 'applied' },
        ],
        state: st,
      };
    }
    throw new Error(`未预期的请求：${method} ${url}`);
  };
  return { api, calls };
}

test('正常采集：reset + 逐步采集 + 恢复到原 tick，时间轴标出分歧与收敛', async () => {
  const { api, calls } = fakeApi({ savedTick: 3 });
  const { timeline, restoredTick } = await collectDiff({
    drillId: 'd1', idA: 'R1', idB: 'R2',
    fromTick: 1, toTick: 3, api,
  });
  assert.equal(restoredTick, 3);
  // 采集阶段 1 次 reset + 3 次 play；恢复阶段 1 次 reset + 3 次 play
  const resets = calls.filter((c) => c.url.endsWith('/reset')).length;
  const plays = calls.filter((c) => c.url.endsWith('/play'));
  assert.equal(resets, 2);
  assert.equal(plays.length, 6);
  assert.ok(plays.every((c) => c.body.steps === 1));

  assert.deepEqual(timeline.ticks.map((t) => t.same), [true, false, true]);
  assert.equal(timeline.ticks[2].convergedHere, true);
  const ids = timeline.entries.map((e) => e.opId).sort();
  assert.deepEqual(ids, ['x', 'y']);
  assert.ok(timeline.entries.every((e) => e.resolvedTick === 3 && !e.persistent));
});

test('从 tick 2 开始采集时，第 1 步不采集但仍需回放到 toTick', async () => {
  const { api, calls } = fakeApi({ savedTick: 2 });
  const { timeline } = await collectDiff({
    drillId: 'd1', idA: 'R1', idB: 'R2',
    fromTick: 2, toTick: 2, api,
  });
  assert.equal(calls.filter((c) => c.url.endsWith('/play')).length, 2 + 2); // 采集到 2 + 恢复到 2
  assert.equal(timeline.entries.length, 2);
});

test('读取失败：直接报告 read，不做任何 reset/play', async () => {
  const { api, calls } = fakeApi({ failAt: { read: true } });
  await assert.rejects(
    collectDiff({ drillId: 'd1', idA: 'R1', idB: 'R2', fromTick: 1, toTick: 3, api }),
    (e) => e instanceof CollectFailed && e.stage === 'read',
  );
  assert.equal(calls.length, 1);
});

test('重置失败：报告 reset', async () => {
  const { api } = fakeApi({ failAt: { reset: true } });
  await assert.rejects(
    collectDiff({ drillId: 'd1', idA: 'R1', idB: 'R2', fromTick: 1, toTick: 3, api }),
    (e) => e instanceof CollectFailed && e.stage === 'reset',
  );
});

test('采集中途回放失败：报告 play 位置，仍恢复到原 tick，不返回时间轴', async () => {
  const { api, calls } = fakeApi({ savedTick: 3, failAt: { play: 2 } });
  let caught;
  try {
    await collectDiff({ drillId: 'd1', idA: 'R1', idB: 'R2', fromTick: 1, toTick: 3, api });
  } catch (e) { caught = e; }
  assert.ok(caught instanceof CollectFailed);
  assert.equal(caught.stage, 'play');
  assert.match(caught.message, /第 2 步/);
  // 恢复仍执行：总共两次 reset（采集前 + 恢复前）
  assert.equal(calls.filter((c) => c.url.endsWith('/reset')).length, 2);
  // 恢复放足 3 步
  const afterSecondReset = (() => {
    const idx = calls.map((c) => c.url).lastIndexOf('/api/drills/d1/reset');
    return calls.slice(idx);
  })();
  assert.equal(afterSecondReset.filter((c) => c.url.endsWith('/play')).length, 3);
});

test('恢复失败：错误位置标为 restore', async () => {
  // 让“第二次” reset（恢复阶段）失败：用计数器
  let resetCount = 0;
  const calls = [];
  const api = async (method, url) => {
    calls.push({ method, url });
    if (method === 'GET') return stateAt(2, 'R1', 'R2');
    if (url.endsWith('/reset')) {
      resetCount += 1;
      if (resetCount === 2) throw new Error('boom-restore-reset');
      return stateAt(0, 'R1', 'R2');
    }
    if (url.endsWith('/play')) {
      return { advanced: 1, tick: 1, events: [], state: stateAt(1, 'R1', 'R2') };
    }
    throw new Error('unexpected');
  };
  await assert.rejects(
    collectDiff({ drillId: 'd1', idA: 'R1', idB: 'R2', fromTick: 1, toTick: 1, api }),
    (e) => e instanceof CollectFailed && e.stage === 'restore' && /重置演练/.test(e.message),
  );
});

test('取消：中止后的 play 不再发出，但恢复仍执行到原 tick', async () => {
  const ac = new AbortController();
  const { api, calls } = fakeApi({ savedTick: 3, abortErrorAt: new Set([2]) });
  let caught;
  const p = collectDiff({
    drillId: 'd1', idA: 'R1', idB: 'R2',
    fromTick: 1, toTick: 3, api, signal: ac.signal,
  }).catch((e) => { caught = e; });
  // fakeApi 是同步推进的，AbortError 在第 2 个 play 抛出即可
  await p;
  assert.ok(caught instanceof CollectAborted);
  // 采集只进行到第 2 步（1 次成功 play + 1 次中止 play），之后进入恢复：
  // 恢复阶段 reset 一次，再 play 3 次
  const resets = calls.filter((c) => c.url.endsWith('/reset')).length;
  assert.equal(resets, 2);
  const lastReset = calls.map((c) => c.url).lastIndexOf('/api/drills/d1/reset');
  const restorePlays = calls.slice(lastReset).filter((c) => c.url.endsWith('/play')).length;
  assert.equal(restorePlays, 3);
});

test('含重开后零散投递的演练：读取阶段直接拒绝，不发 reset/play', async () => {
  const calls = [];
  const api = async (method, url) => {
    calls.push({ method, url });
    const st = stateAt(2, 'R1', 'R2');
    st.log = [{ tick: null, replica: 'R1', extra: true, title: '重开后零散投递' }];
    return st;
  };
  await assert.rejects(
    collectDiff({ drillId: 'd1', idA: 'R1', idB: 'R2', fromTick: 1, toTick: 2, api }),
    (e) => e instanceof CollectFailed && e.stage === 'read' && /零散投递/.test(e.message),
  );
  assert.equal(calls.length, 1);
});

test('已封存演练：恢复阶段补做封存，最终状态重新 sealed', async () => {
  const calls = [];
  const api = async (method, url) => {
    calls.push({ method, url });
    if (method === 'GET') {
      const st = stateAt(1, 'R1', 'R2');
      st.sealed = true;
      return st;
    }
    if (url.endsWith('/reset')) return stateAt(0, 'R1', 'R2');
    if (url.endsWith('/seal')) {
      calls.push({ method: 'POST', url: `${url}#done` });
      return stateAt(1, 'R1', 'R2');
    }
    if (url.endsWith('/play')) {
      return { advanced: 1, tick: 1, events: [], state: stateAt(1, 'R1', 'R2') };
    }
    throw new Error('unexpected');
  };
  await collectDiff({ drillId: 'd1', idA: 'R1', idB: 'R2', fromTick: 1, toTick: 1, api });
  // 恰好一次 seal，且发生在最后
  const seals = calls.filter((c) => c.url.endsWith('/seal'));
  assert.equal(seals.length, 1);
  const realCalls = calls.filter((c) => !c.url.endsWith('#done'));
  assert.equal(realCalls[realCalls.length - 1].url, '/api/drills/d1/seal');
});

test('makeApi：非 2xx 抛错带 payload；AbortError 映射为 CollectAborted', async () => {
  const okFetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
  const apiOk = makeApi(okFetch);
  assert.deepEqual(await apiOk('GET', 'http://x/'), { ok: true });

  const badFetch = async () => new Response(JSON.stringify({ error: '坏了' }), { status: 500 });
  const apiBad = makeApi(badFetch);
  await assert.rejects(apiBad('GET', 'http://x/'), /坏了/);

  const abortFetch = async (url, init) => {
    if (init.signal.aborted) {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    return new Response('{}', { status: 200 });
  };
  const apiAbort = makeApi(abortFetch);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    apiAbort('GET', 'http://x/', undefined, ac.signal),
    (e) => e instanceof CollectAborted,
  );
});
