/**
 * issue #243（工单 fix-261116-03 第 3 步）：`textualized_tool_call` 的**界面渲染**判据。
 *
 * 现场（改前实测，读数记在 `/tmp/tickets/deliver-243-step3.md`）：这类事件在前端 `dispatch` 里落进
 * `default: return` ⇒ **整条事件被静默丢弃**（回放与实时各加 0 条条目、DOM 里零节点）。
 * 所以本文件钉的是「**补上的那段渲染**」，四格各自治一种错法：
 *   ① 事件存在 ⇒ 页面上真出现这句话（历史回放 + 实时**两条路都要**，同一句文案同一个位置）；
 *   ② **缺 marker** 也照出这句话，且不许漏出 `undefined` / 悬空破折号（后端第 2 步特意留了「缺 marker
 *      也照发」⇒ 渲染不许依赖它）；
 *   ③ `marker` 含 `<invoke name="exec">` 与全角竖线 ⇒ **原文可见**（证明走的是文本节点而不是
 *      `v-html`；把 `StreamPanel` 那处插值改成 `v-html`，本格必须红——标签会被吃掉，连后半句一起吞）；
 *   ④ **反向自证**：正常 `run_end` + 普通正文的 run **不该**出现这句话（它是诊断，不是终态装饰）。
 * 另加三格守住红线本身：中性（`.roundsep` 而非 `.syserr`，且没有 `⚠`）、位置（正文之后、终态条之前）、
 * 双语（zh/en 各自出话，en 里不许混中文）、脏 marker（不许 `[object Object]` 渗进用户可见文案）。
 *
 * ⚠ 口径：本文件**不用 `w.emitted()`**（本机 `NODE_ENV=production` 会让它恒空 ⇒ 假绿），一律 DOM 文本断言。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import StreamPanel from './StreamPanel.vue';
import { useWorkbenchStore } from '../stores/workbench';
import { i18n, setLocale } from '../i18n';

const NOTICE_ZH = '模型把工具调用写进了正文，这次调用没有真的执行';
const NOTICE_EN_HEAD = 'the model wrote the tool call into its answer text';
const CJK = /[\u4e00-\u9fff]/;

function mountPanel() {
  return mount(StreamPanel, { global: { plugins: [i18n] } });
}

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
  setActivePinia(createPinia());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = async () => new Response('{"items":[]}', { status: 200 });
});

/** 历史回放帧（GET /events/history 的响应项形状；与 SSE data 展开后同构）。 */
const historyFrame = (payload: Record<string, unknown>, seq = 101) => ({
  seq, run_id: 'r243', type: 'textualized_tool_call', payload,
});
/** 实时 SSE 帧（`handleEvent` 吃的是 MessageEvent 形状）。 */
const liveFrame = (payload: Record<string, unknown>, seq = 102) => ({
  data: JSON.stringify({ seq, run_id: 'r243', ...payload }),
});

const sepTexts = (wrapper: ReturnType<typeof mountPanel>) =>
  wrapper.findAll('.roundsep').map((n) => n.text());

