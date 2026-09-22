// 单测：materializer.js（渲染 / manifest generation / 原子写 / 幂等 / 删除清理）+ fsutil 原子写。
// 隔离约定（docs/testing.md §2.1）：注入临时目录，不碰真实 /srv/erix/users。
import test from 'node:test';
import { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  renderConfigJson,
  renderPortsJson,
  renderManifest,
  buildFilePlan,
  createMaterializer,
  runMaterializerOnce,
  hostPathFor,
  CONTAINER_HOME,
} from '../src/materializer.js';
import { atomicWriteFile, sha256, commitTempFile, writeTempFile } from '../src/fsutil.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mat-test-'));
}

test('renderConfigJson：占位 key + endpoint（erix-agent v0.3.5 slots 嵌套格式）+ 三 slot', () => {
  const obj = JSON.parse(renderConfigJson({ llmBaseUrl: 'http://llm.localhost:8090' }));
  assert.equal(obj.slots.default.apiKey, 'erix-placeholder');
  assert.equal(obj.slots.default.endpoint, 'http://llm.localhost:8090/v1');
  assert.equal(obj.slots.audit.apiKey, 'erix-placeholder');
  assert.equal(obj.slots.fold.apiKey, 'erix-placeholder');
  assert.equal(obj.slots.default.model, 'claude-sonnet');
});

test('renderPortsJson：schema/fde/project/generation/allocations 投影（state 未释放）', () => {
  const obj = JSON.parse(
    renderPortsJson({
      fdeName: 'alice',
      projectName: 'proj1',
      generation: 42,
      allocations: [
        { scope: 'project', port: 4016, role: 'frontend', run_id: null, url: 'https://alice-p-proj1-4016.fde.localhost', exposure: 'private', state: 'allocated' },
      ],
    }),
  );
  assert.equal(obj.schema, 1);
  assert.equal(obj.fde, 'alice');
  assert.equal(obj.project, 'proj1');
  assert.equal(obj.generation, 42);
  assert.equal(obj.allocations.length, 1);
  assert.equal(obj.allocations[0].port, 4016);
});

test('renderManifest：files 键字典序 + generation + materialized_at', () => {
  const content = renderManifest({
    fdeName: 'alice',
    generation: 7,
    materializedAt: '2026-09-12T08:30:00.000Z',
    entries: {
      '/home/erix/.erix/config.json': { sha256: 'a'.repeat(64), revision: 3 },
      '/home/erix/AGENTS.md': { sha256: 'b'.repeat(64), revision: 1 },
    },
  });
  const obj = JSON.parse(content);
  assert.equal(obj.generation, 7);
  assert.deepEqual(Object.keys(obj.files), ['/home/erix/.erix/config.json', '/home/erix/AGENTS.md']);
  assert.equal(obj.files['/home/erix/AGENTS.md'].revision, 1);
});

test('hostPathFor：容器绝对路径 → 宿主 <root>/<fde>/...', () => {
  assert.equal(
    hostPathFor('/srv/erix/users', 'alice', `${CONTAINER_HOME}/projects/proj1/.erix/ports.json`),
    path.join('/srv/erix/users', 'alice', 'projects/proj1/.erix/ports.json'),
  );
});

test('buildFilePlan：home 骨架 + 每项目平台文件，路径映射正确', () => {
  const files = buildFilePlan({
    fdeName: 'alice',
    baseDomain: 'localhost',
    llmBaseUrl: 'http://llm.localhost:8090',
    root: '/srv/erix/users',
    generation: 1,
    projects: [{ id: 'p1', name: 'proj1' }],
    allocationsByProject: new Map([['p1', [{ scope: 'project', port: 4016, role: 'frontend', run_id: null, url: 'https://alice-p-proj1-4016.fde.localhost', exposure: 'private', state: 'allocated' }]]]),
  });
  const hostPaths = files.map((f) => f.hostPath);
  assert.ok(hostPaths.includes(path.join('/srv/erix/users', 'alice', 'home', 'AGENTS.md')));
  assert.ok(hostPaths.includes(path.join('/srv/erix/users', 'alice', 'projects', 'proj1', '.erix', 'ports.json')));
  const portsFile = files.find((f) => f.containerPath.endsWith('.erix/ports.json'));
  assert.equal(JSON.parse(portsFile.content).generation, 1);
});

