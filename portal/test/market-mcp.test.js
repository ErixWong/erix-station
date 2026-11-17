// portal/test/market-mcp.test.js —— MCP 通道的 portal 侧判据（issue #608，契约 docs/design/mcp-integration.md）
//
// 为什么单独一个文件而不是塞进 market.test.js：那支用的是「尽量像真 SQL」的 FakePool，
// 已经 1000+ 行；MCP 的读面（槽位、加密值、内部通道）要另一组表，混进去会让两支测试互相牵制。
// 这里用一个**只认本文件需要的 SQL 形状**的小 fake：遇到不认识的 SQL 直接抛，缺 handler 不会静默。
//
// 覆盖（对应契约 §11 的 portal 部分）：
//   MC-1  MCP 字段面负例（transport / command / url / exposure / lifecycle / reason / resident）
//   MC-2  槽位矩阵（secret+context、stdio+header、http+env、保留名、重名、超限）
//   MC-3  发布：合法 MCP 条目落库（manifest 带 transport）、不写 capability_files
//   MC-4  发布闸门：配置不全不能发布（mcp_config_incomplete）
//   MC-5  安装：不落盘（disk='none'）、不碰 skills 目录
//   MC-6  启用：缺必填槽 ⇒ 409 capability_secret_missing（details.missing），补齐后可启用
//   MC-7  凭据只写不读：listSlots 回 has_value，**没有任何字段承载值**
//   MC-8  解析（内部通道）：只取 published && enabled && 非 hidden；fde 覆盖 global；缺槽进 missing
//   MC-9  skill 红色形状：detached:true ⇒ 400 capability_package_shape（反向：去掉该形状则通过）

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  MarketError, MCP_LIMITS, installCapability, listCapabilitiesForFde, listMcpServersForFde, listSlots, publishItem,
  resolveMcpServersForFde, setCapabilityEnabled, setItemState, setSlotValues, validateBundle,
  validateMcpFields,
} from '../src/market.js';
import { decryptValue, encryptValue } from '../src/secrets.js';

const KEY = Buffer.alloc(32, 9);

// ---------------------------------------------------------------------------
// 最小 fake：只认本文件用到的 SQL 形状
// ---------------------------------------------------------------------------

class McpFake {
  constructor() {
    this.items = [];
    this.files = new Map();
    this.installs = new Map();
    this.params = new Map();
    this.values = new Map();
    this.revisions = new Map();
    this.outbox = [];
    this.seq = 0;
  }

  paramsOf(itemId) { return [...this.params.values()].filter((p) => p.item_id === itemId); }

  /** `withTransaction` 需要 connect()/release()：fake 是单连接语义（同进程串行，够用）。 */
  async connect() {
    return { query: (sql, params) => this.query(sql, params), release: () => {} };
  }

