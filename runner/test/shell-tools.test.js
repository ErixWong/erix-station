// runner/lib/shell-tools.js 单测（issue #72 v1）：echo/退出码/stderr/cwd 边界/超时击杀/输出截断/参数校验。
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