describe('#243 ①②③④ 渲染四格', () => {
  it('① 历史回放（刷新后这条路）⇒ 页面上出现这句中性提示，并带上命中的特征片段', () => {
    const store = useWorkbenchStore();
    store.es.replayEvent(historyFrame({ chars: 1830, marker: '<｜｜DSML｜｜' }) as never);
    const wrapper = mountPanel();

    const seps = sepTexts(wrapper);
    expect(seps.length).toBe(1);
    expect(seps[0]).toContain(NOTICE_ZH);
    expect(seps[0]).toContain('<｜｜DSML｜｜');
    // 中性措辞：不是警报（正文里那段文字就是模型答案的一部分，只是没执行）
    expect(seps[0]).not.toContain('⚠');
    expect(seps[0]).not.toMatch(/失败|错误|异常/);
  });

  it('① 实时 SSE 帧 ⇒ 同一句话同一个位置（两路共用一条 dispatch，#89 口径）', () => {
    const store = useWorkbenchStore();
    store.es.handleEvent('textualized_tool_call', liveFrame({ chars: 44, marker: '<tool_call' }) as never);
    const wrapper = mountPanel();

    const seps = sepTexts(wrapper);
    expect(seps.length).toBe(1);
    expect(seps[0]).toContain(NOTICE_ZH);
    expect(seps[0]).toContain('<tool_call');
    expect(seps[0]).not.toContain('⚠');
  });

  it('① 两路同文案：实时帧与刷新回放帧落到**同一行**中性分隔行（除片段外逐字一样）', () => {
    const live = renderOnce(() => useWorkbenchStore().es
      .handleEvent('textualized_tool_call', liveFrame({ chars: 44, marker: '<tool_call' }) as never));
    const replay = renderOnce(() => useWorkbenchStore().es
      .replayEvent(historyFrame({ chars: 44, marker: '<tool_call' }) as never));
    expect(live).toBe(replay);
    expect(live).toContain(NOTICE_ZH);
  });

  it('② 缺 marker ⇒ 这句话照样出现，且没有 undefined / 空串 / 悬空破折号', () => {
    const store = useWorkbenchStore();
    store.es.replayEvent(historyFrame({ chars: 44 }) as never);
    const wrapper = mountPanel();

    const seps = sepTexts(wrapper);
    expect(seps.length).toBe(1, '缺 marker 也必须出这一条（后端第 2 步特意留了「缺 marker 也照发」）');
    expect(seps[0]).toBe(NOTICE_ZH);            // 整句独立成立
    expect(seps[0]).not.toContain('undefined');
    expect(seps[0]).not.toContain('null');
    expect(seps[0]).not.toMatch(/—\s*$/,);      // 不许留一段没有内容的片段
    expect(wrapper.text()).not.toContain('undefined');
  });

  it('③ marker 含 `<invoke name="exec">`（ASCII 尖括号）⇒ DOM 里原文可见（v-html 会变红的就是这一格）', () => {
    // 夹具形状取自真实现场那一族：`<tool_call…` 家族的文本化调用里，`<invoke name="exec">` 就是
    // 紧跟在后面的那一行（dev 库 `11fa3c68…` 的样本形态）。**必须**是 ASCII 开头的标签：
    // `<｜｜…` 那种全角开头的串在 HTML 里本来就不是标签，v-html 也吃不掉它 ⇒ 拿它当靶子会假绿。
    const raw = '<tool_call>\n<invoke name="exec">';
    const store = useWorkbenchStore();
    store.es.replayEvent(historyFrame({ chars: 900, marker: raw }) as never);
    const wrapper = mountPanel();

    const node = wrapper.findAll('.roundsep')[0];
    // textContent：文本节点的真实内容 ⇒ 改 v-html 后这里会变成「被解析后剩下的残渣」，本格必红
    expect(node.text()).toContain('<invoke name="exec">');
    expect(node.text()).toContain('<tool_call>');
    expect(node.text()).toContain(NOTICE_ZH);            // 主句没被尖括号连同后半句一起吞掉
    // innerHTML：尖括号必须是**转义后**的文本，而不是活标签（序列化器不转义文本里的引号，故只比尖括号）
    expect(node.html()).toContain('&lt;invoke name="exec"&gt;');
    expect(node.html()).not.toMatch(/<invoke\b/);
    // 也没有子元素：v-html 会把 `<invoke>` 变成真的 DOM 节点
    expect(node.element.querySelectorAll('*').length).toBe(0);
  });

  it('③ 全角竖线形态（dev 库真样本 `<｜｜DSML｜｜`）同样原样可见', () => {
    const raw = '<' + '\uff5c'.repeat(2) + 'DSML' + '\uff5c'.repeat(2);
    const store = useWorkbenchStore();
    store.es.replayEvent(historyFrame({ chars: 1830, marker: raw }) as never);
    expect(sepTexts(mountPanel())[0]).toContain(raw);
  });

  it('④ 反向自证：正常 run_end + 普通正文的 run 不该出现这句话', () => {
    const store = useWorkbenchStore();
    store.renderedIds = new Set();
    store.addMessage({ id: 'm1', role: 'assistant', content: '这次改动落在两个文件，测试 55 个全绿。' });
    store.es.replayEvent({ seq: 100, run_id: 'r243', type: 'round_end', payload: { round: 9, final_text: '普通正文' } } as never);
    store.addRunTermination({ seq: 103, run_id: 'r243', type: 'run_termination', payload: { termination: { reason: 'end_turn' } } } as never);
    const wrapper = mountPanel();

    expect(wrapper.text()).not.toContain(NOTICE_ZH);
    // 终态分隔条照旧在（本改动是 additive，没把终态面改掉）
    expect(sepTexts(wrapper).some((s) => s.includes('run 结束'))).toBe(true);
  });
});