  async query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(s)) return { rows: [] };

    if (s.includes('INSERT INTO capability_items')) {
      const it = {
        id: `item-${++this.seq}`, kind: params[0], slug: params[1], name: params[2], summary: params[3],
        when_to_use: params[4], description_md: params[5], version: params[6], author: params[7],
        tags: params[8], license: params[9], state: params[10], manifest: JSON.parse(params[11]),
        security_score: params[12], security_warnings: JSON.parse(params[13]), created_by: params[14],
        published_at: params[10] === 'published' ? new Date() : null, retired_at: null,
        created_at: new Date(), updated_at: new Date(),
      };
      this.items.push(it);
      return { rows: [it] };
    }
    if (s.includes('FROM capability_items WHERE slug = $1')) {
      const it = this.items.find((x) => x.slug === params[0]);
      return { rows: it ? [it] : [] };
    }
    if (s.includes('FROM capability_items WHERE id = $1')) {
      const it = this.items.find((x) => x.id === params[0]);
      return { rows: it ? [it] : [] };
    }
    if (s.includes('SELECT inst.version, inst.enabled, inst.installed_at, inst.updated_at')) {
      const inst = [...this.installs.values()].find((x) => x.fde_id === params[0]
        && this.items.find((i) => i.id === x.item_id)?.slug === params[1]);
      return { rows: inst ? [{ version: inst.version, enabled: inst.enabled, installed_at: new Date(), updated_at: new Date() }] : [] };
    }
    if (s.includes('SELECT kind, manifest FROM capability_items')) {
      const it = this.items.find((x) => x.id === params[0]);
      return { rows: it ? [{ kind: it.kind, manifest: it.manifest }] : [] };
    }
    if (s.includes('SELECT id FROM capability_items WHERE slug')) {
      const it = this.items.find((x) => x.slug === params[0]);
      return { rows: it ? [{ id: it.id }] : [] };
    }
    if (s.includes('UPDATE capability_items') && s.includes('state = $2')) {
      const it = this.items.find((x) => x.id === params[0]);
      if (!it) return { rows: [] };
      it.state = params[1];
      return { rows: [it] };
    }
    if (s.includes('count(*)::int AS n FROM capability_files')) {
      return { rows: [{ n: [...this.files.keys()].filter((k) => k.startsWith(`${params[0]}|`)).length }] };
    }

    if (s.includes('DELETE FROM capability_params WHERE item_id')) {
      for (const [k, v] of [...this.params]) if (v.item_id === params[0]) this.params.delete(k);
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
      return { rows: this.paramsOf(params[0]) };
    }
    if (s.includes('SELECT name, kind, inject, required FROM capability_params')) {
      return { rows: this.paramsOf(params[0]).map(({ name, kind, inject, required }) => ({ name, kind, inject, required })) };
    }
    if (s.includes('SELECT name, inject, required FROM capability_params')) {
      return { rows: this.paramsOf(params[0]).map(({ name, inject, required }) => ({ name, inject, required })) };
    }
    if (s.includes('SELECT name, kind FROM capability_params')) {
      return { rows: this.paramsOf(params[0]).map(({ name, kind }) => ({ name, kind })) };
    }

    if (s.includes('INSERT INTO capability_param_values')) {
      const [itemId, name, scope, fdeId, blob, actorId] = params;
      this.values.set(`${itemId}|${name}|${scope}|${fdeId ?? ''}`, {
        item_id: itemId, name, scope, fde_id: fdeId ?? null, value_encrypted: blob,
        updated_by: actorId ?? null, updated_at: new Date(),
      });
      return { rows: [] };
    }
    if (s.includes('DELETE FROM capability_param_values')) {
      const [itemId, name, scope] = params;
      const fdeId = s.includes('fde_id = $4') ? params[3] : null;
      this.values.delete(`${itemId}|${name}|${scope}|${fdeId ?? ''}`);
      return { rows: [] };
    }
    if (s.includes('SELECT name, scope, fde_id, value_encrypted FROM capability_param_values')) {
      const [itemId, fdeId] = params;
      return { rows: [...this.values.values()].filter((v) => v.item_id === itemId && (v.scope === 'global' || v.fde_id === fdeId)) };
    }
    if (s.includes('SELECT name, fde_id, updated_at FROM capability_param_values')) {
      return { rows: [...this.values.values()].filter((v) => v.item_id === params[0] && v.scope === 'fde') };
    }
    if (s.includes('FROM capability_params p LEFT JOIN capability_param_values v')) {
      const itemId = params[0];
      return {
        rows: this.paramsOf(itemId).map((p) => {
          const v = this.values.get(`${itemId}|${p.name}|global|`);
          return {
            name: p.name, kind: p.kind, inject: p.inject, required: p.required, description: p.description,
            scope: v ? 'global' : null, fde_id: null, updated_at: v?.updated_at ?? null,
            updated_by: v?.updated_by ?? null, has_value: Boolean(v),
          };
        }),
      };
    }
    if (s.includes('SELECT p.item_id, p.name, EXISTS')) {
      const fdeId = params[0];
      const ids = params[1];
      const rows = [];
      for (const id of ids) {
        for (const p of this.paramsOf(id).filter((x) => x.required)) {
          const has = [...this.values.values()].some((v) => v.item_id === id && v.name === p.name
            && (v.scope === 'global' || v.fde_id === fdeId));
          rows.push({ item_id: id, name: p.name, has_value: has });
        }
      }
      return { rows };
    }

    if (s.includes('UPDATE fde_capability_installs SET enabled')) {
      const inst = this.installs.get(`${params[0]}|${params[1]}`);
      if (inst) inst.enabled = params[2];
      return { rows: inst ? [{ version: inst.version, enabled: inst.enabled }] : [] };
    }
    if (s.includes('SELECT id, slug FROM capability_items WHERE slug = ANY')) {
      const slugs = params[0] ?? [];
      return { rows: this.items.filter((i) => slugs.includes(i.slug)).map((i) => ({ id: i.id, slug: i.slug })) };
    }
    if (s.includes('INSERT INTO fde_capability_installs')) {
      this.installs.set(`${params[0]}|${params[1]}`, {
        fde_id: params[0], item_id: params[1], version: params[2], enabled: params[3],
      });
      return { rows: [] };
    }
    if (s.includes('count(*)::int AS n FROM fde_capability_installs')) {
      const kind = params[1] ?? 'skill';
      const n = [...this.installs.values()].filter((x) => {
        if (x.fde_id !== params[0] || !x.enabled) return false;
        return (this.items.find((i) => i.id === x.item_id)?.kind ?? 'skill') === kind;
      }).length;
      return { rows: [{ n }] };
    }
    if (s.includes('FROM fde_capability_installs inst') && s.includes("i.kind = 'skill'")) {
      const rows = [...this.installs.values()]
        .filter((x) => x.fde_id === params[0])
        .map((x) => ({ inst: x, item: this.items.find((i) => i.id === x.item_id) }))
        .filter(({ item }) => item && item.kind === 'skill' && item.state === 'published')
        .sort((a, b) => (a.item.slug < b.item.slug ? -1 : 1))
        .map(({ inst, item }) => ({
          slug: item.slug, name: item.name, summary: item.summary,
          when_to_use: item.when_to_use, manifest: item.manifest, enabled: inst.enabled,
        }));
      return { rows };
    }
    if (s.includes('FROM fde_capability_installs inst') && s.includes("i.kind = 'mcp'")) {
      const rows = [...this.installs.values()]
        .filter((x) => x.fde_id === params[0] && x.enabled)
        .map((x) => this.items.find((i) => i.id === x.item_id))
        .filter((i) => i && i.kind === 'mcp' && i.state === 'published')
        .sort((a, b) => (a.slug < b.slug ? -1 : 1))
        .map((i) => ({ slug: i.slug, name: i.name, summary: i.summary, manifest: i.manifest }));
      return { rows };
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
    throw new Error(`McpFake 不认识这条 SQL：${s}`);
  }
}

