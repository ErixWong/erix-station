// 单测：projects.js（P5 退役留档版）——hostname 新语法 / 校验 / 只读映射。
// P5 去项目化：createProject / renameProject / deleteProject 写路径已整体删除
//（projects 表留档只读；目录即项目，见 docs/design/directory-as-project.md）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateProjectName,
  validateFdeName,
  buildHostname,
  buildUrl,
  toProject,
  toPort,
  listProjects,
  getProject,
  ProjectError,
} from '../src/projects.js';

test('validateProjectName：合法名 / 非法名（大写、下划线、前导 -、超长）', () => {
  assert.equal(validateProjectName('a').ok, true);
  assert.equal(validateProjectName('proj1').ok, true);
  assert.equal(validateProjectName('my-project-2').ok, true);
  assert.equal(validateProjectName('a'.repeat(63)).ok, true);
  assert.equal(validateProjectName('Proj1').ok, false); // 大写
  assert.equal(validateProjectName('proj_1').ok, false); // 下划线
  assert.equal(validateProjectName('-proj').ok, false); // 前导 -
  assert.equal(validateProjectName('abc-').ok, false); // 尾随 -
  assert.equal(validateProjectName('a'.repeat(64)).ok, false); // 超 63
});

test('validateFdeName：合法 / 非法', () => {
  assert.equal(validateFdeName('a').ok, true);
  assert.equal(validateFdeName('alice').ok, true);
  assert.equal(validateFdeName('alice-2').ok, true);
  assert.equal(validateFdeName('a'.repeat(63)).ok, true);
  assert.equal(validateFdeName('Alice').ok, false);
  assert.equal(validateFdeName('abc-').ok, false);
  assert.equal(validateFdeName('a'.repeat(64)).ok, false);
  assert.equal(validateFdeName('-alice').ok, false);
});

test('buildHostname：P5 新语法 <fde>-p-<port4>.fde.<base>（URL 去项目名段）', () => {
  assert.equal(
    buildHostname({ fdeName: 'alice', port: 4016, baseDomain: 'localhost' }),
    'alice-p-4016.fde.localhost',
  );
  assert.equal(
    buildHostname({ fdeName: 'alice', port: 4000, baseDomain: 'erix.vip' }),
    'alice-p-4000.fde.erix.vip',
  );
  // 端口恒 4 位（4000..4999 区间天然 4 位；语法层仍 pad 保底）。
  assert.equal(
    buildHostname({ fdeName: 'eric', port: 4000, baseDomain: 'localhost' }),
    'eric-p-4000.fde.localhost',
  );
});

test('buildHostname：不含项目名段——目录名含 - / 下划线也不需要合法化清洗', () => {
  const h = buildHostname({ fdeName: 'alice', port: 4016, baseDomain: 'localhost' });
  assert.doesNotMatch(h, /proj/);
  // 旧语法对照（迁移 0008 把存量 hostname 重写为该形态）。
  assert.notEqual(h, 'alice-p-proj1-4016.fde.localhost');
});

test('buildUrl：https 前缀', () => {
  assert.equal(buildUrl('alice-p-4016.fde.localhost'), 'https://alice-p-4016.fde.localhost');
});

test('toProject / toPort 映射（留档只读形状不变）', () => {
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
    hostname: 'alice-p-4016.fde.localhost',
    url: 'https://alice-p-4016.fde.localhost',
    exposure: 'private',
    state: 'allocated',
    released_at: null,
  });
  assert.equal(port.port, 4016);
  assert.equal(port.state, 'allocated');
  assert.equal(port.released_at, null);
});

test('listProjects：只读列表（cursor 分页）', async () => {
  const queries = [];
  const pool = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      return {
        rows: [{
          id: 'p1', name: 'proj1', repo_url: null, root_path: '~/projects/proj1',
          slot: 0, template: 'default', created_at: new Date('2026-09-12T08:30:00.000Z'),
        }],
      };
    },
  };
  const r = await listProjects(pool, { userId: 'u1' });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].name, 'proj1');
  assert.equal(r.next_cursor, null, '不足 limit 无 cursor');
  assert.ok(queries[0].sql.includes('deleted_at IS NULL'));
});

test('getProject：只读详情；P5 端口维度已退役（port_allocations.project_id DROP）→ ports 恒空', async () => {
  const queries = [];
  const pool = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('FROM projects')) {
        return {
          rows: [{
            id: params[0], name: 'proj1', repo_url: null, root_path: '~/projects/proj1',
            slot: 0, template: 'default', created_at: new Date('2026-09-12T08:30:00.000Z'),
          }],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const r = await getProject(pool, { userId: 'u1', projectId: 'p1' });
  assert.equal(r.project.name, 'proj1');
  assert.deepEqual(r.ports, []);
  // 不再查询 port_allocations（project_id 列已退役）。
  assert.ok(queries.every((q) => !q.sql.includes('port_allocations')));
});

test('getProject：不存在 → 404 not_found', async () => {
  const pool = { async query() { return { rows: [] }; } };
  await assert.rejects(
    () => getProject(pool, { userId: 'u1', projectId: 'nope' }),
    (e) => e instanceof ProjectError && e.code === 'not_found' && e.httpStatus === 404,
  );
});
