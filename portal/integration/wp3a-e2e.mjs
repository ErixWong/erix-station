// WP3a 真机端到端（需 docker；docker 命令经 `sg docker -c` 绕过，env §8.1）。
// 流程：起栈（含 LiteLLM）→ 建用户 + provision FDE → 假 agentd（真实 token + FDE 网络路径）
//   → SSE 连接 + claim → 事件 seq 递增 → finish → 断线重连 re-claim（方案 B）→ 并发 claim 竞态
//   → mock 网关经 Traefik 注入链流式响应 → 回收。
// 运行：npm run test:integration:wp3a（⚠️ issue #226 起**必须带隔离 env**，见下；缺 env 直接硬失败。）
//
// —— 隔离 env 清单（issue #226；与 wp3b/wp5/wp6 同一套，判据集中在 lib/isolated-env.mjs）——
//   入口 URL / 容器名 / DB 数据目录全部 env 派生（缺省值 = 共享栈现状值，仅为可读；护栏强制显式传）：
//   STATION_STACK_ID=<唯一栈 id> COMPOSE_PROJECT_NAME=<同一个栈 id>
//   STATION_DB_DIR=/tmp/station-db-<栈 id>（必须不存在；缺省会 rm -rf 共享 dev 库数据目录）
//   STATION_DB_NAME/STATION_PORTAL_NAME/STATION_LITELLM_NAME/STATION_DOCKER_PROXY_NAME/STATION_EDGE_NAME
//     =station-*-<栈 id>（compose 用它们做 container_name，不派生与共享栈撞名）
//   PORTAL_HOST_PORT=<非 18080> LITELLM_HOST_PORT=<非 4100> TRAEFIK_WEB_PORT=<非 8090> TRAEFIK_WEBSECURE_PORT=<非 8443>
//   FDE_NAME=<含栈 id 的 FDE 名>（fde-<name> 是全局 docker 网络/容器名，不派生会与共享栈互删）
//   BACKEND_SUBNET=<非 172.32.0.0/24> FDE_POOL=large FDE_IPAM_POOLS=10.201.0.0/16
//   LLM_GATEWAY_HOST=http://127.0.0.1:<LITELLM_HOST_PORT>
//   STATION_PORTAL_IMAGE/STATION_DOCKER_PROXY_IMAGE/FDE_IMAGE=…:<栈 id>
//   FDE_DEV_MODE=1（#227.1 起必需：FDE_IMAGE 为 image:tag 形态时须显式声明 dev 模式；digest 形态豁免）
//   TRAEFIK_STATIC_HOST 由脚本自动生成（只改入口端口的临时 traefik.yml，F8）。代理构建/镜像与
//   HTTP_PROXY 口径见 lib/fde-image.mjs；IPAM 保留段等派生注入见 wp3b 的 isolationComposeEnv()。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCidr, intToIp } from '../src/ipam.js';
import { ensureLlmBinding } from './lib/llm-binding.mjs';
import { LLM_HOST, PORTAL_HOST, composeDomainEnv } from './lib/compose-domain.mjs';
import {
  assertHostPortsAvailable, assertIsolatedEnvironment, createDbDirCleaner, writeTraefikStatic,
} from './lib/isolated-env.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// #227.2：compose 一律显式 -p，且用 bash 的 `${VAR:?msg}`——未 export 时展开即非零退出并点名，
// 不再依赖「COMPOSE_PROJECT_NAME 环境变量压过 compose 文件 name: station」这条隐式优先级
// （忘 export 曾经会让脚本自己对共享 dev 栈 down -v）。
const COMPOSE = 'docker compose -p "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME required for isolated e2e}" --profile litellm --env-file deploy/.env -f deploy/docker-compose.yml';
// issue #226：入口句柄全部 env 派生（缺省值保留现状值只为可读，隔离跑法由护栏强制显式传）。
const PORTAL_HOST_PORT = process.env.PORTAL_HOST_PORT || '18080';
const PORTAL = `http://127.0.0.1:${PORTAL_HOST_PORT}`;
const TRAEFIK_WEB_PORT = process.env.TRAEFIK_WEB_PORT || '8090';
const TRAEFIK_WEBSECURE_PORT = process.env.TRAEFIK_WEBSECURE_PORT || '8443';
const TRAEFIK_WEB = `http://127.0.0.1:${TRAEFIK_WEB_PORT}`;
const LITELLM_HOST_PORT = process.env.LITELLM_HOST_PORT || '4100';
const DOMAIN_COMPOSE_ENV = composeDomainEnv(TRAEFIK_WEB_PORT);
const STATION_DB_NAME = process.env.STATION_DB_NAME || 'station-db';
const STATION_PORTAL_NAME = process.env.STATION_PORTAL_NAME || 'station-portal';
const STATION_LITELLM_NAME = process.env.STATION_LITELLM_NAME || 'station-litellm';
const FDE_NAME = process.env.FDE_NAME || 'alice';
const FDE_CONTAINER = `fde-${FDE_NAME}`; // provisioner/IPAM 命名规则：fde-<fde_name>

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

