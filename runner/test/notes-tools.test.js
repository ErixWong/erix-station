// runner/lib/notes-tools.js 单测（issue #46）：0.10.0 装配工厂形态——
// createBuiltinNotesTools 公开导出（零深路径 import），宿主作用域由工厂内部强制注入
// （本文件不断言 __erix 细节）；lifecycle 仅调用 onRunComplete；notesDir 为 logical-run
// 作用域（同 runId 跨实例/跨 attempt 保留，resume 不断档）。
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
    assert.equal(tools.lifecycle.onRunStart, undefined, '0.12.0 起不再提供 run-start maintenance hook');
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
    assert.equal(listed.count, 1);
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

test('lifecycle：onRunComplete 只完成 active notes，返回 completed 包装和 errors[]', () =>
  withNotesDir(async (notesDir) => {
    const tools = await createNotesTools({ runId: 'run-42', notesDir });

    await tools.executeTool({ id: 'tu-1', name: 'note_take', input: { key: 'k', content: 'v' } });

    // onRunComplete 只做 completeRun（active → done），不运行 purge/janitor。
    const completion = await tools.lifecycle.onRunComplete();
    assert.ok(completion && typeof completion === 'object', 'onRunComplete 应返回结果对象');
    assert.ok(Array.isArray(completion.errors), 'errors 必须是数组');
    assert.equal(completion.errors.length, 0, '正常路径 errors[] 为空');
    assert.equal(completion.completed?.status, 'found');
    assert.equal(completion.completed?.completed, 1);

    // 默认 note_list 只列 active；includeInactive 可见归档。
    const active = JSON.parse(await tools.executeTool({ id: 'tu-2', name: 'note_list', input: {} }));
    assert.equal(active.count, 0, 'completeRun 后默认清单只含 active');
    const inactive = JSON.parse(await tools.executeTool({ id: 'tu-3', name: 'note_list', input: { includeInactive: true } }));
    assert.equal(inactive.count, 1, 'includeInactive 可见 done 归档');
  }));

test('resume 语义：同一 runId + notesDir 的两个独立实例写读不断档（跨 attempt 保留）', () =>
  withNotesDir(async (notesDir) => {
    // attempt N：worker 崩溃路径——无 onRunComplete（笔记保持 active），run 被 release 重排队
    const attempt1 = await createNotesTools({ runId: 'run-42', notesDir });
    const taken = JSON.parse(await attempt1.executeTool({
      id: 'tu-1', name: 'note_take', input: { key: 'checkpoint', content: 'progress-88' },
    }));
    assert.equal(taken.status, 'found');

    // attempt N+1（resume=true，全新实例模拟新 worker 进程）——note-first 取回前序 attempt 的 notes
    const attempt2 = await createNotesTools({ runId: 'run-42', notesDir });
    const read = JSON.parse(await attempt2.executeTool({ id: 'tu-2', name: 'note_read', input: { key: 'checkpoint' } }));
    assert.equal(read.status, 'found', 'resume attempt 必须读到前一 attempt 的 note');
    assert.equal(read.value, 'progress-88');

    const listed = JSON.parse(await attempt2.executeTool({ id: 'tu-3', name: 'note_list', input: {} }));
    assert.equal(listed.count, 1, 'note 目录跨实例连续');
  }));

test('scope 非 run → invalid（0.12.0 schema 收敛为 run-only）', () =>
  withNotesDir(async (notesDir) => {
    const tools = await createNotesTools({ runId: 'run-43', notesDir });
    const out = JSON.parse(await tools.executeTool({ id: 'tu-1', name: 'note_take', input: { key: 'k', content: 'v', scope: 'user' } }));
    assert.equal(out.status, 'invalid');
  }));

// ADR-015：semanticStateProvider 透出并符合 runToolLoop
// 宿主契约（docs/host-consumer-contract.md §Run state）——引擎折叠重建 run state 时以
// {runId, state, previous} 回调，返回 {text, version, status}；version 回声 state.stateVersion；
// store list 失败/无 active note 时返回 undefined（引擎按「未提供」跳过 semantic 段）。
test('semanticStateProvider：透出工厂目录视图，回调返回契约结构 {text, version, status}', () =>
  withNotesDir(async (notesDir) => {
    const tools = await createNotesTools({ runId: 'run-42', notesDir });
    assert.equal(typeof tools.semanticStateProvider, 'function', '工厂应透出 semanticStateProvider');

    // 无 active note → undefined（引擎降级：不注入 semantic 段）
    const empty = await tools.semanticStateProvider({ state: { stateVersion: 3 } });
    assert.equal(empty, undefined);

    // take 一条 active note → 目录渲染（ADR-015：active only、pinned 优先、updated_at 序）
    await tools.executeTool({ id: 'tu-1', name: 'note_take', input: { key: 'target', content: 'gold-4173' } });
    const provided = await tools.semanticStateProvider({ state: { stateVersion: 7 } });
    assert.ok(provided && typeof provided === 'object');
    assert.equal(provided.status, 'ok');
    assert.equal(provided.version, 7, 'version 必须回声 payload.state.stateVersion（防 stale 标记）');
    assert.match(provided.text, /\[notes 小抄目录\]/);
    assert.match(provided.text, /target/);

    // 无参调用也安全（引擎回调形态之外的人为调用兜底）
    const bare = await tools.semanticStateProvider();
    assert.ok(bare && bare.text.includes('target'));
  }));

test('semanticStateProvider：store list 失败 → 返回 undefined 不抛出（引擎降级路径）', () =>
  withNotesDir(async (notesDir) => {
    // 预塞损坏的 store 布局：run 子目录占位成普通文件 → file store list 抛错
    fs.mkdirSync(path.join(notesDir, 'run'), { recursive: true });
    fs.writeFileSync(path.join(notesDir, 'run', 'run-42'), 'not-a-dir');
    const tools = await createNotesTools({ runId: 'run-42', notesDir });
    const provided = await tools.semanticStateProvider({ state: { stateVersion: 1 } });
    assert.equal(provided, undefined, 'list 失败必须静默降级为 undefined，不抛穿引擎');
  }));
