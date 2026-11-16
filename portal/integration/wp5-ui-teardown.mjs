// WP5 UI 验收环境拆除（与 wp5-ui-setup.mjs 配对）：删 FDE 容器/网络、down -v、删临时目录与 DB 目录。
// issue #178：**不删镜像 tag**——共享 tag（erix-station/fde:local / portal:local / mock-llm:local）
// 归共享栈所有，e2e 删它会把共享栈打坏（实测 provision 报 No such image）。
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// issue #495 ①（#412 遗留）：compose 的 `--env-file` 与「等宿主侧物化文件」的失败分类（唯一定义处 lib/e2e-preflight.mjs）。
import { COMPOSE_ENV_FILE, assertComposeEnvFile } from './lib/e2e-preflight.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// #227.2：显式 -p 把「我就是要动共享栈 station」写进命令（不再靠 compose 文件 name: 的隐式兜底；
// 设了 COMPOSE_PROJECT_NAME 则显式改用该 project）。
const COMPOSE = 'docker compose -p "${COMPOSE_PROJECT_NAME:-station}" --env-file deploy/.env -f deploy/docker-compose.yml';
// issue #495 ①：上面命令串固定带 --env-file deploy/.env，而它不入 git ⇒ git worktree / 新 clone 里
// 必然缺。docker compose 要到**整轮镜像构建之后**才报 couldn't find env file（#412 部署机实测白烧 10.7 分钟），
// 所以这条预检放在模块加载时——它先于本文件任何一次 docker/compose；文件在场时零输出。
assertComposeEnvFile({ envFile: COMPOSE_ENV_FILE, cwd: REPO_ROOT, label: 'wp5-ui-teardown' });
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
