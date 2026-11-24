// check-doc-portable 的行为夹具（issue docs-261124-31）。
// CLI 的扫描范围是从**脚本自己的文件位置**推 ROOT（`path.resolve(__dirname, '..')`）⇒
// 夹具必须在**副本**上跑（把 CLI 复制进 `<夹具>/scripts/`）：否则测的是被扫的仓库、
// 而不是夹具的 `.md`。照 test/agents-hotlayer.test.js 的夹具写法。
// ⚠ 本文件是 `*.js`，会被闸扫到**注释行**——故注释里不许写 DENY 词字面量；夹具用的脏词一律放进
//   writeFileSync 的**代码行**（非注释），断言正则同理。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts/check-doc-portable.mjs');

/** 在临时 git 仓库里跑 CLI 副本，返回 { rc, out }。 */
function runRepo(dir, fn) {
  const sh = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  sh(['init', '-q']);
  sh(['config', 'user.email', 'test@test.local']);
  sh(['config', 'user.name', 'test']);
  fn(dir);
  sh(['add', '-A']);
  try {
    const stdout = execFileSync('node', [path.join(dir, 'scripts/check-doc-portable.mjs')], { encoding: 'utf8' });
    return { rc: 0, out: stdout };
  } catch (e) {
    /** @type {any} */ const err = e;
    const out = `${err.stdout || ''}${err.stderr || ''}`;
    return { rc: typeof err.status === 'number' ? err.status : -1, out };
  }
}

const fixture = (fn) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'docport-'));
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  copyFileSync(CLI, path.join(dir, 'scripts/check-doc-portable.mjs'));
  try {
    return runRepo(dir, fn);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// ① 真仓库（工作树）跑 exit 0 —— 这是「仓库文档现在真的可公开」
test('真仓库跑 check:doc-portable exit 0', () => {
  const out = execFileSync('node', [CLI], { encoding: 'utf8' });
  assert.match(out, /check:doc-portable ok/);
});

// ② 夹具里塞一行含某机器坐标（DENY_INFRA 词）的 md → 必须 exit≠0 且输出带该 file:line
test('夹具：含机器坐标的 md 被拦，且报出 file:line', () => {
  const { rc, out } = fixture((dir) => {
    writeFileSync(path.join(dir, 'ok.md'), '# ok\n\n这行干净：只有伞域名与端口号 8090。\n');
    writeFileSync(path.join(dir, 'dirty.md'), '# t\n\n本机坐标 proxy.internal 出口代理。\n');
  });
  assert.notEqual(rc, 0, 'DENY 词还在却 exit 0 = 闸失效');
  assert.match(out, /dirty\.md:3: 172\.20\.0\.35/, `输出未点名脏文件的 file:line，实得:\n${out}`);
  assert.doesNotMatch(out, /ok\.md:/, '干净文件不该被点名');
});

// ③ 身份级 DENY_IDENTITY 永不被 EXEMPT 豁免：把含真实邮箱域的行写进一条 EXEMPT 路径，
//    必须 exit≠0 且点名该 file:line——证明历史账能留坐标、却不能留身份（本轮补上的那一层）。
test('夹具：身份词写进 EXEMPT 路径仍被拦，且报出 file:line', () => {
  const { rc, out } = fixture((dir) => {
    mkdirSync(path.join(dir, 'docs', 'maintenance'), { recursive: true });
    writeFileSync(
      path.join(dir, 'docs', 'maintenance', 'task-ledger.md'),
      '# 台账\n\n上游中转组织 example-org 的额度全局耗尽。\n',
    );
  });
  assert.notEqual(rc, 0, '身份词还在 EXEMPT 文件里却 exit 0 = EXEMPT 越界豁免了身份');
  assert.match(
    out,
    /docs\/maintenance\/task-ledger\.md:3: example-org/,
    `输出未点名 EXEMPT 文件里的身份 file:line，实得:\n${out}`,
  );
});