describe('#243 中性面 / 位置 / 双语 / 脏值', () => {
  it('中性：条目落在 .roundsep 而不是红色 .syserr，且全页没有 ⚠', () => {
    const store = useWorkbenchStore();
    store.es.replayEvent(historyFrame({ chars: 1830, marker: '<｜｜DSML｜｜' }) as never);
    const kinds = store.entries.map((e) => (e as { kind: string }).kind);
    expect(kinds).toEqual(['sep']);
    expect(kinds).not.toContain('syserr');

    const wrapper = mountPanel();
    expect(wrapper.findAll('.syserr').length).toBe(0);
    expect(wrapper.findAll('.roundsep.judge-panel').length).toBe(0, 'judge 的黄色面板也不许借用');
    expect(wrapper.text()).not.toContain('⚠');
  });

  it('位置：正文条目之后、终态分隔条之前（portal 的 seq 已排好，前端不重排）', () => {
    const store = useWorkbenchStore();
    store.renderedIds = new Set();
    store.addMessage({ id: 'mu', role: 'user', content: '把账本记一下' });
    // portal 写入顺序：…正文 → textualized_tool_call → run_end（终态分隔条按 run_end 的 seq 投影）
    store.es.replayEvent(historyFrame({ chars: 1830, marker: '<｜｜DSML｜｜' }, 200) as never);
    store.addRunTermination({ seq: 201, run_id: 'r243', type: 'run_termination', payload: { termination: { reason: 'end_turn' } } } as never);

    const wrapper = mountPanel();
    const notice = wrapper.findAll('.roundsep').find((n) => n.text().includes(NOTICE_ZH));
    const terminal = wrapper.findAll('.roundsep').find((n) => n.text().includes('run 结束'));
    const user = wrapper.find('.msg.user');
    expect(notice, '提示行没渲染出来').toBeTruthy();
    expect(terminal, '终态分隔条没渲染出来').toBeTruthy();
    expect(user.exists(), '正文（用户消息）没渲染出来').toBe(true);
    expect(precedes(user.element, notice!.element), '提示必须在正文**之后**').toBe(true);
    expect(precedes(notice!.element, terminal!.element), '提示必须在终态分隔条**之前**（portal 的 seq 已排好，前端不重排）').toBe(true);
  });

  it('双语：en 下出英文原句，且整行不许混进中文（zh/en 两处都真加了键）', () => {
    setLocale('en');
    const store = useWorkbenchStore();
    store.es.replayEvent(historyFrame({ chars: 44 }) as never);
    const text = sepTexts(mountPanel())[0];
    expect(text).toContain(NOTICE_EN_HEAD);
    expect(text).not.toMatch(CJK);
  });

  it('脏 marker：非串 / 空串 / 超长一律不带片段或截断，绝不把 [object Object] 渗进文案', () => {
    const cases: Array<[unknown, string]> = [
      [{ a: 1 }, '对象'],
      [42, '数字'],
      ['', '空串'],
      [null, 'null'],
    ];
    for (const [marker, label] of cases) {
      setActivePinia(createPinia());
      const store = useWorkbenchStore();
      store.es.replayEvent(historyFrame({ chars: 7, marker }) as never);
      const text = sepTexts(mountPanel())[0];
      expect(text, label).toBe(NOTICE_ZH);
      expect(text, label).not.toContain('[object Object]');
    }
    setActivePinia(createPinia());
    const store = useWorkbenchStore();
    store.es.replayEvent(historyFrame({ chars: 7, marker: 'x'.repeat(500) }) as never);
    const text = sepTexts(mountPanel())[0];
    expect(text).toContain(NOTICE_ZH);
    expect(text.length).toBeLessThanOrEqual(NOTICE_ZH.length + 3 + 120,
      'marker 片段上界与 portal 的载荷校验同源（≤120），一行提示不许撑成一段代码');
  });
});

/** 各自独立建一个 store（`renderOnce` 用）：新 pinia ⇒ 条目互不污染。 */
function renderOnce(drive: () => void): string {
  setActivePinia(createPinia());
  drive();
  return sepTexts(mountPanel()).join('\n');
}

/**
 * DOM 文档序里的先后判据（位置格用）。
 * 口径：取**具体那一行**的元素（不取祖先——祖先是包着全部内容的 div，拿它比会得出假顺序），
 * 再用 `compareDocumentPosition` 判先后；这是「渲染顺序」的唯一真相，不看 entries 数组（那是中间态）。
 */
function precedes(a: Element, b: Element): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const NODE_FOLLOWING = 4; // Node.DOCUMENT_POSITION_FOLLOWING
  return ((a as any).compareDocumentPosition(b) & NODE_FOLLOWING) === NODE_FOLLOWING;
}
