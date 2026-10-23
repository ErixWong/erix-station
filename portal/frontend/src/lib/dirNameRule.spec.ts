// @vitest-environment node
// 「＋ 新建目录」目录名规则（issue #284）：前端 DIR_NAME_RE 与后端 validateSessionCwd 的口径对齐。
//
// 环境选 node（不是默认 jsdom）：本文件只用纯数据（正则 / 文案 / 源码文本），需要 node:fs 读后端源码；
// jsdom 环境下 vite 会把 node 内建模块 externalize 成浏览器桩（实测报 `No such built-in module: node:`）。
//
// 背景（本用例存在的理由）：P5「目录即项目」之后，目录名**不进预览 hostname**
// （hostname = <工位名>-p-<端口>.<伞域>，迁移 0008；docs/design/directory-as-project.md §3），
// 于是「DNS label」不再是目录名的约束来源。后端 portal/src/sessions.js 的 validateSessionCwd
// 早就有意允许 `_`（容器内用户自建目录的自由命名权，真库存量 `meeting_asr_app`），而前端表单
// 仍按旧的 hostname 段规则把 `_` 拒掉 —— 用户看得到、选得中该目录，却建不了同族新目录。
// 本单只补这一条：`_` 放行；首尾 / 大写 / 中文 / 空格 / 长度的既有行为**一字不改**。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DIR_NAME_RE } from './constants';
import { en } from '../i18n/locales/en';
import { zhCN } from '../i18n/locales/zh-CN';

const CJK = /[\u4e00-\u9fff]/;

/** 后端会话 cwd 校验的源码路径（只读文本，不 import：sessions.js 会连带加载 llm-chat 等模块）。 */
const SESSIONS_JS = fileURLToPath(new URL('../../../src/sessions.js', import.meta.url));

describe('DIR_NAME_RE（issue #284：与后端对齐，允许下划线）', () => {
  it('通过：下划线在中间的名字（真库/真实用法）+ 连字符名 + 单字符 + 63 字符', () => {
    // `meeting_asr_app` 是真库存量（15 次 run，含 finished）；另外两个是用户实际想建的名字。
    for (const name of ['meeting_asr_app', 'cmms_test', 'ai_agent_lab', 'my-app', 'a', 'a1', 'a_b-c9']) {
      expect(DIR_NAME_RE.test(name), `应通过：${name}`).toBe(true);
    }
    // 长度上限不变：1 + 61 + 1 = 63（首尾各一个字母数字，中间 ≤61）
    expect(DIR_NAME_RE.test(`a${'b'.repeat(61)}a`), '63 字符应通过').toBe(true);
  });

  it('拒绝：首尾下划线/连字符、大写、中文、空格、超长（与放开 `_` 之前的对称性一致）', () => {
    const rejected = [
      '_x', 'x_', '-x', 'x-', 'A_b', '中文目录', 'a b',
      `a${'b'.repeat(62)}a`, // 64 字符
      '', 'a_b ', ' a_b', 'a.b', 'a/b', 'a__b-',
    ];
    for (const name of rejected) {
      expect(DIR_NAME_RE.test(name), `应拒绝：${JSON.stringify(name)}`).toBe(false);
    }
    expect(`a${'b'.repeat(62)}a`.length, '64 字符样本自证').toBe(64);
  });

  it('issue #284：跨文件防漂移锁——后端已允许的 `_`，前端 DIR_NAME_RE 也必须允许', () => {
    const src = readFileSync(SESSIONS_JS, 'utf8');

    // ① 后端 cwd 形态：`~/projects/<一级目录>`，字符类必须是「非 /」而不是字符集白名单——
    //    白名单化就是收紧（第一个被禁掉的就是 `_`）。这条断言同时钉住「路径穿越仍然被拒」。
    const cwdReSource = /export const CWD_RE = \/(.+?)\/;/.exec(src)?.[1];
    expect(cwdReSource, 'sessions.js 里找不到 CWD_RE 字面量（本锁失效，请同步更新本用例）')
      .toBe('^~\\/projects\\/([^/]+)$');

    // ② 行为探针：用源码里的字面量重建正则（不 import 后端模块，避开副作用）。
    const backendCwd = new RegExp(cwdReSource as string);
    const name = 'meeting_asr_app';
    expect(backendCwd.exec(`~/projects/${name}`)?.[1]).toBe(name);

    // ③ 后端 validateSessionCwd 的硬边界只有「. / .. / 控制字符」：唯一的 `.test(name)` 必须就是
    //    控制字符那条，且不得出现长度上限。将来有人把后端收紧（加字符集白名单 / 长度 / 显式禁 `_`）
    //    这两条会先红，逼他同时更新前端与本锁。
    const body = functionBody(src, 'validateSessionCwd');
    expect(body.match(/\.test\(name\)/g) ?? [], '后端对目录名新增了字符集校验').toHaveLength(1);
    expect(body, '后端对目录名新增了长度校验').not.toMatch(/\.length/);
    expect(body, '控制字符那条校验不见了').toMatch(/\[\\x00-\\x1f\\x7f\]/);

    // ④ 同一个名字，前端表单必须与后端一致地放行——**删掉 DIR_NAME_RE 里的 `_` 就会在这里红**。
    for (const n of [name, 'cmms_test', 'ai_agent_lab']) {
      expect(DIR_NAME_RE.test(n), `前端表单误拒了后端允许的目录名：${n}`).toBe(true);
    }
  });
});

