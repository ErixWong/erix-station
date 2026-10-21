// issue #279：卡片身份尺规（`lib/toolCardKey.ts`）的单测——三条路径共用的那一段拼接规则。
// 语义锚点：docs/api/portal.md §5.3 第 6/7 类（`tool_use`/`tool_result` 载荷**没有** round）与
// erix-agent 0.22.0 `src/display/projection.js:449-455`（`call.key = "<round>#<record>:<entry>:t<i>"`）。
import { describe, expect, it } from 'vitest';
import {
  eventRoundToken,
  projectionRoundToken,
  runSegment,
  toolCardKey,
  UNKNOWN_ROUND_TOKEN,
} from './toolCardKey';

describe('issue #279：toolCardKey（三条路径共用的一把尺）', () => {
  it('三段齐全 ⇒ `<run>:<轮号>:<callId>`（真机形状）', () => {
    expect(toolCardKey('r1', eventRoundToken(3), 'c1')).toBe('r1:3:c1');
  });

  it('拿不到的段**不拼**（不拿占位串冒充）：无轮号 ⇒ `r1:c1`；连 run 也没有 ⇒ 裸 `c1`', () => {
    // 轮号未知（旧后端没有 round_start / 投影键缺轮号）
    expect(toolCardKey('r1', UNKNOWN_ROUND_TOKEN, 'c1')).toBe('r1:c1');
    // run_id 也缺（旧帧）⇒ 与 #279 之前的键逐字相同 ⇒ 旧数据形状零变化
    expect(toolCardKey(null, UNKNOWN_ROUND_TOKEN, 'c1')).toBe('c1');
    expect(toolCardKey(undefined, eventRoundToken(2), 'c1')).toBe('2:c1');
  });

  it('轮号 0 是合法轮号，**绝不**与「未知」混同（不拿 0 冒充缺位，也不反过来）', () => {
    expect(eventRoundToken(0)).toBe('0');
    expect(toolCardKey('r1', eventRoundToken(0), 'c1')).toBe('r1:0:c1');
    expect(toolCardKey('r1', eventRoundToken(undefined), 'c1')).toBe('r1:c1');
  });

  it('脏轮号（字符串数字归一；NaN/null/空串/布尔/对象一律未知）', () => {
    expect(eventRoundToken('3')).toBe('3'); // 与数字 3 同段（"03" 也必须同段）
    expect(eventRoundToken('03')).toBe('3');
    expect(eventRoundToken(3.5)).toBe('3.5'); // 非整数照引擎写法透出，不四舍五入
    for (const bad of [NaN, null, undefined, '', '  ', true, {}, [], Infinity]) {
      expect(eventRoundToken(bad), `脏值 ${JSON.stringify(bad)} 必须算未知`).toBe(UNKNOWN_ROUND_TOKEN);
    }
  });

  it('脏 run_id（空串/数字/对象）⇒ 不拼该段；字符串原样（不 trim 不改写）', () => {
    expect(runSegment('')).toBeNull();
    expect(runSegment(7)).toBeNull();
    expect(runSegment({})).toBeNull();
    expect(runSegment('r-1')).toBe('r-1');
  });

  it('投影侧从 call.key 取轮号：`<round>#…` 命中，上游的 `?`/形状不符 ⇒ 未知', () => {
    expect(projectionRoundToken('1#0:0:t0')).toBe('1');
    expect(projectionRoundToken('12#3:1:t2')).toBe('12');
    expect(projectionRoundToken('0#0:0:t0')).toBe('0');
    // 上游缺轮号时自己写 `?`（projection.js:450）⇒ 我们同样判未知，不把它当轮号
    expect(projectionRoundToken('?#0:0:t0')).toBe(UNKNOWN_ROUND_TOKEN);
    for (const bad of [undefined, null, '', 'c1', '#0:0:t0', 'x#0:0:t0', '1', 7]) {
      expect(projectionRoundToken(bad), `脏键 ${String(bad)} 必须算未知`).toBe(UNKNOWN_ROUND_TOKEN);
    }
  });

  it('两把来源不同的尺对同一次调用必须给出**同一个串**（实时 ↔ DTO 归并的前提）', () => {
    // 事件侧：观测到 round_start(round=4)；投影侧：该调用的 call.key 前缀是 `4#…`
    const live = toolCardKey('r1', eventRoundToken(4), 'call_9');
    const projected = toolCardKey('r1', projectionRoundToken('4#0:1:t0'), 'call_9');
    expect(projected).toBe(live);
  });

  it('跨轮 / 跨 run 必然不同串（缺陷本体：跳轮复用 id 不再撞同一张卡）', () => {
    const r1Round1 = toolCardKey('r1', eventRoundToken(1), 'c1');
    const r1Round2 = toolCardKey('r1', eventRoundToken(2), 'c1');
    const r2Round1 = toolCardKey('r2', eventRoundToken(1), 'c1');
    expect(new Set([r1Round1, r1Round2, r2Round1]).size).toBe(3);
  });
});
