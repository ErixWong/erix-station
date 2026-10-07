// runner/lib/run-data.js 单测（issue #46 评审 HIGH 修正 + issue #64 R1 配套归档修正）：
//  - 启动清扫必须带 mtime 保留期——崩溃后待 resume re-claim 的 run 数据目录 mtime 新鲜，
//    绝不可被 sweep 当残留删光（runs/ 扫描）；
//  - 终态清场是**归档**（runs/ → runs-archive/，conversation-state.md §5 P1 真相层归档 TTL 替代
//    物理删除），runs-archive/ 超归档 TTL 才物理删除，TTL=0 禁用对应扫描。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  archiveRunData,
  moveDir,
  prepareRunDataDir,
  runArchiveDir,
  runDataDir,
  sweepRunDataDir,
} from '../lib/run-data.js';

function makeEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-rundata-test-'));
  const logs = [];
  const env = {
    home,
    ttlHours: 24,
    archiveTtlHours: 168,
    workerUid: process.getuid?.() ?? 0,
    workerGid: process.getgid?.() ?? 0,
    log: (level, msg, extra) => logs.push({ level, msg, ...extra }),
  };
  return { home, logs, env, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test('prepareRunDataDir：run 目录由 agentd 创建，notes 由 worker 创建为 0700', () => {
  const { home, env, cleanup } = makeEnv();
  try {
    const originalUmask = process.umask(0o002);
    try {
      prepareRunDataDir(home, 'run-permissions', env);
    } finally {
      process.umask(originalUmask);
    }

    const runDir = runDataDir(home, 'run-permissions');
    const notesDir = path.join(runDir, 'notes');
    const runStat = fs.statSync(runDir);
    const notesStat = fs.statSync(notesDir);
    assert.equal(runStat.uid, process.getuid(), 'run 目录仍由 agentd 身份创建');
    assert.equal(runStat.gid, process.getgid(), 'run 目录仍由 agentd 组拥有');
    assert.equal(runStat.mode & 0o777, 0o775, 'run 目录仍保持 agentd 的 0775 模式');
    assert.equal(notesStat.uid, env.workerUid, 'notes 目录属于 worker UID');
    assert.equal(notesStat.gid, env.workerGid, 'notes 目录属于 worker GID');
    assert.equal(notesStat.mode & 0o777, 0o700, 'notes 目录权限为 0700');
  } finally {
    cleanup();
  }
});

// 把目录 mtime 拨到 n 小时前（utimes 同时设 atime/mtime）
function ageDir(dir, hours) {
  const t = new Date(Date.now() - hours * 60 * 60 * 1000);
  fs.utimesSync(dir, t, t);
}

test('sweep：mtime 新鲜的目录保留（崩溃后待 resume re-claim 的 run 不可误删）', () => {
  const { home, env, cleanup } = makeEnv();
  try {
    prepareRunDataDir(home, 'run-fresh', env);
    // 模拟 worker 写入 notes 后的状态（目录树存在且 mtime 新鲜）
    fs.writeFileSync(path.join(runDataDir(home, 'run-fresh'), 'notes', 'marker'), 'x');

    sweepRunDataDir(env);

    assert.ok(fs.existsSync(runDataDir(home, 'run-fresh')), '新鲜目录必须保留');
    assert.ok(fs.existsSync(path.join(runDataDir(home, 'run-fresh'), 'notes', 'marker')));
  } finally {
    cleanup();
  }
});

test('sweep：mtime 超过保留期的目录被清扫（fs.utimes 造旧时间戳）', () => {
  const { home, logs, env, cleanup } = makeEnv();
  try {
    prepareRunDataDir(home, 'run-stale', env);
    ageDir(runDataDir(home, 'run-stale'), 25); // 保留期 24h → 过期 1h

    sweepRunDataDir(env);

    assert.ok(!fs.existsSync(runDataDir(home, 'run-stale')), '过期目录必须被清扫');
    assert.ok(logs.some((l) => l.msg === 'swept stale run data dir' && l.run_id === 'run-stale'));
  } finally {
    cleanup();
  }
});

test('sweep：保留期内（接近但未超 TTL）的目录保留', () => {
  const { home, env, cleanup } = makeEnv();
  try {
    prepareRunDataDir(home, 'run-edge', env);
    ageDir(runDataDir(home, 'run-edge'), 23.9); // 接近但未超 24h（精确等号受两次 Date.now() 间隔影响，flaky）→ 不删

    sweepRunDataDir(env);

    assert.ok(fs.existsSync(runDataDir(home, 'run-edge')), '边界目录保留（<= TTL 不删）');
  } finally {
    cleanup();
  }
});

test('sweep：ttlHours=0 禁用 runs/ 清扫（一律保留）', () => {
  const { home, env, cleanup } = makeEnv();
  try {
    prepareRunDataDir(home, 'run-old', env);
    ageDir(runDataDir(home, 'run-old'), 30 * 24); // 30 天前

    sweepRunDataDir({ ...env, ttlHours: 0 });

    assert.ok(fs.existsSync(runDataDir(home, 'run-old')), '禁用清扫时过期目录也保留');
  } finally {
    cleanup();
  }
});

test('archiveRunData：终态清场把 runs/<runId> 归档进 runs-archive/（不再物理删除）', () => {
  const { home, env, cleanup } = makeEnv();
  try {
    prepareRunDataDir(home, 'run-done', env);
    fs.writeFileSync(path.join(runDataDir(home, 'run-done'), 'notes', 'note.md'), '# truth');

    archiveRunData({ ...env, runId: 'run-done' });

    assert.ok(!fs.existsSync(runDataDir(home, 'run-done')), '归档后 runs/ 目录不存在');
    const archived = runArchiveDir(home, 'run-done');
    assert.ok(fs.existsSync(archived), '归档目录存在于 runs-archive/');
    // 真相层内容完整保留（transcript/notes 不丢）
    assert.equal(fs.readFileSync(path.join(archived, 'notes', 'note.md'), 'utf8'), '# truth');
    // 归档时刻刷新 mtime（归档 TTL 从归档起算，长 run 不会「先天过期」）
    const { mtimeMs } = fs.statSync(archived);
    assert.ok(Date.now() - mtimeMs < 60 * 1000, '归档目录 mtime 刷新为归档时刻');
    // 幂等：不存在的 runId 不告警不抛
    archiveRunData({ ...env, runId: 'run-never-existed' });
  } finally {
    cleanup();
  }
});

test('archiveRunData：同名旧归档先清再移（防御异常残留）', () => {
  const { home, env, cleanup } = makeEnv();
  try {
    prepareRunDataDir(home, 'run-dup', env);
    fs.writeFileSync(path.join(runDataDir(home, 'run-dup'), 'notes', 'new.md'), 'new');
    // 预置同名旧归档（含旧内容）
    fs.mkdirSync(path.join(runArchiveDir(home, 'run-dup'), 'notes'), { recursive: true });
    fs.writeFileSync(path.join(runArchiveDir(home, 'run-dup'), 'notes', 'old.md'), 'old');

    archiveRunData({ ...env, runId: 'run-dup' });

    const archived = runArchiveDir(home, 'run-dup');
    assert.ok(fs.existsSync(path.join(archived, 'notes', 'new.md')), '新归档内容就位');
    assert.ok(!fs.existsSync(path.join(archived, 'notes', 'old.md')), '同名旧归档被替换');
  } finally {
    cleanup();
  }
});

test('moveDir：EXDEV 跨设备 fallback——递归复制后删源（mock fsImpl）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-movedir-test-'));
  try {
    const src = path.join(home, 'src');
    fs.mkdirSync(path.join(src, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(src, 'notes', 'a.md'), 'A');

    // mock：renameSync 抛 EXDEV（跨设备），cpSync/rmSync 走真实 fs
    const calls = [];
    const fakeFs = {
      renameSync: () => {
        const err = new Error('cross-device link not permitted');
        err.code = 'EXDEV';
        throw err;
      },
      cpSync: (...args) => { calls.push('cp'); return fs.cpSync(...args); },
      rmSync: (...args) => { calls.push('rm'); return fs.rmSync(...args); },
    };
    const dest = path.join(home, 'dest');
    moveDir(src, dest, fakeFs);

    assert.deepEqual(calls, ['cp', 'rm'], 'EXDEV 时先复制后删源');
    assert.ok(!fs.existsSync(src), '源已删除');
    assert.equal(fs.readFileSync(path.join(dest, 'notes', 'a.md'), 'utf8'), 'A', '内容完整复制');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('moveDir：非 EXDEV 错误原样抛出（不落入复制兜底）', () => {
  const fakeFs = {
    renameSync: () => {
      const err = new Error('permission denied');
      err.code = 'EACCES';
      throw err;
    },
  };
  assert.throws(() => moveDir('/nonexistent-src', '/nonexistent-dst', fakeFs), /permission denied/);
});

test('archiveRunData：归档失败仅 warn 不抛出（残留留给启动 sweep）', () => {
  const { home, logs, env, cleanup } = makeEnv();
  try {
    prepareRunDataDir(home, 'run-fail', env);
    // 让归档根不可建：<home>/runs-archive 被同名**文件**占据 → mkdirSync 必失败，
    // 直路失败落入 worker-uid helper 后 helper 内同款 mkdirSync 也必失败（与 UID 无关，确定性）。
    fs.writeFileSync(path.join(home, 'runs-archive'), 'blocker');

    archiveRunData({ ...env, runId: 'run-fail' });

    assert.ok(logs.some((l) => l.level === 'warn' && l.msg === 'run data archive failed, left for startup sweep' && l.run_id === 'run-fail'));
    assert.ok(fs.existsSync(runDataDir(home, 'run-fail')), '失败时目录残留（留给 sweep 兜底）');
  } finally {
    cleanup();
  }
});

test('sweep：runs-archive/ 超归档 TTL 的归档被物理删除', () => {
  const { home, logs, env, cleanup } = makeEnv();
  try {
    // 已归档的终态 run（mtime 拨到 200h 前 > 168h TTL）
    const archived = runArchiveDir(home, 'run-archived');
    fs.mkdirSync(path.join(archived, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(archived, 'notes', 'old.md'), 'x');
    ageDir(archived, 200);

    sweepRunDataDir(env);

    assert.ok(!fs.existsSync(archived), '超归档 TTL 的归档被物理删除');
    assert.ok(logs.some((l) => l.msg === 'swept stale archived run data dir' && l.run_id === 'run-archived'));
  } finally {
    cleanup();
  }
});

test('sweep：runs-archive/ 保留期内的归档保留（真相层未过期不删）', () => {
  const { home, env, cleanup } = makeEnv();
  try {
    const archived = runArchiveDir(home, 'run-arch-fresh');
    fs.mkdirSync(path.join(archived, 'notes'), { recursive: true });
    ageDir(archived, 100); // < 168h

    sweepRunDataDir(env);

    assert.ok(fs.existsSync(archived), '保留期内的归档保留');
  } finally {
    cleanup();
  }
});

test('sweep：archiveTtlHours=0 禁用归档清扫（超期归档也保留），runs/ 扫描不受影响', () => {
  const { home, env, cleanup } = makeEnv();
  try {
    // 超期归档：禁用后保留
    const archived = runArchiveDir(home, 'run-arch-old');
    fs.mkdirSync(path.join(archived, 'notes'), { recursive: true });
    ageDir(archived, 30 * 24);
    // runs/ 超期残留：仍应被清扫（两个扫描各自独立开关）
    prepareRunDataDir(home, 'run-stale', env);
    ageDir(runDataDir(home, 'run-stale'), 25);

    sweepRunDataDir({ ...env, archiveTtlHours: 0 });

    assert.ok(fs.existsSync(archived), '归档清扫禁用时超期归档保留');
    assert.ok(!fs.existsSync(runDataDir(home, 'run-stale')), 'runs/ 扫描不受归档开关影响');
  } finally {
    cleanup();
  }
});