const META = (slug) => ({
  slug, name: `名字 ${slug}`, summary: '一句话', when_to_use: '需要用它的时候就用', version: '1.0.0',
});

const MCP_FIELDS = (slug, extra = {}) => ({
  ...META(slug), kind: 'mcp', transport: 'stdio', command: 'node', args: ['server.mjs'],
  reason: 'stateful', slots: [{ name: 'ECHO_PREFIX', kind: 'secret', inject: 'env', required: true, description: '前缀' }],
  ...extra,
});

function tmpConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-market-'));
  return { config: { userSpaceRoot: root, fdeUid: null, fdeGid: null, mcpSecretKey: KEY }, root };
}

const expectErr = async (p) => {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof MarketError, `应抛 MarketError，实际 ${e?.name}: ${e?.message}`);
    return e;
  }
  assert.fail('期望抛错但成功了');
};

// ---------------------------------------------------------------------------
// MC-1/MC-2：字段面与槽位矩阵
// ---------------------------------------------------------------------------

test('MC-1 MCP 字段面负例：transport/command/url/exposure/lifecycle/reason/resident', () => {
  const bad = (fields, code = 'validation_failed') => {
    let err;
    try { validateMcpFields(fields, { requireAll: true }); } catch (e) { err = e; }
    assert.ok(err, `应被拒：${JSON.stringify(fields)}`);
    assert.equal(err.code, code, `code 不符：${err.code} / ${err.message}`);
  };
  bad({ ...MCP_FIELDS('a'), transport: 'sse' });
  bad({ ...MCP_FIELDS('a'), command: 'node server.mjs' });
  bad({ ...MCP_FIELDS('a'), transport: 'http', url: 'file:///etc/passwd' });
  bad({ ...MCP_FIELDS('a'), transport: 'http', url: 'https://x.test/mcp', command: 'node' });
  bad({ ...MCP_FIELDS('a'), exposure: 'always' });
  bad({ ...MCP_FIELDS('a'), lifecycle: 'forever' });
  bad({ ...MCP_FIELDS('a'), reason: undefined }, 'capability_reason_required');
  bad({ ...MCP_FIELDS('a'), reason: 'because' }, 'capability_reason_required');
  bad({ ...MCP_FIELDS('a'), resident: 'container' }, 'capability_kind_unsupported');
  bad({ ...MCP_FIELDS('a'), timeout_ms: 999999 });
});

