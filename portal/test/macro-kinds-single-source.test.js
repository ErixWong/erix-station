/**
 * 枚举单一真源的防漂移测试（issue #528 / 契约 `10-implementation-contract.md` §1）。
 *
 * 要防的事故：枚举被抄成两份。W1 当时把取值写在 `portal/src/macros.js` 里，W5 前端也要用
 * 同一份 ⇒ 抽到 `portal/shared/macro-kinds.js`。**「只有一份」是约定，不是物理事实**，
 * 所以必须有一条测试在有人抄回去时立刻变红。
 *
 * 两类断言：
 *  1. **后端**：`portal/src/macros.js` 里不再出现枚举字面量数组，且它 re-export 的
 *     就是 shared 那一份（用**引用相等**，不是深相等——深相等放过「抄了一份一模一样的」）。
 *  2. **前端**：`portal/frontend` 的宏相关源文件里不许出现枚举成员字面量（必须 import
 *     `@shared/macro-kinds.js`）。这条是"抄一份"最可能发生的地方。
 *
 * 纯静态 + 纯 import，不需要 DB（`TEST_DATABASE_URL` 不设也能跑）。
 */
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORTAL = resolve(HERE, '..');

const shared = await import(resolve(PORTAL, 'shared/macro-kinds.js'));
const macros = await import(resolve(PORTAL, 'src/macros.js'));

const read = (rel) => readFileSync(resolve(PORTAL, rel), 'utf8');

/** 正则元字符转义。 */
function esc(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 「这份源码里没有把枚举**抄成一份列表**」。
 *
 * 判据是数组字面量（`['<枚举成员>', …]`）而不是「成员字面量不许出现」：
 * 枚举成员当 **map 键**用是正当用法（跳过人话对照、判决文案表都是以枚举为键），
 * 但「抄一份」在语法上必然是一个**数组字面量**——那个才是要禁的。
 */
function assertNoEnumArrayLiteral(source, label, values) {
  const re = new RegExp(`\\[\\s*['\"\`](${values.map(esc).join('|')})['\"\`]`);
  assert.equal(re.test(source), false,
    `${label} 里出现了枚举字面量数组（${re.source}）：枚举必须 import `
    + '`portal/shared/macro-kinds.js`，不许自己抄一份`');
}

// ── shared 自己：形状与取值 ───────────────────────────────────────────────────

test('shared/macro-kinds.js 是纯 ESM 零依赖并导出全部枚举', () => {
  const source = read('shared/macro-kinds.js');
  assert.equal(/^\s*import\s/m.test(source), false, 'shared 真源不许 import 任何东西（要能被浏览器直接打包）');
  for (const name of ['KINDS', 'STATUS', 'CRITERION', 'SKIPPED_REASON', 'VERDICT', 'KIND_SCHEMA']) {
    assert.ok(Array.isArray(shared[name]) || typeof shared[name] === 'object', `${name} 必须导出`);
    assert.ok(Object.isFrozen(shared[name]), `${name} 必须 Object.freeze`);
  }
  for (const name of ['KINDS', 'STATUS', 'CRITERION', 'SKIPPED_REASON', 'VERDICT']) {
    assert.equal(shared[name].every((v) => typeof v === 'string'), true, `${name} 成员必须全是字符串`);
  }
});

// ── 后端：macros.js 只做 re-export ────────────────────────────────────────────

const REEXPORTS = [
  ['MACRO_KINDS', 'KINDS'],
  ['MACRO_AUDIENCES', 'AUDIENCES'],
  ['MACRO_SCOPES', 'SCOPES'],
  ['MACRO_RUN_STATUSES', 'STATUS'],
  ['MACRO_RUN_TERMINAL_STATUSES', 'TERMINAL_STATUSES'],
  ['MACRO_RUN_CRITERIA', 'CRITERION'],
  ['MACRO_SKIPPED_REASONS', 'SKIPPED_REASON'],
  ['MACRO_VERDICTS', 'VERDICT'],
  ['KIND_SCOPE', 'KIND_SCOPE'],
  ['KIND_SCHEMA', 'KIND_SCHEMA'],
];

test('portal/src/macros.js re-export 的是 shared 那一份（引用相等）', () => {
  for (const [fromMacros, fromShared] of REEXPORTS) {
    assert.equal(macros[fromMacros], shared[fromShared],
      `macros.${fromMacros} 必须是 shared.${fromShared} 同一个引用（深相等放过抄一份）`);
  }
});

test('portal/src/macros.js 里不再出现枚举字面量数组', () => {
  const source = read('src/macros.js');
  assert.match(source, /from '\.\.\/shared\/macro-kinds\.js'/, 'macros.js 必须 import shared 真源');
  assertNoEnumArrayLiteral(source, 'portal/src/macros.js', shared.KINDS);
  assertNoEnumArrayLiteral(source, 'portal/src/macros.js', shared.STATUS);
  assertNoEnumArrayLiteral(source, 'portal/src/macros.js', shared.CRITERION);
  assertNoEnumArrayLiteral(source, 'portal/src/macros.js', shared.SKIPPED_REASON);
  assertNoEnumArrayLiteral(source, 'portal/src/macros.js', shared.VERDICT);
});

// ── 前端：不许抄第二份 ────────────────────────────────────────────────────────

/**
 * **扫全目录，不维护白名单**（早先写成手写三条，结果 `MacroBell.vue` 和 `lib/macroView.ts`
 * 一加进来就逃了 —— 白名单天然落后于新增文件，而「新增文件忘引 shared」正是要抓的东西）。
 *
 * 收录判据：`frontend/src` 下**文件名或路径**带 `macro` 的 `.ts` / `.vue`（大小写不敏感），
 * 且不是 `.spec.`。这样新加的宏组件/工具函数自动进入检查面。
 */
function collectFrontendMacroFiles() {
  const roots = [resolve(PORTAL, 'frontend/src')];
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = resolve(dir, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      if (!/\.(ts|vue)$/.test(e.name)) continue;
      if (/\.spec\./.test(e.name)) continue; // 用例里造枚举字面量是正当的
      if (!/macro/i.test(abs.slice(resolve(PORTAL, 'frontend/src').length))) continue;
      out.push('frontend/src/' + abs.slice(resolve(PORTAL, 'frontend/src').length + 1));
    }
  };
  for (const r of roots) walk(r);
  return out.sort();
}

