// 双副本差异采集编排（纯逻辑，fetch 由参数注入；页面注入 window.fetch，测试注入桩）。
//
// 完全复用现有接口：GET 读取 -> POST /reset -> 逐 tick POST /play {steps:1} 采集投影
// -> 再次 reset 并逐 tick 回放恢复到采集开始时的 tick 与内容。
//
// 保证：
//  - 读取/回放/重置任一环节失败：尽力恢复到原 tick 与内容，报告失败位置，
//    且不 resolve 出半成品时间轴（错误对象带 partialTimeline 仅用于排障展示）；
//  - abort：AbortSignal 触发后后续请求不再发出，恢复流程仍会执行完；
//  - 重选副本/重新采集：调用方用 generation 令牌自行丢弃过期结果，
//    旧请求的响应不会覆盖新选择（见页面）。

import { buildTimeline } from './diff.js';

export class CollectAborted extends Error {
  constructor(stage) {
    super(`已取消（阶段：${stage}）`);
    this.name = 'CollectAborted';
    this.code = 'COLLECT_ABORTED';
    this.stage = stage;
  }
}

export class CollectFailed extends Error {
  constructor(message, stage, partialTimeline = null) {
    super(message);
    this.name = 'CollectFailed';
    this.code = 'COLLECT_FAILED';
    this.stage = stage; // read | reset | play | restore
    this.partialTimeline = partialTimeline;
  }
}

// adapter(fetchImpl, base?) 产出与页面 api() 同构的请求函数。
// 浏览器中相对 URL 由 document 解析，base 可省略；Node 侧（冒烟）需传绝对地址前缀。
export function makeApi(fetchImpl, base = '') {
  return async function api(method, url, body, signal) {
    let res;
    try {
      res = await fetchImpl(base + url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw new CollectAborted('request');
      throw err;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.payload = data;
      err.status = res.status;
      throw err;
    }
    return data;
  };
}

function throwIfAborted(signal, stage) {
  if (signal?.aborted) throw new CollectAborted(stage);
}

// 把演练恢复到指定 tick（reset + 逐步回放 + 必要时重新封存）。
// 任何失败抛出 CollectFailed('restore')。
// 注意：恢复请求刻意不绑定采集的 AbortSignal —— 采集被取消后，恢复仍须走完，
// 不能让演练停在半截 tick 上。
async function restoreTick(api, drillId, tick, reseal) {
  try {
    await api('POST', `/api/drills/${drillId}/reset`);
  } catch (err) {
    throw new CollectFailed(`恢复失败：重置演练时出错（${err.message}）`, 'restore');
  }
  for (let t = 0; t < tick; t += 1) {
    try {
      await api('POST', `/api/drills/${drillId}/play`, { steps: 1 });
    } catch (err) {
      throw new CollectFailed(
        `恢复失败：回放到原第 ${t + 1} 步时出错（${err.message}）`,
        'restore',
      );
    }
  }
  if (reseal) {
    try {
      await api('POST', `/api/drills/${drillId}/seal`);
    } catch (err) {
      throw new CollectFailed(`恢复失败：重新封存时出错（${err.message}）`, 'restore');
    }
  }
}

// 主流程。onTick({done,total,tick}) 用于进度展示。
// 返回 { timeline, restoredTick }。
export async function collectDiff(params) {
  const {
    drillId,
    idA,
    idB,
    fromTick,
    toTick,
    api,
    signal,
    onTick,
  } = params;

  throwIfAborted(signal, 'read');

  // 1) 读取当前状态，记录原 tick（采集结束必须恢复到这里）
  let initial;
  try {
    initial = await api('GET', `/api/drills/${drillId}`, undefined, signal);
  } catch (err) {
    if (err instanceof CollectAborted) throw err;
    throw new CollectFailed(`读取演练失败：${err.message}`, 'read');
  }
  const savedTick = initial.tick;
  if (toTick > initial.length) {
    throw new CollectFailed('回放范围越过演练长度', 'read');
  }
  // reset 只能复现脚本内的投递；重开后的零散投递（tick=null）无法自动复原，
  // 此类演练拒绝采集，避免恢复后丢失内容。
  const hasExtra = Array.isArray(initial.log) && initial.log.some((e) => e.extra);
  if (hasExtra) {
    throw new CollectFailed(
      '该演练含重开后的零散投递，重置会使其无法自动复原；请在仅脚本回放的演练上采集',
      'read',
    );
  }
  const reseal = !!initial.sealed;

  const samples = [];
  let failure = null;
  let partialTimeline = null;

  const buildPartial = () => {
    try {
      return buildTimeline(samples, { idA, idB, fromTick, toTick: Math.min(toTick, samples.length ? samples[samples.length - 1].tick : fromTick - 1) });
    } catch {
      return null;
    }
  };

  try {
    // 2) 重置到 tick 0
    throwIfAborted(signal, 'reset');
    try {
      await api('POST', `/api/drills/${drillId}/reset`, undefined, signal);
    } catch (err) {
      if (err instanceof CollectAborted) throw err;
      throw new CollectFailed(`重置失败：${err.message}`, 'reset');
    }

    // 3) 逐步回放并在每个 tick 末尾采集两侧投影（同一 play 响应里已含两侧快照与事件）
    for (let tick = 1; tick <= toTick; tick += 1) {
      throwIfAborted(signal, 'play');
      let r;
      try {
        r = await api('POST', `/api/drills/${drillId}/play`, { steps: 1 }, signal);
      } catch (err) {
        if (err instanceof CollectAborted) throw err;
        throw new CollectFailed(`回放到第 ${tick} 步失败：${err.message}`, 'play');
      }
      const st = r.state;
      if (!st || !st.replicas || !st.replicas[idA] || !st.replicas[idB]) {
        throw new CollectFailed(`第 ${tick} 步的响应缺少副本投影`, 'play');
      }
      samples.push({
        tick,
        snapA: st.replicas[idA],
        snapB: st.replicas[idB],
        events: r.events ?? [],
      });
      if (onTick) onTick({ done: tick, total: toTick, tick });
    }
  } catch (err) {
    failure = err;
    partialTimeline = buildPartial();
  }

  // 4) 无论成功、失败还是取消，都恢复到采集开始时的步骤与内容
  if (failure instanceof CollectAborted) {
    // 取消后仍尽力恢复；恢复失败附加到取消错误上，由页面提示手动重置
    try {
      await restoreTick(api, drillId, savedTick, reseal);
    } catch (restoreErr) {
      failure.restoreError = restoreErr;
    }
    throw failure;
  }
  if (failure) {
    try {
      await restoreTick(api, drillId, savedTick, reseal);
    } catch (restoreErr) {
      // 恢复也失败：把恢复错误附加在原始失败上上报
      failure.restoreError = restoreErr;
    }
    throw new CollectFailed(failure.message, failure.stage ?? 'play', partialTimeline);
  }

  try {
    await restoreTick(api, drillId, savedTick, reseal);
  } catch (err) {
    throw new CollectFailed(err.message, 'restore', buildPartial());
  }

  const timeline = buildTimeline(samples, { idA, idB, fromTick, toTick });
  return { timeline, restoredTick: savedTick };
}
