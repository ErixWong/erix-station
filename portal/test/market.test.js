// 单测：portal/src/market.js（能力市场 §3 校验 / §4 安装面 / §7 DTO）——issue #595
//
// 判据来源：docs/design/capability-market.md §10 的负例清单（路径、体积、id 一致性、tools 上限、
// 扫描打分、安装幂等、预算闸、kind='mcp' 拒绝、卸载只删 slug 目录）。
// 隔离约定（docs/testing.md §2.1）：tmp 目录当 userSpaceRoot + 手写 fake pool，不碰真实 DB 与 /srv/erix。
//
// ⚠ fake pool 按 **SQL 指纹**分派（不是按调用顺序）：market.js 的每条查询都带唯一表名/列组合，
// 命中不了的语句直接抛 —— 有人改 SQL 而没改 fake 时，测试当场红，而不是静默拿到空行。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LIMITS, ENTRYPOINT, README_FILE, SKILL_SLUG_RE, BUNDLE_MAX_BODY_BYTES,
  MarketError, validateFilePath, validateLayout, extractSkillMeta, scanSecurity, validateBundle,
  publishItem, updateItem, setItemState, listAdminItems, getAdminItem,
  listUserItems, getUserItem, installCapability, uninstallCapability, setCapabilityEnabled,
  listCapabilitiesForFde, toCapabilityIndexEntry, skillDirFor, writeSkillDir, removeSkillDir,
  STATE_VERBS, stateForVerb,
} from '../src/market.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 读被测源文件本身（结构判据用）：这些判据问的是「代码里还有没有某个写法」，不是行为。 */
const srcOf = (rel) => fs.readFileSync(path.join(HERE, rel), 'utf8');
const MARKET_SRC = srcOf('../src/market.js');
const HELPER_SRC = srcOf('../src/market-write.js');
const HELPER_PATH = path.join(HERE, '..', 'src', 'market-write.js');
const HTTP_SRC = srcOf('../src/http.js');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const KIB = 1024;
const MIB = 1024 * 1024;

/** 一个合法的 skill.mjs 源码（tools 条数与 id 可注入，用来打不同的负例）。 */
function skillSrc(id = 'demo-skill', toolCount = 1, extra = '') {
  // 工具名的字符集与 slug **不同**（`-` 在 function name 里非法，§3 的 `^[a-z][a-z0-9_]{1,63}$`），
  // 所以这里必须把 slug 里的 `-` 折成 `_`——否则每个默认 fixture 都自带一个 MK-6 的负例。
  const base = id.replace(/-/g, '_');
  const tools = Array.from({ length: toolCount }, (_, i) =>
    `    { name: '${base}_tool_${i}', description: 'do the thing number ${i} with a description long enough' },`).join('\n');
  return `export const SKILL = {
  id: '${id}',
  name: 'Demo',
  tools: [
${tools}
  ],
  execute: async () => 'ok',
};
export function getSkillDefinition() { return SKILL; }
${extra}`;
}

/** 最小可发布的 bundle：入口 + SKILL.md（§3 允许的两种根文件各一份，顺带钉 readme 面）。 */
const minimalBundle = (id = 'demo-skill') => ({ files: [
  { path: ENTRYPOINT, content_base64: b64(skillSrc(id)) },
  { path: README_FILE, content_base64: b64(`# ${id}\n`) },
] });
const META = (slug = 'demo-skill') => ({
  slug, name: 'Demo', summary: 'a demo skill', when_to_use: 'when you need a demo skill', version: '1.0.0',
});

// ---------------------------------------------------------------------------
// fake pool
// ---------------------------------------------------------------------------

class MarketFake {
  constructor() {
    this.items = [];          // 行对象（id/slug/version/state/kind/manifest/...）
    this.files = new Map();   // `${item}|${version}|${path}` → {path, content(Buffer), bytes}
    this.installs = new Map();
    this.params = new Map();      // #608：配置槽声明（item_id|name → 行）// `${fde}|${item}` → {fde_id, item_id, version, enabled}
    this.outbox = [];
    this.revisions = new Map();
    this.seq = 0;
  }

  filesOf(itemId, version) {
    const out = [];
    for (const [k, v] of this.files) {
      if (k.startsWith(`${itemId}|${version}|`)) out.push(v);
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  async query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    const id = () => `uuid-${++this.seq}`;
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(s)) return { rows: [] };

    if (s.includes('INSERT INTO capability_items')) {
      const it = {
        id: id(), kind: params[0], slug: params[1], name: params[2], summary: params[3],
        when_to_use: params[4], description_md: params[5], version: params[6], author: params[7],
        tags: params[8], license: params[9], state: params[10], manifest: JSON.parse(params[11]),
        security_score: params[12], security_warnings: JSON.parse(params[13]), created_by: params[14],
        published_at: params[10] === 'published' ? new Date() : null, retired_at: null,
        created_at: new Date(), updated_at: new Date(),
      };
      this.items.push(it);
      return { rows: [it] };
    }
    // #608：配置槽声明与值（MCP/skill 共用）。fake 只记形状，够 DTO/校验判据用。
    if (s.includes('DELETE FROM capability_params WHERE item_id')) {
      for (const [k] of [...this.params]) if (k.startsWith(`${params[0]}|`)) this.params.delete(k);
      return { rows: [] };
    }
    if (s.includes('INSERT INTO capability_params')) {
      this.params.set(`${params[0]}|${params[1]}`, {
        item_id: params[0], name: params[1], kind: params[2], inject: params[3],
        required: params[4], description: params[5],
      });
      return { rows: [] };
    }
    if (s.includes('SELECT name, kind, inject, required, description FROM capability_params')) {
      const rows = [...this.params.values()].filter((x) => x.item_id === params[0]);
      return { rows };
    }
    if (s.includes('SELECT name, inject, required FROM capability_params')) {
      const rows = [...this.params.values()].filter((x) => x.item_id === params[0]);
      return { rows: rows.map((x) => ({ name: x.name, inject: x.inject, required: x.required })) };
    }
    if (s.includes('SELECT name, kind FROM capability_params')) {
      const rows = [...this.params.values()].filter((x) => x.item_id === params[0]);
      return { rows: rows.map((x) => ({ name: x.name, kind: x.kind })) };
    }
    if (s.includes('INSERT INTO capability_files')) {
      this.files.set(`${params[0]}|${params[1]}|${params[2]}`,
        { path: params[2], content: params[3], bytes: params[4] });
      return { rows: [] };
    }
    if (s.includes('INSERT INTO fde_capability_installs')) {
      this.installs.set(`${params[0]}|${params[1]}`,
        { fde_id: params[0], item_id: params[1], version: params[2], enabled: params[3] });
      return { rows: [] };
    }
    if (s.includes('INSERT INTO materialize_revisions')) {
      const next = (this.revisions.get(params[0]) ?? 0) + 1;
      this.revisions.set(params[0], next);
      return { rows: [{ revision: next }] };
    }
    if (s.includes('INSERT INTO materialize_outbox')) {
      this.outbox.push({ fde_id: params[0], op: params[1], revision: params[2] });
      return { rows: [] };
    }
    if (s.includes('SELECT kind, manifest FROM capability_items')) {
      const it = this.items.find((x) => x.id === params[0]);
      return { rows: it ? [{ kind: it.kind, manifest: it.manifest }] : [] };
    }
    if (s.includes('count(*)::int AS n FROM capability_files')) {
      const it = this.items.find((x) => x.id === params[0]);
      return { rows: [{ n: it ? this.filesOf(it.id, it.version).length : 0 }] };
    }
    if (s.includes('count(*)::int AS n FROM fde_capability_installs')) {
      // #608：预算分账——按 kind 过滤（params[1] 是 kind，缺省 skill）。
      const kind = params[1] ?? 'skill';
      const n = [...this.installs.values()].filter((x) => {
        if (x.fde_id !== params[0] || !x.enabled) return false;
        const item = this.items.find((i) => i.id === x.item_id);
        return (item?.kind ?? 'skill') === kind;
      }).length;
      return { rows: [{ n }] };
    }
    if (s.includes('SELECT path, content, bytes FROM capability_files')) {
      return { rows: this.filesOf(params[0], params[1]).map((f) => ({ path: f.path, content: f.content, bytes: f.bytes })) };
    }
    if (s.includes('SELECT path, bytes, content FROM capability_files')) {
      return { rows: this.filesOf(params[0], params[1]).map((f) => ({ path: f.path, bytes: f.bytes, content: f.content })) };
    }
    if (s.includes('SELECT path, bytes FROM capability_files')) {
      return { rows: this.filesOf(params[0], params[1]).map((f) => ({ path: f.path, bytes: f.bytes })) };
    }
    if (s.includes('FROM capability_items WHERE slug')) {
      return { rows: this.items.filter((i) => i.slug === params[0]) };
    }
    if (s.includes('FROM capability_items WHERE id')) {
      return { rows: this.items.filter((i) => i.id === params[0]) };
    }
    if (s.startsWith('UPDATE capability_items') && s.includes('state = $2')) {
      const it = this.items.find((x) => x.id === params[0]);
      if (!it) return { rows: [] };
      it.state = params[1];
      if (params[1] === 'published') it.published_at = it.published_at ?? new Date();
      if (params[1] === 'retired') { it.retired_at = new Date(); it.published_at = null; }
      return { rows: [it] };
    }
    if (s.startsWith('UPDATE capability_items')) {
      const it = this.items.find((x) => x.id === params[0]);
      if (!it) return { rows: [] };
      it.name = params[1]; it.summary = params[2]; it.when_to_use = params[3];
      it.description_md = params[4]; it.version = params[5]; it.author = params[6];
      it.tags = params[7]; it.license = params[8];
      if (params.length > 9) { it.manifest = JSON.parse(params[9]); it.security_score = params[10]; }
      return { rows: [it] };
    }
    // ⚠ 顺序敏感：capabilities 的读面 SQL 里也含 `FROM fde_capability_installs inst JOIN capability_items`，
    // 宽泛指纹排前面就会把窄的那条吃掉（fake 静默返回错行 ⇒ 测试假绿）。
    if (s.includes('SELECT i.slug, i.name')) {
      const byItem = new Map([...this.installs.values()].filter((x) => x.fde_id === params[0])
        .map((x) => [x.item_id, x]));
      const rows = [...byItem.values()]
        .map((x) => ({ item: this.items.find((i) => i.id === x.item_id), enabled: x.enabled }))
        .filter(({ item }) => item && item.state === 'published')
        .map(({ item, enabled }) => ({ slug: item.slug, name: item.name, summary: item.summary,
          when_to_use: item.when_to_use, manifest: item.manifest, enabled }))
        .sort((a, b) => (a.slug < b.slug ? -1 : 1));
      return { rows };
    }
    if (s.includes('FROM fde_capability_installs inst JOIN capability_items')) {
      const rows = [...this.installs.values()]
        .filter((x) => x.fde_id === params[0] && this.items.find((i) => i.id === x.item_id)?.slug === params[1])
        .map((x) => ({ version: x.version, enabled: x.enabled, installed_at: new Date(), updated_at: new Date() }));
      return { rows };
    }
    if (s.includes('UPDATE fde_capability_installs SET enabled')) {
      const k = `${params[0]}|${params[1]}`;
      const row = this.installs.get(k);
      if (!row) return { rows: [] };
      row.enabled = params[2];
      return { rows: [{ version: row.version, enabled: row.enabled }] };
    }
    if (s.startsWith('DELETE FROM fde_capability_installs')) {
      this.installs.delete(`${params[0]}|${params[1]}`);
      return { rows: [] };
    }
    // 用户面（params[0] 是 **fde_id**，不是 state）：与列表 SQL 的 LEFT JOIN 同形
    if (s.includes('LEFT JOIN fde_capability_installs inst')) {
      const fdeId = params[0];
      const slug = s.includes('i.slug = $2') ? params[1] : null;
      const rows = this.items.filter((i) => i.state === 'published' && (!slug || i.slug === slug))
        .map((i) => {
          const inst = this.installs.get(`${fdeId}|${i.id}`);
          return { ...i, installed_version: inst?.version ?? null, enabled: inst?.enabled ?? null };
        });
      return { rows };
    }
    if (s.includes('FROM capability_items i')) {
      const state = params[0];
      // 管理端列表的 `installs` 是子查询计数，fake 也必须算出来（否则 DTO 里那个数字无人验证）
      return { rows: this.items.filter((i) => !state || i.state === state).map((i) => ({
        ...i, installs: [...this.installs.values()].filter((x) => x.item_id === i.id).length,
      })) };
    }
    throw new Error(`unhandled SQL: ${s.slice(0, 110)}`);
  }

