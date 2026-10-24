// 镜像级依赖缓存落位判据（eric 空间实测 2026-10-24）。
//
// 病根：FDE 镜像不给 npm 家族指默认缓存位置 ⇒ pnpm 在「默认 store 与项目不同卷 / 不可用」时，
// 自己在项目所在卷上找地方建 `.pnpm-store`；`~/projects` 正是 projects bind mount 的根 ⇒
// 真机长出 `~/projects/.pnpm-store`（388 MB），把目录下拉第一项顶掉（真实项目被工具缓存淹没）。
// 展示层已过滤点开头目录（dirs.js），但那只是遮掉症状；位置本身必须由镜像钉死，否则同类目录
// 会换个工具（corepack / pip）再长一次。
//
// 判据形状（照 deploy-env-defaults.test.js / userspace-dir-mode-doc.test.js 先例：读文件文本，不跑部署）：
//   1. runner/Dockerfile 必须写 npm 的 globalconfig（`/usr/local/etc/npmrc`），且 cache/store
//      都落在 `~/cache`（= user-space.md §4.2 已划定的依赖缓存区，独立 bind mount、不进目录列表）；
//   2. 该层必须在 `npm install --omit=dev` **之后**——否则构建期缓存也落 `~/cache/npm`，
//      运行时被宿主 bind mount 盖住，镜像白占一层且不可回收；
//   3. `~/AGENTS.md` 模板（materializer 的唯一告知面）必须告知「默认已指到 ~/cache、别改到 ~/projects」，
//      否则 agent 会以为要自己配 store，或反向把它挪回去。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DOCKERFILE = path.join(REPO, 'runner', 'Dockerfile');
const MATERIALIZER = path.join(REPO, 'portal', 'src', 'materializer.js');

test('runner 镜像必须把 npm/pnpm 缓存默认落在 ~/cache（globalconfig 层）', () => {
  const text = fs.readFileSync(DOCKERFILE, 'utf8');
  assert.match(text, /\/usr\/local\/etc\/npmrc/, '必须写 npm globalconfig（镜像内 npm config get globalconfig 实测路径）');
  assert.match(text, /cache=\/home\/erix\/cache\/npm/, 'npm cache 必须指向 ~/cache/npm');
  assert.match(text, /store-dir=\/home\/erix\/cache\/pnpm-store/, 'pnpm store 必须指向 ~/cache/pnpm-store');
  assert.doesNotMatch(text, /store-dir=\/home\/erix\/projects/, '缓存不许落在 ~/projects（那正是本项目要修的症状）');
});

test('globalconfig 层必须排在镜像自身 npm install 之后（防构建期缓存被 bind mount 盖进镜像）', () => {
  const text = fs.readFileSync(DOCKERFILE, 'utf8');
  const installAt = text.indexOf('npm install --omit=dev');
  const npmrcAt = text.indexOf('/usr/local/etc/npmrc');
  assert.ok(installAt >= 0 && npmrcAt >= 0, '两处锚点都必须存在（改动 Dockerfile 层序时同步本判据）');
  assert.ok(npmrcAt > installAt, '/usr/local/etc/npmrc 必须写在 npm install --omit=dev 之后');
});

test('~/AGENTS.md 模板必须告知依赖缓存已默认指到 ~/cache、不许挪进 ~/projects', () => {
  const text = fs.readFileSync(MATERIALIZER, 'utf8');
  const line = text.split('\n').find((l) => l.includes('node_modules') && l.includes('每项目一份'));
  assert.ok(line, 'AGENTS.md 模板里必须保留 node_modules 那条约定');
  assert.match(line, /~\/cache/, '必须写明缓存落 ~/cache');
  assert.match(line, /~\/projects/, '必须点明不许把 store/cache 挪进 ~/projects');
});
