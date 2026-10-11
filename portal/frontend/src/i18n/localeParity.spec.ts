// i18n 双语键集对齐断言（#246 交付② 单 B 要求「照 terminationReasons.spec 那种补一条」）。
// 与 en.ts 末尾的 `satisfies MessageSchema`（编译期防漏键/多键）互补：这里是**运行期**断言，
// 好处是失败信息直接点名缺哪个键，并且能顺带钉「新增文案的中英语义都真的写了」。
import { describe, expect, it } from 'vitest';
import { en } from './locales/en';
import { zhCN } from './locales/zh-CN';
import { PREVIEW_PORT_STATES } from '../lib/previewPorts';

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
    for (const text of [...zhValues, zhCN.previewPorts.stateHint, zhCN.previewPorts.title]) {
      expect(text).not.toMatch(/健康/);
      expect(text).not.toMatch(/运行中/);
    }
    for (const text of [...enValues, en.previewPorts.stateHint, en.previewPorts.title]) {
      expect(text).not.toMatch(/healthy/i);
      expect(text).not.toMatch(/running/i);
    }
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
});
