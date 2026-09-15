// 单测：materializer.js（渲染 / manifest generation / 原子写 / 幂等 / 删除清理）+ fsutil 原子写。
// 隔离约定（docs/testing.md §2.1）：注入临时目录，不碰真实 /srv/erix/users。
import test from 'node:test';
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
  hostPathFor,
  CONTAINER_HOME,
} from '../src/materializer.js';
import { atomicWriteFile, sha256 } from '../src/fsutil.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mat-test-'));
}

test('renderConfigJson：占位 key + baseURL=https://llm.<base>/v1 + 三 slot', () => {
  const obj = JSON.parse(renderConfigJson({ llmHost: 'llm.localhost' }));
  assert.equal(obj.default.apiKey, 'erix-placeholder');
  assert.equal(obj.default.baseURL, 'https://llm.localhost/v1');
  assert.equal(obj.audit.apiKey, 'erix-placeholder');
  assert.equal(obj.fold.apiKey, 'erix-placeholder');
  assert.equal(obj.default.model, 'claude-sonnet');
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
    llmHost: 'llm.localhost',
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
    llmHost: 'llm.localhost',
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
    llmHost: 'llm.localhost',
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
    llmHost: 'llm.localhost',
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
