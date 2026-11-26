// #816 第③步：`session.folds` 的前端读侧纯函数（`lib/foldIndex.ts`）。
// 四组口径钉死在这里：① 脏值一律丢（绝不补 0/空串）；② `foldHeadline` 按 origin 分派
// （mechanical 不显示 title、semantic 剥 `## ` 后太短要退回范围）；③ 足迹聚合与 3 组上限；
// ④ 竖串定位是纯数学 `to / max(lastRound, maxTo)`（没有任何 DOM 可量，所以用例只喂数字）。
import { describe, expect, it } from 'vitest';
import {
  foldFootprint,
  foldHeadline,
  foldRailNodes,
  foldRangeLabel,
  normalizeSessionFolds,
  type FoldEntry,
} from './foldIndex';

/** 真机样本形状（dev 库 6 次折叠：1–6 / 7–12 / 13–15 / 16–17 / 18–21 / 22–22，前 5 条 mechanical）。 */
const MECHANICAL: FoldEntry = {
  round: 12,
  from: 1,
  to: 6,
  rounds: 6,
  // 实测：mechanical 的 title 就是把范围又念一遍的模板句（信息量为零，所以它不该出现在界面上）
  title: '早期第 1–6 轮（共 6 轮）已折叠。工具足迹：readFile×40 / shell×1。需要原文请重读文件…',
  origin: 'mechanical',
  toolCalls: [{ name: 'readFile' }, { name: 'shell' }],
};
const SEMANTIC: FoldEntry = {
  round: 24,
  from: 22,
  to: 22,
  rounds: 1,
  title: '## 调研 store 层与投影边界',
  origin: 'semantic',
  truncated: true,
};

describe('#816 normalizeSessionFolds：DTO 收窄（脏值一律丢，绝不补 0/空串）', () => {
  it('真形状两项都留：子键原样收窄，顺序不动（排序与去重是后端契约）', () => {
    const folds = normalizeSessionFolds([MECHANICAL, SEMANTIC]);
    expect(folds).toEqual([MECHANICAL, SEMANTIC]);
    expect(folds.map((f) => f.to)).toEqual([6, 22]);
  });

  it('非数组（undefined / null / 对象 / 字符串）⇒ []（旧后端无此键不是崩，是「没有折叠」）', () => {
    for (const raw of [undefined, null, {}, 'folds', 42, true]) {
      expect(normalizeSessionFolds(raw), String(raw)).toEqual([]);
    }
    expect(normalizeSessionFolds([])).toEqual([]);
  });

  it('脏项整项丢：缺 from / 缺 to / 区间倒挂 / 项不是对象；好项照常留', () => {
    const folds = normalizeSessionFolds([
      { to: 5 }, // 缺 from ⇒ 区间画不出来，不给半截
      { from: 3 }, // 缺 to ⇒ 同上
      { from: 9, to: 4 }, // 倒挂不是折叠
      { from: 1, to: 2, round: '7' }, // 轮号脏 ⇒ 只丢 round 键，项留着
      'oops', // 项不是对象
      null,
      [1, 2], // 数组不是折叠项
      { from: 1, to: 2 }, // 干净项
    ]);
    expect(folds).toEqual([{ from: 1, to: 2 }, { from: 1, to: 2 }]);
    expect('round' in folds[0]).toBe(false); // 脏子键 ⇒ 键缺席，不是 0
  });

  it('脏子键 ⇒ 键缺席而不是 0/空串/false；toolCalls 混脏 ⇒ 逐项清洗，洗完为空就不给这个键', () => {
    const [fold] = normalizeSessionFolds([{
      from: 1,
      to: 2,
      rounds: 0, // 0 轮不是信息
      title: '   ', // 空标题
      origin: 'weird', // 白名单外
      truncated: 'yes', // 不是真 true
      toolCalls: [{ name: 'readFile' }, { name: '' }, {}, null, 'x', { name: 'shell', argsSummary: '  ' }],
    }]);
    expect(fold).toEqual({ from: 1, to: 2, toolCalls: [{ name: 'readFile' }, { name: 'shell' }] });
    expect('rounds' in fold).toBe(false);
    expect('title' in fold).toBe(false);
    expect('origin' in fold).toBe(false);
    expect('truncated' in fold).toBe(false);
    expect(fold.toolCalls?.[1]).toEqual({ name: 'shell' }); // 空 argsSummary ⇒ 不带该子键
    // 全脏 ⇒ 整个 toolCalls 键缺席（不是 []）
    const [bare] = normalizeSessionFolds([{ from: 1, to: 2, toolCalls: [{ name: '' }] }]);
    expect('toolCalls' in bare).toBe(false);
  });

  it('origin 白名单三值原样收，truncated === true 才给键', () => {
    const folds = normalizeSessionFolds([
      { from: 1, to: 2, origin: 'mechanical' },
      { from: 3, to: 4, origin: 'semantic' },
      { from: 5, to: 6, origin: 'host' },
      { from: 7, to: 8, truncated: true },
    ]);
    expect(folds.map((f) => f.origin)).toEqual(['mechanical', 'semantic', 'host', undefined]);
    expect(folds[3]).toEqual({ from: 7, to: 8, truncated: true });
  });
});