test('renderProjectAgentsMd：有 repoUrl 时写入真实地址并移除占位符', () => {
  const files = buildFilePlan({
    fdeName: 'alice',
    baseDomain: 'localhost',
    llmBaseUrl: 'http://llm.localhost:8090',
    root: '/srv/erix/users',
    generation: 1,
    projects: [{ id: 'p1', name: 'proj1', repo_url: 'https://git.example/alice/proj1.git' }],
    allocationsByProject: new Map(),
  });
  const agents = files.find((f) => f.containerPath.endsWith('.erix/AGENTS.md')).content;
  assert.match(agents, /https:\/\/git\.example\/alice\/proj1\.git/);
  assert.doesNotMatch(agents, /<repo_url>/);
});

test('renderProjectAgentsMd：repoUrl 含 shell 元字符时在命令中使用 POSIX 单引号引用', () => {
  const files = buildFilePlan({
    fdeName: 'alice',
    baseDomain: 'localhost',
    llmBaseUrl: 'http://llm.localhost:8090',
    root: '/srv/erix/users',
    generation: 1,
    projects: [{ id: 'p1', name: 'proj1', repo_url: 'https://host/repo.git;id' }],
    allocationsByProject: new Map(),
  });
  const agents = files.find((f) => f.containerPath.endsWith('.erix/AGENTS.md')).content;
  assert.match(agents, /origin 'https:\/\/host\/repo\.git;id'/);
  assert.doesNotMatch(agents, /origin https:\/\/host\/repo\.git;id/);
});

test('renderProjectAgentsMd：无 repoUrl 时给出未关联仓库指引且移除占位符', () => {
  const files = buildFilePlan({
    fdeName: 'alice',
    baseDomain: 'localhost',
    llmBaseUrl: 'http://llm.localhost:8090',
    root: '/srv/erix/users',
    generation: 1,
    projects: [{ id: 'p1', name: 'proj1', repo_url: null }],
    allocationsByProject: new Map(),
  });
  const agents = files.find((f) => f.containerPath.endsWith('.erix/AGENTS.md')).content;
  assert.match(agents, /未关联仓库/);
  assert.doesNotMatch(agents, /<repo_url>/);
});

