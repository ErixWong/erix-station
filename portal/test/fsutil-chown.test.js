// fsutil 属主（uid/gid）语义钉桩：工单 C2「测试可移植性」。
//
// 背景：GitHub Actions 首跑 `npm test` 有 16 项以 `EPERM: operation not permitted, fchown` 失败
// （run 38041183692 / 38041175079；调用栈 portal/src/fsutil.js writeTempFile → atomicWriteFile
// → git-credential.js setGitCredential）。根因不是产品缺陷，而是**测试**把「宿主侧属主」写成字面量 1000：
// 非特权进程只能把属主改成自己的 euid、把属组改成自己所属的组（chown(2)/fchown(2) 硬约束），
// 开发机恰好是 1000:1000 ⇒ 掩盖了问题；GitHub runner 的 `runner` 用户不是 1000:1000 ⇒ 直接 EPERM。
// 生产 portal 以 root 运行（portal/Dockerfile:37 ⇒ 持 CAP_CHOWN），所以产品代码一个字都不动。
//
// 本文件把真实语义钉成**环境无关的确定性单测**：
//   ① 属主取进程自身 ⇒ 必成功，且落盘属主 == SELF；
//   ② 属主取一个当前进程不属于的外部 uid ⇒ 非 root 必须 EPERM 且 fail-closed
//      （不改动已提交的 target、不落半截、不留 .tmp）；root 分支改为断言成功（那正是生产能力面）；
//   ③ 属组同理：非 root 只能 chgrp 到自己所属的组。
// EPERM 一律显式断言（captureError 里「没抛错就当场失败」），绝不用 try/catch 静默吞掉。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFile } from '../src/fsutil.js';

const SELF_UID = process.getuid?.() ?? 1000;
const SELF_GID = process.getgid?.() ?? 1000;
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

// 外部 uid：必须是当前进程**肯定不属于**的值。uid 1（daemon）不是任何正常测试身份会用的 uid；
// 万一真以 uid 1 跑测试，退到 1002（worker，同样不属于 SELF）。
const FOREIGN_UID = SELF_UID === 1 ? 1002 : 1;
// 外部 gid：65534（nobody/nogroup）一般不属于跑测试的用户；若进程恰好能 chgrp 到它，下面用
// canSetGid() 直接问内核来判定（Node 22 没有 process.groups()，不能依赖它）。
const FOREIGN_GID = SELF_GID === 65534 ? 1 : 65534;

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-fsutil-chown-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 返回 fn() 抛出的错误；**没抛错就当场 fail**（把 EPERM 静默吞掉正是本工单要防的事）。 */
function captureError(fn, what) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return assert.fail(`${what} 必须抛错（非 root 改属主是内核级禁止的操作，不许静默通过）`);
}

/** target 同目录下 writeTempFile 留下的 tmp 残骸（fail-closed 必须清干净）。 */
function tmpRemnants(dir) {
  return fs.readdirSync(dir).filter((name) => name.includes('.tmp'));
}

/**
 * 直接问内核：本进程能否把属组设成 gid（非 root 只允许自己所属的组）。
 * 用它代替 process.groups()（Node 22 没有该 API），避免「本机偶发通过」。
 */
function canSetGid(dir, gid) {
  const probe = path.join(dir, 'gid-probe');
  fs.writeFileSync(probe, '');
  try {
    fs.chownSync(probe, -1, gid);
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { force: true });
  }
}

test('fsutil.atomicWriteFile：属主取进程自身（SELF_UID/SELF_GID）必定成功，且落盘属主等于 SELF', (t) => {
  const dir = fixture(t);
  const target = path.join(dir, 'credential');

  atomicWriteFile(target, 'https://alice:pat@example.test\n', {
    mode: 0o640, uid: SELF_UID, gid: SELF_GID, root: dir,
  });

  const stat = fs.statSync(target);
  assert.equal(fs.readFileSync(target, 'utf8'), 'https://alice:pat@example.test\n');
  assert.equal(stat.mode & 0o777, 0o640);
  assert.equal(stat.uid, SELF_UID, '落盘属主必须等于请求的 uid（非特权环境下这是唯一合法属主）');
  assert.equal(stat.gid, SELF_GID, '落盘属组必须等于请求的 gid');
  assert.deepEqual(tmpRemnants(dir), [], '不留 .tmp 残骸');
  t.diagnostic(`SELF=${SELF_UID}:${SELF_GID}（${IS_ROOT ? 'root' : '非 root'}）FOREIGN_UID=${FOREIGN_UID} FOREIGN_GID=${FOREIGN_GID}`);
});

