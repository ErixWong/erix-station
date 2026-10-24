// i18n 双语键集对齐断言（#246 交付② 单 B 要求「照 terminationReasons.spec 那种补一条」）。
// 与 en.ts 末尾的 `satisfies MessageSchema`（编译期防漏键/多键）互补：这里是**运行期**断言，
// 好处是失败信息直接点名缺哪个键，并且能顺带钉「新增文案的中英语义都真的写了」。
import { describe, expect, it } from 'vitest';
import { en } from './locales/en';
import { zhCN } from './locales/zh-CN';
import { PREVIEW_PORT_STATES } from '../lib/previewPorts';
import { KNOWN_GIT_LIGHT_REASONS } from '../lib/gitLight';

const CJK = /[\u4e00-\u9fff]/;

/** 递归展开成 `a.b.c` 形态的叶子键集合（对象才算分支，其余算叶子）。 */
function leafPaths(value: unknown, prefix = ''): string[] {
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key));
  }
  return [prefix];
}

function leafValues(value: unknown, prefix = ''): Array<[string, unknown]> {
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([key, child]) => leafValues(child, prefix ? `${prefix}.${key}` : key));
  }
  return [[prefix, value]];
}

describe('i18n 双语键集对齐（zh-CN ↔ en）', () => {
  it('整棵消息树的叶子键集合两边完全一致（缺译/多译都会点名）', () => {
    const zhKeys = leafPaths(zhCN).sort();
    const enKeys = leafPaths(en).sort();
    expect(enKeys.filter((key) => !zhKeys.includes(key))).toEqual([]);
    expect(zhKeys.filter((key) => !enKeys.includes(key))).toEqual([]);
    expect(zhKeys).toEqual(enKeys);
  });

  it('两边都不留空串叶子', () => {
    for (const [locale, messages] of [['zh-CN', zhCN], ['en', en]] as const) {
      const empty = leafValues(messages).filter(([, value]) => value === '' || value === null);
      expect(empty, `${locale} 的空文案`).toEqual([]);
    }
  });

  it('本次新增的 previewPorts.* 成对存在、zh 真是中文、en 真是英文（不许拿中文交差）', () => {
    const paths = leafPaths(zhCN.previewPorts, 'previewPorts').filter((key) => key.startsWith('previewPorts.'));
    expect(paths.length).toBeGreaterThan(20);
    for (const path of paths) {
      const read = (root: object): string => path.split('.').reduce<unknown>(
        (node, segment) => (node as Record<string, unknown>)[segment],
        root,
      ) as string;
      const zh = read(zhCN);
      const english = read(en);
      expect(zh.length, path).toBeGreaterThan(0);
      expect(english.length, path).toBeGreaterThan(0);
      expect(zh, path).toMatch(CJK);
      expect(english, path).not.toMatch(CJK);
      expect(english, path).not.toBe(zh);
    }
  });
});