describe('目录名文案（issue #284）：不说谎、不把目录名说成域名', () => {
  it('label 与错误文案都点名下划线，且不再出现「预览域名 / DNS」这类 P5 后已不成立的说法', () => {
    for (const [locale, root] of [['zh-CN', zhCN], ['en', en]] as const) {
      const label = root.sidebar.newDirLabel;
      const err = root.errors.dirNameInvalid;
      const text = `${label} ${err}`;
      // 假话红线：目录名自 P5 起不进 hostname（迁移 0008），任何「域名/DNS」说法都会误导用户。
      expect(text, `${locale} 文案不得把目录名说成域名/DNS`).not.toMatch(/域名|DNS|hostname|domain\s*(label|name)?/i);
      expect(label, `${locale} label 必须点名下划线`).toMatch(/下划线|underscore/i);
      expect(err, `${locale} 错误文案必须点名下划线`).toMatch(/下划线|underscore/i);
    }
  });

  it('错误文案写全规则（允许集 / 首尾限制 / 63 上限）+ 存量目录可在下拉里直接选中', () => {
    for (const [locale, text] of [
      ['zh-CN', zhCN.errors.dirNameInvalid],
      ['en', en.errors.dirNameInvalid],
    ] as const) {
      expect(text, `${locale} 必须写明长度上限`).toMatch(/63/);
      expect(text, `${locale} 必须写明连字符`).toMatch(/连字符|hyphen/i);
      expect(text, `${locale} 必须写明首尾限制`).toMatch(/开头|start/i);
      // 存量目录（哪怕含其它字符）不受表单规则限制——不写这句，用户会以为磁盘上的旧目录也「不合法」。
      expect(text, `${locale} 必须说明容器里已存在的目录可直接选中`).toMatch(/已存在|already exist/i);
      expect(text, `${locale} 必须点出目录下拉`).toMatch(/下拉|dropdown/i);
    }
    expect(zhCN.errors.dirNameInvalid, 'zh 文案真是中文').toMatch(CJK);
    expect(en.errors.dirNameInvalid, 'en 文案不得含 CJK').not.toMatch(CJK);
    expect(en.sidebar.newDirLabel, 'en label 不得含 CJK').not.toMatch(CJK);
  });
});

/**
 * 从源码文本里截出 `export function <name>(...) { ... }` 的函数体（按花括号配平）。
 * 找不到就抛错——锁失效必须显形，不能静默通过。
 */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}(`);
  if (start < 0) throw new Error(`sessions.js 里找不到 ${name}（本锁失效，请同步更新本用例）`);
  const open = source.indexOf('{', start);
  if (open < 0) throw new Error(`${name} 没有函数体（本锁失效，请同步更新本用例）`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`${name} 的花括号没有配平（本锁失效，请同步更新本用例）`);
}
