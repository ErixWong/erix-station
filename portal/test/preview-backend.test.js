// issue #787：kkFileView 可用性探针（`portal/src/preview-backend.js`）的判据。
//
// 隔离：全部走注入的 `fetchImpl` 桩，零真实网络；`resetProbeCache()` 每例前清槽，避免跨例污染。
// 关键判据：未配置**零 fetch**；任何异常/超时/非 2xx ⇒ available:false 且**绝不抛**；
// TTL 内同 URL 只 fetch 一次；换 baseUrl 再 fetch；未配置时 checkedAt 仍是合法 ISO；
// 响应**永不出现 baseUrl**。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  probePreviewBackend,
  resetProbeCache,
  PROBE_TIMEOUT_MS,
  PROBE_CACHE_TTL_MS,
} from '../src/preview-backend.js';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function assertValidIso(value, label) {
  assert.equal(typeof value, 'string', `${label}: checkedAt 必须是 string`);
  assert.match(value, ISO_RE, `${label}: checkedAt 必须是合法 ISO 8601（Z 结尾）`);
  assert.ok(!Number.isNaN(Date.parse(value)), `${label}: Date.parse 必须能解析 checkedAt`);
}

/** 计数型 fetch 桩：记录每次调用的 url/init，返回 `responder` 给的结果（可抛/可 ok）。 */
function countingFetch(responder = () => ({ ok: true })) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('PB-1 未配置（空串 / 非 string）⇒ 零 fetch，{configured:false,available:false}', async () => {
  for (const bad of [undefined, null, '', '   ', 123, {}, [], true]) {
    resetProbeCache();
    const fetchImpl = countingFetch();
    const res = await probePreviewBackend({ baseUrl: bad, fetchImpl });
    assert.equal(res.configured, false, `未配置：configured 必须 false（输入 ${String(bad)}）`);
    assert.equal(res.available, false, `未配置：available 必须 false（输入 ${String(bad)}）`);
    assert.equal(fetchImpl.calls.length, 0, `未配置：必须零 fetch（输入 ${String(bad)}）`);
    assertValidIso(res.checkedAt, `未配置 ${String(bad)}`);
    // 响应形状：恰好三字段，且永不出现 baseUrl（探针不是反代，不回内网坐标）。
    assert.deepEqual(Object.keys(res).sort(), ['available', 'checkedAt', 'configured']);
  }
});

test('PB-2 fetch 抛错 ⇒ available:false 且不抛，checkedAt 合法', async () => {
  resetProbeCache();
  const boom = new Error('ECONNREFUSED');
  const fetchImpl = async () => { throw boom; };
  const res = await probePreviewBackend({ baseUrl: 'http://kkfileview:8012', fetchImpl });
  assert.equal(res.configured, true);
  assert.equal(res.available, false);
  assertValidIso(res.checkedAt, 'fetch 抛错');
});

test('PB-3 超时（AbortSignal 触发、fetch 永挂）⇒ available:false 且不抛', async () => {
  resetProbeCache();
  // fetch 只认 signal：signal 一 abort 就 reject，否则永不主动 settle。
  // ❗ 另挂一个 **ref 的**兼底定时器（~30ms）保事件循环不排空：`AbortSignal.timeout` 的内部
  //   定时器是 unref 的，若无 ref 的活物挂在上面，测试会在 abort 前就退出事件循环（pending promise）。
  const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => reject(new Error('simulated timeout')), 30);
    init.signal.addEventListener('abort', () => {
      clearTimeout(keepAlive);
      reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    });
  });
  const res = await probePreviewBackend({
    baseUrl: 'http://kkfileview:8012', fetchImpl, timeoutMs: 5,
  });
  assert.equal(res.configured, true);
  assert.equal(res.available, false, '超时必须收敛成 available:false，绝不抛');
  assertValidIso(res.checkedAt, '超时');
});

test('PB-4 非 2xx ⇒ available:false；2xx ⇒ available:true', async () => {
  for (const [status, expect] of [[200, true], [204, true], [302, false], [500, false]]) {
    resetProbeCache();
    const fetchImpl = countingFetch(() => ({ ok: status >= 200 && status < 300, status }));
    const res = await probePreviewBackend({ baseUrl: 'http://kkfileview:8012', fetchImpl });
    assert.equal(res.available, expect, `status=${status} ⇒ available 应为 ${expect}`);
    // 探针打的是 <base 去尾斜杠>/index。
    assert.equal(fetchImpl.calls[0].url, 'http://kkfileview:8012/index');
  }
});

test('PB-5 base 带尾斜杠 ⇒ 探针 URL 去重斜杠后拼 /index', async () => {
  resetProbeCache();
  const fetchImpl = countingFetch(() => ({ ok: true }));
  await probePreviewBackend({ baseUrl: 'http://kkfileview:8012/', fetchImpl });
  assert.equal(fetchImpl.calls[0].url, 'http://kkfileview:8012/index');
});

test('PB-6 TTL 内同 URL 只 fetch 一次；命中返回首次探测的 checkedAt', async () => {
  resetProbeCache();
  let tick = 1_000_000;
  const fetchImpl = countingFetch(() => ({ ok: true }));
  const first = await probePreviewBackend({
    baseUrl: 'http://kkfileview:8012', fetchImpl, now: () => tick,
  });
  assert.equal(fetchImpl.calls.length, 1, '首次探测必须 fetch 一次');
  assert.equal(first.available, true);
  tick += PROBE_CACHE_TTL_MS - 1000; // TTL 内
  const second = await probePreviewBackend({
    baseUrl: 'http://kkfileview:8012', fetchImpl, now: () => tick,
  });
  assert.equal(fetchImpl.calls.length, 1, 'TTL 内第二次必须命中缓存、不再 fetch');
  assert.equal(second.checkedAt, first.checkedAt, '命中时 checkedAt 必须是首次探测那一刻');
});

test('PB-7 TTL 过期后重新 fetch', async () => {
  resetProbeCache();
  let tick = 2_000_000;
  const fetchImpl = countingFetch(() => ({ ok: true }));
  await probePreviewBackend({ baseUrl: 'http://kkfileview:8012', fetchImpl, now: () => tick });
  assert.equal(fetchImpl.calls.length, 1);
  tick += PROBE_CACHE_TTL_MS + 1; // 过期
  await probePreviewBackend({ baseUrl: 'http://kkfileview:8012', fetchImpl, now: () => tick });
  assert.equal(fetchImpl.calls.length, 2, 'TTL 过期后必须重新探测');
});

test('PB-8 换 baseUrl ⇒ 另一槽、再 fetch 一次（缓存按 baseUrl 字符串分槽）', async () => {
  resetProbeCache();
  const fetchImpl = countingFetch(() => ({ ok: true }));
  await probePreviewBackend({ baseUrl: 'http://kk-a:8012', fetchImpl });
  assert.equal(fetchImpl.calls.length, 1);
  await probePreviewBackend({ baseUrl: 'http://kk-b:8012', fetchImpl });
  assert.equal(fetchImpl.calls.length, 2, '换地址必须重探（不共用上一槽的缓存）');
});

test('PB-9 默认超时/TTL 常量符合契约', () => {
  assert.equal(PROBE_TIMEOUT_MS, 1200);
  assert.equal(PROBE_CACHE_TTL_MS, 10_000);
});
