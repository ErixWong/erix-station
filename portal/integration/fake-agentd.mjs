#!/usr/bin/env node
// 假 agentd：以真实 per-container token + 真实网络路径（经 Traefik internal/llm 路由）
// 驱动 run 生命周期，供 WP3a e2e 使用。运行在接 fde-<name> 网络的临时容器内，
// 源 IP 落在 fde_networks 精确 subnet → Traefik ipAllowList/ClientIP 判定为真。
//
// 用法：
//   node fake-agentd.mjs --phase happy|reclaim|concurrent|llm \
//     --gateway http://<bridge 网关 IP>:8090 --token <ERIX_STATION_TOKEN> \
//     --station-host station.localhost --llm-host llm.localhost
import http from 'node:http';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const phase = arg('phase', 'happy');
const gateway = arg('gateway', 'http://127.0.0.1:8090');
const token = arg('token', '');
const stationHost = arg('station-host', 'station.localhost');
const llmHost = arg('llm-host', 'llm.localhost');
const holdMs = Number(arg('hold-ms', '2000'));

const base = gateway.replace(/\/$/, '');
const internalBase = `${base}/api/internal`;

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** http.request 到 Traefik internal 端点（node:http 可手动设置 Host；undici fetch 会忽略 Host 头）。 */
function call(method, path, { body, host = stationHost, extraHeaders = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${base}${path}`);
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const headers = {
      Host: host,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    };
    if (payload !== undefined) headers['Content-Length'] = Buffer.byteLength(payload);
    const req = http.request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c.toString('utf8'); });
        res.on('end', () => {
          let data = null;
          if (buf) {
            try { data = JSON.parse(buf); } catch { data = buf; }
          }
          resolve({ status: res.statusCode, data, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** 打开 SSE 下行，收集事件直到 waitMs 或收到首个 ping，然后关闭。 */
function collectSse(waitMs = 1500) {
  return new Promise((resolve) => {
    const u = new URL(`${base}/api/internal/stream`);
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'GET',
        headers: { Host: stationHost, Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => {
          buf += c.toString('utf8');
        });
        setTimeout(() => {
          req.destroy();
          resolve({ status: res.statusCode, events: buf });
        }, waitMs);
      },
    );
    req.on('error', () => resolve({ status: 0, events: '' }));
    req.end();
  });
}

function eventPayload(text) {
  return { text };
}

async function phaseHappy() {
  const sse = await collectSse(1200);
  const claim = await call('POST', '/api/internal/claim', { body: { capacity: 1, hold_ms: 1000 } });
  if (claim.status !== 200) return out({ ok: false, error: 'claim not 200', status: claim.status, data: claim.data, sse });

  const runId = claim.data.run.id;
  const claimToken = claim.data.claim_token;
  const X = { 'X-Claim-Token': claimToken };

  const running = await call('PUT', `/api/internal/runs/${runId}/state`, { body: { state: 'running' }, extraHeaders: X });
  if (running.status !== 200) return out({ ok: false, error: 'state running not 200', run_id: runId, status: running.status, data: running.data, sse });

  const ev1 = await call('POST', `/api/internal/runs/${runId}/events`, {
    body: { batch_id: 'happy-1', events: [{ client_event_id: `${runId}:1:0`, type: 'assistant_delta', ts: null, payload: eventPayload('hi') }, { client_event_id: `${runId}:1:1`, type: 'round_end', ts: null, payload: { round: 1 } }] },
    extraHeaders: X,
  });
  if (ev1.status !== 200) return out({ ok: false, error: 'events not 200', run_id: runId, status: ev1.status, data: ev1.data });

  const finish = await call('PUT', `/api/internal/runs/${runId}/state`, {
    body: { state: 'finished', termination: { reason: 'end_turn' }, usage: { input_tokens: 10, output_tokens: 3 }, rounds: 1, final_text: 'done' },
    extraHeaders: X,
  });
  if (finish.status !== 200) return out({ ok: false, error: 'finish not 200', run_id: runId, status: finish.status, data: finish.data });

  out({ ok: true, phase: 'happy', run_id: runId, claim_attempt: claim.data.run.attempt, resume: claim.data.run.resume, events: ev1.data, sse_status: sse.status, sse_has_ping: sse.events.includes('ping') });
}

async function phaseReclaim() {
  const claim1 = await call('POST', '/api/internal/claim', { body: { capacity: 1, hold_ms: 1000 } });
  if (claim1.status !== 200) return out({ ok: false, error: 'claim1 not 200', status: claim1.status, data: claim1.data });
  const runId = claim1.data.run.id;
  const attempt1 = claim1.data.run.attempt;
  const X1 = { 'X-Claim-Token': claim1.data.claim_token };

  await call('PUT', `/api/internal/runs/${runId}/state`, { body: { state: 'running' }, extraHeaders: X1 });
  await call('POST', `/api/internal/runs/${runId}/events`, {
    body: { batch_id: 'reclaim-attempt-1', events: [{ client_event_id: `${runId}:1:0`, type: 'round_start', ts: null, payload: { round: 0 } }] },
    extraHeaders: X1,
  });

  const release = await call('POST', `/api/internal/runs/${runId}/release`, { body: { reason: 'worker_crashed' }, extraHeaders: X1 });
  if (release.status !== 200) return out({ ok: false, error: 'release not 200', run_id: runId, status: release.status, data: release.data });

  const claim2 = await call('POST', '/api/internal/claim', { body: { capacity: 1, hold_ms: 1000 } });
  if (claim2.status !== 200) return out({ ok: false, error: 'reclaim not 200', run_id: runId, status: claim2.status, data: claim2.data });
  const X2 = { 'X-Claim-Token': claim2.data.claim_token };

  await call('PUT', `/api/internal/runs/${runId}/state`, { body: { state: 'running' }, extraHeaders: X2 });
  const ev2 = await call('POST', `/api/internal/runs/${runId}/events`, {
    body: { batch_id: 'reclaim-attempt-2', events: [{ client_event_id: `${runId}:2:0`, type: 'recovering', ts: null, payload: { round: 0 } }] },
    extraHeaders: X2,
  });
  const finish = await call('PUT', `/api/internal/runs/${runId}/state`, {
    body: { state: 'finished', termination: { reason: 'end_turn' }, usage: { input_tokens: 5, output_tokens: 2 }, rounds: 1, final_text: 'reclaimed' },
    extraHeaders: X2,
  });

  out({ ok: true, phase: 'reclaim', run_id: runId, attempt1, attempt2: claim2.data.run.attempt, resume: claim2.data.run.resume, release: release.data, events: ev2.data, finish_status: finish.status });
}

async function phaseConcurrent() {
  const [a, b] = await Promise.all([
    call('POST', '/api/internal/claim', { body: { capacity: 1, hold_ms: holdMs } }),
    call('POST', '/api/internal/claim', { body: { capacity: 1, hold_ms: holdMs } }),
  ]);
  const winners = [a, b].filter((r) => r.status === 200);
  const empty = [a, b].filter((r) => r.status === 204);
  let runId = null;
  if (winners.length === 1) {
    runId = winners[0].data.run.id;
    const X = { 'X-Claim-Token': winners[0].data.claim_token };
    await call('PUT', `/api/internal/runs/${runId}/state`, { body: { state: 'running' }, extraHeaders: X });
    await call('PUT', `/api/internal/runs/${runId}/state`, {
      body: { state: 'finished', termination: { reason: 'end_turn' }, usage: { input_tokens: 0, output_tokens: 0 }, rounds: 0, final_text: '' },
      extraHeaders: X,
    });
  }
  out({ ok: winners.length === 1 && empty.length === 1, phase: 'concurrent', winners: winners.length, empty: empty.length, run_id: runId });
}

async function phaseLlm() {
  // 故意带错误 Authorization（STOLEN-KEY）：证明 Traefik 按 ClientIP 覆盖为 erix-placeholder。
  const text = await new Promise((resolve, reject) => {
    const u = new URL(`${base}/v1/chat/completions`);
    const payload = JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'ping' }], stream: true });
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: { Host: llmHost, Authorization: 'Bearer STOLEN-KEY', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c.toString('utf8'); });
        res.on('end', () => resolve({ status: res.statusCode, text: buf, contentType: res.headers['content-type'] }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
  const chunks = (text.text.match(/data: /g) || []).length;
  out({
    ok: text.status === 200 && text.text.includes('[DONE]') && chunks >= 2,
    phase: 'llm',
    status: text.status,
    content_type: text.contentType,
    chunks,
    has_done: text.text.includes('[DONE]'),
  });
}

(async () => {
  try {
    if (phase === 'happy') return await phaseHappy();
    if (phase === 'reclaim') return await phaseReclaim();
    if (phase === 'concurrent') return await phaseConcurrent();
    if (phase === 'llm') return await phaseLlm();
    out({ ok: false, error: `unknown phase: ${phase}` });
  } catch (err) {
    out({ ok: false, error: String(err?.stack ?? err) });
  }
})();
