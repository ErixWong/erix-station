// WP3b 真机端到端（需 docker；docker 命令经 `sg docker -c` 绕过，env §8.1）。
// 流程：起栈（含 mock LLM 网关）→ 建用户 + 两步登录 → 建项目（触发 materializer 写 config.json）
//   → provision FDE（真实 runner 镜像）→ agentd SSE 连接 + ping → 种子 run（真实 internal API claim）
//   → worker 跑 erix-agent runToolLoop（mock LLM 网关）→ 事件 seq 落库 → 终态 + run_end + usage 记账
//   → 崩溃恢复：run 进行中 docker restart FDE → agentd 重启 → re-claim（attempt+1、resume=true）→ 终态。
// 运行：npm run test:integration:wp3b
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as totp from '../src/totp.js';
import * as auth from '../src/auth.js';
import { ensureMockLlmBinding } from './lib/llm-mock-binding.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COMPOSE = 'docker compose --env-file deploy/.env -f deploy/docker-compose.yml';
const PORTAL = 'http://127.0.0.1:18080';
const FDE_IMAGE = 'erix-station/fde:local';

function docker(args) {
  return execSync(`sg docker -c ${JSON.stringify(`docker ${args}`)}`, {
    encoding: 'utf8',
    stdio: 'pipe',
    cwd: REPO_ROOT,
  });
}

function dockerStdin(args, input) {
  return execSync(`sg docker -c ${JSON.stringify(`docker ${args}`)}`, {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: REPO_ROOT,
  });
}

// M6：DB 数据目录可参数化（STATION_DB_DIR，与 deploy/docker-compose.yml 的挂载一致），
// 不再硬删共享固定路径 /docker/station-db——并行跑/多栈场景互不误伤。
const DB_DIR = (process.env.STATION_DB_DIR || '/docker/station-db').replace(/\/+$/, '');
function removeDbDir() {
  const parent = path.posix.dirname(DB_DIR);
  const name = path.posix.basename(DB_DIR);
  safe(() => docker(`run --rm -v ${JSON.stringify(parent)}:/host alpine rm -rf ${JSON.stringify(`/host/${name}`)}`));
}

function compose(args, env = {}) {
  return execSync(`sg docker -c ${JSON.stringify(`${COMPOSE} ${args}`)}`, {
    encoding: 'utf8',
    stdio: 'pipe',
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

async function waitFor(fn, { timeoutMs = 120000, intervalMs = 500, label = 'condition' } = {}) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}${lastErr ? `: ${lastErr.message}` : ''}`);
}

function readCookie(setCookie) {
  const first = (setCookie || '').split(',')[0];
  const nameVal = first.split(';')[0];
  const idx = nameVal.indexOf('=');
  return nameVal.slice(idx + 1);
}

function psql(query) {
  return docker(`exec -i station-db psql -U station -d station -tAc ${JSON.stringify(query)}`).trim();
}

function psqlStdin(sql) {
  dockerStdin('exec -i station-db psql -U station -d station -v ON_ERROR_STOP=1', sql);
}

const S = {
  userspaceRoot: null,
  dynamicRoot: null,
  userId: '00000000-0000-0000-0000-000000000001',
  password: 'correct horse battery staple',
  totpSecret: null,
  cookie: null,
  projectId: null,
  sessionId: null,
  token: null,
  gateway: null,
  networkName: null,
  subnet: null,
  containerId: null,
};

const FDE_ENV = {
  FDE_IMAGE,
  FDE_CMD: '[]',
  FDE_DEV_USER: '',
  FDE_DEV_MODE: '1',
  FDE_AGENT_VERSION: '0.1.0',
  // mock LLM 人为延迟：让 run 保持 running 足够久，e2e 才能在 run 进行中 docker restart（崩溃恢复）。
  MOCK_LATENCY_MS: '5000',
};

async function insertUser() {
  const passwordHash = await auth.hashPassword(S.password);
  S.totpSecret = totp.generateSecret(20);
  const sql = `
    INSERT INTO users (id, login, display_name, role, fde_name, auth_source, status, password_hash, totp_secret)
    VALUES ('${S.userId}', 'alice', 'Alice', 'fde', 'alice', 'local', 'active',
            '${passwordHash}', '${S.totpSecret}');
  `;
  psqlStdin(sql);
}

async function login() {
  const step1 = await fetch(`${PORTAL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'alice', password: S.password }),
  });
  assert.equal(step1.status, 200, 'login step1');
  const { pending_token } = await step1.json();
  const code = totp.totp(S.totpSecret);
  const step2 = await fetch(`${PORTAL}/api/auth/login/totp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pending_token, code }),
  });
  assert.equal(step2.status, 200, 'login step2');
  S.cookie = readCookie(step2.headers.get('set-cookie'));
  assert.ok(S.cookie, 'session cookie');
}

async function createProject() {
  const r = await fetch(`${PORTAL}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `fde_session_dev=${S.cookie}` },
    body: JSON.stringify({ name: 'proj1', repo_url: 'https://git.example/alice/proj1.git', template: 'node' }),
  });
  const body = await r.json();
  assert.equal(r.status, 201, `create project: ${JSON.stringify(body)}`);
  S.projectId = body.project.id;
  assert.ok(S.projectId, 'project id');
}

