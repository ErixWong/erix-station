// WP5 端到端：对话链路（portal.md §4/§5）——会话 → 发消息建 run → 浏览器 SSE → 工具卡片事件 →
// 停止（cancel_requested_at → cancelling → aborted run_end）→ assistant 回写 → 归档。
// 复用 wp3b/wp4 验收环境（真实 runner 镜像 + mock LLM）。
// ⚠️ 不可与其它 e2e 并行（down 本机 station 栈 / 删 /docker/station-db，同 wp2b/wp3a/wp3b/wp4 约定）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as totp from '../src/totp.js';
import * as auth from '../src/auth.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COMPOSE = 'docker compose --env-file deploy/.env -f deploy/docker-compose.yml';
const PORTAL = 'http://127.0.0.1:18080';
const FDE_IMAGE = 'erix-station/fde:local';

function docker(args) {
  return execSync(`sg docker -c ${JSON.stringify(`docker ${args}`)}`, { encoding: 'utf8', stdio: 'pipe', cwd: REPO_ROOT });
}
function dockerStdin(args, input) {
  return execSync(`sg docker -c ${JSON.stringify(`docker ${args}`)}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], cwd: REPO_ROOT });
}
const DB_DIR = (process.env.STATION_DB_DIR || '/docker/station-db').replace(/\/+$/, '');
function removeDbDir() {
  const parent = path.posix.dirname(DB_DIR);
  const name = path.posix.basename(DB_DIR);
  safe(() => docker(`run --rm -v ${JSON.stringify(parent)}:/host alpine rm -rf ${JSON.stringify(`/host/${name}`)}`));
}
function compose(args, env = {}) {
  return execSync(`sg docker -c ${JSON.stringify(`${COMPOSE} ${args}`)}`, { encoding: 'utf8', stdio: 'pipe', cwd: REPO_ROOT, env: { ...process.env, ...env } });
}
function safe(fn) { try { return fn(); } catch { return null; } }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function waitFor(fn, { label, timeoutMs, intervalMs = 200 }) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try { const v = await fn(); if (v) return resolve(v); } catch { /* retry */ }
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`timeout: ${label}`));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}
function psql(query) {
  return docker(`exec station-db psql -U station -d station -tAc ${JSON.stringify(query)}`).trim();
}
function psqlStdin(sql) {
  dockerStdin('exec -i station-db psql -U station -d station -v ON_ERROR_STOP=1', sql);
}
function readCookie(setCookie) {
  const m = /fde_session_dev=([^;]+)/.exec(setCookie ?? '');
  return m ? m[1] : null;
}

const S = { userspaceRoot: null, dynamicRoot: null, password: 'correct horse battery staple', totpSecret: null, cookie: null };
const FDE_ENV = { FDE_IMAGE, FDE_CMD: '[]', FDE_DEV_USER: '', FDE_DEV_MODE: '1', FDE_AGENT_VERSION: '0.1.0', MOCK_LATENCY_MS: '5000' };

async function insertUser(loginName) {
  const suffix = loginName === 'alice' ? 'a1' : 'a2';
  const userId = `00000000-0000-4000-8000-0000000000${suffix}`;
  const passwordHash = await auth.hashPassword(S.password);
  const secret = totp.generateSecret(20);
  psqlStdin(`
    INSERT INTO users (id, login, display_name, role, fde_name, auth_source, status, password_hash, totp_secret)
    VALUES ('${userId}', '${loginName}', '${loginName}', 'fde', '${loginName}', 'local', 'active', '${passwordHash}', '${secret}');
  `);
  if (loginName === 'alice') { S.userId = userId; S.totpSecret = secret; }
  return secret;
}
async function login(loginName = 'alice', secret = S.totpSecret) {
  const step1 = await fetch(`${PORTAL}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: loginName, password: S.password }),
  });
  assert.equal(step1.status, 200, 'login step1');
  const { pending_token } = await step1.json();
  const step2 = await fetch(`${PORTAL}/api/auth/login/totp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pending_token, code: totp.totp(secret) }),
  });
  assert.equal(step2.status, 200, 'login step2');
  const cookie = readCookie(step2.headers.get('set-cookie'));
  assert.ok(cookie, 'session cookie');
  return cookie;
}
async function api(path, opts = {}, cookie = S.cookie) {
  const r = await fetch(`${PORTAL}${path}`, {
    headers: { 'Content-Type': 'application/json', Cookie: `fde_session_dev=${cookie}` }, ...opts,
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

/** 读 SSE 流直到谓词满足或超时；返回累计的具名事件数组。 */
async function readSse(sessionId, { until, timeoutMs, lastEventId = null }) {
  const url = `${PORTAL}/api/sessions/${sessionId}/events${lastEventId != null ? `?last_event_id=${lastEventId}` : ''}`;
  const r = await fetch(url, { headers: { Cookie: `fde_session_dev=${S.cookie}`, Accept: 'text/event-stream' } });
  assert.equal(r.status, 200, `SSE 连接 200（得到 ${r.status}）`);
  const events = [];
  const dec = new TextDecoder();
  let buf = '';
  let raw = '';
  const t0 = Date.now();
  for await (const chunk of r.body) {
    const text = dec.decode(chunk, { stream: true });
    if (raw.length < 4000) raw += text;
    buf += text;
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const evLine = frame_event(frame);
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!evLine) continue;
      const type = evLine;
      let data = {};
      try { data = JSON.parse((dataLine ?? 'data: {}').slice(6)); } catch { /* 忽略 */ }
      events.push({ type, data });
      if (until(events, { type, data })) {
        r.body.cancel().catch(() => {});
        return events;
      }
      if (Date.now() - t0 > timeoutMs) throw new Error(`SSE 等待超时：${JSON.stringify(events.map((e) => e.type))}\nRAW=${JSON.stringify(raw.slice(0, 3000))}`);
    }
  }
  return events;

  function frame_event(frame) {
    const l = frame.split('\n').find((x) => x.startsWith('event: '));
    return l ? l.slice(7).trim() : null;
  }
}

test('WP5 端到端：会话 → 发消息建 run → SSE 事件流 → 停止 → 回写 → 归档', { timeout: 15 * 60 * 1000 }, async (t) => {
  S.userspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-users-wp5-'));
  S.dynamicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-dynamic-wp5-'));
  fs.chmodSync(S.userspaceRoot, 0o755);
  fs.chmodSync(S.dynamicRoot, 0o755);

  const cleanup = () => {
    safe(() => docker('rm -f fde-alice 2>/dev/null || true'));
    safe(() => docker('network rm fde-alice 2>/dev/null || true'));
    safe(() => compose('down -v', { ERIX_USERSPACE_ROOT_HOST: S.userspaceRoot, TRAEFIK_DYNAMIC_DIR_HOST: S.dynamicRoot }));
    safe(() => docker('rmi -f erix-station/portal:local erix-station/mock-llm:local 2>/dev/null || true'));
    safe(() => docker(`rmi -f ${FDE_IMAGE} 2>/dev/null || true`));
    safe(() => fs.rmSync(S.userspaceRoot, { recursive: true, force: true }));
    safe(() => fs.rmSync(S.dynamicRoot, { recursive: true, force: true }));
    removeDbDir();
  };
  t.after(cleanup);

  try {
    safe(() => compose('down -v', { ERIX_USERSPACE_ROOT_HOST: S.userspaceRoot, TRAEFIK_DYNAMIC_DIR_HOST: S.dynamicRoot }));
    removeDbDir();
    safe(() => docker(`rmi -f ${FDE_IMAGE} 2>/dev/null || true`));
    docker(`build -t ${FDE_IMAGE} runner/`);
    compose('up -d --build', { ERIX_USERSPACE_ROOT_HOST: S.userspaceRoot, TRAEFIK_DYNAMIC_DIR_HOST: S.dynamicRoot, ...FDE_ENV });
    await waitFor(async () => {
      const r = await fetch(`${PORTAL}/healthz`).catch(() => null);
      return r && r.status === 200;
    }, { label: 'portal healthz', timeoutMs: 240000, intervalMs: 1000 });

    await insertUser('alice');
    S.cookie = await login('alice');
    const proj = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'proj1', repo_url: 'https://git.example/alice/proj1.git', template: 'node' }) });
    assert.equal(proj.status, 201, 'create project');
    const projectId = proj.body.project.id;

    docker('exec station-portal node portal/src/cli.js provision-fde --fde-name alice');
    await waitFor(() => (psql(`SELECT status FROM containers WHERE fde_name='alice'`) === 'running' ? true : null),
      { label: 'fde-alice running', timeoutMs: 60000 });
    await waitFor(() => (docker('logs fde-alice 2>&1').includes('sse ping received') ? true : null),
      { label: 'agentd sse ping', timeoutMs: 90000, intervalMs: 1000 });

    // 1) 建会话 + 详情
    const created = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ project_id: projectId, title: 'wp5' }) });
    assert.equal(created.status, 201, `create session: ${JSON.stringify(created.body)}`);
    const sessionId = created.body.session.id;
    const readSseDuring = (runId, fromSeq) => readSse(sessionId, {
      lastEventId: fromSeq, timeoutMs: 120000,
      until: (evs, { type, data }) => type === 'run_end' && data.run_id === runId,
    });
    const detail = await api(`/api/sessions/${sessionId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.session.active_run_id, null, '新会话无活跃 run（§4.1 active_run_id）');
    assert.equal(detail.body.last_seq, 0, '新会话 last_seq=0');
    assert.deepEqual(detail.body.messages, []);

    // 跨用户越权：bob 对 alice 的 session 一律 404（不泄露存在性）
    const bobSecret = await insertUser('bob');
    const bobCookie = await login('bob', bobSecret);
    for (const [method, p2, body] of [
      ['GET', `/api/sessions/${sessionId}`, undefined],
      ['PATCH', `/api/sessions/${sessionId}`, JSON.stringify({ title: 'x' })],
      ['DELETE', `/api/sessions/${sessionId}`, undefined],
      ['POST', `/api/sessions/${sessionId}/messages`, JSON.stringify({ content: 'x' })],
      ['POST', `/api/sessions/${sessionId}/stop`, '{}'],
      ['GET', `/api/sessions/${sessionId}/events`, undefined],
    ]) {
      const r = await api(p2, { method, body }, bobCookie);
      assert.equal(r.status, 404, `跨用户 ${method} ${p2} → 404（得 ${r.status}）`);
    }
    // 非法 last_event_id → 400；超界 → 404（bob 视角对 alice 会话先 404，用 alice 自测）
    const badLe = await api(`/api/sessions/${sessionId}/events?last_event_id=abc`, {}, S.cookie);
    assert.equal(badLe.status, 400, '非法 last_event_id → 400');
    // 归档后不可改标题（CAS）：先归档一个空会话验证


    // 2) 校验：空 content 400；他人会话 404（用 alice 的会话 + 未登录请求 → 401/404 由鉴权层保证）
    const bad = await api(`/api/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify({ content: '' }) });
    assert.equal(bad.status, 400, '空 content 400');

    // 3) 发消息 → 202 + user 消息 + queued run
    const sent = await api(`/api/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify({ content: 'WP5 对话链路验收任务' }) });
    assert.equal(sent.status, 202, `send: ${JSON.stringify(sent.body)}`);
    assert.equal(sent.body.message.role, 'user');
    assert.equal(sent.body.run.status, 'queued');
    const run1 = sent.body.run.id;

    // 4) 并发第二条消息 → 409 run_in_progress（run 1 进行中；mock LLM 延迟 5s 提供窗口）
    const dup = await api(`/api/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify({ content: '第二条' }) });
    assert.equal(dup.status, 409, `并发发送 409: ${JSON.stringify(dup.body)}`);
    assert.equal(dup.body.error.code, 'run_in_progress');

    // 5) run 终态先行（确定性），再用 SSE replay 断言事件流完整 + seq 连续
    await waitFor(() => (psql(`SELECT status FROM runs WHERE id='${run1}'`) === 'finished' ? true : null),
      { label: 'run1 finished', timeoutMs: 120000, intervalMs: 500 });
    const userSeq = sent.body.message.seq;
    const events = await readSseDuring(run1, userSeq);
    assert.ok(events.find((e) => e.type === 'round_start'), 'SSE 含 round_start');
    assert.ok(events.find((e) => e.type === 'assistant_delta'), 'SSE 含 assistant_delta');
    assert.ok(events.at(-1).type === 'run_end' && events.at(-1).data.run_id === run1, 'SSE 末位 run_end');

    // 6) assistant 回写 + seq 连续（messages+run_events 合并后从 1 严格递增无空洞）
    const after = await api(`/api/sessions/${sessionId}`);
    const seqs = await psql(`SELECT string_agg(seq::text, ',' ORDER BY seq) FROM (SELECT seq FROM run_events WHERE session_id='${sessionId}' UNION SELECT seq FROM messages WHERE session_id='${sessionId}') x`).split(',').map(Number);
    assert.deepEqual(seqs, seqs.map((_, i) => i + 1), `seq 严格递增无空洞：${seqs.join(',')}`);
    const runEndLast = psql(`SELECT type FROM run_events WHERE run_id='${run1}' ORDER BY seq DESC LIMIT 1`);
    assert.equal(runEndLast, 'run_end', 'run_end 末位');
    const assistantMsgs = after.body.messages.filter((m) => m.run_id === run1 && m.role === 'assistant' && !m.synthetic);
    assert.equal(assistantMsgs.length, 1, `assistant 回写一 run 一条：${JSON.stringify(after.body.messages)}`);

    // 6.5) 无进行中 run 时 stop → 409
    const stopIdle = await api(`/api/sessions/${sessionId}/stop`, { method: 'POST', body: '{}' });
    assert.equal(stopIdle.status, 409, '无进行中 run 时 stop → 409');

    // 7) 停止链路 + 实时 SSE：先连浏览器 SSE（无 last_event_id，不补发历史）→ 发消息 →
    //    stop → 实时收 run_end(aborted)（验 ④ live 推送通道，与 ⑤ replay 互补）
    const sent2 = await api(`/api/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify({ content: '会被停止的任务' }) });
    assert.equal(sent2.status, 202);
    const run2 = sent2.body.run.id;
    const livePromise = readSse(sessionId, {
      timeoutMs: 120000,
      until: (evs, { type, data }) => type === 'run_end' && data.run_id === run2,
    });
    await waitFor(() => (psql(`SELECT status FROM runs WHERE id='${run2}'`) === 'running' ? true : null),
      { label: 'run2 running', timeoutMs: 60000, intervalMs: 200 });
    const stop = await api(`/api/sessions/${sessionId}/stop`, { method: 'POST', body: '{}' });
    assert.equal(stop.status, 200, `stop: ${JSON.stringify(stop.body)}`);
    assert.equal(stop.body.run.status, 'cancelling');
    const stopAgain = await api(`/api/sessions/${sessionId}/stop`, { method: 'POST', body: '{}' });
    assert.equal(stopAgain.status, 200, 'cancelling 重复停止幂等 200');
    const liveEvents = await livePromise;
    const liveRunEnd = liveEvents.filter((e) => e.type === 'run_end').at(-1);
    assert.ok(liveRunEnd && liveRunEnd.data.run_id === run2, '实时 SSE 收到 run2 run_end');
    assert.ok(['aborted', 'failed'].includes(liveRunEnd.data.termination?.reason), `实时 run_end 终止原因：${liveRunEnd.data.termination?.reason}`);
    await waitFor(() => {
      const st = psql(`SELECT status FROM runs WHERE id='${run2}'`);
      const term = psql(`SELECT termination->>'reason' FROM runs WHERE id='${run2}'`);
      return (st === 'failed' || st === 'finished' || st === 'cancelling') && term ? { st, term } : null;
    }, { label: 'run2 终态（aborted）', timeoutMs: 120000, intervalMs: 500 });
    const term2 = psql(`SELECT termination->>'reason' FROM runs WHERE id='${run2}'`);
    assert.ok(['aborted', 'failed'].includes(term2), `run2 终止原因 aborted/failed：${term2}`);
    const runDetail = await api(`/api/runs/${run2}`);
    assert.equal(runDetail.status, 200, `GET /api/runs/:id: ${JSON.stringify(runDetail.body)}`);
    assert.equal(runDetail.body.run.id, run2);
    assert.equal(runDetail.body.run.termination?.reason, 'aborted', 'run 详情 termination.aborted');
    const runForeign = await api(`/api/runs/${run2}`, {}, bobCookie);
    assert.equal(runForeign.status, 404, '他人 run → 404');
    const run404 = await api('/api/runs/00000000-0000-4000-8000-0000000000zz');
    assert.ok([400, 404].includes(run404.status), '非法 run id → 400/404');

    // 8) 归档：无进行中 run → 204/200；归档后 GET → 404（存在性不泄露）
    const arch = await api(`/api/sessions/${sessionId}`, { method: 'DELETE' });
    assert.equal(arch.status, 204, `archive → 204（得 ${arch.status}）`);
    const gone = await api(`/api/sessions/${sessionId}`);
    assert.equal(gone.status, 404, '归档后 GET 404');

    console.log('\n[wp5] ✅ 对话链路全绿：会话/发消息建 run/409 并发/SSE 事件流/seq 连续/停止→aborted/回写/归档');
  } catch (err) {
    try {
      console.log('\n[wp5] --- portal logs ---');
      console.log(docker('logs station-portal --tail 60 2>&1'));
      console.log('\n[wp5] --- fde-alice logs ---');
      console.log(docker('logs fde-alice --tail 60 2>&1'));
    } catch { /* 尽力 */ }
    throw err;
  }

});