describe('#816 foldRangeLabel：范围是折叠的身份，三处（常驻条/面板/竖串卡）共用一种写法', () => {
  it('区间 / 单轮 / 只有 to / 两头都缺，四种写法各一条', () => {
    expect(foldRangeLabel({ from: 7, to: 12 })).toBe('第 7–12 轮');
    expect(foldRangeLabel({ from: 22, to: 22 })).toBe('第 22 轮'); // 不写「第 22–22 轮」
    expect(foldRangeLabel({ from: 1, to: 1 })).toBe('第 1 轮');
    expect(foldRangeLabel({ to: 12 } as FoldEntry)).toBe('到第 12 轮'); // 只有 to（手搓窄对象 / 将来只给一头）
    expect(foldRangeLabel({} as FoldEntry)).toBe('更早的轮次'); // 两头都不知道
  });
});

describe('#816 foldHeadline：按 origin 分派（这是本单的核心口径，不许简化）', () => {
  it('mechanical ⇒ 返回范围，且**不含** title 原文（实测它的 title 是把范围又念一遍的模板句）', () => {
    const label = foldHeadline(MECHANICAL);
    expect(label).toBe('第 1–6 轮');
    expect(label).not.toContain('已折叠');
    expect(label).not.toContain('工具足迹');
    expect(label).not.toContain(MECHANICAL.title!);
  });

  it('semantic 剥 `## ` 前缀；剥完不足 6 字 ⇒ 退回范围（`## 阶段` 是实测样本，退回是预期行为）', () => {
    expect(foldHeadline({ from: 22, to: 22, origin: 'semantic', title: '## 阶段' })).toBe('第 22 轮');
    expect(foldHeadline({ from: 22, to: 22, origin: 'semantic', title: '  ###  收尾  ' })).toBe('第 22 轮');
    expect(foldHeadline({ from: 1, to: 2, origin: 'semantic', title: '阶段' })).toBe('第 1–2 轮');
    // 闸门就在 6 字上：5 字退回范围、6 字过闸
    expect(foldHeadline({ from: 1, to: 2, origin: 'semantic', title: '调研边界定' })).toBe('第 1–2 轮');
    expect(foldHeadline({ from: 1, to: 2, origin: 'semantic', title: '调研边界已定' })).toBe('调研边界已定');
  });

  it('semantic 的长 title ⇒ 剥掉 markdown 标题符号后原样给出（不再带 `#`）', () => {
    expect(foldHeadline({ from: 22, to: 22, origin: 'semantic', title: '## 调研 store 层与投影边界' }))
      .toBe('调研 store 层与投影边界');
    expect(foldHeadline({ from: 1, to: 3, origin: 'semantic', title: '没有前缀的普通标题' }))
      .toBe('没有前缀的普通标题');
  });

  it('origin 缺席（旧后端只给 title）⇒ 同 semantic 分支；title 也没有 ⇒ 范围', () => {
    expect(foldHeadline({ from: 4, to: 9, title: '接入鉴权与配额' })).toBe('接入鉴权与配额');
    expect(foldHeadline({ from: 4, to: 9 })).toBe('第 4–9 轮');
    // 整串只有 `#`：长度过了 6 的闸也不能当标题
    expect(foldHeadline({ from: 4, to: 9, title: '#######' })).toBe('第 4–9 轮');
  });
});