/** 种子 run + 用户消息（run 创建 API 尚未交付——P1 由 DB 直接入队，与 WP3a 同口径）。 */
function seedRun({ runId, queueId, sessionId, messageId, task }) {
  const sql = `
    INSERT INTO chat_sessions (id, user_id, project_id, title, model, last_seq)
    VALUES ('${sessionId}', '${S.userId}', '${S.projectId}', 'wp3b', 'mock-model', 1)
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO runs (id, session_id, status) VALUES ('${runId}', '${sessionId}', 'queued');
    INSERT INTO messages (id, session_id, run_id, seq, role, content)
    VALUES ('${messageId}', '${sessionId}', '${runId}', 1, 'user', '${task.replace(/'/g, "''")}');
    INSERT INTO run_queue (id, run_id, container_id, status)
    VALUES ('${queueId}', '${runId}', '${S.containerId}', 'pending');
  `;
  psqlStdin(sql);
}

function readTokenFromContainer() {
  const inspect = JSON.parse(docker('inspect fde-alice'));
  const env = inspect[0].Config.Env || [];
  const line = env.find((e) => e.startsWith('ERIX_STATION_TOKEN='));
  return line ? line.slice('ERIX_STATION_TOKEN='.length) : null;
}

function agentdLogs() {
  return docker('logs fde-alice --tail 200 2>&1');
}

