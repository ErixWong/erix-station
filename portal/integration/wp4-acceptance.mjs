// WP4 端到端验收（issue #13 walking skeleton 里程碑）：一条命令跑通 + 6 条真机断言。
// 断言清单（issue #13）：① 跨 FDE 隔离 ② 未认证 403 ③ cookie 不透传上游 ④ 未分配端口不可达 ⑤ 事件落 DB ⑥ SSE 收到。
// 拓扑：FDE alice = 真实 runner 镜像（agentd 跑 run，断言 ⑤⑥）；FDE bob = 同镜像 + docker exec 起 echo server（断言 ①②③④）。
// 依据：docs/design/fde-platform.md §8/§9、topology.md §4-L3/§5、portal.md §2.7/§2.8/§9。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as totp from '../src/totp.js';
import * as auth from '../src/auth.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COMPOSE = 'docker compose --env-file deploy/.env -f deploy/docker-compose.yml';
const PORTAL = 'http://127.0.0.1:18080';
const TRAEFIK_WEB = 'http://127.0.0.1:8090';
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

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitFor(fn, { label, timeoutMs, intervalMs = 100 }) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const v = await fn();
        if (v) return resolve(v);
      } catch { /* retry */ }
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

const S = {
  userspaceRoot: null,
  dynamicRoot: null,
  password: 'correct horse battery staple',
  users: {}, // name -> { userId, totpSecret, cookie, projectId, portId, port, hostname, containerIp }
};
let logProc = null;

const FDE_ENV = {
  FDE_IMAGE,
  FDE_CMD: '[]',
  FDE_DEV_USER: '',
  FDE_DEV_MODE: '1',
  FDE_AGENT_VERSION: '0.1.0',
  MOCK_LATENCY_MS: '5000',
};

const RUNNER = {
  run1: '00000000-0000-0000-0000-000000000301',
  queue1: '00000000-0000-0000-0000-000000000401',
  session1: '00000000-0000-0000-0000-000000000501',
  message1: '00000000-0000-0000-0000-000000000601',
};

async function insertUser(name) {
  const ids = { alice: '00000000-0000-4000-8000-000000000001', bob: '00000000-0000-4000-8000-000000000002' };
  const passwordHash = await auth.hashPassword(S.password);
  const totpSecret = totp.generateSecret(20);
  psqlStdin(`
    INSERT INTO users (id, login, display_name, role, fde_name, auth_source, status, password_hash, totp_secret)
    VALUES ('${ids[name]}', '${name}', '${name}', 'fde', '${name}', 'local', 'active', '${passwordHash}', '${totpSecret}');
  `);
  S.users[name] = { userId: ids[name], totpSecret };
}

async function login(name) {
  const u = S.users[name];
  const step1 = await fetch(`${PORTAL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: name, password: S.password }),
  });
  assert.equal(step1.status, 200, `login step1 ${name}`);
  const { pending_token } = await step1.json();
  const step2 = await fetch(`${PORTAL}/api/auth/login/totp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pending_token, code: totp.totp(u.totpSecret) }),
  });
  assert.equal(step2.status, 200, `login step2 ${name}`);
  u.cookie = readCookie(step2.headers.get('set-cookie'));
  assert.ok(u.cookie, `session cookie ${name}`);
}

async function createProject(name) {
  const u = S.users[name];
  const r = await fetch(`${PORTAL}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `fde_session_dev=${u.cookie}` },
    body: JSON.stringify({ name: `proj-${name}`, repo_url: `https://git.example/${name}/proj.git`, template: 'node' }),
  });
  const body = await r.json();
  assert.equal(r.status, 201, `create project ${name}: ${JSON.stringify(body)}`);
  u.projectId = body.project.id;
  u.portId = body.ports[0].id;
  u.port = body.ports[0].port;
  u.hostname = body.ports[0].hostname;
  assert.equal(body.ports[0].state, 'allocated');
}

function containerIp(name) {
  return docker(`inspect fde-${name} --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'`).trim();
}