test('MC-2 槽位矩阵：secret+context / stdio+header / http+env / 保留名 / 重名 / 超限', () => {
  const bad = (slots, ctx, name) => {
    let err;
    try { validateMcpFields({ ...MCP_FIELDS('a'), slots }, { requireAll: true }); } catch (e) { err = e; }
    assert.ok(err, `应被拒：${name}`);
    assert.equal(err.code, 'capability_slot_invalid', `${name} 的 code 不符：${err.code}`);
  };
  const S = (extra) => [{ name: 'X_TOKEN', kind: 'secret', inject: 'env', required: true, description: 'd', ...extra }];
  bad(S({ inject: 'context' }), null, 'secret+context');
  bad(S({ inject: 'header' }), null, 'stdio+header');
  bad(S({ name: 'PATH' }), null, '保留名');
  bad(S({ name: 'ERIX_SOMETHING' }), null, '保留前缀');
  bad(S({ name: 'bad-name' }), null, '非法字符');
  bad([...S(), ...S()], null, '重名');
  bad(Array.from({ length: MCP_LIMITS.maxSlots + 1 }, (_, i) => ({
    name: `X${i}`, kind: 'config', inject: 'env', required: false, description: 'd',
  })), null, '超限');

  // 合法：stdio+env、http+header
  assert.equal(validateMcpFields(MCP_FIELDS('a'), { requireAll: true }).slots.length, 1);
  const http = validateMcpFields({
    ...MCP_FIELDS('b'), transport: 'http', url: 'https://srch.test/mcp', command: undefined, args: undefined,
    slots: [{ name: 'AUTHORIZATION', kind: 'secret', inject: 'header', required: true, description: 'token' }],
  }, { requireAll: true });
  assert.equal(http.manifest.transport, 'http');
  assert.equal(http.slots[0].inject, 'header');
});

// ---------------------------------------------------------------------------
// MC-3/MC-4：发布
// ---------------------------------------------------------------------------

test('MC-3/MC-4 发布：合法条目落库且 manifest 带 transport；配置不全不能发布', async () => {
  const pool = new McpFake();
  const item = await publishItem({ pool, actorId: null, fields: MCP_FIELDS('hub') });
  assert.equal(item.kind, 'mcp');
  assert.equal(pool.items[0].manifest.transport, 'stdio', 'manifest 必须带 transport（runner 靠它选传输）');
  assert.equal(pool.items[0].manifest.exposure, 'deferred', 'exposure 缺省 deferred');
  assert.equal(pool.params.size, 1, '槽位声明必须落 capability_params');

  // 配置不全（没有 command/url）⇒ 发布闸门拒
  pool.items[0].manifest = { transport: 'stdio' };
  const e = await expectErr(setItemState({ pool, itemId: pool.items[0].id, state: 'published' }));
  assert.equal(e.code, 'capability_not_published');
  assert.equal(e.details.reason, 'mcp_config_incomplete');
});

// ---------------------------------------------------------------------------
// MC-5/MC-6/MC-7：安装 / 启用 / 凭据
// ---------------------------------------------------------------------------

