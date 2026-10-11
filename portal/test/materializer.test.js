// 单测：materializer.js（渲染 / manifest generation / 原子写 / 幂等 / 删除清理）+ fsutil 原子写。
// P5 去项目化（directory-as-project §5）：项目级物化退役——平台文件 = 家目录骨架 +
// FDE 级 ~/.erix/ports.json；旧项目脚手架靠 stale 清理（manifest 机制）自然移除。
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
  renderHomeAgentsMd,
  buildFilePlan,
  createMaterializer,
  runMaterializerOnce,
  rebuildAllFdes,
  hostPathFor,
  CONTAINER_HOME,
} from '../src/materializer.js';
import { atomicWriteFile, sha256, commitTempFile, writeTempFile } from '../src/fsutil.js';
import { previewAllocationPlan, PREVIEW_PORTS } from '../src/portalloc.js';

// 宿主侧属主跟随进程身份（同 portal/test/git-cli-config.test.js 顶部口径）：生产是
// `uid/gid = fdeUid/fdeGid`（portal/src/materializer.js:441-442 默认 1000），而测试里的 chown
// 只能落在自己的 euid/所属组上，所以这里取进程自身（硬编码 1000 在 uid≠1000 的 runner 上
// 会刷 chown 告警、属主也不是配置声称的那个）。
const SELF_UID = process.getuid?.() ?? 1000;
const SELF_GID = process.getgid?.() ?? 1000;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mat-test-'));
}

const ALLOC = { scope: 'project', port: 4016, role: 'frontend', run_id: null, url: 'https://alice-p-4016.fde.erix.vip', exposure: 'private', state: 'allocated' };

function snapshot(overrides = {}) {
  return {
    fdeName: 'alice',
    baseDomain: 'localhost',
    llmBaseUrl: 'http://llm.localhost:8090',
    generation: 1,
    allocations: [],
    materializedAt: new Date('2026-09-12T08:30:00.000Z'),
    ...overrides,
  };
}

test('renderConfigJson：占位 key + endpoint（erix-agent v0.3.5 slots 嵌套格式）+ 三 slot', () => {
  const obj = JSON.parse(renderConfigJson({ llmBaseUrl: 'http://llm.localhost:8090' }));
  assert.equal(obj.slots.default.apiKey, 'erix-placeholder');
  assert.equal(obj.slots.default.endpoint, 'http://llm.localhost:8090/v1');
  assert.equal(obj.slots.audit.apiKey, 'erix-placeholder');
  assert.equal(obj.slots.fold.apiKey, 'erix-placeholder');
  assert.equal(obj.slots.default.model, 'deepseek-flash'); // 占位即兜底：须为 relay 真实支持的模型名（#79）
});

test('renderPortsJson：P5 FDE 级单一文件（schema/fde/generation/allocations 平铺，无 project 字段）', () => {
  const obj = JSON.parse(
    renderPortsJson({
      fdeName: 'alice',
      generation: 42,
      allocations: [ALLOC],
    }),
  );
  assert.equal(obj.schema, 1);
  assert.equal(obj.fde, 'alice');
  assert.equal(obj.generation, 42);
  assert.equal(obj.project, undefined, 'FDE 级文件不再按项目分组');
  assert.equal(obj.allocations.length, 1);
  assert.equal(obj.allocations[0].port, 4016);
  // 任何一条 allocation 进 ports.json 都必须带 url（#240 起把这条口径钉死在渲染层）
  assert.deepEqual(obj.allocations.map((a) => a.url), [ALLOC.url]);
});

// issue #240：开户预分配 10 条 FDE 级预览域名后，ports.json 就是「告知」的第一落点
// （第二落点是 runner 的 SYSTEM_PROMPT）。口径不放宽：10 条全在、每条都带 url。
const PREVIEW_ALLOCS = previewAllocationPlan({
  fdeName: 'alice',
  baseDomain: 'fde.erix.vip',
  publicBaseUrl: 'http://station.fde.erix.vip:8090',
}).map((p) => ({
  scope: p.scope, port: p.port, role: p.role, run_id: null, url: p.url, exposure: p.exposure, state: p.state,
}));

test('renderPortsJson：#240 预分配的 10 条预览域名全部出现，且**每条都带 url**', () => {
  const obj = JSON.parse(renderPortsJson({ fdeName: 'alice', generation: 7, allocations: PREVIEW_ALLOCS }));
  assert.deepEqual(obj.allocations.map((a) => a.port), PREVIEW_PORTS, '端口 4000–4009 一条不缺');
  assert.equal(obj.allocations.length, 10);
  for (const a of obj.allocations) {
    assert.equal(typeof a.url, 'string');
    assert.ok(a.url && a.url.length > 0, `端口 ${a.port} 的条目必须带 url（agent 永不自行拼 URL）`);
    assert.equal(a.url, `http://alice-p-${a.port}.fde.erix.vip:8090`);
    assert.equal(a.scope, 'fde');
    assert.equal(a.role, 'spare');
    assert.equal(a.state, 'allocated');
  }
});

