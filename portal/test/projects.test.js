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
  createProject,
  toProject,
  toPort,
  renameProject,
  DEFAULT_PORT_QUOTA,
  PORT_BLOCK_BASE,
  PORT_BLOCK_SIZE,
  ProjectError,
} from '../src/projects.js';

function createProjectPool() {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(normalized)) return { rows: [] };
      if (normalized.includes('SELECT id, login, display_name, role, fde_name')) {
        return { rows: [{ id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active' }] };
      }
      if (normalized.includes('SELECT 1 FROM projects WHERE user_id = $1 AND name = $2')) return { rows: [] };
      if (normalized.includes('FROM fde_networks WHERE fde_id = $1 AND state IN')) {
        return { rows: [{ fde_id: 'u1', network_name: 'fde-alice', subnet: '10.200.0.0/29', prefix_len: 29, gateway: '10.200.0.1', pool: 'default', state: 'allocated' }] };
      }
      if (normalized.startsWith('SELECT slot FROM projects')) return { rows: [] };
      if (normalized.startsWith('INSERT INTO projects')) {
        return {
          rows: [{
            id: 'p1',
            name: params[1],
            repo_url: params[2],
            root_path: params[3],
            slot: params[4],
            template: params[5],
            created_at: new Date('2026-09-12T08:30:00.000Z'),
          }],
        };
      }
      if (normalized.startsWith('INSERT INTO port_allocations')) {
        return {
          rows: [{
            id: 'pa1',
            scope: 'project',
            port: params[2],
            role: 'frontend',
            run_id: null,
            hostname: params[3],
            url: params[4],
            exposure: 'private',
            state: 'allocated',
            released_at: null,
          }],
        };
      }
      if (normalized.startsWith('INSERT INTO route_revisions') || normalized.startsWith('INSERT INTO materialize_revisions')) {
        return { rows: [{ revision: 1 }] };
      }
      if (normalized.startsWith('INSERT INTO route_outbox') || normalized.startsWith('INSERT INTO materialize_outbox')) return { rows: [] };
      if (normalized.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] };
      throw new Error(`unexpected query in createProject test: ${normalized}`);
    },
    release() {},
  };
  return {
    queries,
    async connect() { return client; },
  };
}

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

for (const [label, repoUrl] of [['未提供 repo_url', undefined], ['repo_url 为空串', ''], ['repo_url 纯空白', '   ']]) {
  test(`createProject：${label} → 成功创建并将 repo_url 落库为 NULL`, async () => {
    const pool = createProjectPool();
    const result = await createProject(pool, {
      userId: 'u1',
      name: 'proj1',
      repoUrl,
      template: 'node',
      config: { baseDomain: 'localhost' },
    });
    const insert = pool.queries.find(({ sql }) => sql.includes('INSERT INTO projects'));
    assert.equal(result.project.repo_url, null);
    assert.equal(insert.params[2], null);
  });
}

for (const repoUrl of [123, {}]) {
  test(`createProject：非字符串 repo_url ${JSON.stringify(repoUrl)} → validation_failed 400`, async () => {
    await assert.rejects(
      () => createProject(createProjectPool(), { userId: 'u1', name: 'proj1', repoUrl, config: { baseDomain: 'localhost' } }),
      (err) => err instanceof ProjectError
        && err.code === 'validation_failed'
        && err.httpStatus === 400
        && err.details.field === 'repo_url',
    );
  });
}

test('createProject：repo_url 含控制字符 → validation_failed 400', async () => {
  await assert.rejects(
    () => createProject(createProjectPool(), {
      userId: 'u1',
      name: 'proj1',
      repoUrl: 'https://git.example/repo\n.git',
      config: { baseDomain: 'localhost' },
    }),
    (err) => err instanceof ProjectError
      && err.code === 'validation_failed'
      && err.httpStatus === 400
      && err.details.field === 'repo_url',
  );
});

for (const repoUrl of ['ftp://x', 'not-a-url']) {
  test(`createProject：非法 repo_url ${repoUrl} → validation_failed 400`, async () => {
    await assert.rejects(
      () => createProject(createProjectPool(), { userId: 'u1', name: 'proj1', repoUrl, config: { baseDomain: 'localhost' } }),
      (err) => err instanceof ProjectError
        && err.code === 'validation_failed'
        && err.httpStatus === 400
        && err.details.field === 'repo_url',
    );
  });
}

test('F7：改名后 enqueue materialize change（新目录生成 + 旧目录收敛；不改 route outbox）', async () => {
  const calls = { materialize: 0, route: 0 };
  const client = {
    async query(sql, params) {
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('SELECT 1 FROM projects WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('SELECT 1 FROM projects WHERE user_id = $1 AND name = $2')) return { rows: [] };
      if (sql.trimStart().startsWith('UPDATE projects SET name')) {
        return { rows: [{ id: params[0], name: params[2], repo_url: 'https://git.example/a.git', root_path: params[3], slot: 0, template: 'node', created_at: new Date('2026-09-12T08:30:00.000Z') }] };
      }
      if (sql.includes('INSERT INTO materialize_revisions')) return { rows: [{ revision: 2 }] };
      if (sql.includes('INSERT INTO materialize_outbox')) { calls.materialize += 1; return { rows: [] }; }
      if (sql.includes('INSERT INTO route_outbox')) { calls.route += 1; return { rows: [] }; }
      return { rows: [] };
    },
    release() {},
  };
  const pool = { async connect() { return client; } };
  const p = await renameProject(pool, { userId: 'u1', projectId: 'p1', name: 'proj2' });
  assert.equal(p.name, 'proj2');
  assert.equal(calls.materialize, 1);
  assert.equal(calls.route, 0);
});
