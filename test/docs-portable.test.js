// check-doc-portable 的行为夹具（issue docs-261124-31）。
// CLI 的扫描范围是从**脚本自己的文件位置**推 ROOT（`path.resolve(__dirname, '..')`）⇒
// 夹具必须在**副本**上跑（把 CLI 复制进 `<夹具>/scripts/`）：否则测的是被扫的仓库、
// 而不是夹具的 `.md`。照 test/agents-hotlayer.test.js 的夹具写法。
// ⚠ 本文件是 `*.js`，会被闸扫到**注释行**——故注释里不许写 DENY 词字面量；夹具用的脏词一律放进
//   writeFileSync 的**代码行**（非注释），断言正则同理。
// 本闸只查坐标（不查账号名，身份词表已按用户裁决移除），故这里只钉坐标检查。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts/check-doc-portable.mjs');

/** 在临时 git 仓库里跑 CLI 副本，返回 { rc, out }。 */
function runRepo(dir, fn, args = []) {
  const sh = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  sh(['init', '-q']);
  sh(['config', 'user.email', 'test@test.local']);
  sh(['config', 'user.name', 'test']);
  fn(dir);
  sh(['add', '-A']);
  try {
    const stdout = execFileSync('node', [path.join(dir, 'scripts/check-doc-portable.mjs'), ...args], { encoding: 'utf8' });
    return { rc: 0, out: stdout };
  } catch (e) {
    /** @type {any} */ const err = e;
    const out = `${err.stdout || ''}${err.stderr || ''}`;
    return { rc: typeof err.status === 'number' ? err.status : -1, out };
  }
}

const fixture = (fn, args = []) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'docport-'));
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  copyFileSync(CLI, path.join(dir, 'scripts/check-doc-portable.mjs'));
  try {
    return runRepo(dir, fn, args);
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
//    ⚠ 夹具里的坐标也用**片段拼接**：本文件本身在仓库里，不留明文（下同）
test('夹具：含机器坐标的 md 被拦，且报出 file:line', () => {
  const proxy = ['172.20.', '0.35'].join('');
  const { rc, out } = fixture((dir) => {
    writeFileSync(path.join(dir, 'ok.md'), '# ok\n\n这行干净：只有伞域名与端口号 8090。\n');
    writeFileSync(path.join(dir, 'dirty.md'), `# t\n\n本机坐标 ${proxy} 出口代理。\n`);
  });
  assert.notEqual(rc, 0, 'DENY 词还在却 exit 0 = 闸失效');
  assert.ok(out.includes(`dirty.md:3: ${proxy}`), `输出未点名脏文件的 file:line，实得:\n${out}`);
  assert.doesNotMatch(out, /ok\.md:/, '干净文件不该被点名');
});
