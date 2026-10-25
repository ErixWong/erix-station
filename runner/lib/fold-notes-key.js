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

// payload = erix-agent 0.26.0 `context.onFoldSummary` 的入参：`{ text, source, chars, bytes, truncated, round }`。
// 返回 null = 不该写注（无 text）。正文里必须自带来源与规模：这条注是**唯一**能回答「丢了什么、
// 多大一块、谁折的」的东西——原文已退出模型可见上下文，下一任模型只能看见这条注。
export function deriveFoldNote({ payload, seq, nowIso, runId } = {}) {
  const text = payload?.text;
  if (typeof text !== 'string' || text.trim() === '') return null;

  const source = typeof payload.source === 'string' && payload.source.trim() !== ''
    ? payload.source.trim()
    : 'unknown';
  const chars = Number.isSafeInteger(payload.chars) ? payload.chars : '?';
  const round = payload.round === undefined || payload.round === null ? '?' : String(payload.round);
  const stamp = typeof nowIso === 'string' && nowIso ? nowIso : new Date().toISOString();

  const content = [
    `折走存档：第 ${Number.isSafeInteger(seq) && seq > 0 ? seq : 1} 次折叠（run ${runId ?? '-'}，${stamp}）`,
    `round ${round} 及之前的原文已退出模型可见上下文，本条是它留下的摘要——要细节去 transcript 查，别当它还在眼前。`,
    '',
    text.trimEnd(),
    '',
    [
      `— 来源 ${source}`,
      `摘掉正文 ${chars} 字`,
      `引擎截断 ${payload.truncated === true ? '是' : '否'}`,
      `作用域 会话`,
    ].join(' · '),
  ].join('\n');

  return {
    key: foldNoteKey({ nowIso: stamp, round: payload.round, seq }),
    content,
    tags: [FOLD_NOTE_TAG, `src:${slug(source, 'unknown')}`],
  };
}
