// WP3a 真机端到端（需 docker；docker 命令经 `sg docker -c` 绕过，env §8.1）。
// 流程：起栈（含 mock LLM 网关）→ 建用户 + provision FDE → 假 agentd（真实 token + FDE 网络路径）
//   → SSE 连接 + claim → 事件 seq 递增 → finish → 断线重连 re-claim（方案 B）→ 并发 claim 竞态
//   → mock 网关经 Traefik 注入链流式响应 → 回收。
// 运行：npm run test:integration:wp3a
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCidr, intToIp } from '../src/ipam.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COMPOSE = 'docker compose --env-file deploy/.env -f deploy/docker-compose.yml';
const PORTAL = 'http://127.0.0.1:18080';
const TRAEFIK_WEB = 'http://127.0.0.1:8090';

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
  try { return fn(); } catch { return null; }
}

async function waitFor(fn, { timeoutMs = 120000, intervalMs = 500, label = 'condition' } = {}) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { lastErr = e; }
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}${lastErr ? `: ${lastErr.message}` : ''}`);
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
  projectId: '00000000-0000-0000-0000-000000000010',
  sessionId: '00000000-0000-0000-0000-000000000020',
  token: null,
  gateway: null,
  networkName: null,
  subnet: null,
  containerId: null,
};

function seedRun({ runId, queueId }) {
  const sql = `
    INSERT INTO projects (id, user_id, name, repo_url, root_path, slot, template)
    VALUES ('${S.projectId}', '${S.userId}', 'proj1', 'https://git.example/alice/proj1.git', '~/projects/proj1', 0, 'node')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO chat_sessions (id, user_id, project_id, title, model, last_seq)
    VALUES ('${S.sessionId}', '${S.userId}', '${S.projectId}', 'e2e', 'mock-model', 0)
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO runs (id, session_id, status) VALUES ('${runId}', '${S.sessionId}', 'queued');
    INSERT INTO run_queue (id, run_id, container_id, status) VALUES ('${queueId}', '${runId}', '${S.containerId}', 'pending');
  `;
  psqlStdin(sql);
}

function readTokenFromContainer() {
  const inspect = JSON.parse(docker('inspect fde-alice'));
  const env = inspect[0].Config.Env || [];
  const line = env.find((e) => e.startsWith('ERIX_STATION_TOKEN='));
  return line ? line.slice('ERIX_STATION_TOKEN='.length) : null;
}

function runFakeAgentd(phase) {
  const cmd = `run --rm --network ${S.networkName} -v ${REPO_ROOT}:/app:ro node:22-alpine node /app/portal/integration/fake-agentd.mjs --phase ${phase} --gateway http://${S.gateway}:8090 --token ${S.token} --station-host station.localhost --llm-host llm.localhost`;
  const out = docker(cmd).trim();
  const lines = out.split('\n').filter((l) => l.trim());
  return JSON.parse(lines[lines.length - 1]);
}

