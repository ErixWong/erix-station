// issue #905：宏/审查任务（macro-dispatcher → sessions.postMessage）也受 llm_not_configured 预检覆盖。
// 判据：当 fde_llm_bindings 无 active 行时，sessions.postMessage 必须在 pool.connect() 之前
// 抛出 SessionError(httpStatus=409, code='llm_not_configured')，不开业务事务、不入队 run。
// 隔离约定（docs/testing.md §2.1）：注入内存 fake pool，不碰真实 DB。
import test from 'node:test';
import assert from 'node:assert/strict';

import { postMessage, SessionError } from '../src/sessions.js';

const USER_ID = '00000000-0000-4000-8000-0000000000c9';

/**
 * 极简 fake pool：只响应 llm_not_configured 预检那条 SELECT。
 * 其余语句（事务内的 BEGIN/connect 等）不应被到达（本测试断言预检在 connect 之前）。
 */
function fakePool({ llmBindingFound = false } = {}) {
  let connected = 0;
  const queries = [];
  return {
    get connected() { return connected; },
    get queries() { return queries; },
    async query(sql, params) {
      queries.push({ sql, params });
      if (/FROM\s+fde_llm_bindings/i.test(sql)) {
        return { rows: llmBindingFound ? [{ '?column?': 1 }] : [] };
      }
      // 不应到达此处（预检失败后直接 throw）
      return { rows: [] };
    },
    async connect() {
      connected += 1;
      return { query: async () => ({ rows: [] }), release() {} };
    },
  };
}

test('issue #905：无 active binding → postMessage 抛 409 llm_not_configured，不开事务（宏路也盖住）', async () => {
  const pool = fakePool({ llmBindingFound: false });
  let err;
  try {
    await postMessage(pool, {
      userId: USER_ID,
      sessionId: 'a1b2c3d4-1111-4111-8111-abcdefabcdef',
      content: 'macro test',
      attachments: [],
      triggerKind: 'synthetic',
    });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof SessionError, '应抛 SessionError');
  assert.equal(err.code, 'llm_not_configured');
  assert.equal(err.httpStatus, 409);
  assert.match(err.message, /未配置 LLM 上游/);
  assert.match(err.en, /no LLM upstream/);
  assert.equal(pool.connected, 0, 'fail-fast：pool.connect() 不得被调用（不开业务事务）');
});

test('issue #905：有 active binding → postMessage 预检放行（继续进入事务）', async () => {
  const pool = fakePool({ llmBindingFound: true });
  // 预检放行后 pool.connect() 被调用，后续事务内的 BEGIN 等用简单 stub 即可——
  // 这里只验证 connect 被调用（证明预检确实放行了），不断言整个事务流。
  let err;
  try {
    await postMessage(pool, {
      userId: USER_ID,
      sessionId: 'a1b2c3d4-1111-4111-8111-abcdefabcdef',
      content: 'macro test',
      attachments: [],
      triggerKind: 'synthetic',
    });
  } catch (e) {
    err = e;
  }
  // 放行后继续走事务：connect 至少被调用一次（后续 fetchSession 拿不到行会报别的错，
  // 但绝不是 llm_not_configured）。
  assert.equal(pool.connected, 1, '预检放行：pool.connect() 被调用');
  assert.ok(!err || err.code !== 'llm_not_configured', '放行后不应再抛 llm_not_configured');
});
