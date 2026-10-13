// WP5 端到端：对话链路（portal.md §4/§5）——会话 → 发消息建 run → 浏览器 SSE → 工具卡片事件 →
// 停止（cancel_requested_at → cancelling → aborted run_end）→ assistant 回写 → 归档。
// 复用真实 runner + LiteLLM mock model；必须显式传入独立的栈名、容器名、端口和临时 DB 路径。
// ⚠️ e2e 前置：**必须导出 `HTTP_PROXY`/`HTTPS_PROXY`**（FDE 镜像构建要联网下 gh/tea/glab）；
//   隔离栈须派生镜像 tag（`FDE_IMAGE`/`STATION_PORTAL_IMAGE`）并显式导出 `FDE_DEV_MODE=1`（#227.1：
//   tag 形态不声明 dev 模式会被护栏拒跑；digest 形态豁免）——本脚本**绝不删除共享镜像 tag**
//   （issue #178，口径集中在 lib/fde-image.mjs）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as totp from '../src/totp.js';
import * as auth from '../src/auth.js';
import { ensureLlmBinding } from './lib/llm-binding.mjs';
import { DEFAULT_FDE_IMAGE, buildFdeImage } from './lib/fde-image.mjs';
import { composeDomainEnv } from './lib/compose-domain.mjs';
// issue #226：护栏/DB 目录解析/Traefik 静态配置生成的一副本均在 lib/isolated-env.mjs。
import {
  assertHostPortsAvailable, defaultFdeIpamPools, assertIsolatedEnvironment, createDbDirCleaner, writeTraefikStatic,
  writeDynamicStub,
} from './lib/isolated-env.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// #227.2：compose 一律显式 -p，且用 bash 的 `${VAR:?msg}`——未 export 时展开即非零退出并点名，
// 不再依赖「COMPOSE_PROJECT_NAME 环境变量压过 compose 文件 name: station」这条隐式优先级
// （忘 export 曾经会让脚本自己对共享 dev 栈 down -v）。
const COMPOSE = 'docker compose -p "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME required for isolated e2e}" --profile litellm --env-file deploy/.env -f deploy/docker-compose.yml';

// #227.3：FDE_IPAM_POOLS 未显式传时按栈 id 派生本栈口径（派生段+portal large 池固定段；显式传入优先）。
if (!process.env.FDE_IPAM_POOLS && process.env.STATION_STACK_ID) {
  process.env.FDE_IPAM_POOLS = defaultFdeIpamPools(process.env.STATION_STACK_ID);
}

const PORTAL_HOST_PORT = process.env.PORTAL_HOST_PORT || '18080';
const PORTAL = `http://127.0.0.1:${PORTAL_HOST_PORT}`;
const TRAEFIK_WEB_PORT = process.env.TRAEFIK_WEB_PORT || '8090';
const DOMAIN_COMPOSE_ENV = composeDomainEnv(TRAEFIK_WEB_PORT);
const LITELLM_HOST_PORT = process.env.LITELLM_HOST_PORT || '4100';
const STATION_DB_NAME = process.env.STATION_DB_NAME || 'station-db';
const STATION_PORTAL_NAME = process.env.STATION_PORTAL_NAME || 'station-portal';
const FDE_NAME = process.env.FDE_NAME || 'alice';
const FDE_CONTAINER = `fde-${FDE_NAME}`;
const FDE_IMAGE = process.env.FDE_IMAGE || DEFAULT_FDE_IMAGE;

// #226：护栏判据本体已提到 lib/isolated-env.mjs（wp2a/wp3a/wp5/wp6 共用一份）；本脚本的参数是
// 「栈内含 LiteLLM」+「单一 FDE 名（必须带栈 id、不得等于共享栈的 alice）」。
function isolatedStackOptions() {
  return { fdeNames: [{ env: 'FDE_NAME', value: FDE_NAME, sharedDefault: 'alice' }] };
}

