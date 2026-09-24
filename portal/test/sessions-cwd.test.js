// 单测：P5 createSession——project_id 即目录名（cwd 绑定），服务端校验 + 「不存在则 mkdir」语义。
// 隔离约定：tmp userSpaceRoot 注入；内存 fake pool，不碰真实 DB / bind mount。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSession, validateSessionCwd, SessionError } from '../src/sessions.js';

function tmpRoot() {
  const userSpaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-sessions-'));
  return { userSpaceRoot, projectsRoot: path.join(userSpaceRoot, 'alice', 'home', 'projects') };
}

function poolWith({ fdeName = 'alice' } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('SELECT fde_name FROM users')) {
        return { rows: fdeName ? [{ fde_name: fdeName }] : [] };
      }
      if (sql.startsWith('INSERT INTO chat_sessions')) {
        return {
          rows: [{
            id: 's1', user_id: params[0], project_id: null, cwd: params[1],
            title: params[2], model: params[3], status: 'active', last_seq: 0,
            created_at: new Date('2026-09-24T00:00:00.000Z'), updated_at: new Date('2026-09-24T00:00:00.000Z'),
          }],
        };
      }
      return { rows: [] };
    },
  };
}

test('validateSessionCwd：~/projects/<name> 合法（含下划线/点段/数字），其余一律拒绝', () => {
  assert.equal(validateSessionCwd('~/projects/meeting_asr_app'), '~/projects/meeting_asr_app');
  assert.equal(validateSessionCwd('~/projects/a'), '~/projects/a');
  assert.equal(validateSessionCwd('~/projects/my.app-2'), '~/projects/my.app-2');
  for (const bad of [
    undefined, null, 123, '', '~/projects', '~/projects/', '~/projects/../x',
    '~/projects/..', '~/projects/.', '~/projects/a/b', '/abs/path', 'projects/a',
    '~/projects/a\nb',
  ]) {
    assert.throws(() => validateSessionCwd(bad), SessionError, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test('createSession：目录不存在 → mkdir（＋新建目录语义）+ 落库 cwd + 响应带 cwd', async () => {
  const { userSpaceRoot, projectsRoot } = tmpRoot();
  try {
    const pool = poolWith();
    const created = await createSession(pool, {
      userId: 'u1', projectId: '~/projects/new-dir', title: 't', config: { userSpaceRoot },
    });
    assert.equal(created.cwd, '~/projects/new-dir');
    assert.equal(created.project_id, null, 'P5 不再写 project_id（列留档）');
    assert.ok(fs.existsSync(path.join(projectsRoot, 'new-dir')), '目录被创建');
    const insert = pool.queries.find((q) => q.sql.startsWith('INSERT INTO chat_sessions'));
    assert.equal(insert.params[1], '~/projects/new-dir');
  } finally {
    fs.rmSync(userSpaceRoot, { recursive: true, force: true });
  }
});

test('createSession：目录已存在 → 幂等复用（不报错、不重建）', async () => {
  const { userSpaceRoot, projectsRoot } = tmpRoot();
  try {
    fs.mkdirSync(path.join(projectsRoot, 'existing'), { recursive: true });
    fs.writeFileSync(path.join(projectsRoot, 'existing', 'KEEP.md'), 'user file');
    const pool = poolWith();
    const created = await createSession(pool, {
      userId: 'u1', projectId: '~/projects/existing', config: { userSpaceRoot },
    });
    assert.equal(created.cwd, '~/projects/existing');
    assert.equal(fs.readFileSync(path.join(projectsRoot, 'existing', 'KEEP.md'), 'utf8'), 'user file');
  } finally {
    fs.rmSync(userSpaceRoot, { recursive: true, force: true });
  }
});

test('createSession：非法 project_id → 400 validation_failed（任何目录都不建）', async () => {
  const { userSpaceRoot, projectsRoot } = tmpRoot();
  try {
    const pool = poolWith();
    await assert.rejects(
      () => createSession(pool, { userId: 'u1', projectId: '~/projects/../escape', config: { userSpaceRoot } }),
      (e) => e instanceof SessionError && e.code === 'validation_failed' && e.httpStatus === 400,
    );
    assert.equal(fs.existsSync(path.join(userSpaceRoot, 'alice')), false, '非法请求不落盘');
    assert.equal(pool.queries.some((q) => q.sql.startsWith('INSERT INTO chat_sessions')), false);
  } finally {
    fs.rmSync(userSpaceRoot, { recursive: true, force: true });
  }
});

test('createSession：用户无 fde_name → 400（无家目录可绑定）', async () => {
  const { userSpaceRoot } = tmpRoot();
  try {
    const pool = poolWith({ fdeName: null });
    await assert.rejects(
      () => createSession(pool, { userId: 'u1', projectId: '~/projects/x', config: { userSpaceRoot } }),
      (e) => e instanceof SessionError && e.code === 'validation_failed' && e.details.field === 'fde_name',
    );
  } finally {
    fs.rmSync(userSpaceRoot, { recursive: true, force: true });
  }
});