test('WP3a 端到端：internal API + run 状态机 + 方案 B re-claim + mock 网关注入链', { timeout: 12 * 60 * 1000 }, async (t) => {
  S.userspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-users-wp3a-'));
  S.dynamicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-dynamic-wp3a-'));
  fs.chmodSync(S.userspaceRoot, 0o755);
  fs.chmodSync(S.dynamicRoot, 0o755);

  const cleanup = () => {
    safe(() => docker('rm -f fde-alice 2>/dev/null || true'));
    safe(() => docker('network rm fde-alice 2>/dev/null || true'));
    safe(() => compose('down -v', { ERIX_USERSPACE_ROOT_HOST: S.userspaceRoot, TRAEFIK_DYNAMIC_DIR_HOST: S.dynamicRoot }));
    safe(() => docker('rmi -f erix-station/portal:local erix-station/mock-llm:local 2>/dev/null || true'));
    safe(() => fs.rmSync(S.userspaceRoot, { recursive: true, force: true }));
    safe(() => fs.rmSync(S.dynamicRoot, { recursive: true, force: true }));
    safe(() => docker('run --rm -v /docker:/docker alpine rm -rf /docker/station-db'));
  };
  t.after(cleanup);

  try {
    // 0) 预清理
    safe(() => compose('down -v', { ERIX_USERSPACE_ROOT_HOST: S.userspaceRoot, TRAEFIK_DYNAMIC_DIR_HOST: S.dynamicRoot }));
    safe(() => docker('run --rm -v /docker:/docker alpine rm -rf /docker/station-db'));

    // 1) 起栈（含 station-mock-llm）
    compose('up -d --build', { ERIX_USERSPACE_ROOT_HOST: S.userspaceRoot, TRAEFIK_DYNAMIC_DIR_HOST: S.dynamicRoot });

    await waitFor(async () => {
      const r = await fetch(`${PORTAL}/healthz`).catch(() => null);
      return r && r.status === 200;
    }, { label: 'portal healthz', timeoutMs: 240000 });

    await waitFor(async () => {
      const r = await fetch('http://127.0.0.1:4000/healthz').catch(() => null);
      return r && r.status === 200;
    }, { label: 'mock-llm healthz', timeoutMs: 120000 });

    // 2) 建用户（provision 前提）+ provision FDE（复用 WP2b 路径）
    psqlStdin(`INSERT INTO users (id, login, display_name, role, fde_name, auth_source, status) VALUES ('${S.userId}', 'alice', 'Alice', 'fde', 'alice', 'local', 'active');`);
    docker('exec station-portal node portal/src/cli.js provision-fde --fde-name alice');

    await waitFor(() => {
      const st = safe(() => docker('inspect fde-alice --format {{.State.Status}}').trim());
      return st === 'running' ? st : null;
    }, { label: 'fde-alice running' });

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

    // 3) 等 routes.yml 生成 internal + llm 路由
    const routesFile = path.join(S.dynamicRoot, 'routes.yml');
    await waitFor(() => {
      if (!fs.existsSync(routesFile)) return null;
      const txt = fs.readFileSync(routesFile, 'utf8');
      return txt.includes('/api/internal') && txt.includes('llm.localhost') ? txt : null;
    }, { label: 'routes.yml 含 internal + llm 路由' });

    // 4) ipAllowList 负向：宿主来源（127.0.0.1）不在 FDE subnet → 403
    const curlForbidden = `curl -s -o /dev/null -w '%{http_code}' -H 'Host: station.localhost' -H 'Authorization: Bearer ${S.token}' ${TRAEFIK_WEB}/api/internal/heartbeat`;
    await waitFor(async () => {
      const c = execSync(curlForbidden, { encoding: 'utf8', stdio: 'pipe' }).trim();
      return c === '403' ? c : null;
    }, { label: '非 FDE 来源 internal 403', timeoutMs: 30000 });

    // 5) happy path：claim → running → events（seq 递增）→ finish
    seedRun({ runId: '00000000-0000-0000-0000-000000000100', queueId: '00000000-0000-0000-0000-000000000200' });
    const happy = runFakeAgentd('happy');
    assert.equal(happy.ok, true, `happy phase: ${JSON.stringify(happy)}`);
    assert.equal(happy.claim_attempt, 1);
    assert.equal(happy.resume, false);
    assert.equal(happy.sse_has_ping, true, 'SSE 下行收到 ping');
    assert.equal(happy.events.stored, 2);

    const happyStatus = psql(`SELECT status FROM runs WHERE id='00000000-0000-0000-0000-000000000100'`);
    assert.equal(happyStatus, 'finished');
    // 注意：seq 为 session 全局分配器（messages 与 run_events 共享 chat_sessions.last_seq，§7.3）。
    // happy run 落库序：事件 seq 1,2 → assistant 消息 seq 3 → run_end seq 4。
    const happySeqs = psql(`SELECT string_agg(seq::text, ',' ORDER BY seq) FROM run_events WHERE run_id='00000000-0000-0000-0000-000000000100'`);
    assert.equal(happySeqs, '1,2,4', 'run_events seq（seq 3 为 assistant 消息）');
    const runEndIsLast = psql(`SELECT type FROM run_events WHERE run_id='00000000-0000-0000-0000-000000000100' ORDER BY seq DESC LIMIT 1`);
    assert.equal(runEndIsLast, 'run_end', 'run_end 为 run 内最后一条');
    const usageCount = psql(`SELECT count(*) FROM usage_ledger WHERE run_id='00000000-0000-0000-0000-000000000100' AND source='erix'`);
    assert.equal(usageCount, '1', 'usage_ledger 一 run 一条');
    const assistant = psql(`SELECT count(*) FROM messages WHERE run_id='00000000-0000-0000-0000-000000000100' AND role='assistant'`);
    assert.equal(assistant, '1', 'assistant 消息回写');

    // 6) 方案 B re-claim：claim(attempt 1) → release → re-claim(attempt 2, resume) → finish
    seedRun({ runId: '00000000-0000-0000-0000-000000000101', queueId: '00000000-0000-0000-0000-000000000201' });
    const reclaim = runFakeAgentd('reclaim');
    assert.equal(reclaim.ok, true, `reclaim phase: ${JSON.stringify(reclaim)}`);
    assert.equal(reclaim.attempt1, 1);
    assert.equal(reclaim.attempt2, 2);
    assert.equal(reclaim.resume, true, '方案 B re-claim 返回 resume=true');
    assert.equal(reclaim.release.outcome, 'requeued');

    const rcAttempts = psql(`SELECT attempts FROM run_queue WHERE run_id='00000000-0000-0000-0000-000000000101'`);
    assert.equal(rcAttempts, '2', 'attempts 递增到 2');
    const rcStatus = psql(`SELECT status FROM runs WHERE id='00000000-0000-0000-0000-000000000101'`);
    assert.equal(rcStatus, 'finished');
    // 事件含 attempt 1 与 attempt 2 前缀，seq 继续单调
    const rcEvents = psql(`SELECT string_agg(client_event_id, ',' ORDER BY seq) FROM run_events WHERE run_id='00000000-0000-0000-0000-000000000101' AND type <> 'run_end'`);
    assert.ok(rcEvents.includes(':1:0'), 'attempt 1 事件存在');
    assert.ok(rcEvents.includes(':2:0'), 'attempt 2 事件存在');
    const rcLast = psql(`SELECT type FROM run_events WHERE run_id='00000000-0000-0000-0000-000000000101' ORDER BY seq DESC LIMIT 1`);
    assert.equal(rcLast, 'run_end', 're-claim 后 run_end 仍为最后一条');

    // 7) 并发 claim 竞态：单 pending run，两个并发 claim 只有一个成功
    seedRun({ runId: '00000000-0000-0000-0000-000000000102', queueId: '00000000-0000-0000-0000-000000000202' });
    const concurrent = runFakeAgentd('concurrent');
    assert.equal(concurrent.ok, true, `concurrent phase: ${JSON.stringify(concurrent)}`);
    assert.equal(concurrent.winners, 1);
    assert.equal(concurrent.empty, 1);

    // 8) mock 网关经 Traefik 注入链流式响应（伪造 Authorization 被覆盖为 erix-placeholder）
    const llm = runFakeAgentd('llm');
    assert.equal(llm.ok, true, `llm phase: ${JSON.stringify(llm)}`);
    assert.equal(llm.has_done, true, '流式以 [DONE] 结束');
    assert.ok(llm.chunks >= 2, '至少两段流式 chunk');

    // 9) seq 全局不变式：messages + run_events 共享 session last_seq，无空洞、无重号
    const allSeq = psql(`SELECT string_agg(seq::text, ',' ORDER BY seq) FROM (SELECT seq FROM run_events WHERE session_id='${S.sessionId}' UNION SELECT seq FROM messages WHERE session_id='${S.sessionId}') x`);
    const seqList = allSeq.split(',').map(Number);
    assert.ok(seqList.every((v, i) => v === i + 1), `session 级 seq 严格递增无空洞：${allSeq}`);

    // eslint-disable-next-line no-console
    console.log(`\n[e2e] WP3a OK: internal API + 状态机 + 方案B re-claim + 并发 claim + mock 网关注入链 全部通过`);
  } catch (err) {
    try {
      // eslint-disable-next-line no-console
      console.log('\n[e2e] --- portal logs ---');
      // eslint-disable-next-line no-console
      console.log(docker('logs station-portal --tail 80'));
      // eslint-disable-next-line no-console
      console.log('\n[e2e] --- mock-llm logs ---');
      // eslint-disable-next-line no-console
      console.log(docker('logs station-mock-llm --tail 40'));
    } catch {}
    throw err;
  }
});