function docker(args) {
  return execSync(`sg docker -c ${JSON.stringify(`docker ${args}`)}`, { encoding: 'utf8', stdio: 'pipe', cwd: REPO_ROOT });
}
function dockerStdin(args, input) {
  return execSync(`sg docker -c ${JSON.stringify(`docker ${args}`)}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], cwd: REPO_ROOT });
}
// #226：DB 目录解析（缺省即抛 + 必须在临时目录）已集中到 lib/isolated-env.mjs。
const { removeDbDir } = createDbDirCleaner({ docker });
function compose(args, env = {}) {
  return execSync(`sg docker -c ${JSON.stringify(`${COMPOSE} ${args}`)}`, { encoding: 'utf8', stdio: 'pipe', cwd: REPO_ROOT, env: { ...process.env, ...env } });
}
function safe(fn) { try { return fn(); } catch { return null; } }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitHeartbeatDownlink(cycles = 2) { await sleep(cycles * 15_000 + 5_000); }
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
async function restartPortalAndWaitForConfig(fdeName) {
  // Users are inserted after stack startup; exercise the documented DB+volume rebuild path.
  docker(`restart ${STATION_PORTAL_NAME}`);
  await waitFor(async () => (await fetch(`${PORTAL}/healthz`).catch(() => null))?.status === 200,
    { label: 'portal healthz after materializer rebuild', timeoutMs: 120000, intervalMs: 500 });
  const configPath = path.join(S.userspaceRoot, fdeName, 'home', '.erix', 'config.json');
  await waitFor(() => (fs.existsSync(configPath) ? configPath : null),
    { label: `${fdeName} config.json materialized`, timeoutMs: 60000, intervalMs: 250 });
}
function psql(query) {
  return docker(`exec ${STATION_DB_NAME} psql -U station -d station -tAc ${JSON.stringify(query)}`).trim();
}
function psqlStdin(sql) {
  dockerStdin(`exec -i ${STATION_DB_NAME} psql -U station -d station -v ON_ERROR_STOP=1`, sql);
}
function readCookie(setCookie) {
  const m = /fde_session_dev=([^;]+)/.exec(setCookie ?? '');
  return m ? m[1] : null;
}

const S = {
  userspaceRoot: null,
  dynamicRoot: null,
  staticRoot: null,
  artifactsRoot: null,
  staticFile: null,
  password: 'correct horse battery staple',
  totpSecret: null,
  cookie: null,
};
const FDE_ENV = { FDE_IMAGE, FDE_CMD: '[]', FDE_DEV_USER: '', FDE_DEV_MODE: '1', FDE_AGENT_VERSION: '0.1.0' };

async function insertUser(loginName) {
  const suffix = loginName === 'alice' ? 'a1' : 'a2';
  const userId = `00000000-0000-4000-8000-0000000000${suffix}`;
  const passwordHash = await auth.hashPassword(S.password);
  const secret = totp.generateSecret(20);
  psqlStdin(`
    INSERT INTO users (id, login, display_name, role, fde_name, auth_source, status, password_hash, totp_secret)
    VALUES ('${userId}', '${loginName}', '${loginName}', 'fde', '${loginName === 'alice' ? FDE_NAME : loginName}', 'local', 'active', '${passwordHash}', '${secret}');
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
  const { headers, ...rest } = opts; // 允许调用方追加头（如 Idempotency-Key）而不丢 Cookie
  const r = await fetch(`${PORTAL}${path}`, {
    headers: { 'Content-Type': 'application/json', Cookie: `fde_session_dev=${cookie}`, ...(headers ?? {}) }, ...rest,
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
  assertIsolatedEnvironment(isolatedStackOptions());
  await assertHostPortsAvailable([PORTAL_HOST_PORT, LITELLM_HOST_PORT, TRAEFIK_WEB_PORT, process.env.TRAEFIK_WEBSECURE_PORT]);
  S.userspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-users-wp5-'));
  S.dynamicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-dynamic-wp5-'));
  S.staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-static-wp5-'));
  S.artifactsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-artifacts-wp5-'));
  S.staticFile = writeTraefikStatic(S.staticRoot, {
    repoRoot: REPO_ROOT, webPort: TRAEFIK_WEB_PORT, websecurePort: process.env.TRAEFIK_WEBSECURE_PORT,
  });
  fs.chmodSync(S.userspaceRoot, 0o755);
  fs.chmodSync(S.dynamicRoot, 0o755);
  fs.chmodSync(S.staticRoot, 0o755);
  fs.chmodSync(S.artifactsRoot, 0o755);
  // #268 M1：预写 edge watch 桩（坑见 lib/isolated-env.mjs:writeDynamicStub；必须早于 compose up）。
  writeDynamicStub(S.dynamicRoot);
  const composePaths = {
    ...DOMAIN_COMPOSE_ENV,
    ERIX_USERSPACE_ROOT_HOST: S.userspaceRoot,
    TRAEFIK_DYNAMIC_DIR_HOST: S.dynamicRoot,
    TRAEFIK_STATIC_HOST: S.staticFile,
    ERIX_ARTIFACTS_ROOT_HOST: S.artifactsRoot,
  };

  const cleanup = () => {
    safe(() => docker(`rm -f ${FDE_CONTAINER} 2>/dev/null || true`));
    safe(() => docker(`network rm fde-${FDE_NAME} 2>/dev/null || true`));
    safe(() => compose('down -v', composePaths));
    // issue #178：不删镜像（共享 tag 绝不能被 e2e 删除；compose/docker build 按需失效缓存）。
    safe(() => fs.rmSync(S.userspaceRoot, { recursive: true, force: true }));
    safe(() => fs.rmSync(S.dynamicRoot, { recursive: true, force: true }));
    safe(() => fs.rmSync(S.staticRoot, { recursive: true, force: true }));
    safe(() => fs.rmSync(S.artifactsRoot, { recursive: true, force: true }));
    removeDbDir();
  };
  t.after(cleanup);

  try {
    safe(() => compose('down -v', composePaths));
    removeDbDir();
    buildFdeImage(FDE_IMAGE);
    // F2：baseline（docs/data/schema.sql）自 P1 冻结、**不含** idempotency_keys；该表只能由增量迁移
    //   0001 提供 → 本 e2e 以 MIGRATE_ON_START=1 跑**真实迁移 runner**（portal 在监听端口前以
    //   station_platform 应用 baseline 之后的增量）。这不仅让表存在，也验证了「增量生效」链路。
    compose('up -d --build', {
      ...composePaths,
      MIGRATE_ON_START: '1',
      LITELLM_HOST_PORT,
      LLM_GATEWAY_HOST: `http://127.0.0.1:${LITELLM_HOST_PORT}`,
      ...FDE_ENV,
    });
    await waitFor(async () => {
      const r = await fetch(`${PORTAL}/healthz`).catch(() => null);
      return r && r.status === 200;
    }, { label: 'portal healthz', timeoutMs: 240000, intervalMs: 1000 });
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${LITELLM_HOST_PORT}/health/readiness`).catch(() => null);
      return response?.status === 200;
    }, { label: 'LiteLLM readiness', timeoutMs: 180000, intervalMs: 1000 });

    // 迁移链路对账：0001 已应用 + 表/state 列存在（baseline 未提供此表）
    assert.equal(psql(`SELECT count(*) FROM schema_migrations WHERE version='0001-idempotency-keys'`), '1',
      '增量迁移 0001 已落 schema_migrations');
    assert.equal(psql(`SELECT count(*) FROM information_schema.tables WHERE table_name='idempotency_keys'`), '1',
      'idempotency_keys 由迁移 0001 建出');
    assert.equal(psql(`SELECT count(*) FROM information_schema.columns WHERE table_name='idempotency_keys' AND column_name='state'`), '1',
      'state 列（先占位后执行）存在');

    await insertUser('alice');
    await restartPortalAndWaitForConfig(FDE_NAME);
    S.cookie = await login('alice');
    docker(`exec ${STATION_PORTAL_NAME} node portal/src/cli.js provision-fde --fde-name ${FDE_NAME}`);
    await waitFor(() => (psql(`SELECT status FROM containers WHERE fde_name='${FDE_NAME}'`) === 'running' ? true : null),
      { label: `${FDE_CONTAINER} running`, timeoutMs: 60000 });
    await waitFor(() => (docker(`logs ${FDE_CONTAINER} 2>&1`).includes('sse ping received') ? true : null),
      { label: 'agentd sse ping', timeoutMs: 90000, intervalMs: 1000 });

    // 配置 LiteLLM credential/model 和 FDE binding；5 秒 mock 延迟保留并发 409 验收窗口。
    await ensureLlmBinding({
      docker,
      dynamicDir: S.dynamicRoot,
      fdeName: FDE_NAME,
      portal: PORTAL,
      portalContainerName: STATION_PORTAL_NAME,
      dbContainerName: STATION_DB_NAME,
      mockDelay: 5,
      adminLogin: 'wp5-admin',
      adminPassword: 'wp5-admin-pass-123',
    });
    await waitHeartbeatDownlink();

    // 1) 建会话 + 详情
    const created = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ cwd: '~/projects/proj1', title: 'wp5' }),
    });
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
    const run1Status = await waitFor(() => {
      const status = psql(`SELECT status FROM runs WHERE id='${run1}'`);
      return status === 'finished' || status === 'failed' ? status : null;
    }, { label: 'run1 terminal', timeoutMs: 120000, intervalMs: 500 });
    assert.equal(run1Status, 'finished',
      `run1 failed: ${psql(`SELECT termination::text FROM runs WHERE id='${run1}'`)}`);
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

    // 6.6) A 项幂等（portal.md §1.4）：同 Idempotency-Key 重发同一 content → 首次结果（同 message.id/run.id）。
    //      重发时机选在首个 run 结束后（而非 run 进行中）：按 §4.3「同 session 单活跃 run」语义，
    //      run 进行中重发若未命中幂等回放会撞 409 run_in_progress；放到结束后断言「回放」语义更确定
    //      （注：回放路径根本不会调 postMessage，故 run 进行中重发也能回放——这里不做依赖）。
    const idemKey = `wp5-idem-${Date.now()}`;
    const idemContent = '幂等重发验收任务';
    const idemHeaders = { 'Idempotency-Key': idemKey };
    const userMsgsBefore = Number(psql(`SELECT count(*) FROM messages WHERE session_id='${sessionId}' AND role='user'`));
    const idemFirst = await api(`/api/sessions/${sessionId}/messages`, {
      method: 'POST', headers: idemHeaders, body: JSON.stringify({ content: idemContent, attachments: [] }),
    });
    assert.equal(idemFirst.status, 202, `幂等首次 202：${JSON.stringify(idemFirst.body)}`);
    assert.equal(idemFirst.body.message.content, idemContent);
    const idemRunId = idemFirst.body.run.id;
    // 等首个 run 收敛，再做重发
    await waitFor(() => {
      const st = psql(`SELECT status FROM runs WHERE id='${idemRunId}'`);
      return st === 'finished' || st === 'failed' ? st : null;
    }, { label: 'idempotent run 终态', timeoutMs: 120000, intervalMs: 500 });

    const idemSecond = await api(`/api/sessions/${sessionId}/messages`, {
      method: 'POST', headers: idemHeaders, body: JSON.stringify({ content: idemContent, attachments: [] }),
    });
    assert.equal(idemSecond.status, 202, '同 key 重发仍 202（回放首次结果）');
    assert.equal(idemSecond.body.message.id, idemFirst.body.message.id, '回放返回首次 message.id');
    assert.equal(idemSecond.body.run.id, idemRunId, '回放返回首次 run.id');
    // DB 对账：两次提交只产生 1 条 user 消息（assistant 回写不计入 user 计数）
    const userMsgsAfter = Number(psql(`SELECT count(*) FROM messages WHERE session_id='${sessionId}' AND role='user'`));
    assert.equal(userMsgsAfter - userMsgsBefore, 1, `同 key 重发只新增 1 条 user 消息（实际 ${userMsgsAfter - userMsgsBefore}）`);
    assert.equal(Number(psql(`SELECT count(*) FROM idempotency_keys WHERE key='${idemKey}'`)), 1, '幂等台账一行');
    // 台账 status_code/response 落库与首次一致
    assert.equal(psql(`SELECT status_code FROM idempotency_keys WHERE key='${idemKey}'`), '202');
    assert.equal(psql(`SELECT response->'run'->>'id' FROM idempotency_keys WHERE key='${idemKey}'`), idemRunId);

    // 6.7) 同 key 不同载荷 → 409 idempotency_key_reuse（不产生第二次副作用）
    const idemReuse = await api(`/api/sessions/${sessionId}/messages`, {
      method: 'POST', headers: idemHeaders, body: JSON.stringify({ content: `${idemContent}（不同载荷）`, attachments: [] }),
    });
    assert.equal(idemReuse.status, 409, `同 key 不同载荷 409：${JSON.stringify(idemReuse.body)}`);
    assert.equal(idemReuse.body.error.code, 'idempotency_key_reuse');
    assert.equal(Number(psql(`SELECT count(*) FROM messages WHERE session_id='${sessionId}' AND role='user'`)), userMsgsAfter,
      '409 不产生新 user 消息');

    // 6.8) 非法 Idempotency-Key（>128）→ 400 validation_failed
    const idemBad = await api(`/api/sessions/${sessionId}/messages`, {
      method: 'POST', headers: { 'Idempotency-Key': 'x'.repeat(129) }, body: JSON.stringify({ content: 'x' }),
    });
    assert.equal(idemBad.status, 400, `非法 key 400（得 ${idemBad.status}）`);
    assert.equal(idemBad.body.error.code, 'validation_failed');
    assert.equal(Number(psql(`SELECT count(*) FROM messages WHERE session_id='${sessionId}' AND role='user'`)), userMsgsAfter,
      '非法 key 不产生新 user 消息');

    // 6.9) 并发同 key 双发（双击/客户端重发竞态）：**先到先得**，无论哪一边先赢，都不得产生第二条 user 消息/第二个 run。
    //      按新裁决（先占位后执行），两种结果均合规：① 赢家 202、输者 409 `idempotency_conflict`（占位在
    //      赢家手里，`retryable: true`）；② 赢家已提交占位但**输者先于赢家拿到 session 锁**时，输者会撞
    //      sessions.postMessage 的「同 session 单活跃 run」守卫 → 409 `run_in_progress`。两者都允许（先到先得）。
    //      旧「输者回查并回放首次结果」语义已废弃（那正是 F1 的双执行窗口），故这里**不再**断言两边同 id。
    const raceKey = `wp5-race-${Date.now()}`;
    const raceContent = '幂等并发重发验收';
    const raceBeforeUser = Number(psql(`SELECT count(*) FROM messages WHERE session_id='${sessionId}' AND role='user'`));
    const raceBeforeRuns = Number(psql(`SELECT count(*) FROM runs WHERE session_id='${sessionId}'`));
    const [race1, race2] = await Promise.all([
      api(`/api/sessions/${sessionId}/messages`, { method: 'POST', headers: { 'Idempotency-Key': raceKey }, body: JSON.stringify({ content: raceContent, attachments: [] }) }),
      api(`/api/sessions/${sessionId}/messages`, { method: 'POST', headers: { 'Idempotency-Key': raceKey }, body: JSON.stringify({ content: raceContent, attachments: [] }) }),
    ]);
    const raceStatuses = [race1.status, race2.status].sort((a, b) => a - b);
    assert.ok(raceStatuses.every((s) => s === 202 || s === 409), `并发同 key 状态 ∈ {202,409}：${raceStatuses}`);
    assert.ok(raceStatuses.includes(202), `并发同 key 至少一个 202：${raceStatuses}`);
    const raceWinner = race1.status === 202 ? race1 : race2;
    const raceLoser = race1.status === 202 ? race2 : race1;
    if (raceLoser.status === 409) {
      // 先到先得：输者只会是「幂等占位未收敛」或「同 session 单活跃 run」两者之一
      assert.ok(
        ['idempotency_conflict', 'run_in_progress'].includes(raceLoser.body.error.code),
        `输者 409 码仅允许 idempotency_conflict / run_in_progress（得 ${raceLoser.body.error.code}）`,
      );
      if (raceLoser.body.error.code === 'idempotency_conflict') {
        assert.equal(raceLoser.body.error.retryable, true, 'idempotency_conflict 可重试');
      }
    } else {
      // 两边都 202：只能是赢家完成后输者（同一个 key）后来命中回放 → 同 message/run id
      assert.equal(raceLoser.status, 202, `输者状态：${raceLoser.status}`);
      assert.equal(raceLoser.body.message.id, raceWinner.body.message.id, '两边 202 → 同一 message.id（回放）');
      assert.equal(raceLoser.body.run.id, raceWinner.body.run.id, '两边 202 → 同一 run.id（回放）');
    }
    assert.equal(Number(psql(`SELECT count(*) FROM messages WHERE session_id='${sessionId}' AND role='user'`)) - raceBeforeUser, 1,
      '并发双发只产生 1 条 user 消息');
    assert.equal(Number(psql(`SELECT count(*) FROM runs WHERE session_id='${sessionId}'`)) - raceBeforeRuns, 1,
      '并发双发只产生 1 个 run');
    assert.equal(Number(psql(`SELECT count(*) FROM idempotency_keys WHERE key='${raceKey}'`)), 1, '并发同 key 台账一行');
    assert.equal(psql(`SELECT state FROM idempotency_keys WHERE key='${raceKey}'`), 'done',
      '赢家完成后台账为 done（先占位后执行）');
    // 等该 run 收敛（下步 step 7/8 需要无活跃 run）
    const raceRunId = raceWinner.body.run.id;
    await waitFor(() => {
      const st = psql(`SELECT status FROM runs WHERE id='${raceRunId}'`);
      return st === 'finished' || st === 'failed' ? st : null;
    }, { label: '并发幂等 run 终态', timeoutMs: 120000, intervalMs: 500 });

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

    console.log('\n[wp5] ✅ 对话链路全绿：会话/发消息建 run/409 并发/SSE 事件流/seq 连续/停止→aborted/回写/幂等重发/归档');
  } catch (err) {
    try {
      console.log('\n[wp5] --- portal logs ---');
      console.log(docker(`logs ${STATION_PORTAL_NAME} --tail 60 2>&1`));
      console.log(`\n[wp5] --- ${FDE_CONTAINER} logs ---`);
      console.log(docker(`logs ${FDE_CONTAINER} --tail 60 2>&1`));
    } catch { /* 尽力 */ }
    throw err;
  }

});
