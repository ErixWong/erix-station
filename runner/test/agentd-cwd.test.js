// P5 去项目化（directory-as-project §2/§6）：agentd run.cwd 解析 + 旧 portal 回退 + capacity 默认 2。
// 隔离约定：agentd 经 direct-run 守卫被 import（不启动主循环）；tmp 家目录注入。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// #890 跨侧钉子：portal 侧的归一器（纯函数）——拿它与 runner 的 resolveRunCwd 对拍同一项目。
import { validateRunCwd } from '../../portal/src/sessions.js';

process.env.ERIX_STATION_TOKEN = 'test-token';
process.env.FDE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-agentd-cwd-'));
const agentd = await import('../agentd.js');
const { resolveRunCwd } = agentd;

test.after(() => {
  fs.rmSync(process.env.FDE_HOME, { recursive: true, force: true });
});

test('resolveRunCwd：run.cwd（~/projects/<name>）为权威 → 直达项目目录并确保存在', () => {
  const cwd = resolveRunCwd({ id: 'r1', cwd: '~/projects/demo_app' });
  assert.equal(cwd, path.join(process.env.FDE_HOME, 'projects', 'demo_app'));
  assert.ok(fs.existsSync(cwd), '目录不存在时 mkdir 兜底（新建目录语义）');
});

test('resolveRunCwd：形态防线——绝对路径 / .. / 多级 / 非 ~/projects 前缀一律回退 project name', () => {
  for (const bad of ['/etc', '~/projects/../home', '~/projects/a/b', '~/other/x', '~/.ssh', '']) {
    const cwd = resolveRunCwd({ id: 'r1', cwd: bad, project: { name: 'proj1' } });
    assert.equal(cwd, path.join(process.env.FDE_HOME, 'projects', 'proj1'), `cwd=${JSON.stringify(bad)} 回退`);
  }
});

test('resolveRunCwd：cwd 缺失（旧 portal 部署序错位）→ 回退 run.project.name 并 warn', () => {
  const cwd = resolveRunCwd({ id: 'r1', project: { name: 'legacy-proj' } });
  assert.equal(cwd, path.join(process.env.FDE_HOME, 'projects', 'legacy-proj'));
  assert.ok(fs.existsSync(cwd));
});

test('resolveRunCwd：cwd 与 project 皆缺失 → 回退 default 目录', () => {
  const cwd = resolveRunCwd({ id: 'r1' });
  assert.equal(cwd, path.join(process.env.FDE_HOME, 'projects', 'default'));
});

test('P5：capacity 默认 1 → 2（同项目并行放行，pi 对齐；env 可调）', () => {
  // 本测试进程未设 ERIX_AGENTD_CAPACITY → 模块加载快照应取新默认 2。
  assert.equal(agentd.testConfig.capacity, 2);
});

// —— #890 跨侧一致性钉子：portal validateRunCwd 的归一输出 ⇒ runner resolveRunCwd 落到同一项目 ——
// 为什么这样接得住缺陷（不是「自己造 message 再比同一 message」那种恒真）：
//   • portal 侧从宿主绝对路径 `<userSpaceRoot>/<fde>/projects/<name>` 认定的项目 = <name>（唯一真相）；
//   • 把 portal 归一的输出喂进 runner 的 resolveRunCwd ⇒ 解出的目录 basename 必须 == <name>；
//   • 并故意给 project.name 塞一个不同的哨兵：若 validateRunCwd 没把绝对折叠成 tilde（变异 ②），
//     resolveRunCwd 会对绝对形态走那条 warn 回退分支 ⇒ 落到哨兵 WRONG_SENTINEL ≠ <name> ⇒ 当场红。
//   两侧各自跑真实的纯函数、比对的是独立从宿主路径推出的项目身份，不是同一条 message，故非恒真。
test('#890 跨侧一致性：portal 归一的 cwd ⇒ runner resolveRunCwd 解析出同一项目目录', () => {
  const USR = '/srv/erix/users';
  const FDE = 'erix';
  const name = 'demo_app';
  const hostAbs = path.join(USR, FDE, 'projects', name);
  // portal 侧：绝对 → 归一必须是 tilde（这就是跨侧唯一的可传输契约形态）。
  const normalized = validateRunCwd(hostAbs, { userSpaceRoot: USR, fdeName: FDE });
  assert.equal(normalized, `~/projects/${name}`, 'portal 必须把绝对 projects/<name> 折叠成 tilde');
  // runner 侧：喂进 resolveRunCwd ⇒ 解析目录 basename 必须 == portal 认定的 <name>（project.name 给不同哨兵）。
  const resolved = resolveRunCwd({ id: 'r-cross', cwd: normalized, project: { name: 'WRONG_SENTINEL' } });
  assert.equal(path.basename(resolved), name, `runner 解析目录必须 == 项目 ${name}，实得：${resolved}`);
  assert.equal(resolved, path.join(process.env.FDE_HOME, 'projects', name));
  // 反向自证（缺陷形态）：直接喂未归一的宿主绝对 ⇒ runner 静默回退到哨兵，basename 绝不是 name。
  const leaked = resolveRunCwd({ id: 'r-leak', cwd: hostAbs, project: { name: 'WRONG_SENTINEL' } });
  assert.equal(path.basename(leaked), 'WRONG_SENTINEL', '绝对形态下发 runner ⇒ 静默回退（正是 #890 缺陷）');
  assert.notEqual(path.basename(leaked), name);
});

test('buildWorkerEnv：git identity 覆盖继承值，旧 portal 未下发时保持原值', () => {
  const inherited = {
    GIT_AUTHOR_NAME: 'inherited author',
    GIT_AUTHOR_EMAIL: 'author@inherited.test',
    GIT_COMMITTER_NAME: 'inherited committer',
    GIT_COMMITTER_EMAIL: 'committer@inherited.test',
    ERIX_STATION_TOKEN: 'must-not-reach-worker',
  };
  const withIdentity = agentd.buildWorkerEnv({
    git_identity: { name: 'FDE Name', email: 'fde@example.test' },
  }, inherited);
  assert.equal(withIdentity.GIT_AUTHOR_NAME, 'FDE Name');
  assert.equal(withIdentity.GIT_AUTHOR_EMAIL, 'fde@example.test');
  assert.equal(withIdentity.GIT_COMMITTER_NAME, 'FDE Name');
  assert.equal(withIdentity.GIT_COMMITTER_EMAIL, 'fde@example.test');
  assert.equal(Object.hasOwn(withIdentity, 'ERIX_STATION_TOKEN'), false);

  const legacy = agentd.buildWorkerEnv({}, inherited);
  assert.equal(legacy.GIT_AUTHOR_NAME, inherited.GIT_AUTHOR_NAME);
  assert.equal(legacy.GIT_AUTHOR_EMAIL, inherited.GIT_AUTHOR_EMAIL);
  assert.equal(legacy.GIT_COMMITTER_NAME, inherited.GIT_COMMITTER_NAME);
  assert.equal(legacy.GIT_COMMITTER_EMAIL, inherited.GIT_COMMITTER_EMAIL);
});