  async connect() {
    return { query: (sql, params) => this.query(sql, params), release() {} };
  }
}

// ---------------------------------------------------------------------------
// 一个「已发布且可安装」的现场（tmp userSpaceRoot + fake pool）
// ---------------------------------------------------------------------------

async function harness({ publish = true, slug = 'demo-skill', state = 'published' } = {}) {
  const pool = new MarketFake();
  const userSpaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'market-test-'));
  const config = { userSpaceRoot, fdeUid: null, fdeGid: null };   // null ⇒ 不去 chown（非 root 测试环境）
  const fde = { id: 'fde-1', name: 'alice' };
  const after = () => fs.rmSync(userSpaceRoot, { recursive: true, force: true });
  if (publish) {
    await publishItem({ pool, fields: { ...META(slug), bundle: minimalBundle(slug) } });
    const item = pool.items.find((i) => i.slug === slug);
    if (state !== 'draft') await setItemState({ pool, itemId: item.id, state });
  }
  return { pool, config, fde, userSpaceRoot, slug, after, dir: (s = slug) => path.join(userSpaceRoot, 'alice', 'home', '.erix', 'skills', s) };
}

const errOf = (p) => p.then(() => null, (e) => e);
const expectErr = async (p, { code, httpStatus, reason } = {}) => {
  const e = await errOf(p);
  assert.ok(e instanceof MarketError, `必须抛 MarketError，实得 ${JSON.stringify(e)}`);
  if (code) assert.equal(e.code, code, `code 不符：${e.code} / ${e.message}`);
  if (httpStatus) assert.equal(e.httpStatus, httpStatus, `httpStatus 不符：${e.httpStatus} / ${e.message}`);
  if (reason) assert.equal(e.details.reason, reason, `details.reason 不符：${JSON.stringify(e.details)}`);
  return e;
};

// ---------------------------------------------------------------------------
// §3 之一：路径安全（工单点名的五条）
// ---------------------------------------------------------------------------

test('MK-1 路径：zip-slip / 绝对路径 / 反斜杠 / 空段 / 超长 一律 400，且点名字段', () => {
  const cases = [
    ['zip-slip 前导', '../evil'],
    ['zip-slip 中段逃逸', 'scripts/../../evil'],
    ['绝对路径', '/skill.mjs'],
    ['反斜杠', 'scripts\\x.mjs'],
    ['空段', 'scripts//x.mjs'],
    ['点段', './skill.mjs'],
    ['尾斜杠（目录项）', 'scripts/'],
    ['超长', `${'a'.repeat(210)}.mjs`],
  ];
  for (const [label, p] of cases) {
    assert.throws(() => validateFilePath(p), (e) => e instanceof MarketError && e.code === 'validation_failed'
      && typeof e.details.field === 'string', `${label}（${p}）必须被拒`);
  }
  // 反向：`..` 作为**子串**是合法文件名（判据是段，不是子串——否则误杀 + 漏掉中段逃逸）
  assert.equal(validateFilePath('references/a..b.md'), 'references/a..b.md');
  assert.equal(validateFilePath(`${'a'.repeat(196)}.mjs`).length, 200, '200 字符这条边界必须可用');
});

test('MK-2 布局：入口只能在根、根不得有别的文件、子目录白名单三条', () => {
  const f = (paths) => () => validateLayout(paths.map((p) => ({ path: p })));
  assert.throws(f(['SKILL.md']), /skill\.mjs/, '缺入口必须拒');
  assert.throws(f(['skill.mjs', 'readme.md']), /根目录只允许/, '根上多出来的文件必须拒（readme.md ≠ SKILL.md）');
  assert.throws(f(['skill.mjs', 'vendor/x.mjs']), /子目录只允许/, '白名单外的目录必须拒');
  assert.throws(f(['skill.mjs', 'scripts/skill.mjs']), /只能出现在包根/, '子目录里的第二份入口必须拒');
  assert.doesNotThrow(f(['skill.mjs', 'SKILL.md', 'scripts/a.mjs', 'references/b.md', 'assets/c.png']));
});