test('前端宏相关源文件从 shared 引枚举，不自己抄字面量', () => {
  // ⚠ 反向自证：往 `frontend/src/lib/` 或任意 `Macro*.vue` 里塞一行
  // `['run-notify', …]` 字面量 ⇒ 本条必须红。白名单形态下它不会红（已实测）。
  const exists = collectFrontendMacroFiles();
  assert.ok(exists.length >= 3, `扫描面异常小（${exists.length} 个），检查 collectFrontendMacroFiles`);
  for (const rel of exists) {
    const source = read(rel);
    const label = `portal/${rel}`;
    // ① 硬规则：不许出现枚举**数组字面量**（「抄一份」在语法上必然是数组）
    for (const values of [shared.KINDS, shared.STATUS, shared.CRITERION,
      shared.SKIPPED_REASON, shared.VERDICT]) {
      assertNoEnumArrayLiteral(source, label, values);
    }
    // ② 用到枚举成员字面量（单值也算，例如 `verdict === 'red'`）就必须走 shared。
    //    只对**真用到**的文件要求 import —— 无条件要求会把只用 `notifications.severity`
    //    这类别的枚举的组件（如 MacroBell）误伤成红。
    const usesEnumMember = [shared.KINDS, shared.STATUS, shared.CRITERION,
      shared.SKIPPED_REASON, shared.VERDICT].some((values) => {
      const re = new RegExp(`['\"\`](${values.map(esc).join('|')})['\"\`]`);
      return re.test(source);
    });
    if (usesEnumMember) {
      assert.match(source, /@shared\/macro-kinds/, `${label} 用到了枚举成员字面量，必须 import @shared/macro-kinds`);
    }
  }
});

// ── #625：KIND_SCHEMA 必须是契约 §1 的**逐字照抄**（含 default / required）──────────
// 事故（#625）：schema 里只有 `type/values/min/max`，把契约里写好的 `default` 与 `required`
// 全漏了 ⇒ ① 缺 `at` 的 `scheduled-task` 建得出来（永不触发）；② 前端只能按通用规则猜默认值
// （`run-notify` 的 `states` 成 `[]` ⇒ 永远不会通知）。单靠「形状检查」抓不到这两条，
// 所以这里**直接读契约 §1 的正文**跟 schema 对表：漂移立刻变红，而不是等到有人建模板。

const CONTRACT_DOC = resolve(HERE, '../../docs/design/event-platform/10-implementation-contract.md');

/** 把字面量文本切成 JS 值（支持 `'str'` / 整数 / 由字符串或整数组成的数组）。 */
function parseLiteral(text) {
  const t = text.trim();
  if (t.startsWith('[')) {
    return [...t.matchAll(/'([^']*)'|(\d+)/g)].map((m) => (m[1] !== undefined ? m[1] : Number(m[2])));
  }
  if (t.startsWith("'")) return t.slice(1, -1);
  if (/^(true|false)$/.test(t)) return t === 'true';
  if (/^-?\d+$/.test(t)) return Number(t);
  return t;
}

/**
 * 从契约 §1 的 `KIND_SCHEMA` 正文里取某 kind 某字段的规则原文。
 * 文档里数组会跨行折行 ⇒ 先把空白压平再匹配（字段规则对象里没有嵌套 `{}`，`[^}]*` 够用）。
 */
