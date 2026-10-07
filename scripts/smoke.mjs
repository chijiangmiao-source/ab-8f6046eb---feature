// HTTP 冒烟：
//  1) GET /healthz 必须 200 且 ok=true
//  2) GET / 页面必须 200 且包含挂载点与资源引用
//  3) API 端到端：建演练 -> 整段回放 -> 断言收敛/墓碑/等待/首拒因
//  4) 重启恢复：重启服务（同一数据目录）后投影与等待项一致，再补投滞留合法操作
//
// 若设置了 BASE_URL，则直接对该地址冒烟（Compose 中 verify 依赖 web）；
// 否则在本地临时端口拉起服务自测。

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { collectDiff, makeApi } from '../public/collect.js';

const EXTERNAL_BASE = process.env.BASE_URL || '';
let child = null;
let tmpDir = null;
let failures = 0;

function fail(msg) {
  failures += 1;
  console.error(`✗ ${msg}`);
}
function ok(msg) {
  console.log(`✓ ${msg}`);
}
function assert(cond, msg) {
  if (cond) ok(msg);
  else fail(msg);
}

async function waitForHealth(base, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`服务在 ${timeoutMs}ms 内未就绪：${lastErr?.message ?? 'healthz 非 200'}`);
}

async function startServer() {
  if (EXTERNAL_BASE) return EXTERNAL_BASE;
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'drill-smoke-'));
  const port = 8900 + Math.floor(Math.random() * 800);
  child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: path.join(tmpDir, 'data') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  const base = `http://127.0.0.1:${port}`;
  await waitForHealth(base);
  return base;
}