test('MK-3 体积与条数天花板：单文件 / 总量 / 条数 / 空包 / 重复路径', () => {
  const big = b64('x'.repeat(LIMITS.maxFileBytes + 1));
  expectErr(validateBundleAsync({ files: [{ path: ENTRYPOINT, content_base64: big }] }), { reason: undefined });
  // 上面那条只为证明能触发；下面是同步面的逐条判据
  assert.throws(() => validateBundle({ slug: 's', whenToUse: 'when to use it', bundle: { files: [{ path: ENTRYPOINT, content_base64: big }] } }),
    /512 KiB/);
  // 每个文件都在线内、**总量**越线才算总量判据（单文件 1.2 MiB 会先撞 512 KiB 那条）
  const perFile = b64('y'.repeat(460 * KIB));
  assert.throws(() => validateBundle({
    slug: 's', whenToUse: 'when to use it',
    bundle: { files: Array.from({ length: 5 }, (_, i) => ({ path: `references/f${i}.md`, content_base64: perFile })) },
  }), /总大小/);
  assert.throws(() => validateBundle({
    slug: 's', whenToUse: 'when to use it',
    bundle: { files: Array.from({ length: LIMITS.maxFiles + 1 }, (_, i) => ({ path: `references/f${i}.md`, content_base64: b64('x') })) },
  }), /文件数/, '条数天花板');
  assert.throws(() => validateBundle({ slug: 's', whenToUse: 'when to use it', bundle: { files: [] } }),
    /不能为空|empty/, '空 bundle');
  assert.throws(() => validateBundle({
    slug: 'demo', whenToUse: 'when to use it',
    bundle: { files: [{ path: ENTRYPOINT, content_base64: b64(skillSrc('demo')) }, { path: ENTRYPOINT, content_base64: b64(skillSrc('demo')) }] },
  }), /重复/, '重复路径：落盘只剩一份，manifest 却记两条');
});

/** validateBundle 的 async 包装（只为让 expectErr 能用同一套断言）。 */
const validateBundleAsync = (bundle) => Promise.resolve().then(() => validateBundle({ slug: 's', whenToUse: 'when to use it', bundle }));

test('MK-4 base64 与 UTF-8：非规范 base64、非 UTF-8 都拒（P0 只分发文本）', () => {
  const cases = [
    ['含换行的 base64', 'YWJj\nZA=='],
    ['含空白', 'YW Jj'],
    ['长度不是 4 的倍数', 'YWJ'],
    ['非法字符', 'YWJ*'],
  ];
  for (const [label, raw] of cases) {
    assert.throws(() => validateBundle({ slug: 's', whenToUse: 'when to use it', bundle: { files: [{ path: 'a.md', content_base64: raw }] } }),
      (e) => e instanceof MarketError && e.code === 'validation_failed', `${label} 必须拒`);
  }
  // 0xEF 0xBF 0xBD 之前的非法序列：0xff 0xfe 不是合法 UTF-8 起始
  const notUtf8 = Buffer.from([0xff, 0xfe, 0x41]).toString('base64');
  const e = (() => { try {
    validateBundle({ slug: 's', whenToUse: 'when to use it', bundle: { files: [{ path: 'a.md', content_base64: notUtf8 }] } });
    return null;
  } catch (err) { return err; } })();
  assert.ok(e, '非 UTF-8 必须拒');
  assert.equal(e.details.reason, 'not_utf8');
});

// ---------------------------------------------------------------------------
// §3 之二：源码静态一致性（id、tools）
// ---------------------------------------------------------------------------

test('MK-5 skill.id 取不到或与 slug 不等 ⇒ 400，且 details 给出两侧值', async () => {
  const noId = { files: [{ path: ENTRYPOINT, content_base64: b64('export function getSkillDefinition(){}') }] };
  await expectErr(validateBundleAsync(noId), { code: 'validation_failed', reason: 'skill_id_unreadable' });
  const mismatch = { files: [{ path: ENTRYPOINT, content_base64: b64(skillSrc('other-name')) }] };
  const e = await expectErr(validateBundleAsync(mismatch), { code: 'validation_failed', reason: 'skill_id_mismatch' });
  assert.deepEqual([e.details.skill_id, e.details.slug], ['other-name', 's']);
  // 引号+注释感知的定界：源码里出现 `[` 与 `// tools: [` 不许把定界带跑
  const tricky = skillSrc('s', 1, '// tools: [ 这是一句注释\nconst BRACKET = "[";\n');
  const ok = validateBundle({ slug: 's', whenToUse: 'when to use it', bundle: { files: [{ path: ENTRYPOINT, content_base64: b64(tricky) }] } });
  assert.equal(ok.manifest.tools.length, 1, '注释里的 tools: [ 不得被当成真数组');
});

test('MK-6 tools：0 条 / 超 12 / 非法名 / 重名 / 描述过短 全部 400', async () => {
  const withSrc = (src) => validateBundleAsync({ files: [{ path: ENTRYPOINT, content_base64: b64(src) }] });
  await expectErr(withSrc(skillSrc('s', 0)), { reason: 'tools_count' });
  await expectErr(withSrc(skillSrc('s', LIMITS.maxTools + 1)), { reason: 'tools_count' });
  await expectErr(withSrc(skillSrc('s').replace('s_tool_0', 'Tool_Bad')), { reason: 'tool_name_invalid' });
  // 整段换掉整条 description（只替换一小截会让总长仍然 ≥ 20，测不到那条判据）
  await expectErr(withSrc(skillSrc('s').replace(/description: '[^']*'/, "description: 'too short'")),
    { reason: 'tool_description_short' });
  const dup = skillSrc('s', 2).replace('s_tool_1', 's_tool_0');
  await expectErr(withSrc(dup), { reason: 'tool_name_duplicate' });
  // slug 形状：目录名就是它，字符集必须对 shell / URL / skill 都安全
  assert.equal(SKILL_SLUG_RE.test('Demo'), false);
  assert.equal(SKILL_SLUG_RE.test('-lead'), false);
  assert.equal(SKILL_SLUG_RE.test('with_underscore'), false);
  assert.equal(SKILL_SLUG_RE.test('pdf-tools'), true);
});

test('MK-7 when_to_use 必填且 8..500（L3 的路由信号，缺了等于装了但模型不知道何时用）', async () => {
  const bundle = minimalBundle('s');
  for (const w of [undefined, '', 'short', 'x'.repeat(501)]) {
    const e = await expectErr(Promise.resolve().then(() => validateBundle({ slug: 's', whenToUse: w, bundle })));
    assert.equal(e.details.field, 'when_to_use', `${JSON.stringify(w)} 必须点名 when_to_use`);
  }
  // 发布侧同理：元数据缺 when_to_use 也进不来（L3 没有路由信号就等于装了但没人调）
  const e1 = await expectErr(publishItem({ pool: new MarketFake(), fields: { ...META('s'), when_to_use: undefined, bundle } }));
  assert.equal(e1.details.field, 'when_to_use');
  const e2 = await expectErr(publishItem({ pool: new MarketFake(), fields: { ...META('s'), when_to_use: 'short', bundle } }));
  assert.equal(e2.details.field, 'when_to_use');
});

// ---------------------------------------------------------------------------
// §3 之三：静态扫描打分
// ---------------------------------------------------------------------------

test('MK-8 扫描打分 = max(0, 100 - 10×命中)，advisory 而不是闸门', () => {
  const clean = scanSecurity([{ path: ENTRYPOINT, content: Buffer.from(skillSrc('s')) }]);
  assert.equal(clean.score, 100);
  assert.deepEqual(clean.warnings, []);

  const risky = scanSecurity([{ path: ENTRYPOINT, content: Buffer.from(
    `import cp from 'child_process';\neval('x');\nawait fetch('https://example.invalid');\n`) }]);
  assert.equal(risky.warnings.length, 3, '每条命中一条 warning');
  assert.equal(risky.score, 70, '100 - 10×3');
  assert.deepEqual(risky.warnings.map((w) => w.code),
    ['uses_child_process', 'uses_eval', 'uses_fetch'], 'warning 必须带机器可读 code（前端要按它出文案）');
  assert.ok(risky.warnings.every((w) => w.path === ENTRYPOINT && w.line >= 1 && w.note),
    'warning 形状 = {code,path,line,note}（§2 的 security_warnings 列就是它）');

  // 下限 0：命中再多也不许负分（负分会让「分数」失去可比较性）
  const many = scanSecurity([{ path: 'a.mjs', content: Buffer.from('process.env.A\n'.repeat(30)) }]);
  assert.equal(many.score, 0);
  assert.ok(many.warnings.length <= LIMITS.maxWarnings, 'warning **列表**有上限，但分数按总命中数算');
  // 非文本文件不参与扫描（将来若允许 png，不该因为像素里出现 "eval(" 而扣分）
  assert.equal(scanSecurity([{ path: 'assets/x.png', content: Buffer.from('eval(') }]).score, 100);
});

// ---------------------------------------------------------------------------
// §4 安装 / 卸载 / 启停
// ---------------------------------------------------------------------------

test('MK-9 安装落盘到 §4 的位置与模式，且同版本重复安装一个字节都不写', async () => {
  const h = await harness();
  try {
    const r1 = await installCapability({ pool: h.pool, config: h.config, fde: h.fde, slug: h.slug });
    assert.equal(r1.changed, true);
    const dir = h.dir();
    assert.ok(dir.endsWith(path.join('alice', 'home', '.erix', 'skills', 'demo-skill')), `位置：${dir}`);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o755, '目录 0755');
    assert.equal(fs.statSync(path.join(dir, ENTRYPOINT)).mode & 0o777, 0o644, '文件 0644（writeFileSync 的 mode 受 umask 影响，必须显式 chmod）');
    assert.deepEqual(fs.readdirSync(dir).sort(), [README_FILE, ENTRYPOINT]);

    const before = fs.statSync(path.join(dir, ENTRYPOINT)).mtimeMs;
    fs.writeFileSync(path.join(dir, ENTRYPOINT), '// 用户手改过\n');
    const r2 = await installCapability({ pool: h.pool, config: h.config, fde: h.fde, slug: h.slug });
    assert.equal(r2.changed, false, '同版本且 enabled 没变 ⇒ changed:false');
    assert.equal(r2.idempotent, true);
    assert.equal(fs.readFileSync(path.join(dir, ENTRYPOINT), 'utf8'), '// 用户手改过\n',
      '幂等必须**无副作用**：否则页面多点一下就把用户手改的内容冲掉了');
    assert.equal(h.pool.installs.size, 1, 'DB 也只该有一行');
    assert.equal(h.pool.outbox.length, 1, '幂等这一趟不该再排一次物化');

    // 漂移出路：force ⇒ 重写（页面「重新安装」按钮走的就是这条）
    const r3 = await installCapability({ pool: h.pool, config: h.config, fde: h.fde, slug: h.slug, force: true });
    assert.equal(r3.changed, true);
    assert.match(fs.readFileSync(path.join(dir, ENTRYPOINT), 'utf8'), /getSkillDefinition/, 'force 必须把包内容盖回去');
    assert.equal(h.pool.installs.size, 1, 'force 不新增行');
  } finally { h.after(); }
});