function contractRule(kind, field) {
  const doc = readFileSync(CONTRACT_DOC, 'utf8');
  const from = doc.indexOf('## 1.');
  const to = doc.indexOf('\n## 2.', from);
  const sec = doc.slice(from, to < 0 ? undefined : to).replace(/\s+/g, ' ');
  const kindAt = sec.indexOf(`'${kind}':`);
  assert.ok(kindAt >= 0, `契约 §1 里没有 kind '${kind}'：schema 与契约谁改的？`);
  const scope = sec.slice(kindAt, kindAt + 1200);
  const m = scope.match(new RegExp(`\\b${field}:\\s*\\{([^}]*)\\}`));
  return m ? m[1] : null;
}

/** 取规则文本里某个键的字面量（没有 ⇒ undefined）。 */
function ruleValue(ruleText, key) {
  const m = ruleText.match(new RegExp(`${key}:\\s*(\\[[^\\]]*\\]|'[^']*'|[^,}]+)`));
  return m ? parseLiteral(m[1]) : undefined;
}

test('#625 KIND_SCHEMA 的 default/required/min/max/scope 与契约 §1 逐字一致（不许自己发明）', () => {
  const schema = shared.KIND_SCHEMA;
  assert.deepEqual(Object.keys(schema), shared.KINDS, 'KIND_SCHEMA 的 kind 集合必须与 KINDS 一致');
  for (const kind of shared.KINDS) {
    for (const [field, rule] of Object.entries(schema[kind])) {
      const ruleText = contractRule(kind, field);
      if (ruleText === null) {
        // 契约 §1 没有这个字段 ⇒ 只允许**已记录在案的**budget 拍平字段（#617：`budget: {...}`
        // 拍平成 `max_per_day` / `quiet_hours`，权威注释在 `shared/macro-kinds.js`）。
        assert.ok(['max_per_day', 'quiet_hours'].includes(field),
          `${kind}.${field} 既不在契约 §1 也不在已记录的拍平字段里：新增字段要先改契约`);
        continue;
      }
      for (const key of ['default', 'required', 'min', 'max']) {
        const docValue = ruleValue(ruleText, key);
        const codeValue = rule[key];
        if (docValue === undefined) {
          assert.equal(codeValue, undefined,
            `${kind}.${field}.${key}：契约 §1 没写，schema 却写了（发明出来的值）`);
        } else {
          assert.notEqual(codeValue, undefined,
            `${kind}.${field}.${key}：契约 §1 写了 ${JSON.stringify(docValue)}，schema 里却缺了（#625 的原病）`);
          assert.deepEqual(codeValue, docValue,
            `${kind}.${field}.${key}：schema 是 ${JSON.stringify(codeValue)}，契约 §1 是 ${JSON.stringify(docValue)}`);
        }
      }
    }
    // scope 也只能照抄契约（`KIND_SCOPE` 与 schema 不许各说一套）
    const doc = readFileSync(CONTRACT_DOC, 'utf8').replace(/\s+/g, ' ');
    const kindBlock = doc.slice(doc.indexOf(`'${kind}':`));
    const m = kindBlock.match(/scope:\s*'(\w+)'/);
    assert.ok(m, `契约 §1 里 '${kind}' 缺 scope`);
    assert.equal(shared.KIND_SCOPE[kind], m[1], `KIND_SCOPE['${kind}'] 与契约不一致`);
  }
});

test('#625 契约里的 default 自身必须合法（默认值也在自己的取值/上下界里）', () => {
  for (const [kind, fields] of Object.entries(shared.KIND_SCHEMA)) {
    for (const [field, rule] of Object.entries(fields)) {
      if (!('default' in rule)) continue;
      const d = rule.default;
      if (rule.type === 'enum') {
        assert.ok(rule.values.includes(d), `${kind}.${field} 默认值不在 values 里`);
      } else if (rule.type === 'enum[]') {
        assert.ok(Array.isArray(d) && d.length > 0,
          `${kind}.${field} 的默认值不许是空数组（空数组=永远不通知，#625 的病根）`);
        assert.ok(d.every((v) => rule.values.includes(v)), `${kind}.${field} 默认值含 values 外的取值`);
      } else if (rule.type === 'int') {
        assert.ok(Number.isInteger(d), `${kind}.${field} 默认值必须是整数`);
        if (rule.values) assert.ok(rule.values.includes(d), `${kind}.${field} 默认值不在 values 里`);
        if (rule.min !== undefined) assert.ok(d >= rule.min, `${kind}.${field} 默认值 < min`);
        if (rule.max !== undefined) assert.ok(d <= rule.max, `${kind}.${field} 默认值 > max`);
      } else if (rule.type === 'duration') {
        assert.match(d, shared.DURATION_RE, `${kind}.${field} 默认值不是 duration 形态`);
      } else if (rule.type === 'time') {
        assert.match(d, shared.TIME_RE, `${kind}.${field} 默认值不是 HH:MM`);
      }
      // 必填字段不该同时有默认值（有默认值就不会缺，`required` 是空话）
      assert.equal(Boolean(rule.required) && 'default' in rule, false,
        `${kind}.${field} 既 required 又有 default：口径自相矛盾`);
    }
  }
});