test('runMaterializerOnce：#240 开户写入的 10 行落进盘上 ~/.erix/ports.json（读侧 SQL 口径不变）', async () => {
  const root = tmpdir();
  const pool = {
    async query(sql) {
      if (sql.includes('FROM users')) return { rows: [{ id: 'u1', fde_name: 'alice' }] };
      if (sql.includes('FROM port_allocations')) return { rows: PREVIEW_ALLOCS.map((a) => ({ ...a })) };
      if (sql.includes('UPDATE materialize_outbox SET state =')) return { rows: [] };
      throw new Error(`unexpected pool query: ${sql}`);
    },
    async connect() {
      return {
        async query(sql) {
          if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
          if (sql.includes('RETURNING o.id')) return { rows: [{ id: 'outbox-1', fde_id: 'u1', revision: 1, op: 'upsert' }] };
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
      baseDomain: 'fde.erix.vip',
    });
    assert.deepEqual(result, { processed: 1, claimed: 1 });
    const ports = JSON.parse(fs.readFileSync(path.join(root, 'alice', 'home', '.erix', 'ports.json'), 'utf8'));
    assert.equal(ports.allocations.length, 10, '盘上 ports.json 必须是 10 条');
    assert.deepEqual(ports.allocations.map((a) => a.port), PREVIEW_PORTS);
    assert.deepEqual(ports.allocations.map((a) => a.url), PREVIEW_PORTS.map((p) => `http://alice-p-${p}.fde.erix.vip:8090`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('renderHomeAgentsMd：端口指引指向 FDE 级 ~/.erix/ports.json（不再提项目级 .erix/ports.json）', () => {
  const md = renderHomeAgentsMd({ fdeName: 'alice' });
  assert.match(md, /~\/\.erix\/ports\.json/);
  assert.doesNotMatch(md, /projects\/<project>\/\.erix\/ports\.json/);
  // #240：告知「固定 10 条、端口 4000–4009、不够用不再给」——容器侧不管控，只能靠告知收口
  assert.match(md, /10 条预览域名/, 'AGENTS.md 必须告知预建 10 条预览域名');
  assert.match(md, /4000–4009/, '必须写明端口窗口');
});

test('renderHomeAgentsMd：clone 指引并入 FDE 级（平台不 clone / 空目录 clone . / git init）', () => {
  const md = renderHomeAgentsMd({ fdeName: 'alice' });
  assert.match(md, /## clone 方式/);
  assert.match(md, /git clone <地址> \./);
  assert.match(md, /git init/);
  assert.doesNotMatch(md, /<repo_url>/);
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

test('hostPathFor：容器绝对路径 → 宿主 <root>/<fde>/...（D8/P5：worktrees 挂载已拆，home 内容落 home/）', () => {
  assert.equal(
    hostPathFor('/srv/erix/users', 'alice', `${CONTAINER_HOME}/projects/proj1/.erix/ports.json`),
    path.join('/srv/erix/users', 'alice', 'projects/proj1/.erix/ports.json'),
  );
  assert.equal(
    hostPathFor('/srv/erix/users', 'alice', `${CONTAINER_HOME}/.erix/ports.json`),
    path.join('/srv/erix/users', 'alice', 'home', '.erix/ports.json'),
  );
});

test('buildFilePlan：P5 家目录骨架 + FDE 级 ports.json（无任何项目级文件）', () => {
  const files = buildFilePlan({
    fdeName: 'alice',
    baseDomain: 'localhost',
    llmBaseUrl: 'http://llm.localhost:8090',
    root: '/srv/erix/users',
    generation: 1,
    allocations: [ALLOC],
  });
  const hostPaths = files.map((f) => f.hostPath);
  assert.ok(hostPaths.includes(path.join('/srv/erix/users', 'alice', 'home', 'AGENTS.md')));
  assert.ok(hostPaths.includes(path.join('/srv/erix/users', 'alice', 'home', '.erix', 'ports.json')));
  assert.ok(hostPaths.includes(path.join('/srv/erix/users', 'alice', 'home', '.erix', 'config.json')));
  assert.ok(hostPaths.includes(path.join('/srv/erix/users', 'alice', 'home', '.erix', 'mcp.json')));
  // 项目级物化整体退役：.gitignore / 项目 .erix/ 一律不生成。
  assert.equal(files.filter((f) => f.containerPath.includes('/projects/')).length, 0, '无项目级平台文件');
  const portsFile = files.find((f) => f.containerPath.endsWith('.erix/ports.json'));
  assert.equal(JSON.parse(portsFile.content).generation, 1);
  assert.equal(JSON.parse(portsFile.content).allocations.length, 1);
});

test('runMaterializerOnce：P5 不再查询 projects；allocations 平铺落 FDE 级 ports.json', async () => {
  const root = tmpdir();
  const queried = [];
  const pool = {
    async query(sql) {
      queried.push(sql);
      if (sql.includes('FROM users')) {
        return { rows: [{ id: 'u1', fde_name: 'alice' }] };
      }
      if (sql.includes('FROM projects')) throw new Error('P5：materializer 不得再查询 projects 表');
      if (sql.includes('FROM port_allocations')) return { rows: [{ ...ALLOC }] };
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

    const ports = JSON.parse(fs.readFileSync(path.join(root, 'alice', 'home', '.erix', 'ports.json'), 'utf8'));
    assert.equal(ports.fde, 'alice');
    assert.equal(ports.allocations.length, 1);
    assert.equal(ports.allocations[0].url, ALLOC.url);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * issue #183：按 users.status 过滤的 fake pool——允许集合从 SQL 里解析（存在 'awaiting_credential'
 * 即允许该状态），只有当前状态被允许时才返回用户行。这样测试同时锁住「行为」与「SQL 契约」：
 * 一旦过滤退回 status = 'active'，awaiting_credential 用例就会落空。
 */
function statusFilterPool({ userStatus, allocations = [ALLOC] } = {}) {
  const allowedStatuses = (sql) => (sql.includes("'awaiting_credential'") ? ['active', 'awaiting_credential'] : ['active']);
  const userMatches = (sql) => allowedStatuses(sql).includes(userStatus);
  return {
    async query(sql) {
      if (sql.includes('FROM users')) {
        return { rows: userMatches(sql) ? [{ id: 'u1', fde_name: 'alice' }] : [] };
      }
      if (sql.includes('FROM port_allocations')) return { rows: allocations.map((a) => ({ ...a })) };
      if (sql.includes('FROM materialize_revisions')) return { rows: [{ revision: 1 }] };
      if (sql.startsWith('UPDATE materialize_outbox')) return { rows: [] };
      throw new Error(`unexpected pool query: ${sql}`);
    },
    async connect() {
      return {
        async query(sql) {
          if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
          if (sql.includes('RETURNING o.id')) {
            return { rows: [{ id: 'outbox-1', fde_id: 'u1', revision: 1, op: 'upsert' }] };
          }
          if (sql.startsWith('UPDATE materialize_outbox')) return { rows: [] };
          throw new Error(`unexpected client query: ${sql}`);
        },
        release() {},
      };
    },
  };
}

const MATERIALIZER_CONFIG = (root) => ({
  userSpaceRoot: root,
  llmPublicBaseUrl: 'http://llm.localhost:8090',
  baseDomain: 'localhost',
});

function configJsonPath(root) {
  return path.join(root, 'alice', 'home', '.erix', 'config.json');
}

test('runMaterializerOnce：awaiting_credential 的 FDE 照常物化平台文件（issue #183）', async () => {
  const root = tmpdir();
  try {
    const result = await runMaterializerOnce(statusFilterPool({ userStatus: 'awaiting_credential' }), MATERIALIZER_CONFIG(root));
    assert.deepEqual(result, { processed: 1, claimed: 1 }, 'awaiting_credential 不得被物化过滤丢弃');
    assert.ok(fs.existsSync(configJsonPath(root)), '凭据待补不阻塞 ~/.erix/config.json 落盘');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runMaterializerOnce：disabled 的 FDE 仍被跳过（回归，offboarding 后不再物化）', async () => {
  const root = tmpdir();
  try {
    const result = await runMaterializerOnce(statusFilterPool({ userStatus: 'disabled' }), MATERIALIZER_CONFIG(root));
    assert.deepEqual(result, { processed: 0, claimed: 1 });
    assert.equal(fs.existsSync(configJsonPath(root)), false, 'disabled 不得物化');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rebuildAllFdes：启动全量重物化覆盖 awaiting_credential（存量自愈）', async () => {
  const root = tmpdir();
  try {
    const count = await rebuildAllFdes(statusFilterPool({ userStatus: 'awaiting_credential' }), MATERIALIZER_CONFIG(root));
    assert.equal(count, 1);
    assert.ok(fs.existsSync(configJsonPath(root)), 'rebuildAllFdes 必须把 awaiting_credential 也纳入');
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
  const mat = createMaterializer({ root, uid: SELF_UID, gid: SELF_GID });
  const snap = snapshot({ generation: 5, allocations: [ALLOC] });
  const r1 = await mat.materialize(snap);
  const manifestPath = path.join(root, 'alice', 'home', '.erix', 'manifest.json');
  const prevManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const mtime1 = fs.statSync(manifestPath).mtimeMs;
  const r2 = await mat.materialize({ ...snap, prevManifest });
  assert.equal(r1.generation, 5);
  assert.equal(r2.generation, 5);
  assert.equal(r1.manifest, r2.manifest);
  // 幂等：manifest 未重写（mtime 不变，user-space §8.2）。
  assert.equal(fs.statSync(manifestPath).mtimeMs, mtime1);
  fs.rmSync(root, { recursive: true, force: true });
});

/** 在磁盘 + prevManifest 里预置一份「旧版平台生成」的项目脚手架（模拟 0008 前的存量状态）。 */
function seedLegacyProjectScaffold(root, mat) {
  const scaffold = {
    gitignore: path.join(root, 'alice', 'projects', 'proj1', '.gitignore'),
    ports: path.join(root, 'alice', 'projects', 'proj1', '.erix', 'ports.json'),
    agents: path.join(root, 'alice', 'projects', 'proj1', '.erix', 'AGENTS.md'),
  };
  for (const p of Object.values(scaffold)) fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(scaffold.gitignore, '.erix/\n');
  fs.writeFileSync(scaffold.ports, '{"schema":1,"project":"proj1"}\n');
  fs.writeFileSync(scaffold.agents, '# proj1 · 项目级约定\n');
  return scaffold;
}

function prevManifestWithScaffold(prevManifest, sha = 'c'.repeat(64)) {
  return {
    ...prevManifest,
    files: {
      ...prevManifest.files,
      [`${CONTAINER_HOME}/projects/proj1/.gitignore`]: { sha256: sha, revision: 1 },
      [`${CONTAINER_HOME}/projects/proj1/.erix/ports.json`]: { sha256: sha, revision: 1 },
      [`${CONTAINER_HOME}/projects/proj1/.erix/AGENTS.md`]: { sha256: sha, revision: 1 },
    },
  };
}

test('materialize：P5 新 plan 收敛移除存量项目脚手架（stale 清理，manifest 机制）', async () => {
  const root = tmpdir();
  const mat = createMaterializer({ root, uid: SELF_UID, gid: SELF_GID });
  await mat.materialize(snapshot());
  const manifestPath = path.join(root, 'alice', 'home', '.erix', 'manifest.json');
  const scaffold = seedLegacyProjectScaffold(root, mat);
  for (const p of Object.values(scaffold)) assert.ok(fs.existsSync(p), '预置脚手架存在');

  // 同代新 plan（无项目文件）+ prevManifest 含旧脚手架 → stale 收敛移除。
  await mat.materialize({
    ...snapshot(),
    prevManifest: prevManifestWithScaffold(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))),
  });
  for (const p of Object.values(scaffold)) assert.equal(fs.existsSync(p), false, '旧脚手架被移除');
  // 家目录骨架不受影响。
  assert.ok(fs.existsSync(path.join(root, 'alice', 'home', 'AGENTS.md')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('materialize：ports.json generation == manifest generation（跨文件一致性锚点，FDE 级）', async () => {
  const root = tmpdir();
  const mat = createMaterializer({ root, uid: SELF_UID, gid: SELF_GID });
  const r = await mat.materialize(snapshot({ generation: 42, allocations: [ALLOC] }));
  const manifest = JSON.parse(r.manifest);
  const ports = JSON.parse(fs.readFileSync(path.join(root, 'alice', 'home', '.erix', 'ports.json'), 'utf8'));
  assert.equal(manifest.generation, 42);
  assert.equal(ports.generation, 42);
  assert.equal(sha256(fs.readFileSync(path.join(root, 'alice', 'home', '.erix', 'manifest.json'))), sha256(r.manifest));
  fs.rmSync(root, { recursive: true, force: true });
});

test('F1：prevManifest 被篡改含 ../ 时，不删除其他 FDE 的文件（跳过 + 告警，不报 500）', async () => {
  const root = tmpdir();
  const warnings = [];
  const mat = createMaterializer({ root, uid: SELF_UID, gid: SELF_GID, log: { warn: (m) => warnings.push(m) } });
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

  await mat.materialize(snapshot({ generation: 2, prevManifest }));
  // 不抛错（跳过而非 500）；受害文件仍在；且告警记录可疑路径。
  assert.ok(fs.existsSync(victim));
  assert.equal(fs.readFileSync(victim, 'utf8'), 'VICTIM');
  assert.ok(warnings.some((w) => w.includes('skip stale file')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('F6：同内容 symlink 拒绝（lstat 不跟随，不静默保留 symlink）', async () => {
  const root = tmpdir();
  const mat = createMaterializer({ root, uid: SELF_UID, gid: SELF_GID });
  const snap = snapshot();
  await mat.materialize(snap);
  const agentsPath = path.join(root, 'alice', 'home', 'AGENTS.md');
  const content = fs.readFileSync(agentsPath, 'utf8');
  // 用 symlink 替换目标文件（指向同内容的他处文件）。
  const elsewhere = path.join(root, 'alice', 'home', 'real-agents.md');
  fs.writeFileSync(elsewhere, content);
  fs.unlinkSync(agentsPath);
  fs.symlinkSync(elsewhere, agentsPath);
  const prevManifest = JSON.parse(fs.readFileSync(path.join(root, 'alice', 'home', '.erix', 'manifest.json'), 'utf8'));

  await assert.rejects(
    mat.materialize({ ...snap, prevManifest }),
    /symlink|tampered/,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('F8：未传 materializedAt 时同快照仍字节级幂等（沿用旧 materialized_at）', async () => {
  const root = tmpdir();
  const mat = createMaterializer({ root, uid: SELF_UID, gid: SELF_GID });
  const snap = snapshot({ generation: 5, allocations: [ALLOC] });
  delete snap.materializedAt; // 走默认 new Date()
  const r1 = await mat.materialize(snap);
  const manifestPath = path.join(root, 'alice', 'home', '.erix', 'manifest.json');
  const prev = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const mtime1 = fs.statSync(manifestPath).mtimeMs;
  // 第二次不传 materializedAt（默认 new Date()）→ 内容未变应沿用旧 materialized_at，字节级相同。
  const r2 = await mat.materialize({ ...snap, prevManifest: prev });
  assert.equal(r1.manifest, r2.manifest);
  assert.equal(fs.statSync(manifestPath).mtimeMs, mtime1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('M1：root 内用户自建 .gitignore/AGENTS.md 在 stale 清理后存活（不在平台管理路径集合）', async () => {
  const root = tmpdir();
  const warnings = [];
  const mat = createMaterializer({ root, uid: SELF_UID, gid: SELF_GID, log: { warn: (m) => warnings.push(m) } });
  await mat.materialize(snapshot());

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

  // 平台自己的项目脚手架 stale；用户文件虽在 prevManifest 但不在平台管理路径集合 → 必须存活。
  const scaffold = seedLegacyProjectScaffold(root, mat);
  const prev2 = prevManifestWithScaffold(prev);
  await mat.materialize({ ...snapshot({ generation: 2 }), prevManifest: prev2 });

  assert.equal(fs.existsSync(userGitignore), true);
  assert.equal(fs.readFileSync(userGitignore, 'utf8'), 'node_modules/\n');
  assert.equal(fs.existsSync(userAgents), true);
  assert.equal(fs.readFileSync(userAgents, 'utf8'), '# my own agents\n');

  // 平台自己的项目脚手架仍被清理。
  for (const p of Object.values(scaffold)) assert.equal(fs.existsSync(p), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('M2：stale-only 变更（仅删 stale）时 materialized_at 更新', async () => {
  const root = tmpdir();
  const mat = createMaterializer({ root, uid: SELF_UID, gid: SELF_GID });
  const t1 = new Date('2026-09-12T08:30:00.000Z');
  await mat.materialize(snapshot({ materializedAt: t1 }));
  const manifestPath = path.join(root, 'alice', 'home', '.erix', 'manifest.json');
  let prev = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(prev.materialized_at, t1.toISOString());

  // 预置存量项目脚手架（stale 候选）。
  const scaffold = seedLegacyProjectScaffold(root, mat);
  prev = prevManifestWithScaffold(prev);

  const t2 = new Date('2026-09-12T09:00:00.000Z');
  // 无内容变更，只有 stale 删除 → materialized_at 必须更新到 t2。
  await mat.materialize({ ...snapshot({ generation: 2 }), prevManifest: prev, materializedAt: t2 });
  const after = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(after.materialized_at, t2.toISOString());
  for (const p of Object.values(scaffold)) assert.equal(fs.existsSync(p), false);
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
