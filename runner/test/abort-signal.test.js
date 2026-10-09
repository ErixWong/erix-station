// issue #211：abort signal 传递链契约测试。
// 两层：
//  A. 源码级断言（本文件核心）——把「executeTool 包装必须把 signal 转交自带工具」钉成测试。
//     这字段在上游契约里太容易漏：引擎把它放在 executeTool options 的**顶层**，而宿主
//     registry.executeTool 是 (name, input, context) 三位置参数、没有 signal 槽位，任何一次
//     「顺手清理包装函数」的重构都会静默丢掉它（不报错、不失败，只是「停止」变慢 60s~3600s）。
//     所以这里不测行为、直接钉源码形态，并顺手钉住上游契约仍在传 signal。
//  B. lib/abort.js 自身语义（onAbort 摘除、throwIfAborted 形状）。
// 隔离约定：纯读源码 + 内存对象，不碰真实环境。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { abortError, onAbort, throwIfAborted, yieldToEventLoop } from '../lib/abort.js';

const RUNNER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(RUNNER_DIR, rel), 'utf8');

/** 读上游 erix-agent 的文件工具源码（issue #228 后，遍历内真中断的实现住在上游）。
 * erix-agent 的 exports 只暴露 . / ./tools / ./contract-tests，不能 require.resolve 子路径文件，
 * 所以走「解析包根 + 拼路径」（与下方「上游契约仍在传 signal」那条用例同技法）。 */
function readUpstreamFileToolsSource() {
  const require = createRequire(import.meta.url);
  const pkgRoot = path.dirname(path.dirname(require.resolve('erix-agent')));
  return fs.readFileSync(path.join(pkgRoot, 'src', 'tools', 'file-tools.js'), 'utf8');
}

/** 抠出 `const executeTool = async (options) => {` 到配对 `};` 的函数体（源码级断言用）。 */
function extractExecuteToolWrapper(src) {
  const start = src.indexOf('const executeTool = async (options) =>');
  assert.notEqual(start, -1, 'worker.js 必须仍有 `const executeTool = async (options) =>` 包装');
  const end = src.indexOf('\n  };', start);
  assert.notEqual(end, -1, 'executeTool 包装函数体收尾没找到');
  return src.slice(start, end);
}

// --- A. 源码级契约钉 ------------------------------------------------------

test('issue #211：worker.js executeTool 包装把 signal 转交 registry（自带 file/shell 工具能收到中止）', () => {
  const body = extractExecuteToolWrapper(read('worker.js'));

  // ① 必须出现 signal 转交
  assert.match(body, /registry\.executeTool\(/, '包装必须经 registry.executeTool 派发');
  assert.match(body, /signal\s*:\s*options\.signal/,
    'issue #211 回归：executeTool 包装必须把 options.signal 注入下发给自带工具；'
    + '丢了它 shell/rg 收不到中止，用户点「停止」要等满 shell 超时（默认 60s，env 上限 3600s）才停');

  // ② 禁止退回「只转 name/input/context」的三位置参数形态（缺陷原始形态）
  assert.doesNotMatch(
    body,
    /registry\.executeTool\(\s*options\.name,\s*options\.input,\s*options\.context\s*\)/,
    'issue #211 回归：不允许退回 registry.executeTool(name, input, context) 三参形态——该形态没有 signal 槽位',
  );

  // ③ context 必须仍被转交（不能为了塞 signal 把 context 丢了）
  assert.match(body, /\.\.\.options\.context/, 'context 仍须整体转交（engine 注入的 round/上下文）');
});

test('issue #211：shell/file 工具执行器都从 context 取 signal（链路下游两段都在）', (t) => {
  const shellSrc = read('lib/shell-tools.js');
  assert.match(shellSrc, /async function shell\([\s\S]{0,200}?context\s*=\s*\{\}\)/,
    'shell 执行器必须接第二参 context');
  assert.match(shellSrc, /signal\s*:\s*context\?\.signal/,
    'shell 执行器必须把 context.signal 传给 runCommand');
  assert.match(shellSrc, /function runCommand\(\{[^}]*\bsignal\b[^}]*\}\)/,
    'runCommand 签名必须含 signal');
  // 中止必须复用既有进程组 SIGKILL（而不是新增一条只 resolve 不杀进程的假中止）
  assert.match(shellSrc, /process\.kill\(-child\.pid,\s*'SIGKILL'\)/,
    '进程组 SIGKILL 路径必须保留');
  assert.match(shellSrc, /removeAbortListener\(\)/,
    '收尾必须摘 abort 监听（防在长寿命 run signal 上堆监听器）');

  const fileSrc = read('lib/file-tools.js');
  // issue #228：fork 的四个 executor 已退役，file 工具的真中断实现搬到上游，所以本文件的
  // 「下游」分成三段钉：装配层入口查中止 + context/signal 真的下给上游 + 上游自己仍在遍历内检查。
  assert.match(fileSrc, /import \{ createFileTools as createUpstreamFileTools \} from 'erix-agent\/tools'/,
    'file 工具必须装配上游 erix-agent/tools 的 createFileTools（不得退回本地 fork）');
  assert.match(fileSrc, /throwIfAborted\(signal\)/,
    '装配层必须在入口检查中止（上游 readFile/writeFile/edit 不接 context，这一枪只能宿主补）');
  assert.match(fileSrc, /isStructuredCall\(firstArg\)[\s\S]{0,120}firstArg\.signal[\s\S]{0,80}firstArg\.context\?\.signal/,
    '结构化调用形态的 signal（引擎放在顶层）也必须被装配层读到');
  assert.match(fileSrc, /upstream\.executeTool\(firstArg\)/,
    '结构化调用形态必须整体下给上游（否则上游 checkpoint 拿不到 signal，遍历不能真中断）');
  assert.match(fileSrc, /upstream\.executeTool\(firstArg, input, context\)/,
    '位置形态必须把 context 原样下给上游（中止与引擎上下文都搭在里面）');

  // 上游侧：每 32 项让出 + 查中止的实现必须还在（上游把它删了 = station 的「停止」变慢，立刻知道）
  let upstreamFile = null;
  try {
    upstreamFile = readUpstreamFileToolsSource();
  } catch {
    t.skip('erix-agent 未安装（runner 单测进程解析不到包根），跳过上游遍历检查点钉');
    return;
  }
  assert.match(upstreamFile, /const ABORT_CHECKPOINT_EVERY = 32/,
    '上游遍历检查点间隔变了：需复核「同步遍历期间能收到 MSG.ABORT」这条保证是否仍在（issue #211 / #228）');
  assert.match(upstreamFile, /await new Promise\(\(resolve\) => setImmediate\(resolve\)\);\s*\n\s*throwIfAborted\(signal\)/,
    '上游遍历必须先让出事件循环再查中止（不让出的 abort 是永远为 false 的空检查，issue #211）');
});