test('runMaterializerOnce：项目查询带出 repo_url 并落盘真实仓库地址', async () => {
  const root = tmpdir();
  const repoUrl = 'https://git.example/alice/proj1.git';
  const pool = {
    async query(sql) {
      if (sql.includes('FROM users')) {
        return { rows: [{ id: 'u1', fde_name: 'alice' }] };
      }
      if (sql.includes('FROM projects')) {
        const project = { id: 'p1', name: 'proj1' };
        // 模拟 pg 的投影：只有查询显式选择 repo_url 时，行里才有该字段。
        if (sql.includes('repo_url')) project.repo_url = repoUrl;
        return { rows: [project] };
      }
      if (sql.includes('FROM port_allocations')) return { rows: [] };
      if (sql.includes('UPDATE materialize_outbox SET state =')) return { rows: [] };
      throw new Error(`unexpected pool query: ${sql}`);
    },
    async connect() {
      return {
        async query(sql) {
          if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
          if (sql.includes('RETURNING o.id')) {
            return { rows: [{ id: 'outbox-1', fde_id: 'u1', revision: 1, op: 'update' }] };
          }
          if (sql.startsWith('UPDATE materialize_outbox')) return { rows: [] };
          throw new Error(`unexpected client query: ${sql}`);
        },
        release() {},
      };
    },
  };

  try {
    const result = await runMaterializerOnce(pool, {
      userSpaceRoot: root,
      llmPublicBaseUrl: 'http://llm.localhost:8090',
      baseDomain: 'localhost',
    });
    assert.deepEqual(result, { processed: 1, claimed: 1 });

    const agentsPath = path.join(root, 'alice', 'projects', 'proj1', '.erix', 'AGENTS.md');
    const agents = fs.readFileSync(agentsPath, 'utf8');
    assert.match(agents, new RegExp(repoUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(agents, /<repo_url>/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fsutil.atomicWriteFile：写入完整内容，无半截/空文件', () => {
  const dir = tmpdir();
  const target = path.join(dir, 'file.txt');
  const content = 'hello world\n'.repeat(1000);
  atomicWriteFile(target, content, { root: dir });
  assert.equal(fs.readFileSync(target, 'utf8'), content);
  // 无残留 tmp 文件
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fsutil.atomicWriteFile：目标路径含 symlink → 拒写且保留旧文件', () => {
  const dir = tmpdir();
  const target = path.join(dir, 'sub', 'file.txt');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(target, 'OLD');
  // 把 sub 换成 symlink 指向别处
  fs.renameSync(path.join(dir, 'sub'), path.join(dir, 'sub-real'));
  fs.symlinkSync(path.join(dir, 'sub-real'), path.join(dir, 'sub'));
  assert.throws(() => atomicWriteFile(target, 'NEW', { root: dir }), /symlink|tampered/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('materialize：幂等（同一快照两次 → generation 不变、字节级相同、无重写）', async () => {
  const root = tmpdir();
  const mat = createMaterializer({ root, uid: 1000, gid: 1000 });
  const snapshot = {
    fdeName: 'alice',
    baseDomain: 'localhost',
    llmBaseUrl: 'http://llm.localhost:8090',
    generation: 5,
    projects: [{ id: 'p1', name: 'proj1' }],
    allocationsByProject: new Map([['p1', [{ scope: 'project', port: 4016, role: 'frontend', run_id: null, url: 'https://alice-p-proj1-4016.fde.localhost', exposure: 'private', state: 'allocated' }]]]),
    materializedAt: new Date('2026-09-12T08:30:00.000Z'),
  };
  const r1 = await mat.materialize(snapshot);
  const manifestPath = path.join(root, 'alice', 'home', '.erix', 'manifest.json');
  const prevManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const mtime1 = fs.statSync(manifestPath).mtimeMs;
  const r2 = await mat.materialize({ ...snapshot, prevManifest });
  assert.equal(r1.generation, 5);
  assert.equal(r2.generation, 5);
  assert.equal(r1.manifest, r2.manifest);
  // 幂等：manifest 未重写（mtime 不变，user-space §8.2）。
  assert.equal(fs.statSync(manifestPath).mtimeMs, mtime1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('materialize：项目删除后清理 stale 平台文件', async () => {
  const root = tmpdir();
  const mat = createMaterializer({ root, uid: 1000, gid: 1000 });
  const proj = { id: 'p1', name: 'proj1' };
  const alloc = [{ scope: 'project', port: 4016, role: 'frontend', run_id: null, url: 'https://alice-p-proj1-4016.fde.localhost', exposure: 'private', state: 'allocated' }];
  const before = {
    fdeName: 'alice',
    baseDomain: 'localhost',
    llmBaseUrl: 'http://llm.localhost:8090',
    generation: 1,
    projects: [proj],
    allocationsByProject: new Map([['p1', alloc]]),
    materializedAt: new Date('2026-09-12T08:30:00.000Z'),
  };
  await mat.materialize(before);
  const portsPath = path.join(root, 'alice', 'projects', 'proj1', '.erix', 'ports.json');
  assert.ok(fs.existsSync(portsPath));
  const prevManifest = JSON.parse(fs.readFileSync(path.join(root, 'alice', 'home', '.erix', 'manifest.json'), 'utf8'));

  // 项目删除 → projects 为空 → 清理该项目平台文件（以 DB 为真相，prevManifest 仅作删除/幂等诊断）。
  const after = { ...before, generation: 2, projects: [], allocationsByProject: new Map(), prevManifest };
  await mat.materialize(after);
  assert.equal(fs.existsSync(portsPath), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('materialize：ports.json generation == manifest generation（跨文件一致性锚点）', async () => {
  const root = tmpdir();
  const mat = createMaterializer({ root, uid: 1000, gid: 1000 });
  const r = await mat.materialize({
    fdeName: 'alice',
    baseDomain: 'localhost',
    llmBaseUrl: 'http://llm.localhost:8090',
    generation: 42,
    projects: [{ id: 'p1', name: 'proj1' }],
    allocationsByProject: new Map([['p1', [{ scope: 'project', port: 4016, role: 'frontend', run_id: null, url: 'https://alice-p-proj1-4016.fde.localhost', exposure: 'private', state: 'allocated' }]]]),
    materializedAt: new Date('2026-09-12T08:30:00.000Z'),
  });
  const manifest = JSON.parse(r.manifest);
  const ports = JSON.parse(fs.readFileSync(path.join(root, 'alice', 'projects', 'proj1', '.erix', 'ports.json'), 'utf8'));
  assert.equal(manifest.generation, 42);
  assert.equal(ports.generation, 42);
  assert.equal(sha256(fs.readFileSync(path.join(root, 'alice', 'home', '.erix', 'manifest.json'))), sha256(r.manifest));
  fs.rmSync(root, { recursive: true, force: true });
});

test('F1：prevManifest 被篡改含 ../ 时，不删除其他 FDE 的文件（跳过 + 告警，不报 500）', async () => {
  const root = tmpdir();
  const warnings = [];
  const mat = createMaterializer({ root, uid: 1000, gid: 1000, log: { warn: (m) => warnings.push(m) } });
  // 受害者：另一个 FDE 的 .erix 文件（不可被删除）。
  const victim = path.join(root, 'bob', 'home', '.erix', 'config.json');
  fs.mkdirSync(path.dirname(victim), { recursive: true });
  fs.writeFileSync(victim, 'VICTIM');

  // 篡改 prevManifest：files 键含 ../ 逃逸路径。
  const prevManifest = {
    schema: 1,
    fde: 'alice',
    generation: 1,
    materialized_at: '2026-09-12T08:30:00.000Z',
    files: {
      [`${CONTAINER_HOME}/../../bob/home/.erix/config.json`]: { sha256: 'x'.repeat(64), revision: 1 },
    },
  };

  await mat.materialize({
    fdeName: 'alice',
    baseDomain: 'localhost',
    llmBaseUrl: 'http://llm.localhost:8090',
    generation: 2,
    projects: [],
    allocationsByProject: new Map(),
    prevManifest,
    materializedAt: new Date('2026-09-12T08:30:00.000Z'),
  });
  // 不抛错（跳过而非 500）；受害文件仍在；且告警记录可疑路径。
  assert.ok(fs.existsSync(victim));
  assert.equal(fs.readFileSync(victim, 'utf8'), 'VICTIM');
  assert.ok(warnings.some((w) => w.includes('skip stale file')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('F6：同内容 symlink 拒绝（lstat 不跟随，不静默保留 symlink）', async () => {
  const root = tmpdir();
  const mat = createMaterializer({ root, uid: 1000, gid: 1000 });
  const snapshot = {
    fdeName: 'alice',
    baseDomain: 'localhost',
    llmBaseUrl: 'http://llm.localhost:8090',
    generation: 1,
    projects: [],
    allocationsByProject: new Map(),
    materializedAt: new Date('2026-09-12T08:30:00.000Z'),
  };
  await mat.materialize(snapshot);
  const agentsPath = path.join(root, 'alice', 'home', 'AGENTS.md');
  const content = fs.readFileSync(agentsPath, 'utf8');
  // 用 symlink 替换目标文件（指向同内容的他处文件）。
  const elsewhere = path.join(root, 'alice', 'home', 'real-agents.md');
  fs.writeFileSync(elsewhere, content);
  fs.unlinkSync(agentsPath);
  fs.symlinkSync(elsewhere, agentsPath);
  const prevManifest = JSON.parse(fs.readFileSync(path.join(root, 'alice', 'home', '.erix', 'manifest.json'), 'utf8'));

  await assert.rejects(
    mat.materialize({ ...snapshot, prevManifest }),
    /symlink|tampered/,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('F8：未传 materializedAt 时同快照仍字节级幂等（沿用旧 materialized_at）', async () => {
  const root = tmpdir();
  const mat = createMaterializer({ root, uid: 1000, gid: 1000 });
  const snapshot = {
    fdeName: 'alice',
    baseDomain: 'localhost',
    llmBaseUrl: 'http://llm.localhost:8090',
    generation: 5,
    projects: [{ id: 'p1', name: 'proj1' }],
    allocationsByProject: new Map([['p1', [{ scope: 'project', port: 4016, role: 'frontend', run_id: null, url: 'https://alice-p-proj1-4016.fde.localhost', exposure: 'private', state: 'allocated' }]]]),
  };
  const r1 = await mat.materialize(snapshot);
  const manifestPath = path.join(root, 'alice', 'home', '.erix', 'manifest.json');
  const prev = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const mtime1 = fs.statSync(manifestPath).mtimeMs;
  // 第二次不传 materializedAt（默认 new Date()）→ 内容未变应沿用旧 materialized_at，字节级相同。
  const r2 = await mat.materialize({ ...snapshot, prevManifest: prev });
  assert.equal(r1.manifest, r2.manifest);
  assert.equal(fs.statSync(manifestPath).mtimeMs, mtime1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('M1：root 内用户自建 .gitignore/AGENTS.md 在 stale 清理后存活（不在平台管理路径集合）', async () => {
  const root = tmpdir();
  const warnings = [];
  const mat = createMaterializer({ root, uid: 1000, gid: 1000, log: { warn: (m) => warnings.push(m) } });
  const proj = { id: 'p1', name: 'proj1' };
  const alloc = [{ scope: 'project', port: 4016, role: 'frontend', run_id: null, url: 'https://alice-p-proj1-4016.fde.localhost', exposure: 'private', state: 'allocated' }];
  const before = {
    fdeName: 'alice',
    baseDomain: 'localhost',
    llmBaseUrl: 'http://llm.localhost:8090',
    generation: 1,
    projects: [proj],
    allocationsByProject: new Map([['p1', alloc]]),
    materializedAt: new Date('2026-09-12T08:30:00.000Z'),
  };
  await mat.materialize(before);

  // 用户在 root 内自建嵌套 .gitignore / AGENTS.md（不属于平台管理路径集合）。
  const userGitignore = path.join(root, 'alice', 'projects', 'user', 'repo', '.gitignore');
  const userAgents = path.join(root, 'alice', 'projects', 'user', 'repo', 'AGENTS.md');
  fs.mkdirSync(path.dirname(userGitignore), { recursive: true });
  fs.writeFileSync(userGitignore, 'node_modules/\n');
  fs.writeFileSync(userAgents, '# my own agents\n');

  // 篡改 prevManifest：把用户自建路径塞进上一版 files（模拟 manifest 被污染 / 映射错误）。
  const manifestPath = path.join(root, 'alice', 'home', '.erix', 'manifest.json');
  const prev = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  prev.files[`${CONTAINER_HOME}/projects/user/repo/.gitignore`] = { sha256: 'x'.repeat(64), revision: 1 };
  prev.files[`${CONTAINER_HOME}/projects/user/repo/AGENTS.md`] = { sha256: 'y'.repeat(64), revision: 1 };

  // 项目删除 → 平台文件 stale；用户文件虽在 prevManifest 但不在平台管理路径集合 → 必须存活。
  await mat.materialize({
    ...before,
    generation: 2,
    projects: [],
    allocationsByProject: new Map(),
    prevManifest: prev,
    materializedAt: new Date('2026-09-12T09:00:00.000Z'),
  });

  assert.equal(fs.existsSync(userGitignore), true);
  assert.equal(fs.readFileSync(userGitignore, 'utf8'), 'node_modules/\n');
  assert.equal(fs.existsSync(userAgents), true);
  assert.equal(fs.readFileSync(userAgents, 'utf8'), '# my own agents\n');

  // 平台自己的项目文件仍被清理。
  assert.equal(fs.existsSync(path.join(root, 'alice', 'projects', 'proj1', '.erix', 'ports.json')), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('M2：stale-only 变更（仅删 stale）时 materialized_at 更新', async () => {
  const root = tmpdir();
  const mat = createMaterializer({ root, uid: 1000, gid: 1000 });
  const proj = { id: 'p1', name: 'proj1' };
  const alloc = [{ scope: 'project', port: 4016, role: 'frontend', run_id: null, url: 'https://alice-p-proj1-4016.fde.localhost', exposure: 'private', state: 'allocated' }];
  const t1 = new Date('2026-09-12T08:30:00.000Z');
  await mat.materialize({
    fdeName: 'alice', baseDomain: 'localhost', llmBaseUrl: 'http://llm.localhost:8090', generation: 1,
    projects: [proj], allocationsByProject: new Map([['p1', alloc]]), materializedAt: t1,
  });
  const manifestPath = path.join(root, 'alice', 'home', '.erix', 'manifest.json');
  const prev = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(prev.materialized_at, t1.toISOString());

  const t2 = new Date('2026-09-12T09:00:00.000Z');
  // 仅删项目 → 无内容变更，只有 stale 删除 → materialized_at 必须更新到 t2。
  await mat.materialize({
    fdeName: 'alice', baseDomain: 'localhost', llmBaseUrl: 'http://llm.localhost:8090', generation: 2,
    projects: [], allocationsByProject: new Map(), prevManifest: prev, materializedAt: t2,
  });
  const after = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(after.materialized_at, t2.toISOString());
  assert.equal(fs.existsSync(path.join(root, 'alice', 'projects', 'proj1', '.erix', 'ports.json')), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('L5：commitTempFile 目录 fsync 失败返回 false（rename 已提交不抛异常）', () => {
  const dir = tmpdir();
  const target = path.join(dir, 'file.txt');
  const tmp = path.join(dir, 'file.txt.abc123.tmp');
  fs.writeFileSync(tmp, 'hello');
  let n = 0;
  const restore = mock.method(fs, 'fsyncSync', () => {
    n += 1;
    throw new Error('EIO');
  });
  try {
    assert.equal(commitTempFile(tmp, target, { root: dir }), false);
    assert.equal(fs.readFileSync(target, 'utf8'), 'hello');
    assert.equal(n, 1);
  } finally {
    try {
      restore();
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('L5：atomicWriteFile 目录 fsync 失败抛 materialize_fsync_failed（不误报未写）', () => {
  const dir = tmpdir();
  const target = path.join(dir, 'file.txt');
  let calls = 0;
  const restore = mock.method(fs, 'fsyncSync', () => {
    calls += 1;
    if (calls === 2) throw new Error('EIO');
  });
  try {
    assert.throws(() => atomicWriteFile(target, 'hello', { root: dir }), { code: 'materialize_fsync_failed' });
  } finally {
    try {
      restore();
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
