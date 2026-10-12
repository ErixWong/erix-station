// WP5 UI 验收环境拆除（与 wp5-ui-setup.mjs 配对）：删 FDE 容器/网络、down -v、删临时目录与 DB 目录。
// issue #178：**不删镜像 tag**——共享 tag（erix-station/fde:local / portal:local / mock-llm:local）
// 归共享栈所有，e2e 删它会把共享栈打坏（实测 provision 报 No such image）。
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// #227.2：显式 -p 把「我就是要动共享栈 station」写进命令（不再靠 compose 文件 name: 的隐式兜底；
// 设了 COMPOSE_PROJECT_NAME 则显式改用该 project）。
const COMPOSE = 'docker compose -p "${COMPOSE_PROJECT_NAME:-station}" --env-file deploy/.env -f deploy/docker-compose.yml';
const STATE_FILE = '/tmp/hb/wp5-ui-state.json';

function docker(args) {
  return execSync(`sg docker -c ${JSON.stringify(`docker ${args}`)}`, { encoding: 'utf8', stdio: 'pipe', cwd: REPO_ROOT });
}
function safe(fn) { try { return fn(); } catch (e) { return null; } }

let state = {};
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* 无状态文件则尽力清理 */ }

const userspaceRoot = state.userspaceRoot ?? (fs.readdirSync('/tmp').find((d) => d.startsWith('erix-users-wp5ui-')));
const dynamicRoot = state.dynamicRoot ?? (fs.readdirSync('/tmp').find((d) => d.startsWith('erix-dynamic-wp5ui-')));

safe(() => docker('rm -f fde-alice'));
safe(() => docker('network rm fde-alice'));
safe(() => execSync(
  `sg docker -c ${JSON.stringify(`${COMPOSE} down -v`)}`,
  { encoding: 'utf8', stdio: 'pipe', cwd: REPO_ROOT, env: { ...process.env, ERIX_USERSPACE_ROOT_HOST: userspaceRoot ?? '/tmp/x', TRAEFIK_DYNAMIC_DIR_HOST: dynamicRoot ?? '/tmp/x' } },
));
// issue #178：不删镜像 tag（共享 tag 归共享栈所有，见文件头）。
safe(() => execSync(`sg docker -c ${JSON.stringify('docker run --rm -v /docker:/host alpine rm -rf /host/station-db')}`));
if (userspaceRoot) safe(() => fs.rmSync(path.join('/tmp', userspaceRoot), { recursive: true, force: true }));
if (dynamicRoot) safe(() => fs.rmSync(path.join('/tmp', dynamicRoot), { recursive: true, force: true }));
safe(() => fs.rmSync(STATE_FILE, { force: true }));
console.log('[wp5-ui] teardown 完成');
