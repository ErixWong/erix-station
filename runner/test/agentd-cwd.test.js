// P5 去项目化（directory-as-project §2/§6）：agentd run.cwd 解析 + 旧 portal 回退 + capacity 默认 2。
// 隔离约定：agentd 经 direct-run 守卫被 import（不启动主循环）；tmp 家目录注入。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ERIX_STATION_TOKEN = 'test-token';
process.env.FDE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-agentd-cwd-'));
const agentd = await import('../agentd.js');
const { resolveRunCwd } = agentd;

test.after(() => {
  fs.rmSync(process.env.FDE_HOME, { recursive: true, force: true });
});

test('resolveRunCwd：run.cwd（~/projects/<name>）为权威 → 直达项目目录并确保存在', () => {
  const cwd = resolveRunCwd({ id: 'r1', cwd: '~/projects/meeting_asr_app' });
  assert.equal(cwd, path.join(process.env.FDE_HOME, 'projects', 'meeting_asr_app'));
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
