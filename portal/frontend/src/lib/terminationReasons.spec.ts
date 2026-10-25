// issue #212 防漂移（前端侧）：termination reason 单一常量的自洽性 + 新 reason 的双语文案齐全。
// 与后端 portal/test/termination-contract.test.js 互补：那边锁「常量 ↔ 文档枚举表 ↔ 引擎源码」，
// 本文件锁「常量 ↔ 前端运行时引用 ↔ i18n 双语键集」（i18n 用真实消息对象，不用 fs 读文本）。
//
// issue #349：本文件**不再裸 import `node:` 内建**。原先结构锁用 `readFileSync` 读被测常量的源码文本，
// 而全局 environment 是 jsdom（vite.config.ts:24）——vite 会把 `node:fs` externalize 成浏览器桩，
// suite 载入期直接 `Error: No such built-in module: node:`（0 test 被计；是否发作取决于 transform
// 缓存/并发状态，三个 agent 各见过一次而主 agent 全绿）。改用 vite 的 `?raw` 导入：**同一份源码文本**，
// 零 node 内建依赖，jsdom / node 两种环境下行为一致 ⇒ 那条结构断言的强度一字未降。
// （另一条路「在文件头 docblock 里把环境改成 node」实测被 src/i18n/index.ts:74 的顶层
//  `document.documentElement.lang = …` 挡住：本 spec 经 useEventStream.ts:18 → i18n/index 间接加载它。
//  不去改那个产品代码的顶层副作用，改走「去掉 node:fs 依赖」这条路。
//  ⚠ 本注释里**故意不写那个 docblock 的原文**：vitest 是全文扫指令注释，写全了（即使只是引用）
//  会真被当成环境指令，本文件就跑去 node 环境跑并报 `document is not defined`（本单踩过一次）。)
import { describe, expect, it } from 'vitest';
import terminationReasonsSource from './terminationReasons.ts?raw';
import { RUN_FAIL_REASONS as RUN_FAIL_REASONS_FROM_STREAM } from '../composables/useEventStream';
import { en } from '../i18n/locales/en';
import { zhCN } from '../i18n/locales/zh-CN';
import {
  ENGINE_VERSION_FOR_TERMINATION_REASONS,
  LEGACY_TERMINATION_REASONS,
  PERSISTENCE_TERMINATION_REASON,
  RUN_END_LABEL_REASONS,
  RUN_FAIL_REASON_LIST,
  RUN_FAIL_REASONS,
  RUN_RETRYABLE_ERROR_CODES,
  RUN_TERMINATION_SYSERR_REASONS,
  TERMINATION_REASONS,
  TERMINATION_REASON_SET,
  USER_STOP_TERMINATION_REASON,
} from './terminationReasons';

const CJK = /[\u4e00-\u9fff]/;

