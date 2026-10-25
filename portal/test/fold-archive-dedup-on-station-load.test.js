// issue #371 遗留判据 **E**：erix-agent 0.25.0 的归档去重，在**本站的 `load()` 形状**上到底命不命中。
//
// 为什么必须实测而不是读代码放心：0.25.0 的去重是**会话级 sha256**（`src/compact/fold-archive.js`），
// resume 过的会话（`foldedThrough > 0`）会 `await store.load(runId)` 把「此前各轮已归档的正文」
// **预先入账**（`ensureSeeded`），此后每次折叠只归档没见过的正文。而本站的 `store.load()` 在 #351
// 之后**会折叠**（0.25 起更是上游随包契约的硬要求）——折叠会改写行、合并分片、给消息盖行级 `ts`。
// 如果去重指纹吃的是「`load()` 里的 `messages`」，本站这一折就可能让指纹**命不中**，差分退化成
// 全量，1 MiB 那条链只解决一半。⇒ 本文件把这件事钉成机器判据，而不是留在注释里。
//
// 结论（实测，2026-10-25，erix-agent 0.25.0）：**命中不受本站折叠影响**，因为预入账扫的是
// `record.foldedPayload`（归档正文），而本站的 `foldLedgerRecords` **从不改写/丢弃 `foldedPayload`**
// （它只合并 `messages`）。下面第 3 格把这个「承重前提」单独钉住：谁哪天在折叠时顺手剥归档，
// 第 2 格立刻从「全命中」掉到 0。
import test from 'node:test';
import assert from 'node:assert/strict';
import { foldLedgerRecords as portalFold } from '../src/transcript-fold.js';
import { foldLedgerRecords as runnerFold } from '../../runner/lib/transcript-fold.js';

// `createFoldArchiveLedger` / `foldMessageFingerprint` 都**不在包 exports 面**（根只导出
// `foldMessageRows` 那一组）⇒ 与 `portal/test/transcript-fold.test.js` 同一手法：按文件路径直连上游真件。
// 路径写死就是 tripwire：上游挪文件/改名 ⇒ 下面这条 import 红，提醒重核本单的结论是否还成立。
const UPSTREAM_FOLD_ARCHIVE = new URL(
  '../../node_modules/erix-agent/src/compact/fold-archive.js', import.meta.url);
let createFoldArchiveLedger;
let foldMessageFingerprint;
try {
  ({ createFoldArchiveLedger, foldMessageFingerprint } = await import(UPSTREAM_FOLD_ARCHIVE));
} catch {
  assert.fail(`上游 \`src/compact/fold-archive.js\` 读不到或符号改名了（${UPSTREAM_FOLD_ARCHIVE}）`
    + ' —— E 的判据依赖它的 pre-seed 与 sha256 指纹，请重核本文件与 #371 的结论');
}

const KEY = 'sess-371-E';

/** 一条正文消息（内容稳定，sha256 可复现）。 */
function msg(text) {
  return { role: 'user', content: [{ type: 'text', text }] };
}

/**
 * 「run 1 折叠过一次」的账本形状（**真形状混合**：载体轮行 + 逐条消息行 + 载体自带归档）。
 * 0.23/0.25 写侧都是这个形状：轮行只剩元数据，正文在 `kind:"message"` 行上，归档在轮行的
 * `foldedPayload` 上（0.25 起还带 `foldedPayloadMeta`）。
 */
function ledgerWithArchive(archivedMessages) {
  return [
    {
      dedupKey: `${KEY}:engine:round:1`, round: 1,
      foldedRoundRange: { from: 1, to: 1 },
      foldedPayload: archivedMessages,
      foldedPayloadMeta: { archivedMessages: archivedMessages.length, dedupedMessages: 0, droppedMessages: 0 },
      messages: [],
    },
    { dedupKey: `${KEY}:msg:1:0`, round: 1, seq: 0, kind: 'message', ts: '2026-10-25T00:00:01.000Z', messages: [msg('第一轮正文甲')] },
    { dedupKey: `${KEY}:msg:1:1`, round: 1, seq: 1, kind: 'message', ts: '2026-10-25T00:00:02.000Z', messages: [msg('第一轮正文乙')] },
    { dedupKey: `${KEY}:msg:1:2`, round: 1, seq: 2, kind: 'message', ts: '2026-10-25T00:00:03.000Z', messages: [msg('第一轮正文丙')] },
  ];
}