describe('预览端口 state 的双语键集（§4.7a：只列 allocated / active）', () => {
  it('zh 与 en 的 previewPorts.state 键集 = PREVIEW_PORT_STATES（新增 state 取值会立刻在这里被要求补文案）', () => {
    const zh = zhCN.previewPorts.state as Readonly<Record<string, string>>;
    const enState = en.previewPorts.state as Readonly<Record<string, string>>;
    expect(Object.keys(zh).sort()).toEqual([...PREVIEW_PORT_STATES].sort());
    expect(Object.keys(enState).sort()).toEqual([...PREVIEW_PORT_STATES].sort());
  });

  it('state 文案不承诺「健康/运行中」（active 只代表首次凭证放行过）', () => {
    const zhValues = Object.values(zhCN.previewPorts.state as Record<string, string>);
    const enValues = Object.values(en.previewPorts.state as Record<string, string>);
    // issue #308：侧栏紧凑形态的**短**标签与作用域说明行同样受这条红线约束（不能换个短词就写成「运行中」）
    const zhShort = Object.values(zhCN.previewPorts.stateShort as Record<string, string>);
    const enShort = Object.values(en.previewPorts.stateShort as Record<string, string>);
    for (const text of [...zhValues, ...zhShort, zhCN.previewPorts.stateShortUnknown, zhCN.previewPorts.stateHint, zhCN.previewPorts.title]) {
      expect(text).not.toMatch(/健康/);
      expect(text).not.toMatch(/运行中/);
    }
    for (const text of [...enValues, ...enShort, en.previewPorts.stateShortUnknown, en.previewPorts.stateHint, en.previewPorts.title]) {
      expect(text).not.toMatch(/healthy/i);
      expect(text).not.toMatch(/running/i);
    }
  });

  // issue #308：紧凑形态的短标签键集必须与 state.* 一一对应（新增 state 取值会立刻要求补短标签）
  it('issue #308：previewPorts.stateShort 键集 = PREVIEW_PORT_STATES（与 state.* 同步）', () => {
    const zhShort = zhCN.previewPorts.stateShort as Readonly<Record<string, string>>;
    const enShort = en.previewPorts.stateShort as Readonly<Record<string, string>>;
    expect(Object.keys(zhShort).sort()).toEqual([...PREVIEW_PORT_STATES].sort());
    expect(Object.keys(enShort).sort()).toEqual([...PREVIEW_PORT_STATES].sort());
  });

  it('改块确认文案必须点名「立刻失效 / 404 / 链接会断」三要素（二次确认的判据）', () => {
    for (const admin of [zhCN.previewPorts.admin, en.previewPorts.admin]) {
      const confirmText = `${admin.confirmTitle} ${admin.confirmBody} ${admin.confirmWarning}`;
      expect(confirmText).toMatch(/404/);
      expect(confirmText).toMatch(/立刻失效|stop working immediately/);
      expect(confirmText).toMatch(/链接会断|links .* break/);
      expect(admin.confirmBody).toContain('{oldBlock}');
      expect(admin.confirmBody).toContain('{newBlock}');
    }
  });

  // issue #288（缺陷 B）：`attempt_killed` 的整套文案双语成对，且形状必须支持「缺 silent_ms 就整段不显示」。
  it('issue #288：stream.event.attemptKilled* 双语成对，且静默段是可选后缀片段', () => {
    const zh = zhCN.stream.event;
    const enEv = en.stream.event;
    for (const [locale, ev] of [['zh-CN', zh], ['en', enEv]] as const) {
      expect(ev.attemptKilled, locale).toContain('{attempt}');
      expect(ev.attemptKilled, locale).toContain('{max}');
      expect(ev.attemptKilled, locale).toContain('{cause}');
      // {silent} 必须是**末尾的可选片段**（调用方没时长时传空串），文案不得把它放进括号里当必填成分
      expect(ev.attemptKilled, locale).toMatch(/\{silent\}$/);
      expect(ev.attemptKilled, locale).not.toMatch(/\{dur\}/); // 时长只出现在 Silent 片段里
      expect(ev.attemptKilledSilent, locale).toContain('{dur}');
      expect(ev.attemptKilledSilent, locale).not.toMatch(/ms|undefined|null/); // 单位由 formatDuration 给
      expect(ev.attemptKilledUnknown, locale).not.toMatch(/undefined|\[object Object\]/);
      expect(Object.keys(ev.attemptKilledCause as Record<string, string>).sort()).toEqual(['crash', 'watchdog']);
    }
    expect(zh.attemptKilled).toMatch(CJK);
    expect(enEv.attemptKilled).not.toMatch(CJK);
    expect(enEv.attemptKilled).not.toBe(zh.attemptKilled);
  });

  // issue #288（缺陷 C）：「挂起工具未重放」的中性文案双语成对，且 {tool} 是可选后缀片段。
  it('issue #288：stream.event.toolReplay* 双语成对，工具名片段是可选后缀', () => {
    const zh = zhCN.stream.event;
    const enEv = en.stream.event;
    for (const [locale, ev] of [['zh-CN', zh], ['en', enEv]] as const) {
      // {tool} 必须在**末尾**且独立成片段：调用方名字不可信时传空串，主文案得是完整一句话
      expect(ev.toolReplaySkipped, locale).toMatch(/\{tool\}$/);
      expect(ev.toolReplaySkipped, locale).not.toMatch(/\{name\}/); // 名字只出现在 Tool 片段里
      expect(ev.toolReplayTool, locale).toContain('{name}');
      // 中性口径：不得把「没重放」写成失败/错误语气（前端走 onSep 分隔行，不是 onSysErr）
      expect(ev.toolReplaySkipped, locale).not.toMatch(/failed|error|失败|错误/i);
      expect(ev.toolReplaySkipped, locale).not.toMatch(/undefined|null|\[object Object\]|\{[a-z]+\}\}/);
      expect(ev.toolReplayTool, locale).not.toMatch(/undefined|null|\[object Object\]/);
    }
    expect(zh.toolReplaySkipped).toMatch(CJK);
    expect(enEv.toolReplaySkipped).not.toMatch(CJK);
    expect(enEv.toolReplaySkipped).not.toBe(zh.toolReplaySkipped);
  });

  // issue #300：中止/失败 run 的「部分正文」标签。文件首条用例已钉两边叶子键集合完全一致，
  // 这里额外钉**语义**：既不能说「已完成」（它没完成），也不能说「错误/失败」（半截正文不是错）——
  // 前端因此可以把它渲染成中性助手气泡而不是红色 .syserr。
  it('issue #300：stream.partialOutput.* 双语成对，语义是「已中止 · 部分输出」（不是完成、也不是错误）', () => {
    for (const [locale, root] of [['zh-CN', zhCN], ['en', en]] as const) {
      const label = root.stream.partialOutput.label;
      const truncatedText = root.stream.partialOutput.truncated;
      expect(label, locale).toMatch(/中止|Aborted/);
      expect(label, locale).toMatch(/部分|partial/i);
      expect(label, locale).not.toMatch(/完成|错误|失败|complete|success|error|fail/i);
      // 截断提示必须点名「没生成完」，且不得自带省略号/「已截断」文本以外的形状（后端 payload 里没有文案）
      expect(truncatedText, locale).toMatch(/未生成完|not finished/);
      expect(truncatedText, locale).not.toMatch(/undefined|null|\\[object Object\\]/);
    }
    expect(zhCN.stream.partialOutput.label).toMatch(CJK);
    expect(en.stream.partialOutput.label).not.toMatch(CJK);
    expect(en.stream.partialOutput.label).not.toBe(zhCN.stream.partialOutput.label);
  });

  // issue #283：工具结果行的「有时长 / 无时长」两版文案必须双语成对（文件首条用例已经钉「两边
  // 叶子键集合完全一致」，这里额外钉形状）：
  //   * 单位不得硬编码在文案里（时长由 `lib/toolSummary.formatDuration` 连着单位一起给）；
  //   * 无时长版不得带 `{dur}` 占位（否则渲染出 `undefined` / 空括号）。
  it('issue #283：stream.event.toolResult 与 toolResultNoDur 双语成对，且文案不自带 ms 单位', () => {
    for (const [locale, root] of [['zh-CN', zhCN], ['en', en]] as const) {
      const withDur = root.stream.event.toolResult;
      const noDur = root.stream.event.toolResultNoDur;
      expect(withDur, locale).toContain('{mark}');
      expect(withDur, locale).toContain('{digest}');
      expect(withDur, locale).toContain('{dur}');
      expect(withDur, locale).not.toMatch(/ms/);
      expect(noDur, locale).toContain('{mark}');
      expect(noDur, locale).not.toContain('{dur}');
      expect(noDur, locale).not.toMatch(/ms|undefined|null/);
    }
  });

  // issue #321：judge 是分轴**意见**文案——语义红线双语成对钉死：
  //   * done=true 必须说「未独立核验 + 是否收尾由模型自行判定」（本站 runner 不传 finalGuard，
  //     verification 恒 skipped，没有任何独立核验可承诺）；
  //   * executed 必须自带「非任务完成」语义（ISSUES.md 第 4 条的放大器就是旧文案把放行读成完成）；
  //   * 审计轴不得出现「已完成/已核验/已验证」这类承诺（zh）/ 肯定式 completed・verified（en）。
  // 反证锚：文案退回旧措辞（judge：executed / judge：扩轮 / 无「未独立核验」）时本用例变红。
  it('issue #321：judge 文案是意见不是验收——done=true 声明未独立核验，executed 不得暗示任务完成', () => {
    const zh = zhCN.stream.event;
    const enEv = en.stream.event;
    // 分轴键集必须成对（顶层叶子键对齐用例已综合兜底，这里额外点名本单新增键，防整体重命名躲过检测）。
    for (const key of [
      'judgeAxes', 'judgeAuditExecuted', 'judgeAuditPassThrough', 'judgeAuditBlocked', 'judgeAuditUndecided',
      'judgeGoalDoneTrue', 'judgeGoalDoneFalse', 'judgeConfidence', 'judgeReason',
      'judgeDirectionOffTrack', 'judgeDirectionUncertain', 'judgeExtendSuggest', 'judgeExtendDecline',
      'judgeDegraded', 'judgeUnknownAction', 'judgeNoDetail',
    ] as const) {
      expect(typeof zh[key], `zh judge.${key}`).toBe('string');
      expect(typeof enEv[key], `en judge.${key}`).toBe('string');
    }
    // done=true：未独立核验 + 收尾自判，两语都在。
    expect(zh.judgeGoalDoneTrue).toContain('未独立核验');
    expect(zh.judgeGoalDoneTrue).toContain('是否收尾由模型自行判定');
    expect(enEv.judgeGoalDoneTrue).toMatch(/not independently verified/);
    expect(enEv.judgeGoalDoneTrue).toMatch(/model itself decides whether to wrap up/);
    // executed：必须自带「非任务完成」对语义。
    expect(zh.judgeAuditExecuted).toContain('非任务完成');
    expect(enEv.judgeAuditExecuted).toMatch(/not task completion/i);
    // 承诺红线：审计轴/降级/未知动作文案不得出现已核验/已验证/已完成（zh）；
    // en 侧除 judgeGoalDoneTrue 的否定式外不得出现裸 verified，也不得出现 completed 承诺。
    for (const [locale, ev] of [['zh-CN', zh], ['en', enEv]] as const) {
      for (const [key, value] of Object.entries(ev)) {
        if (!key.startsWith('judge') || typeof value !== 'string') continue;
        expect(value, `${locale} judge.${key} 不得承诺核验`).not.toMatch(/已核验|已验证/);
        if (key === 'judgeGoalDoneTrue') continue; // 唯一允许出现「核验」字样处，且必为「未…核验」
        expect(value, `${locale} judge.${key} 不得出现核验/完成承诺`).not.toMatch(/核验|已验证|已完成/);
        if (key !== 'judgeGoalDoneTrue') expect(value, `${locale} judge.${key}`).not.toMatch(/verified/i);
      }
      expect(zh.judgeGoalDoneTrue).toMatch(CJK);
      expect(enEv.judgeGoalDoneTrue).not.toMatch(CJK);
    }
    // 分轴模板形状：axes 占位符存在，旧三态互斥模板（{action}{dash} 直接透传引擎枚举）不得回潮。
    expect(zh.judgeAxes).toContain('{axes}');
    expect(enEv.judgeAxes).toContain('{axes}');
    expect(zh.judgeAxes).not.toContain('{action}');
  });
});