describe('termination reason 单一常量（issue #212）', () => {
  it('引擎取值面逐项在册：JSDoc 9 值 + persistence_failed，legacy 值不在册', () => {
    expect([...TERMINATION_REASONS]).toEqual([
      'end_turn',
      'no_tool',
      'stall',
      'max_rounds_cap',
      'judge_done',
      'continuation_exhausted',
      'final_guard_unverified',
      'aborted',
      'failed',
      'persistence_failed',
    ]);
    // 版本号是**刻意的 tripwire**：升 erix-agent 时必须重新核过 reason 全集（上游 JSDoc 9 值 +
    // fail() 产出的 persistence_failed）才能追号。0.18.0 → 0.19.0（#299）复核：typedef 从单行
    // 变成多行块（orchestrator.js:443-444）但**九值一字未变** ⇒ 只追版本号。
    // 0.19.0 → 0.20.0（#299）再核：九值仍一字未变（guide §4 的 `aborted` 优先级只改**可达性**，
    // 不改值域）⇒ 只追版本号。
    // 0.20.0 → 0.22.0（#333）三度核：`src/providers/payload.js`/`timeout.js`/`errors.js` 与 0.20.0
    // **逐字节相同**，对 0.22.0 的 `orchestrator.js` 取到的仍是同一组九值⇒ 仍只追版本号，
    // 下面九值断言一字未改（不放宽任何断言，§8.27 先例）。
    // 0.22.0 → 0.23.0（#337 升级片）四度核：整个 `src/providers/` 目录与 `src/loop/termination.js`
    // 与 0.22.0 **逐字节相同**（`diff` 无输出），0.23.0 的 `orchestrator.js` typedef 取到的仍是同一组
    // 九值（顺序、拼写全同，只是行号下移 1 行）⇒ 仍只追版本号，下面九值断言一字未改。
    expect(ENGINE_VERSION_FOR_TERMINATION_REASONS).toBe('0.25.0');
    for (const legacy of LEGACY_TERMINATION_REASONS) expect(TERMINATION_REASON_SET.has(legacy)).toBe(false);
  });

  it('红色集合 = 既有三值 + #212 两值；正常 reason 绝不进红色集合', () => {
    expect([...RUN_FAIL_REASONS].sort()).toEqual([
      'aborted', 'failed', 'final_guard_unverified', 'max_rounds_cap', 'persistence_failed',
    ]);
    for (const r of RUN_FAIL_REASON_LIST) expect(TERMINATION_REASON_SET.has(r)).toBe(true);
    for (const r of ['end_turn', 'no_tool', 'judge_done']) expect(RUN_FAIL_REASONS.has(r)).toBe(false);
    expect(PERSISTENCE_TERMINATION_REASON).toBe('persistence_failed');
  });

  it('useEventStream 复用的是同一个 Set 实例（不存在第二份枚举字面量）', () => {
    expect(RUN_FAIL_REASONS_FROM_STREAM).toBe(RUN_FAIL_REASONS);
  });

  // issue #236：界面分级集合 = 红色集合减掉「用户主动停止」，且由后者**派生**（不手抄第二份）。
  it('界面刷红集合 = RUN_FAIL_REASONS − aborted；aborted 改判中性但仍留在功能面集合里', () => {
    expect([...RUN_TERMINATION_SYSERR_REASONS].sort()).toEqual([
      'failed', 'final_guard_unverified', 'max_rounds_cap', 'persistence_failed',
    ]);
    expect(USER_STOP_TERMINATION_REASON).toBe('aborted');
    // 派生关系（将来往 RUN_FAIL_REASONS 里加值，这里自动跟上）：逐项比对，不靠手写清单。
    const derived = [...RUN_FAIL_REASONS].filter((r) => r !== USER_STOP_TERMINATION_REASON).sort();
    expect([...RUN_TERMINATION_SYSERR_REASONS].sort()).toEqual(derived);
    // #236 只改**呈现**：`aborted` 必须仍在 RUN_FAIL_REASONS 里（#261B 重试面 / #306 补拉靠它）。
    expect(RUN_FAIL_REASONS.has(USER_STOP_TERMINATION_REASON)).toBe(true);
    expect(RUN_TERMINATION_SYSERR_REASONS.has(USER_STOP_TERMINATION_REASON)).toBe(false);
  });

  // 主 agent 补的覆盖缺口（验收时亲跑变异发现的）：上面那条**只比内容**——把派生实现换成
  // 手抄的四值枚举（`new Set(['failed','max_rounds_cap','persistence_failed','final_guard_unverified'])`）
  // 行为逐字相同，上面那条**依旧全绿**（实测），于是注释里承诺的「将来往红色集合加值这里自动跟上」
  // 在测试面上没人守。内容等价测不出「是不是派生的」，所以这里读源码做结构断言
  // （与项目里 `append-seq-ordering.test.js` / `system-prompt.test.js` 同一手法）。
  it('界面刷红集合在**源码层面**必须是派生实现（手抄一份等价枚举不算派生）', () => {
    // issue #349：源码文本走 vite `?raw` 导入（构建期读盘），不再用 `readFileSync`——
    // 既避开 jsdom 下 `node:fs` 被 externalize 的 `No such built-in module: node:`，
    // 也避开 `new URL(…, import.meta.url)` 在 vitest 下是 http: URL 的坑。
    // 读到的仍是同一份 `src/lib/terminationReasons.ts` 全文：常量改名/换写法时下面的 match 落空即红。
    const src = terminationReasonsSource;
    const def = src.match(/export const RUN_TERMINATION_SYSERR_REASONS[\s\S]*?\n\);/);
    // 用 throw 而不是 expect(...).not.toBeNull()：后者不是类型守卫，strict 下 `def[0]` 仍报
    // TS18047 possibly null（CI 步骤 ④ 实测拦下过）。throw 既收窄类型，也保留同样的失败文案。
    if (!def) throw new Error('常量定义必须能在源码里定位到（改名/换写法时本用例先红，提醒重新评估这条锁）');
    const definition = def[0];
    // 必须引用红色集合并减去「用户主动停止」那个常量，而不是写死字面量。
    expect(definition).toContain('RUN_FAIL_REASONS');
    expect(definition).toContain('USER_STOP_TERMINATION_REASON');
    // 反面：出现任何 reason 字面量就是手抄（包括那个将来会新增的值也不能预先写死）。
    expect(definition).not.toMatch(/['"](failed|aborted|max_rounds_cap|persistence_failed|final_guard_unverified)['"]/);
  });

  it('上游可重试码集含 timeout/rate_limited/server/disconnect/checkpoint_failed（runner 镜像同集）', () => {
    expect([...RUN_RETRYABLE_ERROR_CODES].sort()).toEqual([
      'checkpoint_failed', 'disconnect', 'rate_limited', 'server', 'timeout',
    ]);
  });
});

describe('reason 的双语文案（issue #212 → #236）', () => {
  const keys = RUN_END_LABEL_REASONS as readonly string[];

  it('zh-CN 与 en 的 runEndReason 键集 = RUN_END_LABEL_REASONS（除 end_turn 外每个 reason 都有标签），且都有非空文案', () => {
    const zh = zhCN.stream.event.runEndReason as Readonly<Record<string, string>>;
    const enMsg = en.stream.event.runEndReason as Readonly<Record<string, string>>;
    expect(Object.keys(zh).sort()).toEqual([...keys].sort());
    expect(Object.keys(enMsg).sort()).toEqual([...keys].sort());
    // 除 end_turn（走 runEndNormal）外，引擎 reason 全集里每个值都必须有标签（#236 的覆盖面）。
    for (const reason of TERMINATION_REASONS) {
      if (reason === 'end_turn') continue;
      expect(keys).toContain(reason);
    }
    for (const key of keys) {
      expect(zh[key].length).toBeGreaterThan(0);
      expect(enMsg[key].length).toBeGreaterThan(0);
      // en 必须是真英文（不能只写中文交差）；zh 必须真是中文
      expect(enMsg[key]).not.toMatch(CJK);
      expect(zh[key]).toMatch(CJK);
    }
    // #236 的验收面：`aborted` 必须是母语文案，不是裸英文枚举。
    expect(zh.aborted).toBe('已中止');
    expect(enMsg.aborted).not.toBe('aborted');
  });

  it('落盘细节模板双语都带 operation/phase/sideEffect 三个占位符（红色告警要能看见 phase）', () => {
    for (const tpl of [zhCN.stream.event.runEndPersistence, en.stream.event.runEndPersistence]) {
      expect(tpl).toContain('{operation}');
      expect(tpl).toContain('{phase}');
      expect(tpl).toContain('{sideEffect}');
    }
  });
});
