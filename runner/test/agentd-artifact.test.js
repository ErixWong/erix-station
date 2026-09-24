// agentd 终态清场路径触发产物捕获（issue #64 R1）。
// 隔离约定：node:test + stub 全局 fetch（fake internal），tmp 真实 git 项目目录；
// agentd 经 direct-run 守卫被 import（不启动主循环），覆盖 onWorkerFinished / onWorkerExit 终态分支。
// D8 修订（2026-09-24，AGENTS.md §7）：cwd = 项目目录，清场绝不删除项目目录（用户资产）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.ERIX_STATION_TOKEN = 'test-token';
const agentd = await import('../agentd.js');

function makeCtx(projectDir) {
  return {
    runId: '11111111-2222-3333-4444-555555555555',
    claimToken: 'ct-test',
    attempt: 1,
    resume: false,
    worker: null,
    workerPid: null,
    exited: null,
    events: [],
    eventBytes: 0,
    flushTimer: null,
    inflight: false,
    finishing: false,
    dropped: false,
    dropReason: null,
    lastIpcAt: Date.now(),
    projectDir,
  };
}

/** 造一个带 run 产物（修改 + untracked）的真实 git 项目目录（D8 修订后的捕获目标）。 */
function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-agentd-art-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 't']);
  fs.writeFileSync(path.join(root, 'README.md'), '# base\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'base']);
  fs.writeFileSync(path.join(root, 'README.md'), '# base\nagent change\n');
  fs.writeFileSync(path.join(root, 'deliver.js'), 'module.exports = 42;\n');
  return { root };
}

/** stub fetch：state PUT 按 behavior 返回；artifact PUT 记录请求并返回 200。 */
function stubFetch({ stateStatus = 200, artifactStatus = 200 } = {}) {
  const calls = { state: [], artifact: [] };
  const impl = async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    const body = opts.body;
    if (method === 'PUT' && String(url).endsWith('/state')) {
      calls.state.push({ url, body: typeof body === 'string' ? JSON.parse(body) : body });
      const payload = stateStatus === 200
        ? { state: 'finished', run_end_seq: 1 }
        : { error: { code: stateStatus === 409 ? 'run_terminal' : 'internal', message: 'x', retryable: stateStatus >= 500 } };
      return { ok: stateStatus === 200, status: stateStatus, text: async () => JSON.stringify(payload) };
    }
    if (method === 'PUT' && String(url).endsWith('/artifact')) {
      calls.artifact.push({ url, headers: opts.headers, body });
      const payload = artifactStatus === 200
        ? { artifact_id: 'a1', size: body?.length ?? 0 }
        : { error: { code: artifactStatus === 409 ? 'artifact_exists' : 'network_error', message: 'x' } };
      return { ok: artifactStatus === 200, status: artifactStatus, text: async () => JSON.stringify(payload) };
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  };
  return { calls, impl };
}