test('MK-10 换版本 = 先写 tmp 再原子替换；卸载只删 slug 目录', async () => {
  const h = await harness();
  try {
    // 同级技能 + .erix 里别的东西：卸载后必须都还在（§4「只删 slug 目录」）
    const skillsRoot = path.dirname(h.dir());
    fs.mkdirSync(path.join(skillsRoot, 'other-skill'), { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, 'other-skill', 'skill.mjs'), '// keep me\n');
    fs.writeFileSync(path.join(skillsRoot, '..', 'ports.json'), '{"schema":2}\n');
    fs.writeFileSync(path.join(skillsRoot, 'loose.txt'), 'not a skill\n');

    await installCapability({ pool: h.pool, config: h.config, fde: h.fde, slug: h.slug });
    await installCapability({ pool: h.pool, config: h.config, fde: h.fde, slug: 'other-skill' })
      .catch(() => null);   // other-skill 没入库：只为占住目录，装不上不影响本判据

    // 出新版 → 再装：旧文件必须没掉（清空该目录后重写）
    const itemId = h.pool.items.find((i) => i.slug === h.slug).id;
    await updateItem({ pool: h.pool, itemId, fields: {
      version: '2.0.0', bundle: { files: [{ path: ENTRYPOINT, content_base64: b64(skillSrc(h.slug)) }] },
    } });
    const r = await installCapability({ pool: h.pool, config: h.config, fde: h.fde, slug: h.slug });
    assert.equal(r.version, '2.0.0');
    assert.deepEqual(fs.readdirSync(h.dir()), [ENTRYPOINT],
      '新版包里没有 SKILL.md ⇒ 旧文件不得残留（半新半旧的目录是最难查的状态）');
    assert.deepEqual([...fs.readdirSync(skillsRoot)].filter((n) => n.includes('.tmp-')), [],
      '不许留下 tmp 目录（成功路径必须清干净）');

    const u = await uninstallCapability({ pool: h.pool, config: h.config, fde: h.fde, slug: h.slug });
    assert.equal(u.dir_removed, true);
    assert.equal(fs.existsSync(h.dir()), false);
    assert.equal(h.pool.installs.size, 0, '安装账也要删');
    assert.ok(fs.existsSync(path.join(skillsRoot, 'other-skill', 'skill.mjs')), '同级技能必须完好');
    assert.ok(fs.existsSync(path.join(skillsRoot, 'loose.txt')), 'skills 根下的散文件不得被连坐');
    assert.ok(fs.existsSync(path.join(skillsRoot, '..', 'ports.json')), '.erix 里别的东西不得被动');
    // 卸载幂等：目录与账都没了，再卸一次仍是 200
    const u2 = await uninstallCapability({ pool: h.pool, config: h.config, fde: h.fde, slug: h.slug });
    assert.equal(u2.dir_removed, false);
    assert.equal(u2.changed, false);
  } finally { h.after(); }
});

test('MK-11 启停只改一行 DB，磁盘一律不动；未安装则 404 not_installed', async () => {
  const h = await harness();
  try {
    await installCapability({ pool: h.pool, config: h.config, fde: h.fde, slug: h.slug });
    const dir = h.dir();
    const before = fs.readdirSync(dir).join('|');
    const off = await setCapabilityEnabled({ pool: h.pool, fde: h.fde, slug: h.slug, enabled: false });
    assert.equal(off.enabled, false);
    assert.equal(fs.readdirSync(dir).join('|'), before, '停用不得动磁盘（重新启用不必重下）');
    assert.equal(h.pool.installs.get('fde-1|uuid-1').enabled, false);
    const on = await setCapabilityEnabled({ pool: h.pool, fde: h.fde, slug: h.slug, enabled: true });
    assert.equal(on.enabled, true);
    // `enabled` 必须是真布尔：0/1 与字符串都会被 §7 的判据当成没传
    await expectErr(setCapabilityEnabled({ pool: h.pool, fde: h.fde, slug: h.slug, enabled: 'false' }), {});
    // 「没装却要点启用」：条目**存在**但没安装记录 ⇒ 404 + reason=not_installed
    await publishItem({ pool: h.pool, fields: { ...META('never-installed'), bundle: minimalBundle('never-installed') } });
    await setItemState({ pool: h.pool, itemId: h.pool.items.at(-1).id, state: 'published' });
    await expectErr(setCapabilityEnabled({ pool: h.pool, fde: h.fde, slug: 'never-installed', enabled: true }),
      { code: 'capability_not_found', httpStatus: 404, reason: 'not_installed' });
  } finally { h.after(); }
});

test('MK-12 预算闸：启用数上限 12，第 13 个 409；停用的安装不吃预算', async () => {
  const h = await harness({ publish: false });
  try {
    for (let i = 0; i < LIMITS.maxEnabledSkills; i += 1) {
      const slug = `s${String(i).padStart(2, '0')}`;
      await publishItem({ pool: h.pool, fields: { ...META(slug), bundle: minimalBundle(slug) } });
      await setItemState({ pool: h.pool, itemId: h.pool.items.at(-1).id, state: 'published' });
      await installCapability({ pool: h.pool, config: h.config, fde: h.fde, slug });
    }
    const list = await listUserItems({ pool: h.pool, fdeId: h.fde.id });
    // #608：预算分账——技能与 MCP 各一条线（合成一个计数器会让 12 个技能把 MCP 一起锁死）。
    assert.deepEqual(list.budget, {
      max_enabled: 12, enabled_now: 12, max_enabled_mcp: 12, enabled_now_mcp: 0,
    }, '列表必须把预算回给页面（两个 kind 各一条）');

    const slug13 = 's12';
    await publishItem({ pool: h.pool, fields: { ...META(slug13), bundle: minimalBundle(slug13) } });
    await setItemState({ pool: h.pool, itemId: h.pool.items.at(-1).id, state: 'published' });
    const e = await expectErr(installCapability({ pool: h.pool, config: h.config, fde: h.fde, slug: slug13 }));
    assert.equal(e.code, 'capability_budget_exceeded');
    assert.equal(e.httpStatus, 409);
    assert.deepEqual(e.details, { max_enabled: 12, enabled_now: 12, kind: 'skill' });
    assert.equal(fs.existsSync(h.dir(slug13)), false, '被预算挡住时**不得落盘**（否则磁盘上多一个没人记账的目录）');

    // 装成停用 ⇒ 放行且不占预算（§4：预算只管 enabled）
    const r = await installCapability({ pool: h.pool, config: h.config, fde: h.fde, slug: slug13, enabled: false });
    assert.equal(r.enabled, false);
    assert.ok(fs.existsSync(path.join(h.dir(slug13), ENTRYPOINT)), '停用安装仍然落盘（重新启用不必重下）');
    // 停用一条 ⇒ 腾出一个位子
    await setCapabilityEnabled({ pool: h.pool, fde: h.fde, slug: 's00', enabled: false });
    const flip = await installCapability({ pool: h.pool, config: h.config, fde: h.fde, slug: slug13, enabled: true });
    assert.equal(flip.enabled, true, '同版本但 enabled 要变 ⇒ 账必须跟着变（幂等只管磁盘，不管账本字段）');
    assert.equal(flip.disk, 'untouched', '这一趟不得重写盘');
    assert.equal((await listUserItems({ pool: h.pool, fdeId: h.fde.id })).budget.enabled_now, 12);
    // 已启用条目上的重复操作不该被预算挡（它不会让计数 +1）
    const again = await installCapability({ pool: h.pool, config: h.config, fde: h.fde, slug: slug13, enabled: true });
    assert.equal(again.changed, false, '重复安装仍是幂等，不该变成预算错误');
  } finally { h.after(); }
});