const ARCHIVED = [msg('第一轮正文甲'), msg('第一轮正文乙'), msg('第一轮正文丙')];

test('① 判据本体：引擎预入账扫的是本站 load() 里的 foldedPayload，三条老正文全部命中去重', async () => {
  const loadedToEngine = portalFold(ledgerWithArchive(ARCHIVED)); // 本站 store.load() 的输出形状
  const ledger = createFoldArchiveLedger({ store: { load: async () => loadedToEngine }, runId: KEY });
  await ledger.ensureSeeded(2); // resume 后的下一次折叠（beforeRound=2 ⇒ 只预入 round<2 的归档）

  const again = [msg('第一轮正文甲'), msg('第一轮正文乙'), msg('第一轮正文丙'), msg('第二轮新正文')];
  const { kept, dedupedMessages } = ledger.selectUnarchived(again);
  assert.equal(dedupedMessages, 3,
    '三条已归档正文必须全部判为「已归档」。掉到 0 = 本站的折叠形状让会话级去重失效 ⇒ 差分退化成全量'
    + '（就是 E 要防的那件事）');
  assert.deepEqual(kept.map((m) => m.content[0].text), ['第二轮新正文'], '只有没见过的正文才进归档');
});

test('② 反向对照：把归档从载体上剥掉 ⇒ 命中归零（证明①测的是命中，不是恒真）', async () => {
  const stripped = portalFold(ledgerWithArchive(ARCHIVED)).map((record) => {
    const { foldedPayload: _gone, ...rest } = record;
    return rest;
  });
  const ledger = createFoldArchiveLedger({ store: { load: async () => stripped }, runId: KEY });
  await ledger.ensureSeeded(2);
  const { dedupedMessages } = ledger.selectUnarchived([msg('第一轮正文甲')]);
  assert.equal(dedupedMessages, 0,
    '归档不在 load() 输出里 ⇒ 无指纹可预入 ⇒ 每次都重归档一遍。'
    + '这正是 #371 早期方案②④（写侧剥归档 / load 不返归档）被作废的原因');
});

test('③ 承重前提：本站折叠**原样保留** foldedPayload（不改写、不丢、不换成差分）', () => {
  const raw = ledgerWithArchive(ARCHIVED);
  for (const [name, fold] of [['portal', portalFold], ['runner', runnerFold]]) {
    const folded = fold(raw);
    const carrier = folded.find((record) => record.dedupKey === `${KEY}:engine:round:1`);
    assert.ok(carrier, `${name}：载体行必须在`);
    assert.deepEqual(carrier.foldedPayload, ARCHIVED,
      `${name}：折叠后 foldedPayload 必须逐字段不变——它是引擎会话级去重的唯一指纹来源`);
    assert.deepEqual(carrier.foldedPayloadMeta, raw[0].foldedPayloadMeta, `${name}：Meta 同样不许动`);
  }
});

test('④ 两份镜像在同一夹具上输出一致（口径只许有一份）', () => {
  assert.deepEqual(runnerFold(ledgerWithArchive(ARCHIVED)), portalFold(ledgerWithArchive(ARCHIVED)));
});

test('⑤ 指纹本身按消息算（同一内容两次构造同指纹；内容不同必不同）——E 的前提不是巧合', () => {
  assert.equal(foldMessageFingerprint(msg('同样的话')), foldMessageFingerprint(msg('同样的话')));
  assert.notEqual(foldMessageFingerprint(msg('同样的话')), foldMessageFingerprint(msg('不同的话')));
  // ⚠ 反过来也钉一条：本站给消息盖的**行级 `ts`**（0.25 #439 A）会改变消息对象 ⇒ 会改指纹。
  // 所以「命中」依赖的是**归档里那份正文**与**待归档那份**同形；本站只在 `messages` 上盖 ts，
  // 不动 `foldedPayload`，因此不触碰这条（第 ③ 格钉住）。
  assert.notEqual(foldMessageFingerprint(msg('同样的话')), foldMessageFingerprint({ ...msg('同样的话'), ts: 'x' }));
});
