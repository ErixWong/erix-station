// issue #392（B 片）：notes **会话作用域**判据。
//
// 病根（现网标本，erix-station 会话 `bdef6dd7`，erix-agent 0.25.0，195 轮 / 12 run）：
// `note_take` 一共只被调用 3 次，而每次写的都是 `scopeRef = runId` ⇒ **下一个 run 的 `note_list`
// 里上一 run 写的一行都不在**。本站是"一条用户消息 = 一个 run"的形态，run 作用域的笔记与它
// 想救的那个上下文同生同灭 ⇒ 天然无效。修法是把作用域抬到会话，而这里要钉住的恰恰是三条
// "看起来接上了、其实没接"的走法：
//   ① `runId` 与 `scopeRef` 都传 —— 引擎的优先级是 **runId 赢**（0.25.0
//      `src/tools/notes.js:628-630`），`scopeRef` 成了一根没人读的旋钮（#331 前例）；
//   ② 抬了作用域却**照旧在 run 收尾调 `completeRun`** —— 它按 scopeRef 批量 active→done
//      （`src/store/notes.js:94`），于是每个 run 结束都把**整个会话**的笔记刷成 done；
//   ③ notesDir 还挂在 `<home>/runs/<runId>/notes` —— run 终态时 `archiveRunData` 会把整条
//      目录 rename 进 `runs-archive/`，笔记跟着 run 走，下个 run 依旧看不见。
// 三格各一条判据；再加 run 作用域的回归格（不传 scopeRef ⇒ 行为逐字不变）。
//
// ⚠ 不 import worker.js（顶层 fork / process.on 副作用，工单明令）；worker 侧只做源码标记段判据。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNotesTools } from '../lib/notes-tools.js';
import { prepareSessionNotesDir, safeSessionScope, sessionNotesDir } from '../lib/run-data.js';

const RUNNER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'station-notes-scope-'));
const SESSION = '2f7c8a94-0f0d-4b1e-9a1c-6a1a2b3c4d5e';

function freshDir(name) {
  return fs.mkdtempSync(path.join(tmpRoot, `${name}-`));
}

const flatten = (value) => JSON.stringify(value ?? null);

