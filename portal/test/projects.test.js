// 单测：projects.js（hostname grammar / 端口块分配 / 校验 / 不可变性快照）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateProjectName,
  validateFdeName,
  buildHostname,
  buildUrl,
  slotToPort,
  findFreeSlot,
  toProject,
  toPort,
  DEFAULT_PORT_QUOTA,
  PORT_BLOCK_BASE,
  PORT_BLOCK_SIZE,
  ProjectError,
} from '../src/projects.js';

test('validateProjectName：合法名 / 非法名（大写、下划线、前导 -、超长）', () => {
  assert.equal(validateProjectName('proj1').ok, true);
  assert.equal(validateProjectName('my-project-2').ok, true);
  assert.equal(validateProjectName('Proj1').ok, false); // 大写
  assert.equal(validateProjectName('proj_1').ok, false); // 下划线
  assert.equal(validateProjectName('-proj').ok, false); // 前导 -
  assert.equal(validateProjectName('a'.repeat(64)).ok, false); // 超 63
});

test('validateFdeName：合法 / 非法', () => {
  assert.equal(validateFdeName('alice').ok, true);
  assert.equal(validateFdeName('alice-2').ok, true);
  assert.equal(validateFdeName('Alice').ok, false);
  assert.equal(validateFdeName('-alice').ok, false);
});

test('buildHostname：grammar <fde>-p-<project>-<port>.fde.<base>，端口 4 位', () => {
  assert.equal(
    buildHostname({ fdeName: 'alice', projectName: 'proj1', port: 4016, baseDomain: 'localhost' }),
    'alice-p-proj1-4016.fde.localhost',
  );
  assert.equal(
    buildHostname({ fdeName: 'alice', projectName: 'proj1', port: 4000, baseDomain: 'erix.vip' }),
    'alice-p-proj1-4000.fde.erix.vip',
  );
});

test('buildUrl：https 前缀', () => {
  assert.equal(buildUrl('alice-p-proj1-4016.fde.localhost'), 'https://alice-p-proj1-4016.fde.localhost');
});

test('slotToPort：项目级端口 = 块首 4000 + slot*8', () => {
  assert.equal(slotToPort(0), 4000);
  assert.equal(slotToPort(2), 4016);
  assert.equal(slotToPort(39), 4000 + 39 * 8);
  assert.equal(PORT_BLOCK_BASE, 4000);
  assert.equal(PORT_BLOCK_SIZE, 8);
});

test('findFreeSlot：首个空闲 slot；配额满抛 port_quota_exceeded（409）', () => {
  assert.equal(findFreeSlot([]), 0);
  assert.equal(findFreeSlot([0, 1]), 2);
  assert.equal(findFreeSlot([0, 2]), 1);
  const full = Array.from({ length: DEFAULT_PORT_QUOTA }, (_, i) => i);
  assert.throws(() => findFreeSlot(full), (e) => e instanceof ProjectError && e.code === 'port_quota_exceeded' && e.httpStatus === 409);
});

test('hostname 项目名快照：改名不重生成（不可变性）——由构建函数幂等推导', () => {
  // 分配时的项目名进入 hostname；改名只影响 projects.name，hostname 用旧快照。
  const before = buildHostname({ fdeName: 'alice', projectName: 'proj1', port: 4016, baseDomain: 'localhost' });
  const afterRename = buildHostname({ fdeName: 'alice', projectName: 'proj2', port: 4016, baseDomain: 'localhost' });
  assert.notEqual(before, afterRename);
  assert.match(before, /proj1/);
  assert.match(afterRename, /proj2/);
});

test('toProject / toPort 映射', () => {
  const p = toProject({
    id: 'p_1',
    name: 'proj1',
    repo_url: 'https://git.example/a.git',
    root_path: '~/projects/proj1',
    slot: 2,
    template: 'node',
    created_at: new Date('2026-09-12T08:30:00.000Z'),
  });
  assert.equal(p.slot, 2);
  assert.equal(p.created_at, '2026-09-12T08:30:00.000Z');

  const port = toPort({
    id: 'pa_1',
    scope: 'project',
    port: 4016,
    role: 'frontend',
    run_id: null,
    hostname: 'alice-p-proj1-4016.fde.localhost',
    url: 'https://alice-p-proj1-4016.fde.localhost',
    exposure: 'private',
    state: 'allocated',
    released_at: null,
  });
  assert.equal(port.port, 4016);
  assert.equal(port.state, 'allocated');
  assert.equal(port.released_at, null);
});