async function waitFor(cond, { timeoutMs = 5000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('waitFor 超时');
}

test('onWorkerFinished 终态成功：先捕获上传 artifact，再清场（项目目录保留）', async (t) => {
  const { root } = makeProject();
  const { calls, impl } = stubFetch();
  t.after(() => { globalThis.fetch = undefined; fs.rmSync(root, { recursive: true, force: true }); });
  globalThis.fetch = impl;

  const ctx = makeCtx(root);
  await agentd.onWorkerFinished(ctx, {
    ok: true, termination: { reason: 'end_turn' },
    usage: { input_tokens: 1, output_tokens: 2 }, rounds: 1, final_text: 'done',
  });

  assert.equal(calls.state.length, 1, 'U2 终态已上报');
  assert.equal(calls.artifact.length, 1, '终态确认后触发 artifact 上传（U13）');
  assert.ok(calls.artifact[0].body.length > 0, '上传体为 tar.gz 字节流');
  assert.equal(calls.artifact[0].headers['Content-Type'], 'application/gzip');
  assert.match(calls.artifact[0].headers['X-Sha-256'], /^[0-9a-f]{64}$/);
  assert.equal(fs.existsSync(path.join(root, 'deliver.js')), true, 'D8 修订：项目目录是用户资产，清场后交付物仍在');
});

test('onWorkerFinished 409 run_terminal 幂等命中：同样捕获后清场', async (t) => {
  const { root } = makeProject();
  const { calls, impl } = stubFetch({ stateStatus: 409 });
  t.after(() => { globalThis.fetch = undefined; fs.rmSync(root, { recursive: true, force: true }); });
  globalThis.fetch = impl;

  const ctx = makeCtx(root);
  await agentd.onWorkerFinished(ctx, {
    ok: true, termination: { reason: 'end_turn' },
    usage: { input_tokens: 0, output_tokens: 0 }, rounds: 0, final_text: '',
  });

  assert.equal(calls.artifact.length, 1, '幂等命中视为终态确认，仍捕获产物');
  assert.equal(fs.existsSync(root), true, '项目目录不删');
});

test('onWorkerFinished 终态上报失败（非确认终态，非重试 4xx）：不捕获，但照常清场', async (t) => {
  const { root } = makeProject();
  // 400 = 非重试 4xx：单次失败即放弃（500/429 触发 withRetry 无限退避是 M1 有意设计，不进测试）。
  const { calls, impl } = stubFetch({ stateStatus: 400 });
  t.after(() => { globalThis.fetch = undefined; fs.rmSync(root, { recursive: true, force: true }); });
  globalThis.fetch = impl;

  const ctx = makeCtx(root);
  await agentd.onWorkerFinished(ctx, {
    ok: true, termination: { reason: 'end_turn' },
    usage: { input_tokens: 0, output_tokens: 0 }, rounds: 0, final_text: '',
  });

  assert.equal(calls.artifact.length, 0, '终态未确认 → 不捕获');
  assert.equal(fs.existsSync(root), true, '清场不删项目目录');
});

test('onWorkerExit 停止路径（stop_request）：捕获 artifact 后清场', async (t) => {
  const { root } = makeProject();
  const { calls, impl } = stubFetch();
  t.after(() => { globalThis.fetch = undefined; fs.rmSync(root, { recursive: true, force: true }); });
  globalThis.fetch = impl;

  const ctx = makeCtx(root);
  ctx.dropped = true;
  ctx.dropReason = 'stop_request';
  agentd.onWorkerExit(ctx, 0, 'SIGTERM');

  await waitFor(() => calls.artifact.length === 1);
  assert.ok(calls.state.length >= 1, '补报 aborted 已发出');
  assert.equal(fs.existsSync(root), true, 'stop 路径捕获后清场，项目目录不删');
});

test('onWorkerExit lease_lost：run 未确认终态 → 不捕获', async (t) => {
  const { root } = makeProject();
  const { calls, impl } = stubFetch();
  t.after(() => { globalThis.fetch = undefined; fs.rmSync(root, { recursive: true, force: true }); });
  globalThis.fetch = impl;

  const ctx = makeCtx(root);
  ctx.dropped = true;
  ctx.dropReason = 'lease_lost';
  agentd.onWorkerExit(ctx, 1, 'SIGKILL');

  await waitFor(() => calls.state.length >= 0 && !agentd.state.runs.has(ctx.runId));
  assert.equal(calls.artifact.length, 0, 'lease_lost（可能易主重跑）不捕获产物');
  assert.equal(fs.existsSync(root), true, '项目目录不删');
});

test('artifact 上传失败（409 artifact_exists / 5xx）：不阻塞清场', async (t) => {
  for (const artifactStatus of [409, 503]) {
    const { root } = makeProject();
    const { calls, impl } = stubFetch({ artifactStatus });
    globalThis.fetch = impl;
    const ctx = makeCtx(root);
    await agentd.onWorkerFinished(ctx, {
      ok: true, termination: { reason: 'end_turn' },
      usage: { input_tokens: 0, output_tokens: 0 }, rounds: 0, final_text: '',
    });
    assert.equal(calls.artifact.length, 1, `status=${artifactStatus} 有一次上传尝试`);
    assert.equal(fs.existsSync(root), true, `status=${artifactStatus} 清场未被阻塞，项目目录不删`);
    fs.rmSync(root, { recursive: true, force: true });
  }
  globalThis.fetch = undefined;
  t.after(() => { globalThis.fetch = undefined; });
});
