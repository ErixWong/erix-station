// issue #392（C 片）纯函数部分：折叠笔记的 key 与正文。零依赖，便于单测把判据钉死。

export const FOLD_NOTE_TAG = 'fold';

// 与 store 侧同源（erix-agent `src/store/notes.js:47`）：不过这条就会被哈希成 `h<digest>`，
// 人在 `note_list` 里既读不出顺序、也认不出是哪次折叠。
const SAFE_KEY = /^[A-Za-z0-9_-]{1,128}$/;

function basicStamp(iso) {
  const t = typeof iso === 'string' && iso ? iso : new Date().toISOString();
  // 2026-10-25T18:15:30.123Z → 20261025T181530Z（basic 形态：去掉 - : . 后仍在 SAFE_KEY 内）
  return t.replace(/[-:.]/g, '').replace(/\d{3}Z$/, 'Z');
}

function slug(value, fallback = '') {
  const s = String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  return s === '' ? fallback : s;
}

// key 承担时间线：`fold-<basic 时刻>-r<round>-s<序号>`。
// 为什么不能固定：同 scope 下 key 就是笔记 id，固定 key ⇒ 第二次折叠撞重复、注丢掉、台账从此只有一条
//（本站一条用户消息 = 一个 run ⇒ 每个 run 的第一次折叠都会撞上同一条）。
export function foldNoteKey({ nowIso, round, seq } = {}) {
  const stamp = basicStamp(nowIso);
  const roundTok = `r${slug(round, '0')}`;
  const seqTok = `s${Number.isSafeInteger(seq) && seq > 0 ? seq : 1}`;
  let key = `fold-${stamp}-${roundTok}-${seqTok}`;
  if (key.length > 128) key = key.slice(0, 128);
  // 极端输入兜底（时刻被上游塞了怪东西）：宁可退化成「时刻+序号」也不落回固定 key。
  if (!SAFE_KEY.test(key)) key = `fold-${slug(stamp, 'na')}-${seqTok}`;
  return key;
}

// payload = 引擎 `onFoldSummary` 的入参。**逐字取自真链路**（`runToolLoop` + `fold-statistical`，
// 0.26.0 实测键面）：`{ text, source, strategy, bytes, fingerprint, round }`，被引擎夹断时再多两键
// `truncated:true` / `bytesBefore`；策略给出区间时再多 `from` / `to` / `rounds`。
// ⚠ **`chars` 这个键引擎从来没有过**：旧代码读 `payload.chars` 恒定 `undefined` ⇒ 生产上那条注
// 永远写「摘掉正文 ? 字」，而单测手工喂了 `chars: 184320` 所以一直是绿的（#331 同形状：
// 手工喂的形状全绿、真链路是死光纤）。口径改成引擎真给的 `bytes`；`chars` **一律不读**（见下方「规模」段的理由）。
//
// erix-agent #485（已合 main，未发版）会**再加**三键：`foldedRoundRange{from,to}` /
// `foldedThrough` / `foldedRoundCount`。下面全部按「有就写、没有就不写」处理，所以现在合进去
// 在 0.26.0 上表现逐字不变（少写两行），pin 到 ≥0.27.0 之后自动亮。
// ⚠ `foldedRoundCount` 契约明写是 **run 作用域**（resume 后归零）⇒ 文案必须带「本 run」，
//   不许写成会话累计（会话累计要宿主自己把历次投递的数加起来）。
//
// 返回 null = 不该写注（无 text）。正文里必须自带来源与规模：这条注是**唯一**能回答「丢了什么、
// 多大一块、谁折的」的东西——原文已退出模型可见上下文，下一任模型只能看见这条注。
export function deriveFoldNote({ payload, seq, nowIso, runId } = {}) {
  const text = payload?.text;
  if (typeof text !== 'string' || text.trim() === '') return null;

  const source = typeof payload.source === 'string' && payload.source.trim() !== ''
    ? payload.source.trim()
    : 'unknown';
  const strategy = typeof payload.strategy === 'string' && payload.strategy.trim() !== ''
    ? payload.strategy.trim()
    : undefined;
  const round = payload.round === undefined || payload.round === null ? '?' : String(payload.round);
  const stamp = typeof nowIso === 'string' && nowIso ? nowIso : new Date().toISOString();

  // 折叠范围：#485 的嵌套 `foldedRoundRange` 优先，退回引擎 `buildFoldedFacts` 自己的平铺
  // `{from,to}`（两种形状同源，都是本轮那份事实），再退回「第 round 轮及之前」的旧口径。
  const from = Number.isSafeInteger(payload?.foldedRoundRange?.from)
    ? payload.foldedRoundRange.from
    : (Number.isSafeInteger(payload?.from) ? payload.from : undefined);
  const to = Number.isSafeInteger(payload?.foldedRoundRange?.to)
    ? payload.foldedRoundRange.to
    : (Number.isSafeInteger(payload?.to) ? payload.to : undefined);
  const rangeLine = from !== undefined && to !== undefined
    ? `折走第 ${from}–${to} 轮` + (Number.isSafeInteger(payload?.rounds) ? `（${payload.rounds} 轮）` : '')
    : `第 ${round} 轮及之前`;
  // 有就写、没有就不写：不发「0」也不发「?」，免得把「引擎没给」读成「水位线是 0」。
  const scopeExtras = [
    Number.isSafeInteger(payload?.foldedThrough) ? `水位线到第 ${payload.foldedThrough} 轮` : undefined,
    Number.isSafeInteger(payload?.foldedRoundCount) ? `本 run 累计折 ${payload.foldedRoundCount} 轮` : undefined,
  ].filter((line) => line !== undefined);

  // 规模：引擎给的是**字节**（`bytes`，夹断前另有 `bytesBefore`）。**不读 `chars`**：引擎从不发这个
  // 键（`fold-summary-journal.js` 全文无 `chars`，C18 钉着），读它就是第二个 `unshrinkable`——同一个
  // 形状的推测键（见 §8.73：那个在本单里刚被换成契约真有的四个键）。推测键的代价不是报错而是
  // **永不触发**，外加下一个人会以为那个维度有数据。
  const sizeParts = [];
  if (Number.isSafeInteger(payload?.bytes)) {
    sizeParts.push(`${payload.bytes} B`);
    if (payload.truncated === true && Number.isSafeInteger(payload?.bytesBefore)
      && payload.bytesBefore > payload.bytes) {
      sizeParts.push(`夹断前 ${payload.bytesBefore} B`);
    }
  }

  const content = [
    `折走存档：第 ${Number.isSafeInteger(seq) && seq > 0 ? seq : 1} 次折叠（run ${runId ?? '-'}，${stamp}）`,
    `${rangeLine}的原文已退出模型可见上下文，本条是它留下的摘要——要细节去 transcript 查，别当它还在眼前。`,
    '',
    text.trimEnd(),
    '',
    [
      `— 来源 ${source}`,
      ...(strategy === undefined ? [] : [`策略 ${strategy}`]),
      sizeParts.length > 0 ? `摘掉正文 ${sizeParts.join(' / ')}` : '摘掉正文 规模未知',
      `引擎截断 ${payload.truncated === true ? '是' : '否'}`,
      ...scopeExtras,
      `作用域 会话`,
    ].join(' · '),
  ].join('\n');

  return {
    key: foldNoteKey({ nowIso: stamp, round: payload.round, seq }),
    content,
    tags: [FOLD_NOTE_TAG, `src:${slug(source, 'unknown')}`],
  };
}