test('MK-13 kind="mcp"：P1 可发布（无包），但 resident≠false 仍 409；安装不落盘', async () => {
  const h = await harness({ publish: false });
  try {
    // ① 缺 MCP 必填字段 ⇒ 400（不是「kind 不支持」了，是「字段不全」）
    const e0 = await expectErr(publishItem({ pool: h.pool, fields: { ...META('mcp-one'), kind: 'mcp' } }));
    assert.equal(e0.code, 'validation_failed');
    assert.equal(h.pool.items.length, 0, '被拒的发布不该留下条目行');

    // ② resident 非 false ⇒ 409 capability_kind_unsupported（形态②/③ 未实现，fail-closed）
    const e1 = await expectErr(publishItem({
      pool: h.pool,
      fields: {
        ...META('mcp-one'), kind: 'mcp', transport: 'stdio', command: 'node', args: ['s.mjs'],
        reason: 'stateful', resident: 'container', slots: [],
      },
    }));
    assert.equal(e1.code, 'capability_kind_unsupported');
    assert.equal(e1.httpStatus, 409);

    // ③ 合法 MCP 条目：发布成功、无包行、安装只落账（磁盘上不该出现 skills/<slug>）
    const item = await publishItem({
      pool: h.pool,
      fields: {
        ...META('mcp-two'), kind: 'mcp', transport: 'stdio', command: 'node', args: ['s.mjs'],
        reason: 'tool_surface_gt_12', slots: [],
      },
    });
    assert.equal(item.kind, 'mcp');
    await setItemState({ pool: h.pool, itemId: item.id, state: 'published' });
    const r = await installCapability({ pool: h.pool, config: h.config, fde: h.fde, slug: 'mcp-two' });
    assert.equal(r.disk, 'none', 'MCP 没有包内容 ⇒ 安装不落盘');
    assert.equal(fs.existsSync(h.dir('mcp-two')), false, 'MCP 条目的目录不该被创建');
  } finally { h.after(); }
});

test('MK-14 未发布不可装：draft/retired 409、未知 slug 404、当前版本无包也 409', async () => {
  for (const state of ['draft', 'retired']) {
    const h = await harness({ state });
    try {
      const e = await expectErr(installCapability({ pool: h.pool, config: h.config, fde: h.fde, slug: h.slug }));
      assert.equal(e.code, 'capability_not_published');
      assert.equal(e.details.state, state, '回包必须说明现在是什么状态（否则页面只会显示「失败」）');
    } finally { h.after(); }
  }
  const h = await harness({ publish: false });
  try {
    await expectErr(installCapability({ pool: h.pool, config: h.config, fde: h.fde, slug: 'ghost' }),
      { code: 'capability_not_found', httpStatus: 404 });
    // 发布闸门：条目存在但当前版本没有包 ⇒ 不许 publish（装上去是空目录，而索引会告诉模型「有」）
    await publishItem({ pool: h.pool, fields: { ...META('no-files'), bundle: minimalBundle('no-files') } });
    const it = h.pool.items.find((i) => i.slug === 'no-files');
    for (const k of [...h.pool.files.keys()]) if (k.startsWith(`${it.id}|`)) h.pool.files.delete(k);
    await expectErr(setItemState({ pool: h.pool, itemId: it.id, state: 'published' }),
      { code: 'capability_not_published', reason: 'no_files_for_current_version' });
  } finally { h.after(); }
});

// ---------------------------------------------------------------------------
// §7 / §5 DTO 与物化读面
// ---------------------------------------------------------------------------

test('MK-15 列表/详情 DTO：信封、snake_case、真布尔、tool_count、readme_md 缺省空串', async () => {
  const h = await harness();
  try {
    const list = await listUserItems({ pool: h.pool, fdeId: h.fde.id });
    assert.ok(Array.isArray(list.items), '列表必须是 {items:[...]}（不是裸数组）');
    const row = list.items[0];
    assert.equal(row.installed, false, '没装 ⇒ 真 false');
    assert.equal(row.enabled, false);
    assert.equal(row.installed_version, null);
    assert.equal(row.tool_count, 1, 'tool_count 从 manifest 现算');
    assert.ok(Array.isArray(row.tags));

    await installCapability({ pool: h.pool, config: h.config, fde: h.fde, slug: h.slug });
    const row2 = (await listUserItems({ pool: h.pool, fdeId: h.fde.id })).items[0];
    assert.equal(row2.installed, true, '装完必须是真 true（前端按 === true 判）');
    assert.equal(row2.enabled, true);
    assert.equal(row2.installed_version, '1.0.0');
    assert.equal(row2.version, '1.0.0');

    const detail = await getUserItem({ pool: h.pool, fdeId: h.fde.id, slug: h.slug });
    assert.equal(detail.readme_md, `# ${h.slug}\n`, 'readme_md 必须是 SKILL.md 正文');
    assert.equal(typeof detail.description_md, 'string');
    assert.deepEqual(detail.tools.map((t) => t.name), ['demo_skill_tool_0'], 'tools 提到顶层');
    assert.deepEqual(detail.files.map((f) => f.path), [README_FILE, ENTRYPOINT]);

    // 没有 SKILL.md 的包 ⇒ readme_md 是空串（**不是 null**：前端直接喂 markdown 渲染器）
    await updateItem({ pool: h.pool, itemId: h.pool.items[0].id, fields: {
      version: '2.0.0', bundle: { files: [{ path: ENTRYPOINT, content_base64: b64(skillSrc(h.slug)) }] } } });
    const d2 = await getUserItem({ pool: h.pool, fdeId: h.fde.id, slug: h.slug });
    assert.equal(d2.readme_md, '');
    // 列表不取包字节 ⇒ 详情才有 content 形状（files 只 {path,bytes}）
    assert.deepEqual(Object.keys(d2.files[0]).sort(), ['bytes', 'path']);

    const admin = await getAdminItem({ pool: h.pool, itemId: h.pool.items[0].id });
    assert.equal(admin.id, h.pool.items[0].id);
    assert.equal(admin.state, 'published');
    assert.equal(typeof admin.installs, 'undefined', '列表 SQL 才带 installs 计数');
    const adminList = await listAdminItems({ pool: h.pool, state: 'published' });
    assert.equal(adminList.items[0].installs, 1, '管理端列表带装机数');
  } finally { h.after(); }
});

test('MK-16 §5 物化读面：含停用项、按 slug 升序、readme 只在包里有 SKILL.md 时给路径', async () => {
  const h = await harness({ publish: false });
  try {
    // with-readme / no-readme 两条 + 一条停用；插入顺序故意与目标顺序相反
    for (const [slug, withReadme] of [['zeta', true], ['alpha', false], ['mid', true]]) {
      const files = [{ path: ENTRYPOINT, content_base64: b64(skillSrc(slug)) }];
      if (withReadme) files.push({ path: README_FILE, content_base64: b64(`# ${slug}\n`) });
      await publishItem({ pool: h.pool, fields: { ...META(slug), bundle: { files } } });
      await setItemState({ pool: h.pool, itemId: h.pool.items.at(-1).id, state: 'published' });
      await installCapability({ pool: h.pool, config: h.config, fde: h.fde, slug, enabled: slug !== 'mid' });
    }
    const caps = await listCapabilitiesForFde(h.pool, h.fde.id);
    assert.deepEqual(caps.map((c) => c.id), ['alpha', 'mid', 'zeta'], '必须按 slug 升序（字节确定性）');
    assert.deepEqual(caps.map((c) => c.enabled), [true, false, true],
      '停用项**必须也在**：runner 要用它的 id 去填 excludeSkillIds');
    assert.equal(caps[0].readme, null, '包里没有 SKILL.md ⇒ null');
    assert.equal(caps.find((c) => c.id === 'mid').readme, '~/.erix/skills/mid/SKILL.md');
    assert.deepEqual(caps[0].tools, ['alpha_tool_0']);
    // 未安装的条目不进索引；retired 的也不进
    const ghost = toCapabilityIndexEntry({ slug: 'ghost', name: 'G', manifest: {}, enabled: false });
    assert.equal(ghost.id, 'ghost', 'manifest 取不到 skill_id 时退回 slug（绝不让 index 出现 undefined id）');
  } finally { h.after(); }
});

