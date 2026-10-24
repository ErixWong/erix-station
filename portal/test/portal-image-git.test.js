// portal 镜像必须有 git —— issue #359「收工灯」的硬前置（决策 D9 的落地条件之一）。
//
// 为什么值得单独钉一条：`GET /api/git-light`（`portal/src/gitlight.js`）判「未提交 + 未跟踪」要跑
// 一条 `git status --porcelain -uall`。镜像里没 git 时**代码不会崩**，只会把每个仓库都报成
// `grey / git_unavailable` —— 一颗恒灰的灯比没有灯更糟（绿是承诺、灰是无信息，用户会直接当"它坏了"
// 而不再看）。更要紧的是**这个失效在 CI 里看不见**：根单测跑在 CI runner 自己的 git 上，
// 镜像里没 git 也照样全绿 ⇒ 只能靠镜像级锁钉（判据形状照 `runner-image-cache-dir.test.js` /
// `deploy-env-defaults.test.js` 先例：读文件文本，不跑部署、不 build 镜像）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DOCKERFILE = path.join(REPO, 'portal', 'Dockerfile');
const GITLIGHT = path.join(REPO, 'portal', 'src', 'gitlight.js');

/** 按 stage 切段（`FROM ... AS name` / 裸 `FROM`），返回 [{ header, body, index }]。 */
function stages(text) {
  const parts = text.split(/^FROM\s/m).slice(1);
  const headers = text.split('\n').filter((l) => /^FROM\s/.test(l));
  return parts.map((body, i) => ({ header: headers[i], body }));
}

test('portal 运行镜像必须装 git（收工灯的未提交/未跟踪两路要用）', () => {
  const text = fs.readFileSync(DOCKERFILE, 'utf8');
  const runtime = stages(text).find((s) => /portal\/src\/cli\.js/.test(s.body));
  assert.ok(runtime, '找不到运行阶段（CMD 里那句 portal/src/cli.js 是定位锚，改它请同步本判据）');
  assert.match(runtime.body, /apt-get install[^\n]*--no-install-recommends/, 'apt 必须带 --no-install-recommends（控制体积，同 runner/Dockerfile）');
  assert.match(runtime.body, /apt-get install[\s\S]{0,400}\bgit\b/, '运行阶段必须装 git');
  assert.match(runtime.body, /rm -rf \/var\/lib\/apt\/lists\/\*/, 'apt 列表必须**同层**清理（异层清理等于没清，评审 F6 先例）');
});

test('git 层必须排在 npm ci 之前（重且稳定的层在前，改代码不触发重装）', () => {
  const text = fs.readFileSync(DOCKERFILE, 'utf8');
  const aptAt = text.search(/apt-get install[^\n]*--no-install-recommends/);
  const ciAt = text.indexOf('npm ci --omit=dev');
  assert.ok(aptAt >= 0 && ciAt >= 0, '两处锚点都必须存在（改层序时同步本判据）');
  assert.ok(aptAt < ciAt, 'apt 层必须排在 `npm ci --omit=dev` 之前（照 runner/Dockerfile 的层序纪律）');
});

test('git 只装在运行阶段，不许顺手装进前端 builder（builder 里有 vite/tailwind，不需要 git）', () => {
  const text = fs.readFileSync(DOCKERFILE, 'utf8');
  const builder = stages(text).find((s) => /frontend-builder/.test(s.header));
  assert.ok(builder, '前端 builder 阶段必须还在');
  assert.doesNotMatch(builder.body, /apt-get/, 'builder 阶段不该装 apt 包（它只需要 npm 依赖做 vite 构建）');
});

test('镜像缺 git 时灯必须落 ⚪ git_unavailable，而不是崩或猜绿（代码侧的另一半锁）', () => {
  // 镜像装了 git 是"能不能判"，这条钉的是"判不了时怎么表现"：两者是一套，缺任一半都会得到恒灰灯。
  const src = fs.readFileSync(GITLIGHT, 'utf8');
  assert.match(src, /git_unavailable/, '缺 git 必须是显式态（reason=git_unavailable）');
  assert.match(src, /light:\s*'grey'/, '缺 git 必须落灰（⚪ 不得渲染成绿）');
});