test('#392-B1 会话作用域：run A 写的笔记，run B 的 note_list 必须看得见', async () => {
  const notesDir = freshDir('session');
  const a = await createNotesTools({ runId: 'run-A', notesDir, scopeRef: SESSION });
  const taken = await a.executors('note_take', {
    key: 'fold-ledger', content: '第 1–107 轮折走：修 #460 折叠归档 + 契约第 7 步另开 issue',
  });
  assert.equal(taken?.isError, undefined, `note_take 应当成功，实得 ${flatten(taken)}`);

  // **另一个 runId**、同一 scopeRef 与同一 notesDir —— 这就是"用户发了下一条消息"的形状。
  const b = await createNotesTools({ runId: 'run-B', notesDir, scopeRef: SESSION });
  const listed = await b.executors('note_list', {});
  assert.match(flatten(listed), /fold-ledger/u,
    '跨 run 不可见 ⇒ 作用域没抬上去（十有八九是 runId 又把 scopeRef 盖掉了，见 B2）');

  const readBack = await b.executors('note_read', { key: 'fold-ledger' });
  assert.match(flatten(readBack), /#460/u, 'note_read 取不回正文 ⇒ 落到了别的 scope');
});

test('#392-B2 落盘目录必须是 run/<sessionId>，不是 run/<runId>（runId 盖 scopeRef 的锁）', async () => {
  const notesDir = freshDir('shape');
  const tools = await createNotesTools({ runId: 'run-A', notesDir, scopeRef: SESSION });
  await tools.executors('note_take', { key: 'k', content: 'v' });
  const scopeDirs = fs.readdirSync(path.join(notesDir, 'run'), { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name);
  assert.deepEqual(scopeDirs, [SESSION],
    `scope 目录应当只有会话那一个（引擎 file store：${'<notesDir>/run/<scopeRef>'}），实得 ${flatten(scopeDirs)}`);
  assert.ok(!scopeDirs.includes('run-A'),
    '出现了 runId 目录 = `runId` 传进去了并盖掉 `scopeRef`（0.25.0 notes.js:628-630 是 runId 赢）');
});

test('#392-B3 completesRunNotes：会话作用域 false / run 作用域 true（不许每 run 刷 done）', async () => {
  const sessionScoped = await createNotesTools({
    runId: 'run-A', notesDir: freshDir('c1'), scopeRef: SESSION,
  });
  assert.equal(sessionScoped.completesRunNotes, false,
    '会话作用域下 run 收尾不能再调 completeRun（它按 scopeRef 把整个会话的 active 刷成 done）');
  assert.equal(typeof sessionScoped.lifecycle?.onRunComplete, 'function',
    '钩子本体照旧存在——是"不自动调"，不是"没有"');

  const runScoped = await createNotesTools({ runId: 'run-A', notesDir: freshDir('c2') });
  assert.equal(runScoped.completesRunNotes, true,
    '不传 scopeRef ⇒ 旧的 run 作用域行为必须逐字不变（含收尾 completeRun）');
});

test('#392-B4 run 作用域回归：不传 scopeRef 时目录仍是 run/<runId>', async () => {
  const notesDir = freshDir('runscope');
  const tools = await createNotesTools({ runId: 'run-A', notesDir });
  await tools.executors('note_take', { key: 'k', content: 'v' });
  const scopeDirs = fs.readdirSync(path.join(notesDir, 'run')).filter((n) => !n.endsWith('.json'));
  assert.ok(scopeDirs.includes('run-A'), `旧语义丢了：${flatten(scopeDirs)}`);

  // 反向判据：不同 runId、同一 notesDir ⇒ 旧语义下互相看不见（这正是 B1 要治的病）。
  const other = await createNotesTools({ runId: 'run-B', notesDir });
  assert.doesNotMatch(flatten(await other.executors('note_list', {})), /"k"/u,
    '旧语义若变成"看得见"，说明 scopeRef 泄漏进了 run 作用域分支');
});

test('#392-B5 会话目录不进 runs/<runId>：否则会被 run 终态归档一起搬走', () => {
  const dir = sessionNotesDir('/home/erix', SESSION);
  assert.equal(dir, path.join('/home/erix', 'sessions', SESSION, 'notes'));
  assert.ok(!dir.includes(`${path.sep}runs${path.sep}`),
    '挂在 runs/ 下 ⇒ archiveRunData 会把 notes 连目录 rename 进 runs-archive，下个 run 又看不见');
});

test('#392-B6 sessionId 是下行输入，非法形态必须收敛成哈希而不是拼进路径', () => {
  assert.equal(safeSessionScope(SESSION), SESSION, 'UUID 原样（本站常态）');
  for (const bad of ['../../etc/passwd', 'a/b', '', '   ', '..x', 'x'.repeat(200)]) {
    const safe = safeSessionScope(bad);
    assert.match(safe, /^(?:sess-h-[0-9a-f]{24}|[^/\\]+)$/u, `未收敛：${bad} → ${safe}`);
    assert.ok(!safe.includes('/') && !safe.includes('..'),
      `路径里出现了分隔母或 ..：${bad} → ${safe}`);
  }
  assert.equal(safeSessionScope('a/b'), safeSessionScope('a/b'), '同一非法值必须稳定（否则笔记找不回）');
});

test('#392-B7 prepareSessionNotesDir 真建目录且可重复调用（同会话第二个 run 不炸）', () => {
  const home = freshDir('home');
  const ids = { workerUid: process.getuid(), workerGid: process.getgid() };
  const first = prepareSessionNotesDir(home, SESSION, ids);
  const again = prepareSessionNotesDir(home, SESSION, ids);
  assert.equal(first, again);
  assert.ok(fs.statSync(first).isDirectory(), '会话 notes 目录必须真的存在（agentd 在 fork 前备好）');
  assert.equal(fs.statSync(first).mode & 0o777, 0o700,
    '必须 0700 且属主 = worker：file store 每次写都 chmod，属主不对就 EPERM（真机踩过）');
});

test('#392-B8 worker 装配侧：scopeRef 取 sessionId，收尾按标志位分支（防漂移）', async () => {
  const src = fs.readFileSync(path.join(RUNNER_DIR, 'worker.js'), 'utf8');
  const block = src.match(/\/\* #392:notes-session-scope:start \*\/([\s\S]*?)\/\* #392:notes-session-scope:end \*\//);
  assert.ok(block, 'worker.js 必须保留 `/* #392:notes-session-scope:start|end */` 成对标记（装配点被搬走/删掉就先红在这里）');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const out = await new AsyncFunction('runId', 'notesDir', 'sessionId', `
    const calls = [];
    const createNotesTools = (o) => { calls.push(o); return { schemas: [], executeTool: null, lifecycle: null }; };
    ${block[1]}
    return calls[0];`)('run-A', '/tmp/notes', SESSION);
  assert.equal(out.scopeRef, SESSION, 'scopeRef 必须取 sessionId');
  assert.equal(out.notesDir, '/tmp/notes', 'notesDir 仍照旧下行（本片不改下行契约的形状）');
  // 无 session ⇒ scopeRef undefined ⇒ lib 侧退回 run 作用域（逐字旧行为）。
  const noSession = await new AsyncFunction('runId', 'notesDir', 'sessionId', `
    const calls = [];
    const createNotesTools = (o) => { calls.push(o); return {}; };
    ${block[1]}
    return calls[0];`)('run-A', '/tmp/notes', undefined);
  assert.equal(noSession.scopeRef, undefined);
  assert.equal(noSession.runId, 'run-A', '无会话时 runId 必须照旧传出去（旧语义的 scope 就靠它）');

  assert.match(src, /if \(noteTools\.lifecycle && noteTools\.completesRunNotes !== false\) \{/,
    '收尾必须按 `completesRunNotes` 标志位分支：标志位是作用域的另一种说法，两处各自解析就会不一致');
});

test('#392-B9 agentd 侧确实下行会话目录（否则 B1 只在单测里成立）', () => {
  const src = fs.readFileSync(path.join(RUNNER_DIR, 'agentd.js'), 'utf8');
  assert.match(src, /prepareSessionNotesDir/,
    'agentd 必须备会话 notes 目录：worker 只认下行值，没备就是又回到 run 级目录');
  assert.match(src, /import \{[^}]*\bprepareSessionNotesDir\b[^}]*\} from '\.\/lib\/run-data\.js'/,
    '必须从 lib/run-data.js 导入（agentd.js 顶层有 main() 副作用，helpers 一律落在 lib 里才可测）');
  assert.match(src, /notes_dir: ctx\.notesDir \?\? path\.join\(ctx\.runDataPath, 'notes'\)/,
    '下行必须是「会话目录优先、备不出来退回 run 级」：笔记是加分项，不该因为一个目录 EPERM 把 run 打死');
});