test('MK-17 发布/改版的账目：默认 draft、bundle 换版必须换 version、发布后 published_at 落', async () => {
  const h = await harness({ publish: false });
  try {
    const created = await publishItem({ pool: h.pool, fields: { ...META(h.slug), bundle: minimalBundle(h.slug) } });
    assert.equal(created.state, 'draft', '§2：新建默认 draft');
    assert.equal(created.published_at, null);
    assert.equal(created.security_score, 100);
    assert.equal(h.pool.filesOf(created.id, '1.0.0').length, 2);

    const sameVer = await expectErr(updateItem({ pool: h.pool, itemId: created.id, fields: {
      version: '1.0.0', bundle: minimalBundle(h.slug) } }));
    assert.match(sameVer.message, /version/, '同版本覆盖包内容会让已装 FDE 的磁盘与账面脱钩');

    const patched = await updateItem({ pool: h.pool, itemId: created.id, fields: { summary: 'new summary' } });
    assert.equal(patched.summary, 'new summary');
    assert.equal(patched.version, '1.0.0', '只改文案不该动版本');

    const pub = await setItemState({ pool: h.pool, itemId: created.id, state: 'published' });
    assert.ok(pub.published_at, 'publish 必须写 published_at');
    const ret = await setItemState({ pool: h.pool, itemId: created.id, state: 'retired' });
    assert.equal(ret.published_at, null, 'retire 之后 published_at 必须清掉（否则「何时发布」是假账）');
    assert.ok(ret.retired_at);
    // 用户面立刻看不见，但已装的目录不动（§7）
    assert.deepEqual((await listUserItems({ pool: h.pool, fdeId: h.fde.id })).items, []);
  } finally { h.after(); }
});

test('MK-18 请求体上限常量存在且高于 bundle 上限（§4.15 那条坑的机器锁）', () => {
  assert.ok(BUNDLE_MAX_BODY_BYTES > LIMITS.maxTotalBytes,
    '发布路由的上限必须 > bundle 天花板：base64 编码后还会再涨 4/3');
  assert.equal(BUNDLE_MAX_BODY_BYTES, 4 * MIB);
  assert.deepEqual([LIMITS.maxFiles, LIMITS.maxFileBytes, LIMITS.maxTotalBytes, LIMITS.maxEnabledSkills],
    [50, 512 * KIB, 2 * MIB, 12], '天花板数字改了必须同步 docs/api/portal.md §4.16 与设计文档 §3');
  assert.equal(skillDirFor({ userSpaceRoot: '/srv/erix/users' }, 'alice', 'pdf-tools'),
    '/srv/erix/users/alice/home/.erix/skills/pdf-tools');
  assert.throws(() => skillDirFor({ userSpaceRoot: '/srv/erix/users' }, 'alice', '../escape'),
    (e) => e instanceof MarketError && e.code === 'capability_not_found',
      'slug 形状不对时不许拼出逃逸路径');
});

// ---------------------------------------------------------------------------
// §3 之二：静态取 meta 的回归锁（真机 e2e 实测的两条缺陷，issue #595）
// ---------------------------------------------------------------------------

/**
 * 真实形状的 skill.mjs（**别把它改成「最小夹具」**——它的作用就是那些不起眼的边角）：
 *   · `required: ['msg']` / `enum: ['clone', 'update']` → 闭合 `]` **紧跟字符串**（差一位的引爆点）；
 *   · description 含中文与「」；`execute` 用模板字符串（里面既有 `}` 又有 `(`）；注释里出现 `]` 与 `}`；
 *   · 排在 `SKILL` 前面还有一个无关对象 `{ id: 'other' }`（钉住「id 只在技能对象体里找」）。
 * 实测（修复前）：`{ skillId: 'echo-probe', tools: [] }` ⇒ 发布被「tools[] 条数必须 1..12」拒掉；
 * 把 `required: ['msg']` 改成 `required: ['msg',]`（让 `]` 不紧跟字符串）同一份包立刻发布成功 ⇒ 根因是差一位。
 */
const REAL_SKILL_SRC = `// skill.mjs —— echo-probe（e2e 探针，docs/design/capability-market.md §10）
// 注释里出现 ] 与 } 也必须活着穿过静态解析。
const CFG = { id: 'other', nested: { id: 'nested' } };
export const SKILL = {
  id: 'echo-probe',
  name: 'Echo 探针',
  description: '回显一段文本，用来验证「装配真的发生了」这条链路。',
  tools: [
    {
      name: 'echo_probe',
      description: 'Echo the marker back so the transcript proves L1+L2+L3 wiring.',
      parameters: {
        type: 'object',
        properties: {
          msg: { type: 'string', description: 'text to echo back' },
          mode: { type: 'string', enum: ['clone', 'update'], description: 'which echo to run' },
        },
        required: ['msg'],
      },
    },
    {
      name: 'echo_probe_v2',
      description: 'Second tool, description long enough to clear the 20 char floor.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  ],
  execute: async ({ msg }) => \`echo: \${msg}\`,
};
export function getSkillDefinition() { return SKILL; }
`;

test('MK-19 真实形状的包必须解出 tools（差一位缺陷的回归锁：字符串紧跟 ] / } 也算数）', () => {
  const { skillId, tools } = extractSkillMeta(REAL_SKILL_SRC);
  assert.equal(skillId, 'echo-probe', 'id 取错会让「id 必须等于 slug」的闸误伤合法包');
  assert.equal(tools.length, 2, `tools 条数必须是 2（修复前实得 0：闭合 ] 被多跳一格吞掉）：${JSON.stringify(tools)}`);
  assert.deepEqual(tools.map((t) => t.name), ['echo_probe', 'echo_probe_v2']);
  // 描述不许是空串/被截到别的字段（§3 的 toolDescMin=20 靠它，取错位置会误判「描述过短」）
  for (const t of tools) {
    assert.ok(t.description.length >= LIMITS.toolDescMin, `描述取错：${JSON.stringify(t)}`);
    assert.ok(!t.description.includes('[') && !t.description.includes('enum'), `描述越界吃到 schema：${t.description}`);
  }
  // 同一份夹具必须过发布闸（端到端一层：静态取到的 tools 直接喂 validateBundle）
  const v = validateBundle({ slug: 'echo-probe', whenToUse: 'prove the skill wiring end to end', bundle: {
    files: [{ path: ENTRYPOINT, content_base64: b64(REAL_SKILL_SRC) }, { path: README_FILE, content_base64: b64('# p\n') }],
  } });
  assert.equal(v.manifest.tools.length, 2, 'manifest 里的 tools 必须与静态解析同数（§5 的 capabilities.json 用它）');

  // 反向：`name` 后面不是字符串字面量 ⇒ 那一条**被忽略**（跳过，不抛、也不许把整包判死）
  const mixed = extractSkillMeta(`export const SKILL = {
  id: 'mixed-skill',
  tools: [
    { name: TOOL_REF, description: 'a bare identifier is not a tool name', required: ['x'] },
    { name: 42, description: 'a number is not a tool name either', required: ['y'] },
    { name: 'ok_tool', description: 'this one is a literal and must survive' },
  ],
};
`);
  assert.deepEqual(mixed.tools, [{ name: 'ok_tool', description: 'this one is a literal and must survive' }],
    '不可解析的条目只能被丢掉：抛异常会让一整包发布不出去');
});

