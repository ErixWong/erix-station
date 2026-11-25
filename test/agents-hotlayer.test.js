// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 热层预算闸的落地覆盖（与 scripts/agents-hotlayer-budget.mjs 同源，这里只保证它在 npm test /
// CI 里真的被跑到，并且反向自证成立）。规矩本身见 AGENTS.md §6。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'agents-hotlayer-budget.mjs');

function run(cliArgs) {
  return execFileSync(process.execPath, [CLI, ...cliArgs], { cwd: ROOT, encoding: 'utf8' });
}

/**
 * 在**夹具**里跑一次并留住退出码与输出（闸红是我们要的读数，不能让它把测试炸成 error）。
 * ⚠ 必须跑夹具里那份副本：脚本的 ROOT 是**从它自己的文件位置**推出来的（`scripts/..`），
 *    跑仓库那份再改 `cwd` 也没用——它会继续读真仓库的 AGENTS.md。
 */
function runCapture(dir, cliArgs) {
  const cli = path.join(dir, 'scripts', 'agents-hotlayer-budget.mjs');
  try {
    return { rc: 0, out: execFileSync(process.execPath, [cli, ...cliArgs], { cwd: dir, encoding: 'utf8' }) };
  } catch (/** @type {any} */ e) {
    return { rc: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

/**
 * 造一个独立的小夹具目录：只有把 CLI 复制进 `<夹具>/scripts/`，它的 ROOT 才会指到夹具。
 * @param {{ agents?: string, budget?: number }} [spec]
 */
function makeFixture(spec = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hotlayer-gate-'));
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  copyFileSync(CLI, path.join(dir, 'scripts', 'agents-hotlayer-budget.mjs'));
  writeFileSync(path.join(dir, 'AGENTS.md'), spec.agents ?? '# 夹具热层\n\n判据若干，不写死当下数字。\n');
  writeFileSync(path.join(dir, 'scripts', 'agents-hotlayer-budget.json'), JSON.stringify({
    hotBytesBudget: spec.budget ?? 20480,
    measuredHotBytes: 0,
    measuredTotalBytes: 0,
    note: '夹具登记表',
  }, null, 2) + '\n');
  return dir;
}

function readFixtureReg(dir) {
  return JSON.parse(readFileSync(path.join(dir, 'scripts', 'agents-hotlayer-budget.json'), 'utf8'));
}

test('热层预算闸：在最终树上必须全绿', () => {
  let out = '';
  try {
    out = run([]);
  } catch (/** @type {any} */ e) {
    assert.fail(`闸门红：\n${e.stdout || ''}${e.stderr || ''}`);
  }
  assert.match(out, /VERDICT ok/);
  assert.doesNotMatch(out, /^RED /m);
});

test('热层预算闸：反向自证——三类手抄当下断言必须被抓，合法写法必须放过', () => {
  const out = run(['--self-test']);
  assert.doesNotMatch(out, /^RED /m, `自证失败：\n${out}`);
  const n = out.split('\n').filter((l) => l.startsWith('ok   self-test')).length;
  assert.ok(n >= 6, `自证用例太少（${n}）：\n${out}`);
});

test('字节预算：超预算必须报红且点名；--sync 写入实测值后恢复绿', (t) => {
  const dir = makeFixture({ budget: 10 });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const red = runCapture(dir, []);
  assert.equal(red.rc, 1, `超预算却 exit 0：\n${red.out}`);
  assert.match(red.out, /^RED\s+hot-byte-budget:/m);
  assert.match(red.out, /VERDICT red/);

  const sync = runCapture(dir, ['--sync']);
  assert.equal(sync.rc, 0, sync.out);
  const reg = readFixtureReg(dir);
  assert.ok(reg.measuredHotBytes > 0, '--sync 没把实测字节数写进登记表');
  assert.equal(reg.hotBytesBudget, 20480, '--sync 必须写显式目标预算（不是按实测派生）');

  const green = runCapture(dir, []);
  assert.equal(green.rc, 0, `sync 之后仍红：\n${green.out}`);
  assert.match(green.out, /VERDICT ok/);
});

test('手抄当下断言：真跑一次闸必须点名 file:line', (t) => {
  const dir = makeFixture({ agents: '# 夹具热层\n\n当前 pin：0.29.0\n' });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = runCapture(dir, []);
  assert.equal(r.rc, 1, `手抄 pin 没被抓：\n${r.out}`);
  assert.match(r.out, /^RED\s+hand-copied-pin:/m);
  assert.match(r.out, /hand-copied-pin: 3:/);
});

test('余量告警带：预算内但余量 ≤1024 时报 WARN，且不影响退出码', (t) => {
  const agents = '# 夹具热层\n\n' + '判据一行。\n'.repeat(20);
  const bytes = Buffer.byteLength(agents, 'utf8');
  const dir = makeFixture({ agents, budget: bytes + 512 });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = runCapture(dir, []);
  assert.equal(r.rc, 0, `WARN 不该影响退出码：\n${r.out}`);
  assert.match(r.out, /WARN hot-byte-headroom: 余量只剩 512 字节/);
  assert.match(r.out, /VERDICT ok/);
});
