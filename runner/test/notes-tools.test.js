// runner/lib/notes-tools.js 单测：note 工作流（0.8.0 recall 退役后的档案取回路径）。
// 复用上游 notes 技能模块 + erix-agent createFileNotesStore；落盘必须在 run worktree 内（tmp 模拟）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNotesTools } from '../lib/notes-tools.js';

async function withWorktree(fn) {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-notes-test-'));
  try {
    return await fn(worktree);
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
}

test('note 工具：take → list → read 闭环，落盘在 worktree 内', () =>
  withWorktree(async (worktree) => {
    const { schemas, executors } = await createNotesTools({ runId: 'run-42', notesDir: path.join(worktree, '.notes') });
    const names = schemas.map((s) => s.name);
    for (const n of ['note_take', 'note_read', 'note_list', 'note_forget']) {
      assert.ok(names.includes(n), `schema 缺 ${n}`);
    }

    const taken = JSON.parse(await executors.note_take({ key: 'target', content: 'gold-4173', tags: ['fact'] }));
    assert.equal(taken.status, 'found');
    assert.equal(taken.action, 'saved');

    // 落盘路径校验：worktree/.notes 下、且 scopeRef 目录为 run-42 的 canonical 形态
    const notesRoot = path.join(worktree, '.notes');
    assert.ok(fs.existsSync(notesRoot), 'notes 落盘在 run worktree 内');
    assert.ok(fs.existsSync(path.join(notesRoot, 'run', 'run-42', 'target.json')));

    const listed = JSON.parse(await executors.note_list({}));
    assert.equal(listed.status, 'found');
    assert.equal(listed.total, 1);
    assert.equal(listed.notes[0].key, 'target');

    const read = JSON.parse(await executors.note_read({ key: 'target' }));
    assert.equal(read.status, 'found');
    assert.equal(read.value, 'gold-4173');

    // 模型注入 __erix 被过滤（宿主作用域不可被覆盖）
    const injected = JSON.parse(await executors.note_read({ key: 'target', __erix: { runId: 'other' } }));
    assert.equal(injected.value, 'gold-4173', '__erix 注入不得改变宿主作用域');

    // note-first 取回语义：未记录的 key 返回 missing（不猜值）
    const missing = JSON.parse(await executors.note_read({ key: 'never-recorded' }));
    assert.equal(missing.status, 'missing');
  }));

test('note 工具：scope 非 run → unsupported（与上游技能一致）', () =>
  withWorktree(async (worktree) => {
    const { executors } = await createNotesTools({ runId: 'run-43', notesDir: path.join(worktree, '.notes') });
    const out = JSON.parse(await executors.note_take({ key: 'k', content: 'v', scope: 'user' }));
    assert.equal(out.status, 'unsupported');
  }));