test('MK-20 skill.id 只在技能对象体里找（源里先出现无关 { id: \'other\' } 也不许抓错）', () => {
  // 夹具：无关对象与注释都排在前面（旧写法直接对全文抓第一个 /\bid\s*:/，两者都会命中）
  assert.equal(extractSkillMeta(REAL_SKILL_SRC).skillId, 'echo-probe',
    '前置的 { id: \'other\' } 不得抢先（否则 id≠slug ⇒ 合法包 400）');
  assert.equal(extractSkillMeta(`// 老包写作 id: 'legacy' ，那只是注释
const CFG = { id: 'other' };
export const SKILL = { id: 'real-skill', tools: [{ name: 'noop_tool', description: 'does nothing at all, honestly' }] };
`).skillId, 'real-skill');
  // 认不出锚点时退回全文扫描：至少不比旧行为差（历史包形状各异）
  assert.equal(extractSkillMeta(`const S = { id: 'legacy-shape', tools: [] };`).skillId, 'legacy-shape',
    '没有 SKILL 锚点也要能取到 id（退回全文扫描）');
  // 什么都没有 ⇒ null（发布侧据此报「取不到 id」，不是猜一个）
  assert.equal(extractSkillMeta('export function getSkillDefinition() { return null; }').skillId, null);
});

// ---------------------------------------------------------------------------
// §4 落盘面：降权子进程（评审 MEDIUM/8：检查与使用之间的 symlink 竞态）
// ---------------------------------------------------------------------------

/** 取顶层函数体（这些函数的收尾 `}` 在第 0 列）——结构判据只能读源码，行为判据看不到「还有没有 fs.rmSync」。 */
function fnBody(src, decl) {
  const at = src.indexOf(decl);
  assert.notEqual(at, -1, `找不到函数声明：${decl}`);
  const end = src.indexOf('\n}', at);
  assert.ok(end > at, `${decl} 的函数体取不到结尾`);
  return src.slice(at, end);
}

test('MK-21 结构判据：写入与删除都经过子进程，父进程里不再动盘（安全来自降权，不是 assertSafePath）', () => {
  // ① 父进程不许再亲手写/删：这些名字一出现就说明有人把动作挪回了 root 进程。
  //    ⚠ `ensureDirSafe`（建目录）故意**不在**禁止名单里：那是本节唯一留在 root 手里的改盘动作
  //    （全新 FDE 时子进程建不出 `home/.erix` 整串），market.js 里写了为什么与它的残留风险。
  for (const decl of ['export function writeSkillDir(', 'export function removeSkillDir(']) {
    const body = fnBody(MARKET_SRC, decl);
    for (const forbidden of ['fs.writeFileSync', 'fs.writeFile(', 'fs.appendFileSync', 'fs.rmSync',
      'fs.unlinkSync', 'fs.rmdirSync', 'fs.renameSync', 'fs.mkdirSync', 'fs.chmodSync', 'fs.chownSync']) {
      assert.ok(!body.includes(forbidden), `${decl} 里又出现了 ${forbidden}：改盘必须走 market-write.js 子进程`);
    }
    assert.match(body, /diskOps\(/, `${decl} 必须把动作交给 diskOps()（降权子进程）`);
  }
  // ② 子进程确实是 spawn 出去的，并且带着 uid/gid 与「非 root 就跳过」的判定
  const diskBody = fnBody(MARKET_SRC, 'function diskOps({');
  assert.match(MARKET_SRC, /import \{ spawnSync \} from 'node:child_process'/);
  assert.match(diskBody, /spawn\(process\.execPath, \[DISK_HELPER\], opts\)/, 'helper 必须用当前 node 跑，路径由模块位置决定');
  assert.match(diskBody, /opts\.uid = config\?\.fdeUid \?\? 1000/);
  assert.match(diskBody, /opts\.gid = config\?\.fdeGid \?\? 1000/);
  assert.match(diskBody, /canDropPrivileges\(\)/, 'uid/gid 只在能降权时传（非 root 单测环境传了就是 EPERM）');
  assert.match(MARKET_SRC, /process\.getuid\(\) === 0/);
  // payload 走 stdin，不走 argv（Linux 单串 argv 上限 128 KiB，而包上限是 2 MiB）
  assert.match(diskBody, /input: payload/);
  assert.doesNotMatch(diskBody, /\[\s*DISK_HELPER,\s*payload\s*\]/, 'payload 不许塞进 argv');
  // ③ helper 的位置由模块位置决定（而不是 cwd / 相对路径），且它真的在盘上
  assert.match(MARKET_SRC, /path\.dirname\(fileURLToPath\(import\.meta\.url\)\), 'market-write\.js'\)/);
  assert.ok(fs.existsSync(HELPER_PATH), 'portal/src/market-write.js 必须存在');
  // ④ helper 不许带业务判断：只准 import node 内置（不 import market.js，不引第三方）
  const imports = (HELPER_SRC.match(/^import [^\n]*$/gm) ?? []).map((l) => /from '([^']+)'/.exec(l)?.[1]).filter(Boolean);
  assert.deepEqual(imports.sort(), ['node:fs', 'node:path'],
    `market-write.js 只许用 node 内置模块（有业务判断就意味着安全边界又搬回 check-then-use 那侧）：${imports}`);
  // ⑤ 镜像面：portal/Dockerfile 是整目录 COPY，所以新增 src 文件会自动进镜像
  //    （issue #589 刚被「只拷子目录」坑过一次：portal/shared 没进镜像 ⇒ 镜像构建不出来）
  const docker = srcOf('../Dockerfile');
  assert.match(docker, /^COPY portal\/ portal\/$/m,
    'portal/Dockerfile 若改成逐文件 COPY，必须把 portal/src/market-write.js 一起带上');
});