// M6/#226：DB 数据目录可参数化（与 deploy/docker-compose.yml 的挂载一致）。**缺省不再回退**
// /docker/station-db——共享 dev 栈库容器的 bind 源，按缺省 teardown 等于 rm -rf 真机库数据。
const { removeDbDir } = createDbDirCleaner({ docker });

function compose(args, env = {}) {
  return execSync(`sg docker -c ${JSON.stringify(`${COMPOSE} ${args}`)}`, {
    encoding: 'utf8',
    stdio: 'pipe',
    cwd: REPO_ROOT,
    env: { ...process.env, ...DOMAIN_COMPOSE_ENV, ...stackPaths(), ...env },
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
  return docker(`exec -i ${STATION_DB_NAME} psql -U station -d station -tAc ${JSON.stringify(query)}`).trim();
}

function psqlStdin(sql) {
  dockerStdin(`exec -i ${STATION_DB_NAME} psql -U station -d station -v ON_ERROR_STOP=1`, sql);
}

const S = {
  userspaceRoot: null,
  dynamicRoot: null,
  staticRoot: null,
  staticFile: null,
  userId: '00000000-0000-0000-0000-000000000001',
  projectId: '00000000-0000-0000-0000-000000000010',
  sessionId: '00000000-0000-0000-0000-000000000020',
  token: null,
  gateway: null,
  networkName: null,
  subnet: null,
  containerId: null,
};

/** compose 需要的宿主路径（静态配置在 mkdtemp 之前尚未生成 ⇒ 只注入已就绪的键）。 */
function stackPaths() {
  const paths = {
    ERIX_USERSPACE_ROOT_HOST: S.userspaceRoot,
    TRAEFIK_DYNAMIC_DIR_HOST: S.dynamicRoot,
    TRAEFIK_STATIC_HOST: S.staticFile,
  };
  return Object.fromEntries(Object.entries(paths).filter(([, value]) => value !== undefined && value !== null));
}

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
  const inspect = JSON.parse(docker(`inspect ${FDE_CONTAINER}`));
  const env = inspect[0].Config.Env || [];
  const line = env.find((e) => e.startsWith('ERIX_STATION_TOKEN='));
  return line ? line.slice('ERIX_STATION_TOKEN='.length) : null;
}

function runFakeAgentd(phase) {
  const cmd = `run --rm --network ${S.networkName} -v ${REPO_ROOT}:/app:ro node:22-alpine node /app/portal/integration/fake-agentd.mjs --phase ${phase} --gateway http://${S.gateway}:${TRAEFIK_WEB_PORT} --token ${S.token} --station-host ${PORTAL_HOST} --llm-host ${LLM_HOST}`;
  const out = docker(cmd).trim();
  const lines = out.split('\n').filter((l) => l.trim());
  return JSON.parse(lines[lines.length - 1]);
}

test('WP3a 端到端：internal API + run 状态机 + 方案 B re-claim + mock 网关注入链', { timeout: 12 * 60 * 1000 }, async (t) => {
  // issue #226：本脚本以前把入口 URL/容器名/FDE 名写死成共享栈，并把 DB 数据目录缺省指向共享 dev 库；
  // 结果两种跑法都是错的（假绿 + rm -rf 共享库）。现与 wp5/wp6 一样先过硬隔离护栏。
  assertIsolatedEnvironment({
    fdeNames: [{ env: 'FDE_NAME', value: FDE_NAME, sharedDefault: 'alice' }],
  });
  await assertHostPortsAvailable([PORTAL_HOST_PORT, LITELLM_HOST_PORT, TRAEFIK_WEB_PORT, TRAEFIK_WEBSECURE_PORT]);

  S.userspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-users-wp3a-'));
  S.dynamicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-dynamic-wp3a-'));
  S.staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-static-wp3a-'));
  S.staticFile = writeTraefikStatic(S.staticRoot, {
    repoRoot: REPO_ROOT, webPort: TRAEFIK_WEB_PORT, websecurePort: TRAEFIK_WEBSECURE_PORT,
  });
  fs.chmodSync(S.userspaceRoot, 0o755);
  fs.chmodSync(S.dynamicRoot, 0o755);
  fs.chmodSync(S.staticRoot, 0o755);

  const cleanup = () => {
    safe(() => docker(`rm -f ${FDE_CONTAINER} 2>/dev/null || true`));
    safe(() => docker(`network rm ${FDE_CONTAINER} 2>/dev/null || true`));
    safe(() => compose('down -v'));
    // issue #178：不删镜像（共享 tag 绝不能被 e2e 删除；compose up --build 按需重建）。
    safe(() => fs.rmSync(S.userspaceRoot, { recursive: true, force: true }));
    safe(() => fs.rmSync(S.dynamicRoot, { recursive: true, force: true }));
    safe(() => fs.rmSync(S.staticRoot, { recursive: true, force: true }));
    // STATION_DB_DIR 缺省/越界会在 removeDbDir() 里抛错（不会 rm -rf 共享 dev 库数据目录）。
    removeDbDir();
  };
  t.after(cleanup);

  try {
    // 0) 预清理
    safe(() => compose('down -v'));
    removeDbDir();

    // 1) 起栈（含 station-litellm）；启动迁移完成后，管理台 API 才能创建 credential/model/binding。
    // LLM_GATEWAY_HOST 跟隔离栈自己的 LiteLLM publish 端口对齐（host 网络的 Traefik 用）。
    compose('up -d --build', { MIGRATE_ON_START: '1', LLM_GATEWAY_HOST: `http://127.0.0.1:${LITELLM_HOST_PORT}` });

    await waitFor(async () => {
      const r = await fetch(`${PORTAL}/healthz`).catch(() => null);
      return r && r.status === 200;
    }, { label: `portal healthz (${PORTAL})`, timeoutMs: 240000 });

    await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${LITELLM_HOST_PORT}/health/readiness`).catch(() => null);
      return r && r.status === 200;
    }, { label: `LiteLLM readiness (${STATION_LITELLM_NAME})`, timeoutMs: 120000 });

    // 2) 建用户（provision 前提）+ provision FDE（复用 WP2b 路径）
    psqlStdin(`INSERT INTO users (id, login, display_name, role, fde_name, auth_source, status) VALUES ('${S.userId}', 'alice', 'Alice', 'fde', '${FDE_NAME}', 'local', 'active');`);
    docker(`exec ${STATION_PORTAL_NAME} node portal/src/cli.js provision-fde --fde-name ${FDE_NAME}`);

    await waitFor(() => {
      const st = safe(() => docker(`inspect ${FDE_CONTAINER} --format {{.State.Status}}`).trim());
      return st === 'running' ? st : null;
    }, { label: `${FDE_CONTAINER} running` });

    const netRow = psql(`SELECT network_name, subnet, gateway FROM fde_networks WHERE fde_id='${S.userId}'`);
    const [networkName, subnet, gateway] = netRow.split('|').map((s) => s.trim());
    S.networkName = networkName;
    S.subnet = subnet;
    S.gateway = gateway;
    assert.equal(networkName, `fde-${FDE_NAME}`);
    assert.ok(gateway, 'fde gateway .1');

    S.containerId = psql(`SELECT id FROM containers WHERE fde_name='${FDE_NAME}'`);
    assert.ok(S.containerId, 'containers row');
    S.token = readTokenFromContainer();
    assert.ok(S.token, 'ERIX_STATION_TOKEN 已注入容器');

    // issue #38 新语义（fail-closed）：LLM 路由按 fde_llm_bindings（必须有 api_key）生成，
    // 无 binding 即无 LLM 出口（worker LLM 调用 404 → run failed）。provision 之后、跑 run 之前补 binding。
    await ensureLlmBinding({
      docker,
      dynamicDir: S.dynamicRoot,
      fdeName: FDE_NAME,
      // issue #226：helper 的缺省值就是共享栈句柄（宿主 18080 上的 portal、容器名 station-portal、库名 station-db）：
      // 必须显式传派生值，否则隔离栈里它会去改共享栈的管理台资源。
      portal: PORTAL,
      portalContainerName: STATION_PORTAL_NAME,
      dbContainerName: STATION_DB_NAME,
      adminLogin: 'wp3a-admin',
      adminPassword: 'wp3a-admin-pass-123',
    });

    // 3) 等 routes.yml 生成 internal 路由（issue #38 Phase B1 起 LLM 段拆独立文件 llm-routes.yml，
    //    其中 llm-alice 已由上方 helper 等待过；本处只等主文件）
    const routesFile = path.join(S.dynamicRoot, 'routes.yml');
    await waitFor(() => {
      if (!fs.existsSync(routesFile)) return null;
      const txt = fs.readFileSync(routesFile, 'utf8');
      return txt.includes('/api/internal') ? txt : null;
    }, { label: 'routes.yml 含 internal 路由' });

    // 4) ipAllowList 负向：宿主来源（127.0.0.1）不在 FDE subnet → 403
    const curlForbidden = `curl -s -o /dev/null -w '%{http_code}' -H 'Host: ${PORTAL_HOST}' -H 'Authorization: Bearer ${S.token}' ${TRAEFIK_WEB}/api/internal/heartbeat`;
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
      console.log(docker(`logs ${STATION_PORTAL_NAME} --tail 80`));
      // eslint-disable-next-line no-console
      console.log('\n[e2e] --- LiteLLM logs ---');
      // eslint-disable-next-line no-console
      console.log(docker(`logs ${STATION_LITELLM_NAME} --tail 40`));
    } catch {}
    throw err;
  }
});