test('WP3b 端到端：真实 runner 镜像 + agentd/worker + mock LLM + 崩溃恢复', { timeout: 15 * 60 * 1000 }, async (t) => {
  S.userspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-users-wp3b-'));
  S.dynamicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-dynamic-wp3b-'));
  fs.chmodSync(S.userspaceRoot, 0o755);
  fs.chmodSync(S.dynamicRoot, 0o755);

  const cleanup = () => {
    safe(() => docker('rm -f fde-alice 2>/dev/null || true'));
    safe(() => docker('network rm fde-alice 2>/dev/null || true'));
    safe(() => compose('down -v', { ERIX_USERSPACE_ROOT_HOST: S.userspaceRoot, TRAEFIK_DYNAMIC_DIR_HOST: S.dynamicRoot }));
    safe(() => docker('rmi -f erix-station/portal:local erix-station/mock-llm:local erix-station/fde:local 2>/dev/null || true'));
    safe(() => fs.rmSync(S.userspaceRoot, { recursive: true, force: true }));
    safe(() => fs.rmSync(S.dynamicRoot, { recursive: true, force: true }));
    removeDbDir();
  };
  t.after(cleanup);

  try {
    // 0) 预清理
    safe(() => compose('down -v', { ERIX_USERSPACE_ROOT_HOST: S.userspaceRoot, TRAEFIK_DYNAMIC_DIR_HOST: S.dynamicRoot }));
    removeDbDir();
    safe(() => docker(`rmi -f ${FDE_IMAGE} 2>/dev/null || true`));

    // 1) 构建真实 runner 镜像（build context runner/）
    docker(`build -t ${FDE_IMAGE} runner/`);

    // 2) 起栈（含 mock LLM；FDE 用真实 runner 镜像：tag + dev-mode + 无 --user）。
    // MIGRATE_ON_START=1：迁移 0002（llm_providers/llm_models + fde_llm_bindings 扩列）必须已应用，
    // 下方 ensureMockLlmBinding 的 admin API 才有表/列可用。
    compose('up -d --build', {
      ERIX_USERSPACE_ROOT_HOST: S.userspaceRoot,
      TRAEFIK_DYNAMIC_DIR_HOST: S.dynamicRoot,
      MIGRATE_ON_START: '1',
      ...FDE_ENV,
    });

    await waitFor(async () => {
      const r = await fetch(`${PORTAL}/healthz`).catch(() => null);
      return r && r.status === 200;
    }, { label: 'portal healthz', timeoutMs: 240000 });

    await waitFor(async () => {
      const r = await fetch('http://127.0.0.1:4000/healthz').catch(() => null);
      return r && r.status === 200;
    }, { label: 'mock-llm healthz', timeoutMs: 120000 });

    // 3) 建用户 + 两步登录 + 建项目（触发 materializer 写 config.json）
    await insertUser();
    await login();
    await createProject();

    // 等 config.json 物化（materializer 250ms 循环）
    const configJsonPath = path.join(S.userspaceRoot, 'alice', 'home', '.erix', 'config.json');
    await waitFor(() => (fs.existsSync(configJsonPath) ? fs.readFileSync(configJsonPath, 'utf8') : null), { label: 'config.json materialized' });
    const configJson = JSON.parse(fs.readFileSync(configJsonPath, 'utf8'));
    assert.equal(configJson.slots.default.endpoint, 'http://llm.localhost:8090/v1', 'config.json endpoint 指向 llm.<base>（dev http+8090）');
    assert.equal(configJson.slots.default.apiKey, 'erix-placeholder', '占位 key（零真实 LLM 凭据）');

    // 4) provision FDE（真实 runner 镜像）
    docker('exec station-portal node portal/src/cli.js provision-fde --fde-name alice');

    await waitFor(() => {
      const st = safe(() => docker('inspect fde-alice --format {{.State.Status}}').trim());
      return st === 'running' ? st : null;
    }, { label: 'fde-alice running', timeoutMs: 120000 });

    const netRow = psql(`SELECT network_name, subnet, gateway FROM fde_networks WHERE fde_id='${S.userId}'`);
    const [networkName, subnet, gateway] = netRow.split('|').map((s) => s.trim());
    S.networkName = networkName;
    S.subnet = subnet;
    S.gateway = gateway;
    assert.equal(networkName, 'fde-alice');
    assert.ok(gateway, 'fde gateway .1');

    S.containerId = psql(`SELECT id FROM containers WHERE fde_name='alice'`);
    assert.ok(S.containerId, 'containers row');
    S.token = readTokenFromContainer();
    assert.ok(S.token, 'ERIX_STATION_TOKEN 已注入容器');

    // issue #38 新语义（fail-closed）：LLM 路由按 fde_llm_bindings（必须有 api_key）生成，
    // 无 binding 即无 LLM 出口（worker LLM 调用 404 → run failed）。provision 之后、跑 run 之前补 binding。
    await ensureMockLlmBinding({
      docker,
      dynamicDir: S.dynamicRoot,
      fdeName: 'alice',
      adminLogin: 'wp3b-admin',
      adminPassword: 'wp3b-admin-pass-123',
    });

    // 5) agentd 连上 SSE 收 ping（§4.3）+ 首次心跳（containers.last_heartbeat）
    await waitFor(() => (agentdLogs().includes('sse ping received') ? true : null), { label: 'agentd SSE ping received', timeoutMs: 60000 });
    await waitFor(() => {
      const hb = psql(`SELECT last_heartbeat FROM containers WHERE id='${S.containerId}'`);
      return hb && hb !== '' ? hb : null;
    }, { label: 'containers.last_heartbeat set', timeoutMs: 60000 });

    // 6) 断言 UID：agentd 1001 / worker（跑 run 时 1002）——先验 agentd
    const agentdUid = docker(`exec fde-alice sh -c "ps -eo uid=,args= | grep 'node /opt/erix/agentd.js' | head -1"`).trim().split(/\s+/)[0];
    assert.equal(agentdUid, '1001', 'agentd 以 UID 1001 运行');

    // 7) run 1：claim → worker runToolLoop（mock LLM）→ 事件 seq → 终态 + run_end + usage
    seedRun({
      runId: '00000000-0000-0000-0000-000000000100',
      queueId: '00000000-0000-0000-0000-000000000200',
      sessionId: '00000000-0000-0000-0000-000000000020',
      messageId: '00000000-0000-0000-0000-000000000030',
      task: '把登录按钮改成品牌色',
    });

    const run1 = '00000000-0000-0000-0000-000000000100';
    await waitFor(() => {
      const st = psql(`SELECT status FROM runs WHERE id='${run1}'`);
      return (st === 'finished' || st === 'failed') ? st : null;
    }, { label: 'run 1 terminal', timeoutMs: 120000 });

    assert.equal(psql(`SELECT status FROM runs WHERE id='${run1}'`), 'finished', 'run 1 finished');
    assert.equal(psql(`SELECT attempts FROM run_queue WHERE run_id='${run1}'`), '1', 'run 1 attempts=1');

    // 事件 seq 无空洞（session 内 messages + run_events 共享 last_seq）
    const sessionId = '00000000-0000-0000-0000-000000000020';
    const allSeq = psql(`SELECT string_agg(seq::text, ',' ORDER BY seq) FROM (SELECT seq FROM run_events WHERE session_id='${sessionId}' UNION SELECT seq FROM messages WHERE session_id='${sessionId}') x`);
    const seqList = allSeq.split(',').map(Number);
    assert.ok(seqList.length > 0 && seqList.every((v, i) => v === i + 1), `session seq 严格递增无空洞：${allSeq}`);

    // run_end 为 run 内最后一条 + usage 记账一 run 一条
    const runEndLast = psql(`SELECT type FROM run_events WHERE run_id='${run1}' ORDER BY seq DESC LIMIT 1`);
    assert.equal(runEndLast, 'run_end', 'run_end 为 run 内最后一条事件');
    assert.equal(psql(`SELECT count(*) FROM usage_ledger WHERE run_id='${run1}' AND source='erix'`), '1', 'usage_ledger 一 run 一条');
    assert.equal(psql(`SELECT count(*) FROM messages WHERE run_id='${run1}' AND role='assistant'`), '1', 'assistant 消息回写');

    // 事件含 mock LLM 驱动的 delta + round 事件（worker 经 IPC 回 agentd 批量上报）
    const evTypes = psql(`SELECT string_agg(DISTINCT type, ',' ORDER BY type) FROM run_events WHERE run_id='${run1}'`);
    assert.ok(evTypes.includes('assistant_delta'), `含 assistant_delta 事件：${evTypes}`);
    assert.ok(evTypes.includes('round_start'), `含 round_start 事件：${evTypes}`);
    assert.ok(evTypes.includes('round_end'), `含 round_end 事件：${evTypes}`);

    // worker 以 UID 1002 运行过（run 1 期间 ps 取证：终态后 worker 已退出，取日志/agentd 记录的 pid 侧写）
    const workerUidLog = agentdLogs().match(/"msg":"worker spawned".*"pid":(\d+)/);
    assert.ok(workerUidLog, 'agentd 记录了 worker pid');

    // 8) token 不落盘：容器文件系统内无明文 token（仅 agentd 内存 /proc/<pid>/environ）
    const grepToken = docker(`exec fde-alice sh -c "grep -rl '${S.token}' /home /opt 2>/dev/null || true"`).trim();
    assert.equal(grepToken, '', '容器文件系统内无明文 token');

    // 9) 崩溃恢复：run 2 进行中 docker restart → agentd 重启 → re-claim（attempt+1、resume=true）→ 终态
    seedRun({
      runId: '00000000-0000-0000-0000-000000000101',
      queueId: '00000000-0000-0000-0000-000000000201',
      sessionId: '00000000-0000-0000-0000-000000000021',
      messageId: '00000000-0000-0000-0000-000000000031',
      task: '修复登录页的样式问题',
    });
    const run2 = '00000000-0000-0000-0000-000000000101';

    // 等 run 2 进入 running（agentd 已 claim + spawn worker）
    await waitFor(() => {
      const st = psql(`SELECT status FROM runs WHERE id='${run2}'`);
      const at = psql(`SELECT attempts FROM run_queue WHERE run_id='${run2}'`);
      return st === 'running' && at === '1' ? st : null;
    }, { label: 'run 2 running attempts=1', timeoutMs: 60000, intervalMs: 50 });

    // 容器重启（run 进行中）
    docker('restart fde-alice');
    await waitFor(() => {
      const st = safe(() => docker('inspect fde-alice --format {{.State.Status}}').trim());
      return st === 'running' ? st : null;
    }, { label: 'fde-alice restarted', timeoutMs: 60000 });

    // 新 agentd 上线（SSE + ping）
    await waitFor(() => (agentdLogs().includes('sse ping received') ? true : null), { label: 'agentd reconnect after restart', timeoutMs: 60000 });

    // 强制租约过期（模拟 90s lease 到期），让 claim 立即 re-claim 同一 run
    psqlStdin(`UPDATE run_queue SET lease_until = now() - interval '1 second' WHERE run_id = '${run2}';`);

    // 等 re-claim（attempt 2）+ 终态
    await waitFor(() => {
      const st = psql(`SELECT status FROM runs WHERE id='${run2}'`);
      const at = psql(`SELECT attempts FROM run_queue WHERE run_id='${run2}'`);
      return (st === 'finished' || st === 'failed') && at === '2' ? { st, at } : null;
    }, { label: 'run 2 re-claimed attempts=2 terminal', timeoutMs: 120000 });

    assert.equal(psql(`SELECT attempts FROM run_queue WHERE run_id='${run2}'`), '2', '崩溃恢复 re-claim attempts=2');
    assert.equal(psql(`SELECT status FROM runs WHERE id='${run2}'`), 'finished', 'run 2 终态 finished');

    // 事件含 attempt 2 前缀（resume=true 后新 attempt 事件不碰撞）
    const rcEvents = psql(`SELECT string_agg(client_event_id, ',' ORDER BY seq) FROM run_events WHERE run_id='${run2}' AND type <> 'run_end'`);
    assert.ok(rcEvents.includes(':2:0'), `attempt 2 事件存在：${rcEvents}`);
    const rcRunEnd = psql(`SELECT type FROM run_events WHERE run_id='${run2}' ORDER BY seq DESC LIMIT 1`);
    assert.equal(rcRunEnd, 'run_end', '崩溃恢复后 run_end 仍为最后一条');

    // eslint-disable-next-line no-console
    console.log('\n[e2e] WP3b OK: 真实 runner 镜像 + agentd/worker + mock LLM + 崩溃恢复 全部通过');
  } catch (err) {
    try {
      // eslint-disable-next-line no-console
      console.log('\n[e2e] --- portal logs ---');
      // eslint-disable-next-line no-console
      console.log(docker('logs station-portal --tail 80'));
      // eslint-disable-next-line no-console
      console.log('\n[e2e] --- fde-alice (agentd) logs ---');
      // eslint-disable-next-line no-console
      console.log(docker('logs fde-alice --tail 120'));
    } catch {}
    throw err;
  }
});