test('MK-22 子进程契约：payload 走 stdin、removed 由回执决定、非 0 退出 ⇒ capability_install_failed（带子进程码）', () => {
  // tmp 当 userSpaceRoot（docs/testing.md §2.1）：本用例里所有「改盘」都是假件，但
  // `ensureDirSafe`（建目录）仍在真盘上跑 ⇒ root 参数必须是可写的 tmp，不能拿 /srv/erix 去 mkdir。
  const userSpaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'market-spawn-'));
  const h = { config: { userSpaceRoot, fdeUid: 1000, fdeGid: 1000 } };
  const quiet = { warn() {} };
  try {
  const ok = (results) => ({ status: 0, signal: null, stdout: Buffer.from(JSON.stringify({ ok: true, results })), stderr: Buffer.from('') });
  const calls = [];
  const fakeOk = (file, argv, opts) => { calls.push({ file, argv, opts }); return ok([{ op: 'remove', path: 'x', existed: true }]); };

  const r = removeSkillDir({ config: h.config, fdeName: 'alice', slug: 'demo-skill', log: quiet, spawnImpl: fakeOk });
  assert.equal(calls.length, 1, '删除必须且只走一次子进程');
  assert.equal(calls[0].file, process.execPath, '用当前 node 跑 helper（不依赖 PATH 上的 node）');
  assert.deepEqual(calls[0].argv, [HELPER_PATH],
    'argv 只放 helper 路径（由模块位置决定，不靠 cwd）；包内容进 argv 会撑爆单串 128 KiB 上限');
  assert.equal(calls[0].opts.input.includes('demo-skill'), true, '指令必须走 stdin（opts.input）');
  assert.deepEqual(JSON.parse(calls[0].opts.input).ops.map((o) => o.op), ['remove']);
  assert.deepEqual(calls[0].opts.env, {}, '不给子进程带环境（DB 密码之类不该出现在里面）');
  assert.ok(Number.isInteger(calls[0].opts.timeout), '子进程必须有超时：卡死会挂住 HTTP 请求');
  assert.equal(r.removed, true, 'removed 必须由 helper 回执的 existed 决定（父进程不再自己 existsSync）');

  // 幂等：回执说「本来就不在」⇒ removed:false（卸载两次仍是 200）
  calls.length = 0;
  calls.push; // no-op, keeps the array obviously mutable for readers
  const gone = removeSkillDir({ config: h.config, fdeName: 'alice', slug: 'demo-skill', log: quiet,
    spawnImpl: () => ok([{ op: 'remove', path: 'x', existed: false }]) });
  assert.equal(gone.removed, false);

  // 生产分支：root 才降权（这里伪造 getuid()=0 来验「传了 uid/gid」，真实 setuid 效果只能在真容器里验）
  const realGetuid = process.getuid;
  try {
    process.getuid = () => 0;
    calls.length = 0;
    removeSkillDir({ config: h.config, fdeName: 'alice', slug: 'demo-skill', log: quiet, spawnImpl: fakeOk });
    assert.equal(calls[0].opts.uid, 1000, 'root 下必须降权到 fdeUid');
    assert.equal(calls[0].opts.gid, 1000, 'root 下必须降权到 fdeGid');
    calls.length = 0;
    removeSkillDir({ config: { userSpaceRoot }, log: quiet, fdeName: 'alice', slug: 'demo-skill', spawnImpl: fakeOk });
    assert.deepEqual([calls[0].opts.uid, calls[0].opts.gid], [1000, 1000], 'config 没写 fdeUid/fdeGid 时按 §4 的缺省 1000 降权');
  } finally { process.getuid = realGetuid; }
  // 非 root（单测/开发）⇒ 不传 uid/gid，否则 spawnSync 直接 EPERM
  assert.equal(typeof process.getuid === 'function' && process.getuid() === 0, false,
    '本用例假设单测以非 root 跑（若以 root 跑，MK-22 后半段的「不降权」判据要改）');
  calls.length = 0;
  removeSkillDir({ config: h.config, fdeName: 'alice', slug: 'demo-skill', log: quiet, spawnImpl: fakeOk });
  assert.equal(calls[0].opts.uid, undefined, '非 root 环境不许传 uid（EPERM）');

  // 非 0 退出 ⇒ 500 capability_install_failed，details 带子进程的码
  const failFake = () => ({ status: 1, signal: null, stdout: Buffer.from(''),
    stderr: Buffer.from(JSON.stringify({ ok: false, error: "EACCES: permission denied, open '/etc/cron.d/x'",
      code: 'EACCES', op: 'write', path: '/etc/cron.d/x', index: 1 })) });
  for (const [what, run] of [
    ['writeSkillDir', () => writeSkillDir({ config: h.config, fdeName: 'alice', slug: 'demo-skill', log: quiet,
      files: [{ path: ENTRYPOINT, content: Buffer.from('// x\n') }], spawnImpl: failFake })],
    ['removeSkillDir', () => removeSkillDir({ config: h.config, fdeName: 'alice', slug: 'demo-skill', log: quiet, spawnImpl: failFake })],
  ]) {
    let e = null;
    try { run(); } catch (err) { e = err; }
    assert.ok(e instanceof MarketError, `${what} 子进程非 0 退出必须抛 MarketError`);
    assert.equal(e.code, 'capability_install_failed', `${what} 的错误码：${e.code}`);
    assert.equal(e.httpStatus, 500);
    assert.equal(e.details.reason, 'helper_exit_1', `details.reason 要带子进程的码：${JSON.stringify(e.details)}`);
    assert.equal(e.details.exit_code, 1);
    assert.equal(e.details.child_code, 'EACCES', 'helper 的 errno 必须原样带出来（运维要靠它区分「越界」与「盘满」）');
    assert.equal(e.details.child_op, 'write');
    assert.equal(e.details.child_index, 1, '一个 payload 里可以有 20 多条指令：不报「第几条挂了」等于没报');
  }
  // 信号（超时/被杀）同样是失败，不许当成「部分成功」
  let sig = null;
  try {
    removeSkillDir({ config: h.config, fdeName: 'alice', slug: 'demo-skill', log: quiet,
      spawnImpl: () => ({ status: null, signal: 'SIGTERM', stdout: Buffer.from(''), stderr: Buffer.from('') }) });
  } catch (e) { sig = e; }
  assert.equal(sig?.details?.reason, 'helper_signal_SIGTERM');
  // 回执不是 JSON / 形状不对 ⇒ 也是失败（不许「静默当成功」）
  for (const [stdout, reason] of [['nope', 'helper_reply_unparsable'], [JSON.stringify({ ok: true }), 'helper_reply_malformed']]) {
    let e = null;
    try {
      removeSkillDir({ config: h.config, fdeName: 'alice', slug: 'demo-skill', log: quiet,
        spawnImpl: () => ({ status: 0, signal: null, stdout: Buffer.from(stdout), stderr: Buffer.from('') }) });
    } catch (err) { e = err; }
    assert.equal(e?.details?.reason, reason, `stdout=${stdout} 应当判失败：${e?.details?.reason}`);
  }
  // spawn 本身失败（helper 文件被删/execPath 不可用）⇒ 同一条错误码
  let se = null;
  try {
    removeSkillDir({ config: h.config, fdeName: 'alice', slug: 'demo-skill', log: quiet,
      spawnImpl: () => ({ error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }) });
  } catch (e) { se = e; }
  assert.equal(se?.code, 'capability_install_failed');
  assert.equal(se?.details?.reason, 'spawn_failed_ENOENT');

  // payload 超限 ⇒ 在父进程就拦住（一次 spawn 都不该发生）
  const bigCalls = [];
  let pe = null;
  try {
    writeSkillDir({ config: h.config, fdeName: 'alice', slug: 'demo-skill', log: quiet,
      files: [{ path: ENTRYPOINT, content: Buffer.alloc(13 * MIB, 0x61) }],   // base64 后 > 16 MiB
      spawnImpl: (...a) => { bigCalls.push(a); return ok([]); } });
  } catch (e) { pe = e; }
  assert.equal(pe?.details?.reason, 'payload_too_large', `超大 payload 必须当场拒：${pe?.details?.reason}`);
  // 大 payload 一次都没进管道（只剩 catch 里那次小清理，它不该带着 13 MB 内容）
  assert.ok(!bigCalls.some(([, , opts]) => Buffer.byteLength(String(opts.input ?? '')) > MIB),
    `超限就不该把大块内容塞进管道（spawn 次数=${bigCalls.length}）`);
  } finally { fs.rmSync(userSpaceRoot, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// §7 状态动词（真机实测：POST .../publish 曾直接 400）
// ---------------------------------------------------------------------------

test('MK-23 publish/retire 动词必须映射成状态（真机 400 validation_failed 的回归锁）', async () => {
  assert.deepEqual({ ...STATE_VERBS }, { publish: 'published', retire: 'retired' },
    '§7 只开这两个动词；加动词改这张表，别把状态机的域放宽');
  assert.equal(stateForVerb('publish'), 'published');
  assert.equal(stateForVerb('retire'), 'retired');
  let ve = null;
  try { stateForVerb('unretire'); } catch (e) { ve = e; }
  assert.ok(ve instanceof MarketError && ve.httpStatus === 405 && ve.code === 'capability_state_verb_unknown',
    `未知动词 ⇒ 405：${ve?.code} / ${ve?.httpStatus}`);

  // 端到端一层：动词映射喂进状态机 ⇒ 库里 state 与 published_at 都对
  const h = await harness({ publish: true, state: 'draft' });
  try {
    const item = h.pool.items.find((i) => i.slug === h.slug);
    assert.equal(item.state, 'draft');
    const pub = await setItemState({ pool: h.pool, itemId: item.id, state: stateForVerb('publish') });
    assert.equal(pub.state, 'published', 'publish 动词落库必须是 published');
    assert.ok(pub.published_at, 'publish 必须写 published_at（§5 的用户面列表按它排序）');
    const ret = await setItemState({ pool: h.pool, itemId: item.id, state: stateForVerb('retire') });
    assert.equal(ret.state, 'retired');
    assert.ok(ret.retired_at, 'retire 必须写 retired_at');
    // 状态机的域**没有**因为这次修映射而放宽：动词本身仍不是合法状态（防止「把校验删了当修好了」）
    const e = await expectErr(setItemState({ pool: h.pool, itemId: item.id, state: 'publish' }),
      { code: 'validation_failed', httpStatus: 400 });
    assert.equal(e.details.field, 'state');

    // http.js 侧的接线：路由只放这两个动词（非法动词进不了路由 ⇒ 由末尾兜底 404），且调用处传的是映射结果
    const line = HTTP_SRC.split('\n').find((l) => l.includes('adminMarketStateMatch = pathname.match('));
    assert.ok(line, 'publish/retire 路由必须还在 http.js');
    const lit = /pathname\.match\((.+)\);/.exec(line)[1];
    const routeRe = new RegExp(lit.slice(1, -1));
    assert.ok(routeRe.test('/api/admin/market/items/9a2f/publish') && routeRe.test('/api/admin/market/items/9a2f/retire'));
    assert.equal(routeRe.test('/api/admin/market/items/9a2f/unretire'), false,
      '非法动词根本进不了这条路由（落 http.js 末尾的 404 兜底）');
    assert.equal(routeRe.test('/api/admin/market/items/9a2f/published'), false);
    assert.match(HTTP_SRC, /state\.stateForVerb\(adminMarketStateMatch\[2\]\)|stateForVerb\(adminMarketStateMatch\[2\]\)/,
      'http.js 必须把动词过 stateForVerb 再传');
    assert.ok(!/state:\s*adminMarketStateMatch\[2\]/.test(HTTP_SRC),
      '不许再把 URL 动词直接当 state 传（真机 400 validation_failed 的根因）');
  } finally { h.after(); }
});