test('MC-5/MC-6/MC-7 安装不落盘；启用缺槽 409；写值后 has_value=true 且 API 不含值', async () => {
  const pool = new McpFake();
  const { config, root } = tmpConfig();
  const fde = { id: 'fde-1', name: 'alice' };
  try {
    const item = await publishItem({ pool, fields: MCP_FIELDS('hub') });
    await setItemState({ pool, itemId: item.id, state: 'published' });

    const inst = await installCapability({ pool, config, fde, slug: 'hub' });
    assert.equal(inst.disk, 'none', 'MCP 安装不落盘');
    assert.equal(fs.existsSync(path.join(root, 'alice', 'home', '.erix', 'skills')), false, '不该创建 skills 目录');

    // 缺槽 ⇒ 启用被 409 拦住（fail-closed）
    const e = await expectErr(setCapabilityEnabled({ pool, fde, slug: 'hub', enabled: true, config }));
    assert.equal(e.code, 'capability_secret_missing');
    assert.deepEqual(e.details.missing, ['ECHO_PREFIX']);

    // 写值（global）⇒ 密文入库；listSlots 只回元数据
    await setSlotValues({ pool, itemId: item.id, actorId: null, scope: 'global', values: { ECHO_PREFIX: 'PFX' }, key: KEY });
    const stored = [...pool.values.values()][0];
    assert.ok(Buffer.isBuffer(stored.value_encrypted), '库里必须是密文 Buffer');
    assert.equal(stored.value_encrypted.toString('utf8').includes('PFX'), false, '明文不许出现在密文列里');

    const slots = await listSlots({ pool, itemId: item.id });
    assert.equal(slots[0].has_value, true);
    assert.equal(JSON.stringify(slots).includes('PFX'), false, 'listSlots 的响应里不许出现值');

    // 解密（内部通道用）能拿回原文
    assert.equal(decryptValue({
      itemId: item.id, name: 'ECHO_PREFIX', scope: 'global', blob: stored.value_encrypted, key: KEY,
    }), 'PFX');

    // 补齐后可以启用
    const ok = await setCapabilityEnabled({ pool, fde, slug: 'hub', enabled: true, config });
    assert.equal(ok.enabled, true);

    // 删除值（null）⇒ 又变成缺槽
    await setSlotValues({ pool, itemId: item.id, scope: 'global', values: { ECHO_PREFIX: null }, key: KEY });
    assert.equal((await listSlots({ pool, itemId: item.id }))[0].has_value, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// MC-8：内部通道的解析面
// ---------------------------------------------------------------------------

test('MC-8 解析：只取 published && enabled && 非 hidden；fde 覆盖 global；缺槽进 missing', async () => {
  const pool = new McpFake();
  const fde = { id: 'fde-1', name: 'alice' };

  const a = await publishItem({ pool, fields: MCP_FIELDS('alpha') });
  await setItemState({ pool, itemId: a.id, state: 'published' });
  await installCapability({ pool, config: tmpConfig().config, fde, slug: 'alpha' });
  await setSlotValues({ pool, itemId: a.id, scope: 'global', values: { ECHO_PREFIX: 'G' }, key: KEY });

  // hidden 条目：即使装了也不该出现在物化/解析面
  const h = await publishItem({ pool, fields: MCP_FIELDS('ghost', { exposure: 'hidden' }) });
  await setItemState({ pool, itemId: h.id, state: 'published' });
  await installCapability({ pool, config: tmpConfig().config, fde, slug: 'ghost' });
  await setSlotValues({ pool, itemId: h.id, scope: 'global', values: { ECHO_PREFIX: 'G' }, key: KEY });

  const listed = await listMcpServersForFde(pool, fde.id);
  assert.deepEqual(listed.map((s) => s.name), ['alpha'], 'hidden 整条不物化');

  const resolved = await resolveMcpServersForFde({ pool, fde, key: KEY });
  assert.deepEqual(resolved.servers.map((s) => s.name), ['alpha']);
  assert.deepEqual(resolved.servers[0].values, { ECHO_PREFIX: 'G' });

  // fde 覆盖 global
  await setSlotValues({ pool, itemId: a.id, scope: 'fde', fdeId: fde.id, values: { ECHO_PREFIX: 'F' }, key: KEY });
  assert.deepEqual((await resolveMcpServersForFde({ pool, fde, key: KEY })).servers[0].values, { ECHO_PREFIX: 'F' });

  // 停用 ⇒ 两个面都不再出现
  await setCapabilityEnabled({ pool, fde, slug: 'alpha', enabled: false, config: { mcpSecretKey: KEY } });
  assert.deepEqual(await listMcpServersForFde(pool, fde.id), []);
  assert.deepEqual((await resolveMcpServersForFde({ pool, fde, key: KEY })).servers, []);
});

// ---------------------------------------------------------------------------
// MC-10：两个清单互不串味（真机 e2e 抓到的缺陷）
// ---------------------------------------------------------------------------

test('MC-10【反向】MCP 条目不许出现在 skills 清单里（kind 过滤），反之亦然', async () => {
  const pool = new McpFake();
  const fde = { id: 'fde-1', name: 'alice' };
  const mcp = await publishItem({ pool, fields: MCP_FIELDS('hub') });
  await setItemState({ pool, itemId: mcp.id, state: 'published' });
  await installCapability({ pool, config: tmpConfig().config, fde, slug: 'hub' });

  // MCP 装了 ⇒ mcp 清单有它、skills 清单**一条都没有**
  assert.equal((await listMcpServersForFde(pool, fde.id)).length, 1);
  assert.deepEqual(await listCapabilitiesForFde(pool, fde.id), [],
    'MCP 条目混进 skills 清单 ⇒ capabilities.json 会宣称一个不存在的技能包');

  // 反过来：造一条 skill 条目（fake 里直接塞）⇒ skills 清单有它、mcp 清单没有
  pool.items.push({
    id: 'item-skill', kind: 'skill', slug: 'real-skill', name: '真技能', summary: 's',
    when_to_use: 'w', manifest: { skill_id: 'real-skill', tools: [{ name: 't' }] },
    state: 'published', version: '1.0.0',
  });
  pool.installs.set(`fde-1|item-skill`, { fde_id: 'fde-1', item_id: 'item-skill', version: '1.0.0', enabled: true });
  const skills = await listCapabilitiesForFde(pool, fde.id);
  assert.deepEqual(skills.map((x) => x.id), ['real-skill']);
  assert.equal((await listMcpServersForFde(pool, fde.id)).length, 1, 'skills 也不许串进 mcp 清单');
});

// ---------------------------------------------------------------------------
// MC-9：skill 红色形状
// ---------------------------------------------------------------------------

test('MC-9 skill 包红色形状硬拒；去掉该形状则通过（反向）', () => {
  const mk = (src) => ({
    slug: 'shape-test',
    whenToUse: '当用户要测试形状闸的时候使用',
    bundle: {
      files: [
        { path: 'skill.mjs', content_base64: Buffer.from(src).toString('base64') },
        { path: 'SKILL.md', content_base64: Buffer.from('# x\n').toString('base64') },
      ],
    },
  });
  const base = `
export async function getSkillDefinition() {
  return { schema_version: 1, skill: { id: 'shape-test', entrypoint: 'skill.mjs' },
    tools: [{ name: 'run', description: '这是一个足够长的工具描述，长度必须超过二十个字符才能通过发布校验', inputSchema: { type: 'object' } }] };
}
export async function run() { return 'ok'; }
`;
  // 反向：干净包必须过（否则「拒掉一切」也会让上面那条绿）
  assert.ok(validateBundle(mk(base)).manifest.skill_id === 'shape-test');

  let err;
  try {
    validateBundle(mk(`${base}\nconst p = spawn('x', { detached: true });\n`));
  } catch (e) { err = e; }
  assert.ok(err, 'detached:true 必须被拒');
  assert.equal(err.code, 'capability_package_shape');
  assert.ok(err.details.hits.some((h) => h.code === 'detached_spawn'));

  let err2;
  try {
    validateBundle(mk(`${base}\nsetInterval(() => {}, 1000);\n`));
  } catch (e) { err2 = e; }
  assert.ok(err2, '模块级定时器必须被拒');
  assert.equal(err2.code, 'capability_package_shape');
});
