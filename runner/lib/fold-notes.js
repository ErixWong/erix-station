// issue #392（C 片）：把「折叠摘要」写成一条笔记——让被折掉的原文在会话里留下可翻的账。
//
// 为什么必须有：`fold-statistical`（A 片）只是让折叠**产出**替代物；产出之后若没人投递，用户侧
// 感知仍与「静默硬删」一致——「折一次记一次」这条不变量要在这里闭环。引擎侧 0.26.0 已给出口：
//   `context.onFoldSummary(payload)`，`payload = { ...record.foldedFacts, round }`
//   = `{ text, source, chars, bytes, truncated, round }`。
// 投递方向是**宿主的事**（erix-agent#470 的定调：引擎里没有 notesStore 句柄，也不该塞 fs/DB）。
//
// 三条硬约束（写在代码里，不靠注释自觉）：
//   1) **必须可排进时间线**：note key 不能是固定串（同 scope 下 key 即 id，第二条会撞重复）。
//      本站一条用户消息 = 一个 run，所以「谁在什么时候丢了什么」只能由 key 里的时刻承担。
//      key 必须过 store 的 `SAFE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/`（`src/store/notes.js:47`，
//      不过就被哈希成 `h<digest>`，人在 `note_list` 里看不出顺序），故时刻用 basic 形态。
//   2) **失败绝不打死 run**：写注是投递，不是事实源。抛错只上报（`fatal:false`），由 worker 转 warn。
//      引擎侧同一条纪律在 `fold_summary_delivery`（抛错 → `persistence_error`，不杀 run）。
//   3) **无 text 不写空注**：引擎契约是「无替代物就不调用回调」，真被调到了算异常形态，
//      只上报、不写一条空笔记（空笔记会在 `note_list` 里占位并让下一任模型以为已存档）。
import { FOLD_NOTE_TAG, foldNoteKey, deriveFoldNote } from './fold-notes-key.js';

export { FOLD_NOTE_TAG, foldNoteKey, deriveFoldNote };

// onFoldSummary 的投递器。noteTools 由 lib/notes-tools.js 装配（B 片：会话作用域 scopeRef=sessionId），
// 所以这里**不传 scopeRef/runId 给 note_take**——作用域由工厂绑定，传了就是伪造 `__erix`。
export function createFoldNoteSink({ noteTools, runId, onDeliveryError } = {}) {
  const executors = noteTools?.executors;
  if (typeof executors !== 'function') return { enabled: false, onFoldSummary: null, seq: () => 0 };

  let seq = 0;
  const report = (info) => { try { onDeliveryError?.(info); } catch { /* 上报通道自己坏，不再传染 */ } };

  const onFoldSummary = async (payload) => {
    seq += 1;                       // 异常分支也占号：同一秒内连续折叠的 key 必须不重复
    const nowIso = new Date().toISOString();
    const note = deriveFoldNote({ payload, seq, nowIso, runId });
    if (!note) {
      report({ phase: 'fold_summary_delivery', reason: 'no_summary_text', seq, fatal: false });
      return;
    }
    try {
      await executors('note_take', { key: note.key, content: note.content, tags: note.tags, pinned: false }, {});
    } catch (err) {
      report({
        phase: 'fold_summary_delivery',
        key: note.key,
        seq,
        fatal: false,
        message: String(err?.message ?? err),
      });
    }
  };

  return { enabled: true, onFoldSummary, seq: () => seq };
}