test('issue #211：上游 erix-agent 契约仍在 executeTool 上传 signal（引擎侧变了要立刻知道）', (t) => {
  let pkgRoot;
  try {
    const require = createRequire(import.meta.url);
    pkgRoot = path.dirname(path.dirname(require.resolve('erix-agent')));
  } catch {
    t.skip('erix-agent 未安装（runner 单测进程解析不到包根），跳过上游契约钉');
    return;
  }
  const exec = fs.readFileSync(path.join(pkgRoot, 'src/loop/run-snapshot-executor.js'), 'utf8');
  const orch = fs.readFileSync(path.join(pkgRoot, 'src/loop/orchestrator.js'), 'utf8');
  assert.match(exec, /signal:\s*ctx\.toolSignal/,
    '上游 executeTool options 里的 signal 字段名/来源变了：宿主侧转交口径需同步复核（issue #211）');
  assert.match(orch, /const toolSignal = signal \?\? new AbortController\(\)\.signal/,
    '上游 toolSignal 装配点变了：宿主侧转交口径需同步复核（issue #211）');
});

// --- B. lib/abort.js 语义 -------------------------------------------------

test('abort.js：throwIfAborted 未中止不抛；已中止的错误形态对齐上游 abort.js（reason 是 Error 就原样透传）', () => {
  const ctrl = new AbortController();
  assert.doesNotThrow(() => throwIfAborted(ctrl.signal));
  assert.doesNotThrow(() => throwIfAborted(undefined));

  // 上游 abort.js:1-3：reason instanceof Error → 原样返回该对象（保调用方的错误身份/堆栈），
  // 不强制改写成 AbortError——这里钉住这个语义，避免以后有人「顺手」统一改写而弄碎上游对齐。
  const reason = new Error('stop clicked');
  ctrl.abort(reason);
  assert.throws(() => throwIfAborted(ctrl.signal), (err) => {
    assert.equal(err, reason, 'reason Error 必须原样透传（同一个对象）');
    assert.match(err.message, /stop clicked/);
    return true;
  });

  // 无自定义 reason：Node 默认 reason 是 DOMException（name='AbortError'），同样走透传
  const plain = new AbortController();
  plain.abort();
  assert.throws(() => throwIfAborted(plain.signal), { name: 'AbortError' });
  // reason 不是 Error（字符串 reason）走字符串文案分支，name 固定 AbortError
  const strReason = new AbortController();
  strReason.abort('user stop');
  assert.throws(() => throwIfAborted(strReason.signal), (err) => {
    assert.equal(err.name, 'AbortError');
    assert.match(err.message, /user stop/);
    return true;
  });
  // 无 signal 也能造（默认文案）
  assert.equal(abortError(undefined).name, 'AbortError');
  assert.match(abortError(undefined).message, /operation was aborted/);
});

test('abort.js：onAbort 已中止立刻执行并空摘除；未中止挂监听、摘除后不再触发', () => {
  const ctrl = new AbortController();
  let hits = 0;
  const remove = onAbort(ctrl.signal, () => { hits += 1; });
  assert.equal(hits, 0);
  remove(); // 未 abort 就摘除
  ctrl.abort();
  assert.equal(hits, 0, '摘除后 abort 不应再触发 handler');

  const ctrl2 = new AbortController();
  ctrl2.abort();
  const remove2 = onAbort(ctrl2.signal, () => { hits += 1; });
  assert.equal(hits, 1, '传入已中止的 signal 必须立刻执行 handler');
  assert.doesNotThrow(() => remove2());

  // 假 signal（只给 aborted getter，无 addEventListener）退化为空操作，不炸
  assert.doesNotThrow(() => onAbort({ aborted: false }, () => {})());
  assert.doesNotThrow(() => onAbort(undefined, () => {})());
});

test('abort.js：yieldToEventLoop 真的让出一轮（setImmediate 语义）', async () => {
  let flag = false;
  Promise.resolve().then(() => { flag = true; }); // microtask：不让轮不会跑
  await yieldToEventLoop();
  assert.equal(flag, true);
});