test('WP4 端到端验收：6 条真机断言（隔离/403/cookie 边界/未分配端口/事件落 DB/SSE）', { timeout: 15 * 60 * 1000 }, async (t) => {
  S.userspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-users-wp4-'));
  S.dynamicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-dynamic-wp4-'));
  fs.chmodSync(S.userspaceRoot, 0o755);
  fs.chmodSync(S.dynamicRoot, 0o755);

  const cleanup = () => {
    if (logProc) { try { logProc.kill('SIGKILL'); } catch {} logProc = null; }
    safe(() => docker('rm -f fde-alice fde-bob 2>/dev/null || true'));
    safe(() => docker('network rm fde-alice fde-bob 2>/dev/null || true'));
    safe(() => compose('down -v', { ERIX_USERSPACE_ROOT_HOST: S.userspaceRoot, TRAEFIK_DYNAMIC_DIR_HOST: S.dynamicRoot }));
    safe(() => docker(`rmi -f ${FDE_IMAGE} 2>/dev/null || true`));
    safe(() => fs.rmSync(S.userspaceRoot, { recursive: true, force: true }));
    safe(() => fs.rmSync(S.dynamicRoot, { recursive: true, force: true }));
    removeDbDir();
  };
  t.after(cleanup);

  try {
    // 0) 预清理 + 构建 + 起栈
    safe(() => compose('down -v', { ERIX_USERSPACE_ROOT_HOST: S.userspaceRoot, TRAEFIK_DYNAMIC_DIR_HOST: S.dynamicRoot }));
    removeDbDir();
    safe(() => docker(`rmi -f ${FDE_IMAGE} 2>/dev/null || true`));
    docker(`build -t ${FDE_IMAGE} runner/`);
    compose('up -d --build', { ERIX_USERSPACE_ROOT_HOST: S.userspaceRoot, TRAEFIK_DYNAMIC_DIR_HOST: S.dynamicRoot, ...FDE_ENV });

    await waitFor(async () => {
      const r = await fetch(`${PORTAL}/healthz`).catch(() => null);
      return r && r.status === 200;
    }, { label: 'portal healthz', timeoutMs: 240000, intervalMs: 1000 });

    // 1) 双 FDE 用户 + 登录 + 建项目（各自端口块）
    await insertUser('alice');
    await insertUser('bob');
    await login('alice');
    await login('bob');
    await createProject('alice');
    await createProject('bob');
    assert.notEqual(S.users.alice.hostname, S.users.bob.hostname, '两 allocation hostname 不冲突（端口块按用户独立，跨用户同端口号是设计内行为）');

    // 2) provision 双 FDE（同一 runner 镜像；alice 跑 agentd，bob 另起 echo server 当预览上游）
    docker('exec station-portal node portal/src/cli.js provision-fde --fde-name alice');
    docker('exec station-portal node portal/src/cli.js provision-fde --fde-name bob');
    await waitFor(() => (psql(`SELECT status FROM containers WHERE fde_name='bob'`) === 'running' ? true : null),
      { label: 'fde-bob running', timeoutMs: 60000 });

    const bobIp = containerIp('bob');
    const aliceIp = containerIp('alice');
    assert.ok(/^10\.200\./.test(bobIp) && /^10\.200\./.test(aliceIp), `两容器都在 /29 池内: alice=${aliceIp} bob=${bobIp}`);
    assert.notEqual(aliceIp, bobIp, '两 FDE 不共享网络');

    // bob 内起 echo server（回显请求头 JSON）——预览链路的上游 dev server 替身
    const echoJs = `require('http').createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify(q.headers))}).listen(${S.users.bob.port})`;
    docker(`exec -d fde-bob node -e ${JSON.stringify(echoJs)}`);

    // 等 agentd（alice）上线
    await waitFor(() => (docker('logs fde-alice 2>&1').includes('sse ping received') ? true : null),
      { label: 'agentd sse ping', timeoutMs: 90000, intervalMs: 1000 });

    // ================================================================
    // 断言 ①：跨 FDE 隔离——alice 不能到达 bob 的任何端口（反向亦然）
    // ================================================================
    const probeJs = (ip, port) => `fetch('http://${ip}:${port}/',{signal:AbortSignal.timeout(4000)}).then(r=>{console.log('REACHED',r.status);process.exit(3)}).catch(e=>{console.log('BLOCKED',e.cause?.code||e.name);process.exit(0)})`;
    for (const [from, to, toIp] of [['alice', 'bob', bobIp], ['bob', 'alice', aliceIp]]) {
      const out = docker(`exec fde-${from} node -e ${JSON.stringify(probeJs(toIp, S.users[to].port))}`);
      assert.match(out, /BLOCKED/, `断言① 跨 FDE 隔离：fde-${from} → ${toIp}:${S.users[to].port} 必须不可达（得到 ${out}）`);
    }
    // eslint-disable-next-line no-console
    console.log('[wp4] ① 跨 FDE 隔离 OK（alice↔bob 双向均不可达）');

    // ================================================================
    // 断言 ②：未认证 403——无预览凭证经 Traefik 打预览路由 → fail-closed 403
    // ================================================================
    await waitFor(() => {
      const routesFile = path.join(S.dynamicRoot, 'routes.yml');
      return fs.existsSync(routesFile) && fs.readFileSync(routesFile, 'utf8').includes(S.users.bob.hostname) ? true : null;
    }, { label: 'routes.yml 含 bob router' });

    const codeNo = execSync(
      `curl -s -o /dev/null -w '%{http_code}' -H 'Host: ${S.users.bob.hostname}' ${TRAEFIK_WEB}/`,
      { encoding: 'utf8', stdio: 'pipe' },
    ).trim();
    assert.equal(codeNo, '403', '断言② 未认证 403（fail-closed）');
    // eslint-disable-next-line no-console
    console.log('[wp4] ② 未认证 403 OK');

    // ================================================================
    // 断言 ③：cookie 不透传上游——portal session cookie 经 forwardAuth+strip-cookie 绝不到达 dev server
    // ================================================================
    const issue = await fetch(`${PORTAL}/api/ports/${S.users.bob.portId}/preview-ticket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `fde_session_dev=${S.users.bob.cookie}` },
      body: '{}',
    });
    assert.equal(issue.status, 201, '签发 bob ticket');
    const { ticket } = await issue.json();

    // ticket 换预览 cookie（302 bootstrap），捕获 Set-Cookie
    const bootstrap = execSync(
      `curl -s -D - -o /dev/null -H 'Host: ${S.users.bob.hostname}' '${TRAEFIK_WEB}/?preview_ticket=${ticket}'`,
      { encoding: 'utf8', stdio: 'pipe' },
    );
    assert.ok(/HTTP.*302|HTTP\/1\.1 302/.test(bootstrap.split('\n')[0]), 'ticket bootstrap 302');
    const setCookieLine = bootstrap.split('\n').find((l) => /^set-cookie:/i.test(l));
    assert.ok(setCookieLine, '302 带 Set-Cookie（预览 cookie）');
    const previewCookie = setCookieLine.split(':')[1].split(';')[0].trim(); // name=value

    // 手动带上「portal session cookie + 预览 cookie」打预览路由——上游 echo 必须看不到任何 Cookie
    const echoBody = execSync(
      `curl -s -H 'Host: ${S.users.bob.hostname}' -H 'Cookie: fde_session_dev=${S.users.bob.cookie}; ${previewCookie}' ${TRAEFIK_WEB}/`,
      { encoding: 'utf8', stdio: 'pipe' },
    );
    const echoHeaders = JSON.parse(echoBody);
    assert.equal(echoHeaders.cookie, undefined, `断言③ cookie 不透传上游（strip-cookie 生效）：${echoBody.slice(0, 200)}`);
    // eslint-disable-next-line no-console
    console.log('[wp4] ③ cookie 不透传上游 OK（strip-cookie 删除全部 Cookie）');

    // ================================================================
    // 断言 ④：未分配端口不可达——未路由的 Host 经 Traefik → 404
    // ================================================================
    const strayHost = `stray-${Date.now()}.fde.localhost`;
    const codeStray = execSync(
      `curl -s -o /dev/null -w '%{http_code}' -H 'Host: ${strayHost}' ${TRAEFIK_WEB}/`,
      { encoding: 'utf8', stdio: 'pipe' },
    ).trim();
    assert.equal(codeStray, '404', '断言④ 未分配端口不可达（无 router → 404）');
    // eslint-disable-next-line no-console
    console.log('[wp4] ④ 未分配端口不可达 OK');

    // ================================================================
    // 断言 ⑥：SSE 下行 + 吊销收敛——① agentd 的 SSE 长连（portal → 容器，ping 证明下行通）；
    // ② deprovision → token 吊销 → agentd 停领收敛退出。
    // 已知限制（portal.md §10.3/§6.3 同源）：deprovision-fde 走 CLI 独立进程，
    // 内存 SSE hub 的 revoke 推送跨不了进程（当前唯一主动事件实际不可达），收敛靠
    // 心跳/claim 的 token_revoked（≤90s）；进程内推送留待 admin 端点接入（issue 记录）。
    // ================================================================
    fs.mkdirSync('/tmp/hb', { recursive: true });
    logProc = spawn('sg', ['docker', '-c', 'docker logs -f fde-alice 2>&1'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', fs.openSync('/tmp/hb/wp4-agentd.log', 'w'), 'inherit'],
    });
    await waitFor(() => {
      const out = safe(() => fs.readFileSync('/tmp/hb/wp4-agentd.log', 'utf8')) ?? '';
      return out.includes('sse connected') && out.includes('sse ping received') ? out : null;
    }, { label: 'SSE 下行通（agentd 连上并收到 ping）', timeoutMs: 60000 });

    // ================================================================
    // 断言 ⑤：事件落 DB——真实 agentd claim → worker 跑（mock LLM）→ run_events 落库
    // ================================================================
    psqlStdin(`
      DELETE FROM run_queue WHERE run_id='${RUNNER.run1}';
      DELETE FROM messages WHERE run_id='${RUNNER.run1}';
      DELETE FROM runs WHERE id='${RUNNER.run1}';
      DELETE FROM chat_sessions WHERE id='${RUNNER.session1}';
    `);
    psqlStdin(`
      INSERT INTO chat_sessions (id, user_id, project_id, title, model, last_seq)
      VALUES ('${RUNNER.session1}', '${S.users.alice.userId}', '${S.users.alice.projectId}', 'wp4', 'mock-model', 1)
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO runs (id, session_id, status) VALUES ('${RUNNER.run1}', '${RUNNER.session1}', 'queued');
      INSERT INTO messages (id, session_id, run_id, seq, role, content)
      VALUES ('${RUNNER.message1}', '${RUNNER.session1}', '${RUNNER.run1}', 1, 'user', 'WP4 acceptance task');
      INSERT INTO run_queue (id, run_id, container_id, status)
      VALUES ('${RUNNER.queue1}', '${RUNNER.run1}', (SELECT id FROM containers WHERE fde_name='alice'), 'pending');
    `);

    // run 跑完（mock LLM 延迟 5s × 轮次）
    await waitFor(() => {
      const st = psql(`SELECT status FROM runs WHERE id='${RUNNER.run1}'`);
      return (st === 'finished' || st === 'failed') ? st : null;
    }, { label: 'run 终态', timeoutMs: 120000, intervalMs: 1000 });
    const runStatus = psql(`SELECT status FROM runs WHERE id='${RUNNER.run1}'`);
    assert.equal(runStatus, 'finished', 'run 终态 finished');

    const evCount = psql(`SELECT count(*) FROM run_events WHERE run_id='${RUNNER.run1}'`);
    assert.ok(Number(evCount) > 0, `断言⑤ 事件落 DB：run_events ${evCount} 条`);
    const evIds = psql(`SELECT string_agg(client_event_id, ',' ORDER BY seq) FROM run_events WHERE run_id='${RUNNER.run1}'`);
    assert.ok(evIds.includes(':1:0'), `client_event_id 命名空间正确（:attempt:n）：${evIds}`);
    const seqList = psql(`SELECT string_agg(seq::text, ',' ORDER BY seq) FROM (SELECT seq FROM run_events WHERE session_id='${RUNNER.session1}' UNION SELECT seq FROM messages WHERE session_id='${RUNNER.session1}') x`).split(',').map(Number);
    assert.deepEqual(seqList, seqList.map((_, i) => i + 1), `session seq 严格递增无空洞：${seqList.join(',')}`);
    const runEndLast = psql(`SELECT type FROM run_events WHERE run_id='${RUNNER.run1}' ORDER BY seq DESC LIMIT 1`);
    assert.equal(runEndLast, 'run_end', 'run_end 为最后一条事件');
    // eslint-disable-next-line no-console
    console.log(`[wp4] ⑤ 事件落 DB OK（${evCount} 条事件，seq 连续，run_end 末位）`);

    // 吊销收敛（断言 ⑥ 收口）：deprovision → 容器回收 + agentd 退出（token 吊销 / SIGTERM 收敛）
    docker('exec station-portal node portal/src/cli.js deprovision-fde --fde-name alice');
    await waitFor(() => {
      const out = safe(() => fs.readFileSync('/tmp/hb/wp4-agentd.log', 'utf8')) ?? '';
      return (out.includes('"msg":"agentd exiting"') || out.includes('shutdown: draining runs')) ? out : null;
    }, { label: 'agentd 收敛退出', timeoutMs: 60000 });
    await waitFor(() => (psql(`SELECT status FROM containers WHERE fde_name='alice'`) === 'removed' ? true : null),
      { label: 'containers.status = removed', timeoutMs: 30000 });
    // eslint-disable-next-line no-console
    console.log('[wp4] ⑥ SSE 下行 + 吊销收敛 OK（agentd 长连收 ping；deprovision → 容器回收 + agentd 退出）');

    // eslint-disable-next-line no-console
    console.log('\n[wp4] ✅ 6 条真机断言全部通过：跨 FDE 隔离 / 未认证 403 / cookie 不透传 / 未分配端口不可达 / 事件落 DB / SSE 收到');
  } catch (err) {
    try {
      // eslint-disable-next-line no-console
      console.log('\n[wp4] --- portal logs ---');
      // eslint-disable-next-line no-console
      console.log(docker('logs station-portal --tail 60 2>&1'));
      // eslint-disable-next-line no-console
      console.log('\n[wp4] --- fde-alice logs ---');
      // eslint-disable-next-line no-console
      console.log(docker('logs fde-alice --tail 60 2>&1'));
      // eslint-disable-next-line no-console
      console.log('\n[wp4] --- fde-bob logs ---');
      // eslint-disable-next-line no-console
      console.log(docker('logs fde-bob --tail 40 2>&1'));
    } catch { /* 尽力打印 */ }
    throw err;
  }
});