async function stopServer() {
  if (!child) return;
  await new Promise((resolve) => {
    child.on('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(resolve, 2000);
  });
  child = null;
}

async function restartServer(prevBase) {
  await stopServer();
  const port = new URL(prevBase).port;
  child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: port, HOST: '127.0.0.1', DATA_DIR: path.join(tmpDir, 'data') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await waitForHealth(`http://127.0.0.1:${port}`);
  return `http://127.0.0.1:${port}`;
}

const SHEET = {
  replicas: ['R1', 'R2'],
  steps: [
    { opId: 'p', type: 'insert', parent: null, seq: 0, title: '根' },
    { opId: 'x', type: 'insert', parent: 'p', seq: 1, title: '通道X' },
    { opId: 'y', type: 'insert', parent: 'p', seq: 1, title: '通道Y' },
    { opId: 'g', type: 'insert', parent: null, seq: 2, title: '待撤销祖先' },
    { opId: 'c', type: 'insert', parent: 'g', seq: 0, title: '迟到合法子项' },
    { opId: 'del-g', type: 'delete', target: 'g' },
    { opId: 'ghost', type: 'insert', parent: null, seq: 4, title: '滞留后补的父' },
  ],
  scripts: {
    R1: ['p', 'x', 'y', 'g', 'del-g', 'c',
      { opId: 'late-child', type: 'insert', parent: 'ghost', seq: 0, title: '滞留子项' },
      'p',
      { opId: 'x', type: 'insert', parent: 'p', seq: 1, title: '篡改' },
      { opId: 'oob', type: 'insert', parent: null, seq: 99, title: '越界' }],
    R2: ['p', 'y', 'x', 'g', 'c', 'del-g',
      { opId: 'late-child', type: 'insert', parent: 'ghost', seq: 0, title: '滞留子项' },
      'y',
      { opId: 'y', type: 'insert', parent: 'p', seq: 2, title: '篡改' },
      { opId: 'orphan', type: 'insert', parent: 'never', seq: 0, title: '孤儿' }],
  },
};

async function main() {
  const base = await startServer();
  console.log(`冒烟目标：${base}`);

  // 1) 健康接口
  {
    const res = await fetch(`${base}/healthz`);
    const body = await res.json();
    assert(res.status === 200 && body.ok === true, 'GET /healthz 返回 200 且 ok=true');
  }

  // 2) 页面
  {
    const res = await fetch(`${base}/`);
    const html = await res.text();
    assert(res.status === 200 && html.includes('姿控步骤单演练'), 'GET / 返回页面且标题正确');
    assert(html.includes('/app.js') && html.includes('/app.css'), '页面引用 app.js / app.css');
    const js = await fetch(`${base}/app.js`);
    assert(js.status === 200 && (await js.text()).includes('renderReplica'), 'GET /app.js 返回前端脚本');
    const diffJs = await fetch(`${base}/diff.js`);
    assert(diffJs.status === 200 && (await diffJs.text()).includes('buildTimeline'), 'GET /diff.js 返回差异计算模块');
    const collectJs = await fetch(`${base}/collect.js`);
    assert(collectJs.status === 200 && (await collectJs.text()).includes('collectDiff'), 'GET /collect.js 返回采集编排模块');
  }

  // 3) API 端到端
  let drillId;
  {
    const res = await fetch(`${base}/api/drills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheet: JSON.stringify(SHEET) }),
    });
    assert(res.status === 201, 'POST /api/drills 创建演练 201');
    const drill = await res.json();
    drillId = drill.id;
  }

  {
    const res = await fetch(`${base}/api/drills/${drillId}/play`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps: 'all' }),
    });
    const { state } = await res.json();
    assert(state.converged === true, '并发插入相反顺序投递后，两副本收敛为同一可见序列');
    for (const rid of ['R1', 'R2']) {
      const snap = state.replicas[rid];
      const ids = snap.visible.map((s) => s.opId);
      assert(JSON.stringify(ids) === JSON.stringify(['p', 'x', 'y', 'c']),
        `${rid} 可见序列为 p,x,y,c（祖先 g 墓碑穿透，子项 c 在正确位置）`);
      assert(snap.tombstones.map((t) => t.opId).join() === 'g', `${rid} g 保留为不可见墓碑`);
      assert(snap.waiting.some((w) => w.opId === 'late-child'), `${rid} late-child 仍在等待`);
      assert(snap.rejected.some((r) => r.reason === 'REPLAY_CONFLICT'), `${rid} 定位到篡改首拒因`);
    }
    assert(state.replicas.R1.rejected.some((r) => r.reason === 'SEQ_OUT_OF_RANGE'), 'R1 定位到越界首拒因');
    // 重复投递未新增：可见始终只有 p,x,y,c
  }

  // 3.5) 双副本差异时间轴采集（复用 reset / 逐步回放，结束后恢复原步骤与内容）
  let diffId;
  {
    const res = await fetch(`${base}/api/drills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheet: JSON.stringify(SHEET) }),
    });
    diffId = (await res.json()).id;
    await fetch(`${base}/api/drills/${diffId}/play`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps: 'all' }),
    });
    const before = await (await fetch(`${base}/api/drills/${diffId}`)).json();

    const { timeline, restoredTick } = await collectDiff({
      drillId: diffId, idA: 'R1', idB: 'R2',
      fromTick: 1, toTick: before.length,
      api: makeApi(fetch, base),
    });

    assert(restoredTick === before.length, `采集后演练恢复到原第 ${before.length} 步`);

    // 相反投递顺序：x/y 第 2 步首次分歧、第 3 步收敛，且非持续分歧
    const x = timeline.entries.find((e) => e.opId === 'x');
    const y = timeline.entries.find((e) => e.opId === 'y');
    assert(x && x.firstTick === 2 && x.resolvedTick === 3 && !x.persistent,
      'x：第 2 步首次分歧、第 3 步收敛（投递顺序不同不算持续分歧）');
    assert(y && y.firstTick === 2 && y.resolvedTick === 3 && !y.persistent,
      'y：第 2 步首次分歧、第 3 步收敛');
    assert(timeline.ticks[2].same && timeline.ticks[2].convergedHere, '时间轴第 3 步标记为收敛点');

    // g 墓碑分歧（R1 先撤销）在 R2 也撤销后收敛
    const g = timeline.entries.find((e) => e.opId === 'g');
    assert(g && g.category === 'tomb' && g.firstTick === 5 && g.resolvedTick === 6,
      '墓碑 g：第 5 步分歧、第 6 步随 R2 撤销重新一致');

    // 两侧各自的篡改拒因是窗口内持续分歧，且归因到对应副本的投递动作
    const tx = timeline.entries.find((e) => e.opId.startsWith('x#tampered#'));
    const ty = timeline.entries.find((e) => e.opId.startsWith('y#tampered#'));
    assert(tx && tx.persistent && tx.causes.a.length === 1 && tx.causes.b.length === 0,
      'R1 的篡改拒因归因为 R1 投递动作且窗口内不收敛');
    assert(ty && ty.persistent && ty.causes.b.length === 1 && ty.causes.a.length === 0,
      'R2 的篡改拒因归因为 R2 投递动作');

    // 采集结束后投影与采集前逐字节一致（读取到的是恢复后的权威状态）
    const after = await (await fetch(`${base}/api/drills/${diffId}`)).json();
    assert(after.tick === before.tick, '恢复后 tick 与采集前一致');
    assert(JSON.stringify(after.replicas) === JSON.stringify(before.replicas),
      '恢复后两侧投影与采集前完全一致');
  }

  // 4) 重启恢复 + 补投滞留合法操作
  if (!EXTERNAL_BASE) {
    const restartedBase = await restartServer(base);
    {
      const res = await fetch(`${restartedBase}/api/drills/${drillId}`);
      const state = await res.json();
      for (const rid of ['R1', 'R2']) {
        const ids = state.replicas[rid].visible.map((s) => s.opId);
        assert(JSON.stringify(ids) === JSON.stringify(['p', 'x', 'y', 'c']),
          `重启后 ${rid} 可见序列恢复一致`);
        assert(state.replicas[rid].waiting.some((w) => w.opId === 'late-child'),
          `重启后 ${rid} 等待操作恢复`);
      }
    }
    for (const rid of ['R1', 'R2']) {
      const res = await fetch(`${restartedBase}/api/drills/${drillId}/deliver`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ replica: rid, op: SHEET.steps.find((s) => s.opId === 'ghost') }),
      });
      const { state } = await res.json();
      const ids = state.replicas[rid].visible.map((s) => s.opId);
      assert(JSON.stringify(ids) === JSON.stringify(['p', 'x', 'y', 'c', 'ghost', 'late-child']),
        `重开补投后 ${rid} 滞留子项被链式应用且仅一次`);
    }
    const finalRes = await fetch(`${restartedBase}/api/drills/${drillId}`);
    const finalState = await finalRes.json();
    assert(finalState.converged === true, '补投后两副本再次收敛');
  } else {
    console.log('（外部 BASE_URL 模式：跳过进程重启恢复检查，由代码测试覆盖）');
  }

  await stopServer();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });

  if (failures) {
    console.error(`\n冒烟失败：${failures} 项`);
    process.exit(1);
  }
  console.log('\n全部冒烟检查通过。');
}

main().catch(async (err) => {
  console.error('冒烟脚本异常：', err);
  await stopServer();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  process.exit(1);
});
