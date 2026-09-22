// runner/lib/notes-tools.js 单测（issue #46）：0.10.0 装配工厂形态——
// createBuiltinNotesTools 公开导出（零深路径 import），宿主作用域由工厂内部强制注入
// （本文件不断言 __erix 细节）；lifecycle.onRunStart/onRunComplete 按上游 bin/cli.js
// 模式工作；notesDir 为 logical-run 作用域（同 runId 跨实例/跨 attempt 保留，resume 不断档）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNotesTools } from '../lib/notes-tools.js';

async function withNotesDir(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-notes-test-'));
  // 模拟 agentd 的 run 数据目录布局：<home>/runs/<runId>/notes
  const notesDir = path.join(tmp, 'runs', 'run-42', 'notes');
  fs.mkdirSync(notesDir, { recursive: true });
  try {
    return await fn(notesDir);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('装配工厂：四个 note_* schemas + executeTool 结构化形态 take → list → read 闭环', () =>
  withNotesDir(async (notesDir) => {
    const tools = await createNotesTools({ runId: 'run-42', notesDir });
    const names = tools.schemas.map((s) => s.name);
    for (const n of ['note_take', 'note_read', 'note_list', 'note_forget']) {
      assert.ok(names.includes(n), `schemas 缺 ${n}`);
    }
    // 工厂全套透出（worker 接线所需视图齐全）
    for (const view of ['definitions', 'executors', 'executeTool', 'lifecycle', 'semanticStateProvider']) {
      assert.ok(tools[view] !== undefined, `工厂返回值缺 ${view}`);
    }
    assert.equal(typeof tools.executeTool, 'function');
    assert.equal(typeof tools.executors, 'function');
    assert.equal(typeof tools.lifecycle.onRunStart, 'function');
    assert.equal(typeof tools.lifecycle.onRunComplete, 'function');

    // executeTool 结构化形态（runToolLoop 调用约定：{id, name, input, context}）
    const taken = JSON.parse(await tools.executeTool({
      id: 'tu-1', name: 'note_take',
      input: { key: 'target', content: 'gold-4173', tags: ['fact'] },
    }));
    assert.equal(taken.status, 'found');
    assert.equal(taken.action, 'saved');

    // 落盘路径校验：<notesDir>/run/<runId>/<key>.json（file store 布局，logical-run 作用域）
    assert.ok(fs.existsSync(path.join(notesDir, 'run', 'run-42', 'target.json')));

    const listed = JSON.parse(await tools.executeTool({ id: 'tu-2', name: 'note_list', input: {} }));
    assert.equal(listed.status, 'found');
    assert.equal(listed.total, 1);
    assert.equal(listed.notes[0].key, 'target');

    const read = JSON.parse(await tools.executeTool({ id: 'tu-3', name: 'note_read', input: { key: 'target' } }));
    assert.equal(read.status, 'found');
    assert.equal(read.value, 'gold-4173');

    // note-first 取回语义：未记录的 key 返回 missing（不猜值）
    const missing = JSON.parse(await tools.executeTool({ id: 'tu-4', name: 'note_read', input: { key: 'never-recorded' } }));
    assert.equal(missing.status, 'missing');

    // executors 位置参数形态与 executeTool 等价视图
    const viaExecutors = JSON.parse(await tools.executors('note_read', { key: 'target' }, {}));
    assert.equal(viaExecutors.value, 'gold-4173');
  }));

test('lifecycle：onRunStart 清扫可调用；onRunComplete 返回 errors[] 且不抛出覆盖主错误', () =>
  withNotesDir(async (notesDir) => {
    const tools = await createNotesTools({ runId: 'run-42', notesDir });

    // onRunStart = janitor：正常路径不抛
    await tools.lifecycle.onRunStart();

    await tools.executeTool({ id: 'tu-1', name: 'note_take', input: { key: 'k', content: 'v' } });

    // onRunComplete = completeRun → janitor：返回 {completed, janitor, errors}
    const completion = await tools.lifecycle.onRunComplete();
    assert.ok(completion && typeof completion === 'object', 'onRunComplete 应返回结果对象');
    assert.ok(Array.isArray(completion.errors), 'errors 必须是数组');
    assert.equal(completion.errors.length, 0, '正常路径 errors[] 为空');
    assert.equal(completion.completed?.status, 'found');

    // completeRun 把 active 笔记归档为 done（24h grace 内 janitor 不回收）：
    // 默认 note_list 只列 active；includeInactive 可见归档（上游语义，resume 读档用 note_read 精确 key 不受影响）
    const active = JSON.parse(await tools.executeTool({ id: 'tu-2', name: 'note_list', input: {} }));
    assert.equal(active.total, 0, 'completeRun 后默认清单只含 active');
    const inactive = JSON.parse(await tools.executeTool({ id: 'tu-3', name: 'note_list', input: { includeInactive: true } }));
    assert.equal(inactive.total, 1, 'includeInactive 可见 done 归档');
  }));

test('resume 语义：同一 runId + notesDir 的两个独立实例写读不断档（跨 attempt 保留）', () =>
  withNotesDir(async (notesDir) => {
    // attempt N：worker 崩溃路径——无 onRunComplete（笔记保持 active），run 被 release 重排队
    const attempt1 = await createNotesTools({ runId: 'run-42', notesDir });
    await attempt1.lifecycle.onRunStart();
    const taken = JSON.parse(await attempt1.executeTool({
      id: 'tu-1', name: 'note_take', input: { key: 'checkpoint', content: 'progress-88' },
    }));
    assert.equal(taken.status, 'found');

    // attempt N+1（resume=true，全新实例模拟新 worker 进程）——note-first 取回前序 attempt 的 notes
    const attempt2 = await createNotesTools({ runId: 'run-42', notesDir });
    await attempt2.lifecycle.onRunStart();
    const read = JSON.parse(await attempt2.executeTool({ id: 'tu-2', name: 'note_read', input: { key: 'checkpoint' } }));
    assert.equal(read.status, 'found', 'resume attempt 必须读到前一 attempt 的 note');
    assert.equal(read.value, 'progress-88');

    const listed = JSON.parse(await attempt2.executeTool({ id: 'tu-3', name: 'note_list', input: {} }));
    assert.equal(listed.total, 1, 'note 目录跨实例连续');
  }));

test('scope 非 run → unsupported（上游工厂语义保留）', () =>
  withNotesDir(async (notesDir) => {
    const tools = await createNotesTools({ runId: 'run-43', notesDir });
    const out = JSON.parse(await tools.executeTool({ id: 'tu-1', name: 'note_take', input: { key: 'k', content: 'v', scope: 'user' } }));
    assert.equal(out.status, 'unsupported');
  }));
