// 单测：dirs.js（P5 目录视图，directory-as-project §4）——目录枚举 + 运行态徽标 + 目录树懒展开。
// 隔离约定（docs/testing.md §2.1）：tmp 目录注入 userSpaceRoot，内存 fake pool，不碰真实环境。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listDirs, fileTree, DirError } from '../src/dirs.js';

function tmpUserspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-dirs-'));
  const projects = path.join(root, 'alice', 'home', 'projects');
  fs.mkdirSync(projects, { recursive: true });
  return { root, projects };
}

function fakePool({ cwdCounts = {} } = {}) {
  return {
    async query(sql, params = []) {
      if (sql.includes('GROUP BY s.cwd')) {
        const rows = Object.entries(cwdCounts).map(([cwd, c]) => ({
          cwd, running: c.running ?? 0, queued: c.queued ?? 0,
        }));
        return { rows };
      }
      return { rows: [] };
    },
  };
}

test('listDirs：枚举一级目录（字典序），cwd 相对形式 + 运行态徽标聚合', async () => {
  const { root, projects } = tmpUserspace();
  try {
    fs.mkdirSync(path.join(projects, 'meeting_asr_app'), { recursive: true }); // 下划线目录名必须可枚举（P5 自由命名）
    fs.mkdirSync(path.join(projects, 'llm-smoke'), { recursive: true });
    fs.writeFileSync(path.join(projects, 'a-file.txt'), 'x'); // 文件不列为目录
    fs.symlinkSync(path.join(projects, 'llm-smoke'), path.join(projects, 'link-dir')); // symlink 不列为目录

    const pool = fakePool({
      cwdCounts: {
        '~/projects/llm-smoke': { running: 2, queued: 1 },
        '~/projects/meeting_asr_app': { running: 0, queued: 0 },
      },
    });
    const r = await listDirs(pool, { userId: 'u1', userSpaceRoot: root, fdeName: 'alice' });
    assert.deepEqual(r.dirs.map((d) => d.name), ['llm-smoke', 'meeting_asr_app']);
    const smoke = r.dirs[0];
    assert.equal(smoke.cwd, '~/projects/llm-smoke');
    assert.equal(smoke.running_count, 2);
    assert.equal(smoke.queued_count, 1);
    assert.equal(r.dirs[1].running_count, 0, '无活跃 run 的目录徽标为 0');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listDirs：projects 根不存在 → 空列表（不 500，尚无目录是正常态）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-dirs-empty-'));
  try {
    const r = await listDirs(fakePool(), { userId: 'u1', userSpaceRoot: root, fdeName: 'alice' });
    assert.deepEqual(r.dirs, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listDirs：运行态聚合失败 → 徽标退化 0，不阻断目录列表', async () => {
  const { root, projects } = tmpUserspace();
  try {
    fs.mkdirSync(path.join(projects, 'proj1'), { recursive: true });
    const pool = { async query() { throw new Error('no cwd column'); } };
    const r = await listDirs(pool, { userId: 'u1', userSpaceRoot: root, fdeName: 'alice', log: { warn() {} } });
    assert.equal(r.dirs.length, 1);
    assert.equal(r.dirs[0].running_count, 0);
    assert.equal(r.dirs[0].queued_count, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fileTree：根 = cwd 单层列表（目录在前、字典序；文件可见；symlink 不列出）', async () => {
  const { root, projects } = tmpUserspace();
  try {
    const proj = path.join(projects, 'proj1');
    fs.mkdirSync(path.join(proj, 'src', 'deep'), { recursive: true }); // 深层不递归
    fs.mkdirSync(path.join(proj, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'README.md'), '# x');
    fs.writeFileSync(path.join(proj, 'package.json'), '{}');
    fs.symlinkSync(path.join(proj, 'README.md'), path.join(proj, 'readme-link'));

    const r = await fileTree({ userSpaceRoot: root, fdeName: 'alice', cwd: '~/projects/proj1' });
    assert.deepEqual(r.entries, [
      { name: 'docs', type: 'dir' },
      { name: 'src', type: 'dir' },
      { name: 'README.md', type: 'file' },
      { name: 'package.json', type: 'file' },
    ]);
    // 单层懒展开：子目录内容不展开。
    const sub = await fileTree({ userSpaceRoot: root, fdeName: 'alice', cwd: '~/projects/proj1', relPath: 'src' });
    assert.deepEqual(sub.entries, [{ name: 'deep', type: 'dir' }]);
    // path 默认 '.' 与显式等价。
    const dot = await fileTree({ userSpaceRoot: root, fdeName: 'alice', cwd: '~/projects/proj1', relPath: '.' });
    assert.deepEqual(dot, r);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fileTree：cwd 形态防线（非 ~/projects/<name> / 含 .. / 多级 → 400）', async () => {
  const { root } = tmpUserspace();
  try {
    for (const bad of [
      '~/projects',            // 缺 name
      '~/projects/',           // 空 name
      '~/projects/../home',    // 穿越（含 /）
      '~/projects/..',         // 穿越（name = ..）
      '~/projects/.',          // name = .
      '/etc/passwd',           // 绝对路径
      'projects/proj1',        // 缺 ~ 前缀
      '~/projects/a/b',        // 多级（非一级目录）
      123,                     // 非字符串
    ]) {
      await assert.rejects(
        () => fileTree({ userSpaceRoot: root, fdeName: 'alice', cwd: bad }),
        (e) => e instanceof DirError && e.code === 'validation_failed' && e.httpStatus === 400,
        `应拒绝 cwd=${JSON.stringify(bad)}`,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fileTree：path 穿越防护（.. / 绝对路径 / 不存在的段 / 文件节点 / symlink 段）', async () => {
  const { root, projects } = tmpUserspace();
  try {
    const proj = path.join(projects, 'proj1');
    fs.mkdirSync(path.join(proj, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'note.txt'), 'n');

    // 逃逸尝试
    await assert.rejects(
      () => fileTree({ userSpaceRoot: root, fdeName: 'alice', cwd: '~/projects/proj1', relPath: '..' }),
      (e) => e.code === 'validation_failed' && e.httpStatus === 400,
    );
    await assert.rejects(
      () => fileTree({ userSpaceRoot: root, fdeName: 'alice', cwd: '~/projects/proj1', relPath: 'sub/../../..' }),
      (e) => e.code === 'validation_failed' && e.httpStatus === 400,
    );
    await assert.rejects(
      () => fileTree({ userSpaceRoot: root, fdeName: 'alice', cwd: '~/projects/proj1', relPath: '/etc' }),
      (e) => e.code === 'validation_failed' && e.httpStatus === 400,
    );
    // 不存在的段 → 404。
    await assert.rejects(
      () => fileTree({ userSpaceRoot: root, fdeName: 'alice', cwd: '~/projects/proj1', relPath: 'nope/deeper' }),
      (e) => e.code === 'not_found' && e.httpStatus === 404,
    );
    // 文件节点不是目录 → 400（树面板只懒展开目录；文件预览是 P6）。
    await assert.rejects(
      () => fileTree({ userSpaceRoot: root, fdeName: 'alice', cwd: '~/projects/proj1', relPath: 'note.txt' }),
      (e) => e.code === 'validation_failed' && e.httpStatus === 400,
    );
    // symlink 段（根内用户自建）→ 拒绝列出（防 jail 外泄漏）。
    fs.symlinkSync(path.join(projects), path.join(proj, 'sub', 'escape-link'));
    await assert.rejects(
      () => fileTree({ userSpaceRoot: root, fdeName: 'alice', cwd: '~/projects/proj1', relPath: 'sub/escape-link' }),
      (e) => e.code === 'validation_failed' && e.httpStatus === 400,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fileTree：cwd 根不存在 → 404；根本身是 symlink → 404', async () => {
  const { root, projects } = tmpUserspace();
  try {
    await assert.rejects(
      () => fileTree({ userSpaceRoot: root, fdeName: 'alice', cwd: '~/projects/ghost' }),
      (e) => e.code === 'not_found' && e.httpStatus === 404,
    );
    fs.symlinkSync(projects, path.join(projects, 'linked-root'));
    await assert.rejects(
      () => fileTree({ userSpaceRoot: root, fdeName: 'alice', cwd: '~/projects/linked-root' }),
      (e) => e.code === 'not_found' && e.httpStatus === 404,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
