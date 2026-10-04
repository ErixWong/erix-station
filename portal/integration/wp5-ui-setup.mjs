// WP5 UI 验收环境准备：起栈（留活）+ 种子用户 alice（口令+TOTP）+ 建项目 + provision FDE。
// 用法：node portal/integration/wp5-ui-setup.mjs   （验收后 node .../wp5-ui-teardown.mjs）
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
const STATE_FILE = '/tmp/hb/wp5-ui-state.json';

function docker(args) {
  return execSync(`sg docker -c ${JSON.stringify(`docker ${args}`)}`, { encoding: 'utf8', stdio: 'pipe', cwd: REPO_ROOT });
}
function compose(args, env = {}) {
  return execSync(`sg docker -c ${JSON.stringify(`${COMPOSE} ${args}`)}`, { encoding: 'utf8', stdio: 'pipe', cwd: REPO_ROOT, env: { ...process.env, ...env } });
}
function safe(fn) { try { return fn(); } catch { return null; } }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function psqlStdin(sql) {
  execSync(`sg docker -c ${JSON.stringify('docker exec -i station-db psql -U station -d station -v ON_ERROR_STOP=1')}`, { encoding: 'utf8', input: sql, stdio: ['pipe', 'pipe', 'pipe'], cwd: REPO_ROOT });
}
function waitFor(fn, { label, timeoutMs, intervalMs = 500 }) {
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

const userspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-users-wp5ui-'));
const dynamicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-dynamic-wp5ui-'));
fs.chmodSync(userspaceRoot, 0o755);
fs.chmodSync(dynamicRoot, 0o755);

const password = 'correct horse battery staple';
const totpSecret = totp.generateSecret(20);
const userId = '00000000-0000-4000-8000-0000000000a1';

safe(() => compose('down -v', { ERIX_USERSPACE_ROOT_HOST: userspaceRoot, TRAEFIK_DYNAMIC_DIR_HOST: dynamicRoot }));
safe(() => execSync(`sg docker -c ${JSON.stringify(`docker run --rm -v /docker:/host alpine rm -rf /host/station-db`)}`));
safe(() => docker(`rmi -f ${FDE_IMAGE} 2>/dev/null || true`));
docker(`build -t ${FDE_IMAGE} runner/`);
compose('up -d --build', {
  ERIX_USERSPACE_ROOT_HOST: userspaceRoot, TRAEFIK_DYNAMIC_DIR_HOST: dynamicRoot,
  FDE_IMAGE, FDE_CMD: '[]', FDE_DEV_USER: '', FDE_DEV_MODE: '1', FDE_AGENT_VERSION: '0.1.0',
});
await waitFor(async () => {
  const r = await fetch(`${PORTAL}/healthz`).catch(() => null);
  return r && r.status === 200;
}, { label: 'portal healthz', timeoutMs: 240000, intervalMs: 1000 });

const passwordHash = await auth.hashPassword(password);
psqlStdin(`
  INSERT INTO users (id, login, display_name, role, fde_name, auth_source, status, password_hash, totp_secret)
  VALUES ('${userId}', 'alice', 'Alice', 'fde', 'alice', 'local', 'active', '${passwordHash}', '${totpSecret}');
`);

const step1 = await fetch(`${PORTAL}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ login: 'alice', password }),
});
assertOk(step1.status === 200, 'login step1');
const { pending_token } = await step1.json();
const step2 = await fetch(`${PORTAL}/api/auth/login/totp`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ pending_token, code: totp.totp(totpSecret) }),
});
assertOk(step2.status === 200, 'login step2');

docker('exec station-portal node portal/src/cli.js provision-fde --fde-name alice');
await waitFor(() => (execSync(`sg docker -c ${JSON.stringify("docker exec station-db psql -U station -d station -tAc \"SELECT status FROM containers WHERE fde_name='alice'\"")}`).trim() === 'running' ? true : null),
  { label: 'fde-alice running', timeoutMs: 60000 });
await waitFor(() => (docker('logs fde-alice 2>&1').includes('sse ping received') ? true : null),
  { label: 'agentd sse ping', timeoutMs: 90000, intervalMs: 1000 });

fs.mkdirSync('/tmp/hb', { recursive: true });
fs.writeFileSync(STATE_FILE, JSON.stringify({
  userspaceRoot, dynamicRoot, password, totpSecret, userId, login: 'aliceAlice',
  nowCode: totp.totp(totpSecret), issuedAt: new Date().toISOString(),
}, null, 2));
console.log(`[wp5-ui] 栈已就绪（留活）。
  portal: ${PORTAL}
  登录名: alice
  口令:   ${password}
  TOTP 码（当前窗口）: ${totp.totp(totpSecret)}（随时可重算：node -e "import('./portal/src/totp.js').then(m=>console.log(m.totp('${totpSecret}')))"）
  状态文件: ${STATE_FILE}
验收完成后跑 teardown。`);

function assertOk(cond, msg) { if (!cond) { console.error(`[wp5-ui] FAIL: ${msg}`); process.exit(1); } }