describe('#816 foldFootprint：计数聚合 + 3 组上限', () => {
  it('同名聚合计数、首次出现顺序稳定，格式 `readFile×40 / shell×1`', () => {
    const calls = [
      ...Array.from({ length: 40 }, () => ({ name: 'readFile' })),
      { name: 'shell' },
      { name: 'writeFile' },
    ];
    expect(foldFootprint({ from: 1, to: 6, toolCalls: calls })).toBe('readFile×40 / shell×1 / writeFile×1');
    // 顺序由首次出现决定（同一份 DTO 刷新两次不许换序）
    expect(foldFootprint({ from: 1, to: 6, toolCalls: [{ name: 'shell' }, { name: 'readFile' }, { name: 'shell' }] }))
      .toBe('shell×2 / readFile×1');
  });

  it('超过 3 组 ⇒ 截到 3 组并加 ` …`（一行放不下 40 种工具的清单）', () => {
    const footprint = foldFootprint({
      from: 1,
      to: 6,
      toolCalls: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }, { name: 'e' }],
    });
    expect(footprint).toBe('a×1 / b×1 / c×1 …');
    expect(footprint.split(' / ')).toHaveLength(3);
  });

  it('没有足迹（无键 / 空数组 / 全脏 name）⇒ 空串（渲染侧据此不画这一段）', () => {
    expect(foldFootprint({ from: 1, to: 2 })).toBe('');
    expect(foldFootprint({ from: 1, to: 2, toolCalls: [] })).toBe('');
    expect(foldFootprint({ from: 1, to: 2, toolCalls: [{ name: '  ' }, {} as never] })).toBe('');
  });
});

describe('#816 foldRailNodes：纯数学 to / max(lastRound, maxTo)（没有 DOM 可量）', () => {
  /** 真机六次折叠的 `to`：6/12/15/17/21/22。 */
  const folds: FoldEntry[] = [
    { from: 1, to: 6 }, { from: 7, to: 12 }, { from: 13, to: 15 },
    { from: 16, to: 17 }, { from: 18, to: 21 }, { from: 22, to: 22 },
  ];

  it('lastRound=40 ⇒ topPct 递增且末条 = 22/40 = 55（竖串下半段是「还没折的部分」）', () => {
    const nodes = foldRailNodes(folds, 40);
    expect(nodes.map((n) => n.topPct)).toEqual([15, 30, 37.5, 42.5, 52.5, 55]);
    const pct = nodes.map((n) => n.topPct);
    expect([...pct].sort((a, b) => a - b)).toEqual(pct); // 单调不减 = 越新的折叠越靠下
    expect(nodes.at(-1)!.topPct).toBe(55);
    expect(nodes.map((n) => n.fold.to)).toEqual([6, 12, 15, 17, 21, 22]); // 保持入参顺序
  });

  it('lastRound=null ⇒ 用 max(to) 兜，最后一条落在 100（前端没有会话级最新轮号的有意降级）', () => {
    const nodes = foldRailNodes(folds, null);
    expect(nodes.at(-1)!.topPct).toBe(100);
    expect(nodes[0]!.topPct).toBe(27.3); // 6/22 = 27.27… ⇒ 保留 1 位小数
    expect(nodes.every((n) => n.topPct >= 0 && n.topPct <= 100)).toBe(true);
  });

  it('lastRound 比最大 to 还小 ⇒ 分母取 max，末条仍是 100（旧后端轮号滞后不会把节点挤出竖串）', () => {
    expect(foldRailNodes(folds, 10).at(-1)!.topPct).toBe(100);
  });

  it('没有任何轮号（空数组 / maxRound<=0）⇒ 一个节点都不画，而不是画一堆 0%', () => {
    expect(foldRailNodes([], 40)).toEqual([]);
    expect(foldRailNodes([], null)).toEqual([]);
    expect(foldRailNodes([{ from: 0, to: 0 }], null)).toEqual([]);
    expect(foldRailNodes([{ from: 0, to: 0 }], 0)).toEqual([]);
  });

  it('脏 lastRound（NaN / 字符串）不参与分母；越界的 to 钳到 0–100', () => {
    expect(foldRailNodes(folds, Number.NaN).at(-1)!.topPct).toBe(100);
    expect(foldRailNodes(folds, '40' as never).at(-1)!.topPct).toBe(100);
    expect(foldRailNodes([{ from: 1, to: 999 }], 40)[0]!.topPct).toBe(100);
    expect(foldRailNodes([{ from: -9, to: -1 }], 40)[0]!.topPct).toBe(0);
  });
});
