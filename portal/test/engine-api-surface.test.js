// 本站实际消费的引擎 API 面（erix-station issue #812，改写自原 engine-api-contract.test.js）。
//
// 三点立场：
//  1) 本站实际消费的引擎面：本文件断言的是 portal **真的还在 import** 的引擎导出——目前只有
//     `appendUserTurn`（`portal/src/transcript-store.js`）。不再锁整个包的导出面。
//  2) 显示投影已搬走：`projectTranscriptForDisplay` 自 #812 起归本仓
//     `portal/src/display-projection.js`，**不再是引擎导出**，故本文件不再对它做任何断言。
//     其余引擎导出（parseModelJson / parseReflectionDecision / normalizeModelJson / loadModelSlot 等）
//     portal 一个都没 import，按「没有的格直接不要」不搬进来。
//  3) appendUserTurn 的预写判据逐字抄自上游契约
//     `node_modules/erix-agent/test/contract/engine-api.js`（不自己发明）：预写的 key / dedupKey /
//     round / messages 形状一旦变化，要**同步改这里**。
import test from 'node:test';
import assert from 'node:assert/strict';

const getEntry = () => import('erix-agent');

test('engine-api-surface: 包入口导出 appendUserTurn 且为 function', async () => {
  const entry = await getEntry();
  assert.equal(typeof entry.appendUserTurn, 'function');
});

test('engine-api-surface: appendUserTurn 对最小 store stub 完成一次预写（判据逐字抄自上游契约）', async () => {
  const entry = await getEntry();
  const records = [];
  const store = {
    async load() {
      return records.map((record) => structuredClone(record));
    },
    async appendRound(_key, record) {
      records.push(structuredClone(record));
    },
  };
  const result = await entry.appendUserTurn(store, {
    key: 'contract-run',
    text: 'contract pre-write',
    messageId: 'msg-1',
  });
  assert.equal(result.key, 'contract-run');
  assert.equal(result.dedupKey, 'contract-run:input:msg-1');
  assert.equal(result.written, true);
  assert.equal(result.round, 0);
  assert.equal(records.length, 1);
  assert.equal(records[0].round, 0);
  assert.equal(records[0].dedupKey, 'contract-run:input:msg-1');
  assert.equal(records[0].roundKey, 'contract-run:input:msg-1');
  assert.deepEqual(records[0].messages, [
    { role: 'user', content: [{ type: 'text', text: 'contract pre-write' }] },
  ]);
  assert.equal(typeof records[0].ts, 'string');
});
