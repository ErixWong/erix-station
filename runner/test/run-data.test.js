// runner/lib/run-data.js 单测（issue #46 评审 HIGH 修正）：启动清扫必须带 mtime 保留期——
// 崩溃后待 resume re-claim 的 run 数据目录 mtime 新鲜，绝不可被 sweep 当残留删光。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cleanupRunData,
  prepareRunDataDir,
  runDataDir,
  sweepRunDataDir,
} from '../lib/run-data.js';

function makeEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-rundata-test-'));
  const logs = [];
  const env = {
    home,
    ttlHours: 24,
    workerUid: process.getuid?.() ?? 0,
    workerGid: process.getgid?.() ?? 0,
    log: (level, msg, extra) => logs.push({ level, msg, ...extra }),
  };
  return { home, logs, env, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

// 把目录 mtime 拨到 n 小时前（utimes 同时设 atime/mtime）
function ageDir(dir, hours) {
  const t = new Date(Date.now() - hours * 60 * 60 * 1000);
  fs.utimesSync(dir, t, t);
}

test('sweep：mtime 新鲜的目录保留（崩溃后待 resume re-claim 的 run 不可误删）', () => {
  const { home, env, cleanup } = makeEnv();
  try {
    prepareRunDataDir(home, 'run-fresh');
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
    prepareRunDataDir(home, 'run-stale');
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
    prepareRunDataDir(home, 'run-edge');
    ageDir(runDataDir(home, 'run-edge'), 23.9); // 接近但未超 24h（精确等号受两次 Date.now() 间隔影响，flaky）→ 不删

    sweepRunDataDir(env);

    assert.ok(fs.existsSync(runDataDir(home, 'run-edge')), '边界目录保留（<= TTL 不删）');
  } finally {
    cleanup();
  }
});

test('sweep：ttlHours=0 禁用清扫（一律保留）', () => {
  const { home, env, cleanup } = makeEnv();
  try {
    prepareRunDataDir(home, 'run-old');
    ageDir(runDataDir(home, 'run-old'), 30 * 24); // 30 天前

    sweepRunDataDir({ ...env, ttlHours: 0 });

    assert.ok(fs.existsSync(runDataDir(home, 'run-old')), '禁用清扫时过期目录也保留');
  } finally {
    cleanup();
  }
});

test('cleanupRunData：终态清理删除目录（同 UID 环境直删路径）', () => {
  const { home, env, cleanup } = makeEnv();
  try {
    prepareRunDataDir(home, 'run-done');
    cleanupRunData({ ...env, runId: 'run-done' });
    assert.ok(!fs.existsSync(runDataDir(home, 'run-done')), '终态清理后目录不存在');
    // 幂等：不存在的 runId 不告警不抛
    cleanupRunData({ ...env, runId: 'run-never-existed' });
  } finally {
    cleanup();
  }
});
