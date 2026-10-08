// runner/lib/shell-tools.js 单测（issue #72 v1）：echo/退出码/stderr/cwd 边界/超时击杀/输出截断/参数校验。
// issue #211 补：abort signal 中止行为（sleep 30 被叫停、子进程真回收、定时器真清）。
// 隔离约定：进程内 spawn（bash -c），无外部依赖；tmp 目录作 worktree root，不写 /tmp 之外路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createShellTools } from '../lib/shell-tools.js';

async function withShellTools(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-shell-test-'));
  try {
    return await fn(createShellTools({ worktreeRoot: root }), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('shell：echo 与 stdout 捕获（exit_code=0、输出透传）', () =>
  withShellTools(async (tools) => {
    const out = await tools.executors.shell({ command: 'echo hello-shell' });
    assert.match(out, /^exit_code: 0\n/);
    assert.match(out, /duration_ms: \d+\n/);
    assert.match(out, /truncated: false\n/);
    assert.match(out, /hello-shell\n?$/);
  }));

test('shell：非零退出码透传（exit_code=3）', () =>
  withShellTools(async (tools) => {
    const out = await tools.executors.shell({ command: 'exit 3' });
    assert.match(out, /^exit_code: 3\n/);
  }));

test('shell：stderr 捕获（stdout/stderr 拼接进输出体）', () =>
  withShellTools(async (tools) => {
    const out = await tools.executors.shell({ command: 'echo out-line; echo err-line 1>&2' });
    assert.match(out, /out-line/);
    assert.match(out, /err-line/);
  }));

test('shell：cwd 参数生效（pwd 落在 worktree 子目录）', () =>
  withShellTools(async (tools, root) => {
    fs.mkdirSync(path.join(root, 'sub', 'deep'), { recursive: true });
    const out = await tools.executors.shell({ command: 'pwd', cwd: 'sub/deep' });
    assert.match(out, new RegExp(`${path.join(root, 'sub', 'deep').replaceAll('/', '\\/')}\\n?$`));
  }));

test('shell：cwd 默认 worktree 根', () =>
  withShellTools(async (tools, root) => {
    const out = await tools.executors.shell({ command: 'pwd' });
    assert.match(out, new RegExp(`${root.replaceAll('/', '\\/')}\\n?$`));
  }));

test('shell：cwd `..` 逃逸拒绝（含绝对路径）', () =>
  withShellTools(async (tools) => {
    await assert.rejects(() => tools.executors.shell({ command: 'pwd', cwd: '../escape' }), /escapes worktree root/);
    await assert.rejects(() => tools.executors.shell({ command: 'pwd', cwd: 'sub/../../escape' }), /escapes worktree root/);
    await assert.rejects(() => tools.executors.shell({ command: 'pwd', cwd: '/etc' }), /absolute path/);
    // 校验失败必须不给模型返回任何命令输出。
  }));

test('shell：timeout 击杀——promptly 返回且带已捕获输出', () =>
  withShellTools(async (tools) => {
    const startedAt = Date.now();
    const out = await tools.executors.shell({ command: 'echo captured-before-sleep; sleep 5', timeout_ms: 300 });
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 3000, `expected prompt return, took ${elapsed}ms`);
    assert.match(out, /timed out, process group killed/);
    assert.match(out, /captured-before-sleep/);
    assert.match(out, /^exit_code: null \(timed out, process group killed\)\n/);
  }));

test('shell：超长输出截断标记 + 尾部保留', () =>
  withShellTools(async (tools) => {
    // 40000 字节 'x'：超过 32KiB 上限，应截断为标记 + 尾部 32768 字节（结尾 sentinel 必在）。
    const out = await tools.executors.shell({ command: "printf 'x%.0s' $(seq 1 39000); echo; echo TAIL-SENTINEL" });
    assert.match(out, /truncated: true\n/);
    assert.match(out, /output truncated, showing last 32768 bytes/);
    assert.match(out, /TAIL-SENTINEL\n?$/);
    const body = out.slice(out.indexOf('bytes ...]') + 'bytes ...]'.length + 1);
    assert.ok(body.length <= 32768 + 'TAIL-SENTINEL\n'.length, `tail body too large: ${body.length}`);
    // 头部内容已被截掉
    assert.doesNotMatch(out, /^exit_code: 0\ntruncated: true\nx{100}/);
  }));

test('shell：缺 command 校验失败（TypeError）', () =>
  withShellTools(async (tools) => {
    await assert.rejects(() => tools.executors.shell({}), /command must be a non-empty string/);
    await assert.rejects(() => tools.executors.shell({ command: '' }), /command must be a non-empty string/);
  }));

test('shell：timeout_ms 非正数校验失败；超上限封顶到 600000', () =>
  withShellTools(async (tools) => {
    await assert.rejects(() => tools.executors.shell({ command: 'true', timeout_ms: 0 }), /timeout_ms/);
    await assert.rejects(() => tools.executors.shell({ command: 'true', timeout_ms: -5 }), /timeout_ms/);
    // 封顶不拒绝：超大 timeout 也能跑通（真值命令立即返回）
    const out = await tools.executors.shell({ command: 'echo ok', timeout_ms: 9_999_999 });
    assert.match(out, /ok/);
  }));

test('shell：spawn 环境继承 worker env（env 可见）', () =>
  withShellTools(async (tools) => {
    process.env.ERIX_SHELL_TEST_MARKER = 'marker-visible';
    try {
      const out = await tools.executors.shell({ command: 'echo "$ERIX_SHELL_TEST_MARKER"' });
      assert.match(out, /marker-visible/);
    } finally {
      delete process.env.ERIX_SHELL_TEST_MARKER;
    }
  }));

// ---------------------------------------------------------------------------
// issue #211：abort signal 中止行为。
// 这些用例的 timeout_ms 都 **远大于** 断言窗口（60s vs 2s），所以「快」只能来自 signal 转交
// 生效，不可能是超时先到——正好钉住缺陷本身（修前这个用例要挂 30s 且不报错）。
// ---------------------------------------------------------------------------

/** /proc 里 cmdline 含指定串的活动进程 pid 列表（仅 linux；其它平台返回 null 表示不可用）。 */
function pidsWithCmdlineContaining(token) {
  if (process.platform !== 'linux') return null;
  const found = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let cmdline;
    try {
      cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
    } catch { continue; } // 探香期间已退出
    if (cmdline.includes(token)) found.push(Number(entry));
  }
  return found;
}

/** 进程是否还在（含僵尸）：signal 0 探针；ESRCH = 已回收。 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err?.code === 'ESRCH') return false;
    return true; // EPERM 等：进在，只是无权探
  }
}

test('shell：abort 中止 sleep 30——2s 内返回、标为中止、子进程真回收（issue #211）', async () =>
  withShellTools(async (tools, root) => {
    // 用唯一 sleep 时长作残留扫描标记；pid 落盘到 worktree 临时文件（abort 后拿不到命令输出）。
    const SLEEP_MARK = 'sleep 30.211';
    const pidFile = path.join(root, 'erix211.pid');
    const controller = new AbortController();
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 1000);

    let result = null;
    let error = null;
    try {
      // exec 使 sleep 继承 bash 的 pid（= 进程组组长）→ pid 文件既能证「壳没了」也能证「sleep 没了」。
      result = await tools.executors.shell(
        { command: `echo $$ > '${pidFile}'; echo before-sleep; ${SLEEP_MARK}`, timeout_ms: 60_000 },
        { signal: controller.signal },
      );
    } catch (err) {
      error = err;
    }
    const elapsed = Date.now() - startedAt;

    // ① 被标记为中止（而不是一个莫名 failed / 一个假装跑完的正常结果）
    assert.equal(result, null, '中止必须 reject，不能当成正常 tool_result 返回');
    assert.ok(error, 'abort 必须抛出');
    assert.equal(error.name, 'AbortError', `预期 AbortError，实际 ${error.name}: ${error.message}`);
    assert.equal(error.code, 'aborted');
    assert.equal(error.commandAborted, true);

    // ② 2s 内返回（abort 在 1s；超时是 60s，不可能先到）
    assert.ok(elapsed < 2000, `预期 2s 内返回，实际 ${elapsed}ms（超时是 60s，说明 signal 没生效）`);

    // ③ 子进程真回收：ESRCH 同吋排除「僵尸未 reap」与「孤儿还在跑」
    const childPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    assert.ok(Number.isInteger(childPid) && childPid > 0, `pid 文件内容异常: ${childPid}`);
    assert.equal(isProcessAlive(childPid), false, `子进程 ${childPid} 未被回收（僵尸或孤儿）`);

    // ④ 系统里不留残余 sleep（ linux 才查，/proc 依赖）
    const leftover = pidsWithCmdlineContaining(SLEEP_MARK);
    if (leftover !== null) {
      assert.deepEqual(leftover, [], `abort 后仍有残留命令: ${leftover.join(', ')}`);
    }
  }));

test('shell：abort 杀整组——后台子进程一并回收（detached + 负 pid 路径）', () =>
  withShellTools(async (tools, root) => {
    const KID_MARK = 'sleep 30.212';
    const pidFile = path.join(root, 'erix211-group.pid');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 800);
    // 壳 + 一个后台孳孙（不带 exec，两者都在同一进程组）
    const startedAt = Date.now();
    await assert.rejects(
      () => tools.executors.shell(
        { command: `echo $$ > '${pidFile}'; ${KID_MARK} & wait`, timeout_ms: 60_000 },
        { signal: controller.signal },
      ),
      { name: 'AbortError' },
    );
    assert.ok(Date.now() - startedAt < 2500);
    const leftover = pidsWithCmdlineContaining(KID_MARK);
    if (leftover !== null) {
      assert.deepEqual(leftover, [], `进程组里有没被杀的孳子孙: ${leftover.join(', ')}`);
    }
  }));

test('shell：abort 前已中止→不 spawn；不传 signal / context 为空→行为与修前一致', async () =>
  withShellTools(async (tools, root) => {
    // ① 已中止的 signal：直接拒，且不碰磁盘（命令假设写文件，不能出现）
    const pre = new AbortController();
    pre.abort();
    const marker = path.join(root, 'must-not-exist.txt');
    await assert.rejects(
      () => tools.executors.shell({ command: `touch '${marker}'` }, { signal: pre.signal }),
      { name: 'AbortError' },
    );
    assert.equal(fs.existsSync(marker), false, '已中止就不该再 spawn 干活');

    // ② 不传 context / 传空 context / signal 未中止：正常返回，行为逐字不变
    for (const ctx of [undefined, {}, { round: 1 }, { signal: new AbortController().signal }]) {
      const out = await tools.executors.shell({ command: 'echo normal-path' }, ctx);
      assert.match(out, /^exit_code: 0\n/, `context=${JSON.stringify(ctx)} 行为变了`);
      assert.match(out, /normal-path/);
    }

    // ③ 命令在 abort 前就已自然结束：后到的 abort 不得把已定的结果抹掉，也不得报错
    const late = new AbortController();
    const out = await tools.executors.shell({ command: 'echo done-fast' }, { signal: late.signal });
    assert.match(out, /done-fast/);
    assert.doesNotThrow(() => late.abort());
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(out, /done-fast/, '自然结束后 abort 不得影响结果');
  }));

test('shell：abort 后不留存活定时器（否则 worker 会被一个无意义的 60s~3600s timer 顶住）', async () => {
  if (typeof process.getActiveResourcesInfo !== 'function') {
    test.skip?.('Node 无 getActiveResourcesInfo，跳过定时器泄漏检查');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-shell-abort-'));
  try {
    const tools = createShellTools({ worktreeRoot: root });
    const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await assert.rejects(
      () => tools.executors.shell({ command: 'sleep 30', timeout_ms: 900_000 }, { signal: controller.signal }),
      { name: 'AbortError' },
    );
    await new Promise((resolve) => setImmediate(resolve));
    const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    assert.ok(after <= before, `abort 后 Timeout 资塮没清：before=${before} after=${after}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