// issue #359（决策 §7 D9）P0b：收工灯文案的语义红线。**为什么不只钉键集**：这颗灯的全部价值在于
// 一句话——"你的活儿被 git 保护住了吗"。文案一旦漂成"远端是最新的 / 自动提交 / ⚠ 错误"，
// 承诺就假了（绿是承诺、红是日常态、平台零 git 写）。键集对齐由上面第一条统一兜住。
describe('收工灯 gitLight.* 的语义红线（#359 / D9）', () => {
  const zhLight = zhCN.gitLight as unknown as Record<string, Record<string, string>>;
  const enLight = en.gitLight as unknown as Record<string, Record<string, string>>;

  it('reason 键集合与 lib 的已知表**逐字一致**（加 reason 不补文案、或文案漏进 unknown，都会红）', () => {
    expect(Object.keys(zhLight.reason).sort()).toEqual([...KNOWN_GIT_LIGHT_REASONS].sort());
    expect(Object.keys(enLight.reason).sort()).toEqual([...KNOWN_GIT_LIGHT_REASONS].sort());
  });

  it('绿不许承诺"远端是最新的"：必须说"与你已知的远端一致"（同事推的你没 fetch 就看不见）', () => {
    expect(zhLight.reason.synced).toContain('已知');
    expect(enLight.reason.synced).toMatch(/as your machine knows it/);
    expect(zhLight.reason.synced).not.toMatch(/远端是最新|远端最新|已是最新/);
    expect(enLight.reason.synced).not.toMatch(/remote is up to date|latest/i);
    expect(zhLight.tip.greenHonest).toContain('fetch');
    expect(enLight.tip.greenHonest).toMatch(/not fetched/);
  });

  it('红是日常态不是警报：标签与原因里不出现 ⚠，也不说"错误/失败"', () => {
    expect(zhLight.label.red).toBe('未落地');
    expect(zhLight.label.red).not.toMatch(/错误|失败|警告/);
    expect(enLight.label.red.toLowerCase()).not.toMatch(/error|fail|warn/);
    for (const [locale, group] of [['zh-CN', zhLight], ['en', enLight]] as const) {
      for (const [name, bag] of Object.entries(group)) {
        for (const [key, value] of Object.entries(bag)) {
          expect(`${name}.${key}`, `${locale} 键名`).toBeTruthy();
          if (typeof value === 'string') {
            expect(value, `${locale} gitLight.${name}.${key} 不得出现告警符`).not.toContain('⚠');
          }
        }
      }
    }
  });

  it('动作只预填不发送：口径必须写在界面上（发出去就是一次 run，不能让用户以为是自动提交）', () => {
    expect(zhLight.action.finishHint).toMatch(/输入框/);
    expect(zhLight.action.finishHint).toMatch(/不替你发送/);
    expect(enLight.action.finishHint).toMatch(/fills the composer/i);
    expect(enLight.action.finishHint).toMatch(/does not send/i);
    // 预填文本必须给 AI 指名目标与"别漏未跟踪"（D9：未跟踪与未提交同样零保护）
    expect(zhLight.prefill.finish).toContain('{repos}');
    expect(zhLight.prefill.finish).toMatch(/未跟踪/);
    expect(enLight.prefill.finish).toContain('{repos}');
    expect(enLight.prefill.finish).toMatch(/untracked/i);
  });

  it('未检查完必须说出来（partial 的口径是"按未知处理"，不是"已收工"）', () => {
    expect(zhLight.tip.partial).toMatch(/未知/);
    expect(enLight.tip.partial).toMatch(/unknown/i);
    expect(zhLight.label.grey).toBe('未检查');
    expect(enLight.label.grey.toLowerCase()).toContain('unchecked');
  });
});