test('fsutil.atomicWriteFile：chown 到外部 uid → 非 root 必 EPERM 且 fail-closed；root 分支断言成功', (t) => {
  assert.notEqual(FOREIGN_UID, SELF_UID, '外部 uid 不能撞上进程自身，否则用例失去意义');
  const dir = fixture(t);
  const target = path.join(dir, 'credential');
  atomicWriteFile(target, 'OLD\n', { mode: 0o640, uid: SELF_UID, gid: SELF_GID, root: dir });
  const before = fs.statSync(target);

  if (!IS_ROOT) {
    const err = captureError(
      () => atomicWriteFile(target, 'NEW\n', { mode: 0o640, uid: FOREIGN_UID, gid: SELF_GID, root: dir }),
      `非 root（uid=${SELF_UID}）chown 到 uid=${FOREIGN_UID}`,
    );
    assert.equal(err.code, 'EPERM', `必须是 EPERM 原样上抛（不许包装/降级成告警），实际 code=${err?.code} msg=${err?.message}`);
    // fail-closed：已提交的 target 内容/模式/属主全部不变，且不留下 tmp 残骸。
    const after = fs.statSync(target);
    assert.equal(fs.readFileSync(target, 'utf8'), 'OLD\n', 'chown 被拒不得改动已提交的 target');
    assert.equal(after.mode & 0o777, 0o640);
    assert.equal(after.uid, before.uid);
    assert.equal(after.gid, before.gid);
    assert.deepEqual(tmpRemnants(dir), [], '失败的 tmp 必须被清理（rename 根本不发生）');
    return;
  }

  // root 分支：生产 portal 就是 root（portal/Dockerfile:37），同一调用必须成功且属主真的易手。
  t.diagnostic(`root 环境（uid=${SELF_UID}）：外部 uid 用例改为断言成功（EPERM 分支由非 root 环境覆盖）`);
  atomicWriteFile(target, 'NEW\n', { mode: 0o640, uid: FOREIGN_UID, gid: SELF_GID, root: dir });
  const stat = fs.statSync(target);
  assert.equal(fs.readFileSync(target, 'utf8'), 'NEW\n');
  assert.equal(stat.uid, FOREIGN_UID, 'root 必须真能把属主交给外部 uid（生产语义）');
  assert.equal(stat.gid, SELF_GID);
  assert.deepEqual(tmpRemnants(dir), []);
});

test('fsutil.atomicWriteFile：target 尚不存在时 chown 到外部 uid → 非 root EPERM 后既无 target 也无残骸', (t) => {
  const dir = fixture(t);
  const target = path.join(dir, 'brand-new');

  if (!IS_ROOT) {
    const err = captureError(
      () => atomicWriteFile(target, 'NEW\n', { mode: 0o600, uid: FOREIGN_UID, gid: SELF_GID, root: dir }),
      `非 root（uid=${SELF_UID}）新建文件并 chown 到 uid=${FOREIGN_UID}`,
    );
    assert.equal(err.code, 'EPERM');
    assert.equal(fs.existsSync(target), false, '失败不得留下 target（不落半截）');
    assert.deepEqual(fs.readdirSync(dir), [], '失败不得在目录里留下任何残骸');
    return;
  }

  t.diagnostic(`root 环境（uid=${SELF_UID}）：新建文件直接落到外部 uid`);
  atomicWriteFile(target, 'NEW\n', { mode: 0o600, uid: FOREIGN_UID, gid: SELF_GID, root: dir });
  const stat = fs.statSync(target);
  assert.equal(stat.uid, FOREIGN_UID);
  assert.equal(stat.mode & 0o777, 0o600);
});

test('fsutil.atomicWriteFile：chown 到非所属 gid → 非 root 同样必 EPERM（组侧同受限）；root 分支断言成功', (t) => {
  const dir = fixture(t);
  if (!IS_ROOT && canSetGid(dir, FOREIGN_GID)) {
    // 前提在宿主上不成立时**显式说明原因**，而不是悄悄少跑一条断言。
    t.diagnostic(`跳过：本进程有权 chgrp 到 gid=${FOREIGN_GID}（它是本进程所属组），「非所属组」前提不成立（root 分支不受影响）`);
    return;
  }
  assert.notEqual(FOREIGN_GID, SELF_GID, '外部 gid 不能撞上进程自身所属组');
  const target = path.join(dir, 'credential');
  atomicWriteFile(target, 'OLD\n', { mode: 0o640, uid: SELF_UID, gid: SELF_GID, root: dir });

  if (!IS_ROOT) {
    const err = captureError(
      () => atomicWriteFile(target, 'NEW\n', { mode: 0o640, uid: SELF_UID, gid: FOREIGN_GID, root: dir }),
      `非 root（gid=${SELF_GID}）chgrp 到 gid=${FOREIGN_GID}`,
    );
    assert.equal(err.code, 'EPERM');
    assert.equal(fs.readFileSync(target, 'utf8'), 'OLD\n', 'chgrp 被拒不得改动已提交的 target');
    assert.equal(fs.statSync(target).gid, SELF_GID);
    assert.deepEqual(tmpRemnants(dir), []);
    return;
  }

  t.diagnostic(`root 环境（uid=${SELF_UID}）：外部 gid 用例改为断言成功`);
  atomicWriteFile(target, 'NEW\n', { mode: 0o640, uid: SELF_UID, gid: FOREIGN_GID, root: dir });
  assert.equal(fs.statSync(target).gid, FOREIGN_GID);
});

test('root-only：atomicWriteFile 可同时把属主与属组交给任意外部值（生产 portal 的能力面）', (t) => {
  if (!IS_ROOT) {
    t.diagnostic(
      `跳过 root-only 分支：当前进程 uid=${SELF_UID}/gid=${SELF_GID} 非 root，`
      + '内核不允许把属主改成任意 uid（生产 portal 以 root 运行 ⇒ 该能力只在 root 分支断言，'
      + '非 root 环境不假装通过）',
    );
    return;
  }
  const dir = fixture(t);
  const target = path.join(dir, 'credential');
  atomicWriteFile(target, 'ROOT\n', { mode: 0o640, uid: FOREIGN_UID, gid: FOREIGN_GID, root: dir });
  const stat = fs.statSync(target);
  assert.equal(stat.uid, FOREIGN_UID, 'root 部署下 portal 必须能把凭据文件交给 fde 属主');
  assert.equal(stat.gid, FOREIGN_GID);
  assert.equal(fs.readFileSync(target, 'utf8'), 'ROOT\n');
  assert.deepEqual(tmpRemnants(dir), []);
});
