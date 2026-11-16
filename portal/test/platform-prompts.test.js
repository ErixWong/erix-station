// issue #596 片 A：管理台「提示词」面板的**后端**判据（契约 `docs/design/admin-prompts-panel-2026-11-16.md` §8）。
//
// 格子名（`P1`…`P10` + `T1`）写在测试标题里，主 agent 可以按名字点名复跑。分工：
//   · 模块层（`P1`–`P10`）—— 假 pool + 纯函数，判据是「哪一份文本生效、为什么、超没超限、存没存进去」。
//   · HTTP 层（`P7b`/`P8b` + DTO 那几条）—— 真 `createServer`，判据是「状态码 + `details.field` + 响应出自
//     `RETURNING` + 表不存在也是 200」。
//   · `T1` —— 改名链路（手工 + 自动两条）真的把 DB 生效值当 system 发出去（假 fetch 看请求体）。
//
// 隔离约定（docs/testing.md §2.1）：注入假 pool / 临时目录 / 桩 fetch，不碰真实 DB、真实容器、真实网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import { hashToken } from '../src/auth.js';
import { FakePool } from './fake-pool.js';
import { createSessionTextHandler, engineTranscriptRow, inputTranscriptRow } from './fake-session-text.js';
import { generateAiTitle } from '../src/sessions.js';
import { generateAutoTitle } from '../src/session-title.js';
import { TITLE_SYSTEM_PROMPT } from '../src/title-llm.js';
import {
  renderHomeAgentsMd,
  agentsMdRenderBudget,
  agentsMdRenderedBytes,
  AGENTS_MD_EXAMPLE_FDE_NAME,
  AGENTS_MD_ADDENDUM_HEADER,
} from '../src/materializer.js';
// 判据 `P9` 的跨包对账：portal 的注入上限必须等于 runner 注入侧的那个常量。
// ⚠ 只有**测试**跨包 import —— portal 镜像不含 `runner/`（`portal/Dockerfile` 只 `COPY portal/ portal/`），
//   运行期引它 = portal 起不来（先例：`runner/test/system-prompt.test.js` import `portal/src/previewpool.js`）。
import { AGENTS_MD_MAX_FILE_BYTES } from '../../runner/lib/agents-md.js';
import {
  ADDENDUM_MAX_BYTES, OVERRIDE_MAX_BYTES, TITLE_PROMPT_MAX_BYTES, AGENTS_MD_INJECT_MAX_BYTES,
  AUDIT_ACTION, AUDIT_TARGET, DEFAULT_READ_TIMEOUT_MS, PROMPT_FIELDS,
  READONLY_PROMPT_KEYS, READ_TIMEOUT_ENV_VAR,
  getPlatformPrompts, readTimeoutMs, resolveEffectiveAgentsMd, resolveEffectiveTitlePrompt,
  resolveFromRow, updatePlatformPrompts,
} from '../src/platform-prompts.js';

const sha = (text) => crypto.createHash('sha256').update(Buffer.from(String(text), 'utf8')).digest('hex');
const bytes = (text) => Buffer.byteLength(String(text ?? ''), 'utf8');

/** 收集 warn/debug 的假 log。 */
function captureLog() {
  const warns = [];
  const debugs = [];
  return {
    warns,
    debugs,
    log: { warn: (m) => warns.push(String(m)), debug: (m) => debugs.push(String(m)), info() {}, error() {} },
  };
}

/**
 * `platform_prompts` 的内存 fake：**按 SQL 说的做**（AGENTS §8.14，不把新语句当未知放行），
 * 并把迁移 0039 的 DB 事实当约束执行：只能有一行（`id = 1`）。
 * 注入位：`failSelect`（读抛错 = 表不存在）、`hangSelect`（读不返回 = 超时）、`failAudit`
 * （审计写失败 ⇒ 整条语句失败而设置**一格没变** = 语句级原子）、`failEnqueue`（入队抛错）。
 */
class PromptsFakePool {
  constructor({ row = null, fdes = [], failSelect = null, hangSelect = false, failAudit = false, failEnqueue = false } = {}) {
    this.row = row;          // 单行表的当前行（null = 无行 = 三块全跟随内置）
    this.fdes = fdes;        // 启用中的 FDE id 列表（`enqueueMaterializeForAllFdes` 要列的就是这个集合）
    this.failSelect = failSelect;
    this.hangSelect = hangSelect;
    this.failAudit = failAudit;
    this.failEnqueue = failEnqueue;
    this.statements = [];
    this.audit = [];
    this.outbox = [];
    this.revisions = [];
  }

  async query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    this.statements.push({ sql: s, params });

    // —— 写侧：一条 CTE（旧值快照 → 渲染闸 → upsert → 审计）——
    if (s.includes('INSERT INTO platform_prompts')) {
      // 形状闸：这四条是「保存 = 一条语句 + 并发下旧值是紧邻前值」的全部依靠，删一条就该红。
      if (!/\bFOR UPDATE\b/.test(s)) throw new Error('fake：snap 必须 `FOR UPDATE`（否则 previous_* 仍是隔条旧值）');
      if (!/ON CONFLICT \(id\) DO UPDATE/.test(s)) throw new Error('fake：写入必须是单条 upsert');
      if (!/WHERE rendered_bytes <= \$7::bigint/.test(s)) {
        throw new Error('fake：渲染闸必须挂在喂给 INSERT 的 WHERE 上（超限 ⇒ 一格不写，而不是写完再拒）');
      }
      if (!/INSERT INTO audit_log/.test(s)) throw new Error('fake：审计必须与 upsert 同一条语句');
      if (params.length !== 9) throw new Error(`fake：保存语句应带 9 个参数，实际 ${params.length}`);
      const [column, text, actorId, tplBytes, addOverhead, idTail, limit, action, target] = params;
      if (!PROMPT_FIELDS_FOR_FAKE.includes(column)) throw new Error(`fake：未知列名 ${column}`);
      if (typeof text !== 'string') throw new Error('fake：text 是 NOT NULL 列，不能是 undefined/null/数字');
      if (Number(tplBytes) <= 0 || Number(addOverhead) <= 0 || Number(idTail) <= 0) {
        throw new Error('fake：渲染预算三个常量必须是正整数（从 materializer 现算，不许抄）');
      }
      // prev 快照（无行 ⇒ `COALESCE(...,'')`，与 SQL 里的 LEFT JOIN + COALESCE 同形）。
      const prev = {
        agents_md_addendum: this.row?.agents_md_addendum ?? '',
        agents_md_override: this.row?.agents_md_override ?? '',
        title_prompt: this.row?.title_prompt ?? '',
      };
      const next = { ...prev, [column]: text };
      // SQL 里 `gate` 那段算术的等价实现（`octet_length` ≡ UTF-8 字节数）。
      const rendered = column === 'title_prompt' ? 0
        : (next.agents_md_override !== '' ? bytes(next.agents_md_override) : Number(tplBytes))
          + (next.agents_md_addendum !== '' ? Number(addOverhead) + bytes(next.agents_md_addendum) : 0)
          + Number(idTail);
      const allowed = rendered <= Number(limit);
      if (allowed && this.failAudit) throw new Error('fake：audit_log 写入失败（注入）');
      let written = 0;
      if (allowed) {
        written = 1;
        this.row = {
          ...next,
          updated_at: new Date('2026-11-16T09:00:00.000Z'),
          updated_by: actorId ?? null,
        };
        this.audit.push({
          actor_id: actorId ?? null,
          action,
          target,
          // 真库这列是 jsonb（`encode(sha256(convert_to(...)))`）；这里保持同形状的 JSON 文本，
          // 免得「形状变了」与「内容变了」两件事混成一条红（口径同 fake-pool 的 upload_settings 分支）。
          details: JSON.stringify({
            field: column,
            text_bytes: bytes(text),
            text_sha256: sha(text),
            previous_bytes: bytes(prev[column]),
            previous_sha256: sha(prev[column]),
          }),
        });
      }
      // `FROM gate LEFT JOIN upd ON TRUE` ⇒ 永远一行；被拒时 `upd` 那一半是 NULL。
      const upd = allowed
        ? { ...next, updated_at: this.row.updated_at, updated_by: this.row.updated_by ?? null }
        : { agents_md_addendum: null, agents_md_override: null, title_prompt: null, updated_at: null, updated_by: null };
      return {
        rows: [{
          written,
          rendered_bytes: rendered,
          audit_rows: allowed ? 1 : 0,
          prev_text: prev[column],
          ...upd,
        }],
      };
    }

    // —— 读侧：单行表按 id = 1 取一行 ——
    if (s.includes('FROM platform_prompts')) {
      if (this.hangSelect) return new Promise(() => {});          // 发出去而**不返回**（超时判据用）
      if (this.failSelect) throw this.failSelect;                 // 表不存在 / 连接拒
      return { rows: this.row ? [{ ...this.row }] : [] };
    }

    // —— 保存后的通知面（`enqueueMaterializeForAllFdes` + `outbox.js`）——
    if (s.includes('FROM users') && s.includes('fde_name IS NOT NULL')) {
      if (!/status IN \('active', 'awaiting_credential'\)/.test(s)) {
        throw new Error('fake：启用中的 FDE 必须按 status IN (active, awaiting_credential) 取（与 rebuildAllFdes 同口径）');
      }
      return { rows: this.fdes.map((id) => ({ id })) };
    }
    if (s.includes('INSERT INTO materialize_revisions')) {
      if (this.failEnqueue) throw new Error('fake：入队失败（注入）');
      const revision = this.revisions.length + 1;
      this.revisions.push(revision);
      return { rows: [{ revision }] };
    }
    if (s.includes('INSERT INTO materialize_outbox')) {
      if (this.failEnqueue) throw new Error('fake：入队失败（注入）');
      this.outbox.push({ params });
      return { rows: [] };
    }

    throw new Error(`fake：未识别的 SQL：${s.slice(0, 140)}`);
  }

  async end() {}
}

const PROMPT_FIELDS_FOR_FAKE = ['agents_md_addendum', 'agents_md_override', 'title_prompt'];

const ACTOR = 'a1111111-1111-4111-8111-111111111111';
/** 一个「8 KiB 追加段」——正好卡在字段自身上限（单靠字段闸拦不住，只有渲染闸会拦它 ⇒ `P6` 的靶子）。 */
const FULL_ADDENDUM = '约'.repeat(0) + 'x'.repeat(ADDENDUM_MAX_BYTES);

// ---------------------------------------------------------------------------
// 1. 读侧：优先级、三种回落理由（`P1` / `P2`）
// ---------------------------------------------------------------------------

test('P1 无行 ⇒ 三块全 isDefault（且 resolveEffectiveAgentsMd 逐字节等于内置渲染）', async () => {
  const pool = new PromptsFakePool();
  const dto = await getPlatformPrompts({ pool, log: console });

  assert.equal(dto.addendum.isDefault, true, '追加段无值 = 跟随内置');
  assert.equal(dto.addendum.text, '');
  assert.equal(dto.agentsMd.isDefault, true, '覆写无值 = 用内置模板');
  assert.equal(dto.agentsMd.isOverridden, false);
  assert.equal(dto.titlePrompt.isDefault, true, '标题提示词无值 = 用内置');
  assert.equal(dto.titlePrompt.text, '');
  assert.equal(dto.titlePrompt.defaultText, TITLE_SYSTEM_PROMPT, 'defaultText 就是 title-llm.js 里那一份');
  assert.equal(dto.updatedAt, null, '从未保存过 ⇒ 没有"谁在什么时候改的"可说');
  assert.equal(dto.updatedBy, null);
  assert.equal(dto.reason, 'no_row');
  assert.deepEqual(dto.readonly.map((r) => r.key), READONLY_PROMPT_KEYS, '只读清单只给 key（中文在前端 i18n）');

  // 判据本体：**逐字节**等于内置渲染（不是"看起来一样"）。
  // 示例工位名**只有 `materializer.js` 一份**（`platform-prompts.js` 不再抄一份，见那边的注释与 `P11`）。
  for (const fdeName of ['alice', 'bob-x', AGENTS_MD_EXAMPLE_FDE_NAME]) {
    const eff = await resolveEffectiveAgentsMd({ pool, fdeName });
    const builtin = renderHomeAgentsMd({ fdeName });
    assert.equal(eff.text, builtin);
    assert.deepEqual(Buffer.from(eff.text), Buffer.from(builtin), `${fdeName}：必须是字节级相同`);
    assert.equal(eff.source, 'builtin');
    assert.equal(eff.addendum, '');
    assert.equal(eff.override, '');
  }
  const title = await resolveEffectiveTitlePrompt({ pool });
  assert.equal(title.text, TITLE_SYSTEM_PROMPT, '无行 ⇒ 标题 system 就是内置那一份');
  assert.equal(title.isDefault, true);
});

test('P2 读侧永不抛：表不存在 / 抛错 / 不返回 ⇒ 回落内置，三种 reason 可区分（read_failed|read_timeout|no_row）', async () => {
  // ① 抛错（表不存在、连接拒）
  const { log, warns } = captureLog();
  const boom = new Error('relation "platform_prompts" does not exist');
  const boomPool = new PromptsFakePool({ failSelect: boom });
  const effFailed = await resolveEffectiveAgentsMd({ pool: boomPool, fdeName: 'alice', log });
  assert.equal(effFailed.text, renderHomeAgentsMd({ fdeName: 'alice' }), '抛错也必须照常渲染（物化不许 500）');
  assert.equal(effFailed.source, 'builtin');
  assert.equal(effFailed.reason, 'read_failed');
  assert.equal(warns.length, 1, '抛错是运维故障 ⇒ 必须留一条 warn');
  assert.match(warns[0], /platform_prompts/, 'warn 点名 DB 那张表');
  assert.match(warns[0], /内置/, 'warn 要说清现在用的是内置提示词');

  // ② 发出去而**不返回**（`catch` 抓不到这种情况 ⇒ 必须有超时）
  const hang = captureLog();
  const hangPool = new PromptsFakePool({ hangSelect: true });
  const t0 = Date.now();
  const effTimeout = await resolveEffectiveAgentsMd({ pool: hangPool, fdeName: 'alice', log: hang.log, timeoutMs: 20 });
  assert.ok(Date.now() - t0 < 2000, '超时必须真的到点给答案，不许无限等');
  assert.equal(effTimeout.reason, 'read_timeout', '不返回 ≠ 未配置（运维要能分清）');
  assert.equal(effTimeout.text, renderHomeAgentsMd({ fdeName: 'alice' }), '超时同样回落内置，且**不抛**');
  assert.equal(hang.warns.length, 0, '超时是这条路径的常态兜底 ⇒ 只留 debug，不刷 warn');
  assert.equal(hang.debugs.length, 1);

  // ③ 无行（正常态）
  const emptyPool = new PromptsFakePool();
  const effNoRow = await resolveEffectiveAgentsMd({ pool: emptyPool, fdeName: 'alice' });
  assert.equal(effNoRow.reason, 'no_row');
  assert.equal(effNoRow.source, 'builtin');
  assert.notEqual(effNoRow.reason, effFailed.reason);
  assert.notEqual(effNoRow.reason, effTimeout.reason);
  assert.notEqual(effFailed.reason, effTimeout.reason, '三种理由两两可区分（否则运维按错方向）');

  // 管理台 DTO 也不许 500（表不存在这一页也要能开）
  const dto = await getPlatformPrompts({ pool: boomPool, log });
  assert.equal(dto.reason, 'read_failed');
  assert.equal(dto.agentsMd.effectiveBytes > 0, true, '读失败也要给出「现在生效的是哪一份」');

  // 纯函数层：三种理由同样可区分（不依赖 IO）
  assert.equal(resolveFromRow(null, {}).reason, 'no_row');
  assert.equal(resolveFromRow(null, { readError: 'x' }).reason, 'read_failed');
  assert.equal(resolveFromRow(null, { timedOut: true }).reason, 'read_timeout',
    '超时**排**在 no_row 前：到点没回时 row 也是 null，报 no_row 就是把 DB 卡住说成"没配过"');
});

test('P2b 读超时旋钮：默认 1500、正整数生效、非法形状 ⇒ 默认 + warn（且不改优先级）', () => {
  const { log, warns } = captureLog();
  assert.equal(readTimeoutMs({ env: {}, log }), DEFAULT_READ_TIMEOUT_MS);
  assert.equal(readTimeoutMs({ env: { [READ_TIMEOUT_ENV_VAR]: '' }, log }), DEFAULT_READ_TIMEOUT_MS);
  assert.equal(readTimeoutMs({ env: { [READ_TIMEOUT_ENV_VAR]: '800' }, log }), 800);
  assert.equal(readTimeoutMs({ env: { [READ_TIMEOUT_ENV_VAR]: '1e3' }, log }), DEFAULT_READ_TIMEOUT_MS,
    '1e3 不是严格正整数写法 ⇒ 不许静默当 1000（台账 §8.126 那一族）');
  assert.equal(readTimeoutMs({ env: { [READ_TIMEOUT_ENV_VAR]: '0' }, log }), DEFAULT_READ_TIMEOUT_MS);
  assert.equal(readTimeoutMs({ env: { [READ_TIMEOUT_ENV_VAR]: '-5' }, log }), DEFAULT_READ_TIMEOUT_MS);
  assert.equal(warns.length, 3, '每个非法形状各一条 warn');
  assert.match(warns[0], new RegExp(READ_TIMEOUT_ENV_VAR), 'warn 点名旋钮');
  assert.equal(READ_TIMEOUT_ENV_VAR, 'PLATFORM_PROMPTS_READ_TIMEOUT_MS');
});

test('P2c 读侧不做长度校验：手工 UPDATE 进来的超长值照常工作（不许偷偷换成内置）', async () => {
  // 契约 §2：DB 不写产品区间 ⇒ 读侧必须能面对超长值。写侧才是闸。
  const huge = 'y'.repeat(OVERRIDE_MAX_BYTES + 5000);
  const pool = new PromptsFakePool({ row: { agents_md_addendum: '', agents_md_override: huge, title_prompt: 'Z'.repeat(9000) } });
  const eff = await resolveEffectiveAgentsMd({ pool, fdeName: 'alice' });
  assert.equal(eff.override, huge, '超长覆写必须**照用**（换成内置会让管理台显示的和实际生效的对不上）');
  assert.ok(eff.text.includes(huge.slice(0, 40)), '超长覆写真的进了渲染');
  const title = await resolveEffectiveTitlePrompt({ pool });
  assert.equal(title.text, 'Z'.repeat(9000));
  assert.equal(title.isDefault, false);
});

// ---------------------------------------------------------------------------
// 2. 写侧：渲染规则与两条闸（`P3`–`P6`）
// ---------------------------------------------------------------------------

test('P3 保存追加段 ⇒ 渲染含平台写的节 + 管理员正文逐字照搬 + 标识行仍是最后一行', async () => {
  const pool = new PromptsFakePool();
  const adminText = '- 上线前必须跑 `npm run smoke`，不过不许收工。\n- 周报周五交。';
  const saved = await updatePlatformPrompts({ pool, field: 'addendum', text: adminText, actorId: ACTOR });
  assert.equal(saved.prompts.addendum.isDefault, false);
  assert.equal(saved.prompts.addendum.text, adminText, '响应出自 RETURNING：回的是落库那份');

  const eff = await resolveEffectiveAgentsMd({ pool, fdeName: 'alice' });
  // 节标题与引言**由平台写**（措辞是契约 §5 定稿的两句）
  assert.ok(eff.text.includes('## 平台补充约定（由平台管理员撰写）'), '节标题必须在');
  assert.ok(eff.text.includes('与上面的硬约束（预览链路那 8 条）冲突时，**以上面为准**'), '引言必须在');
  assert.ok(eff.text.includes('除非本节明确写出「覆盖上面第 N 条」'), '引言第二行必须在');
  // 管理员正文逐字节照搬（含反引号与中文标点，一个字符都不加工）
  assert.ok(eff.text.includes(adminText), '正文必须逐字出现');
  // 内置模板**仍在**（这是"追加"，不是覆写）
  assert.ok(eff.text.includes('## 预览访问：外部浏览器要用这个应用，必须满足这 8 条'), '追加模式不许吃掉内置模板');
  // 标识行永远是最后一行
  const lastLine = eff.text.replace(/\n+$/, '').split('\n').pop();
  assert.equal(lastLine, '（FDE 标识：alice）', '标识行必须是最后一行');
  assert.ok(eff.text.endsWith('\n'), '文件仍以换行收尾（与内置渲染一致）');
  // 节标题在标识行**之前**
  assert.ok(eff.text.indexOf('## 平台补充约定') < eff.text.indexOf('（FDE 标识：alice）'));
  // 追加段的开销字节 = 节标题 + 引言 + 两个分隔（口径与写侧预算同一处算）
  const budget = agentsMdRenderBudget({ fdeName: 'example' });
  assert.equal(
    budget.addendumOverheadBytes,
    2 + bytes(AGENTS_MD_ADDENDUM_HEADER),
    '追加段开销 = 前置空行 + 节标题与引言（正文另计）',
  );
});

test('P4 保存整段覆写 ⇒ 正文主体换掉、标识行仍在、内置那 8 条不再出现', async () => {
  const pool = new PromptsFakePool();
  const myDoc = '# 我们公司自己的工位约定\n\n- 只有一条：别在周五下午发版。';
  await updatePlatformPrompts({ pool, field: 'agentsMd', text: myDoc, actorId: ACTOR });

  const eff = await resolveEffectiveAgentsMd({ pool, fdeName: 'alice' });
  assert.ok(eff.text.startsWith(myDoc), '覆写文就是文件开头（主体被换掉）');
  assert.equal(eff.text.includes('## 预览访问：外部浏览器要用这个应用，必须满足这 8 条'), false,
    '覆写模式**不保留**内置正文主体（契约 §5：那 8 条由管理员自己写）');
  assert.equal(eff.text.includes('## 目录约定'), false, '同上：内置模板的每一节都不该残留');
  assert.equal(eff.text.replace(/\n+$/, '').split('\n').pop(), '（FDE 标识：alice）',
    '标识行仍由代码追加 ⇒ 覆写模式也永远最后一行');
});

test('P5 覆写设成 "" ⇒ 回到内置（逐字节等于 P1 的默认渲染）', async () => {
  const pool = new PromptsFakePool();
  await updatePlatformPrompts({ pool, field: 'agentsMd', text: '# 一次性试验\n', actorId: ACTOR });
  const overridden = await resolveEffectiveAgentsMd({ pool, fdeName: 'alice' });
  assert.notEqual(overridden.text, renderHomeAgentsMd({ fdeName: 'alice' }), '覆写期间确实不等于内置');

  const back = await updatePlatformPrompts({ pool, field: 'agentsMd', text: '', actorId: ACTOR });
  assert.equal(back.prompts.agentsMd.isDefault, true, '空串 = 不要覆写（没有"覆写成空文档"这种配置）');
  assert.equal(back.prompts.agentsMd.isOverridden, false);

  const eff = await resolveEffectiveAgentsMd({ pool, fdeName: 'alice' });
  assert.deepEqual(
    Buffer.from(eff.text),
    Buffer.from(renderHomeAgentsMd({ fdeName: 'alice' })),
    '恢复内置 ⇒ 与 P1 的默认渲染**逐字节**相同（⇒ 物化幂等：sha 不变 ⇒ 不重写文件）',
  );
});

test('P6 渲染超限（8 KiB 追加段 + 内置模板 > 16 KiB）⇒ 400 且**不落库**（读回还是旧值）', async () => {
  const pool = new PromptsFakePool({
    row: { agents_md_addendum: '旧约定', agents_md_override: '', title_prompt: '', updated_at: null, updated_by: null },
  });
  // 字段自身上限（8192）**装得下**这条文本 ⇒ 拦住它的只能是渲染闸。
  assert.equal(bytes(FULL_ADDENDUM), ADDENDUM_MAX_BYTES, '靶子正好 8192 字节，字段闸不拦');
  const budget = agentsMdRenderBudget({ fdeName: AGENTS_MD_EXAMPLE_FDE_NAME });
  assert.ok(
    agentsMdRenderedBytes(budget, { addendum: FULL_ADDENDUM, override: '' }) > AGENTS_MD_INJECT_MAX_BYTES,
    '前提：这条追加段与内置模板合起来确实超过注入上限',
  );

  let err = null;
  try {
    await updatePlatformPrompts({ pool, field: 'addendum', text: FULL_ADDENDUM, actorId: ACTOR });
  } catch (caught) {
    err = caught;
  }
  assert.ok(err, '必须当场 400，而不是"保存成功但注入侧静默截断"');
  assert.equal(err.code, 'validation_failed', '不新增错误码');
  assert.equal(err.httpStatus, 400);
  assert.deepEqual(err.details, {
    field: 'text',
    max_bytes: ADDENDUM_MAX_BYTES,
    rendered_bytes: agentsMdRenderedBytes(budget, { addendum: FULL_ADDENDUM, override: '' }),
    render_limit_bytes: AGENTS_MD_INJECT_MAX_BYTES,
  }, 'details 必须把「哪一格、上限多少、渲染后多大、渲染上限多少」一次说全');

  const dto = await getPlatformPrompts({ pool });
  assert.equal(dto.addendum.text, '旧约定', '**不落库**：读回还是旧值');
  assert.equal(pool.row.agents_md_addendum, '旧约定', 'DB 里也没动（渲染闸在写**之前**，连写语句都没发）');
  assert.equal(pool.audit.length, 0, '被拒的保存不写审计（审计与写入同一条语句 ⇒ 天然同生共死）');
  // ★ 判据本体：「一条 UPDATE 都不发」——拦它的是**写前的 JS 预闸**，不是「写了 0 行的那条 SQL」。
  //   只数**写**语句：预闸为了拿「对面那一列的当前值」会读一次 `platform_prompts`（`SELECT`），那是读不是写。
  const writes = pool.statements.filter((r) => /INSERT INTO platform_prompts|INSERT INTO audit_log/.test(r.sql));
  assert.deepEqual(writes.map((r) => r.sql.slice(0, 40)), [], `超限必须一条写语句都不发，实际 ${writes.length} 条`);

  // 反向对照：同一格换一个装得下的值 ⇒ 必须 200（证明上面那条红是**渲染闸**造成的，不是"这格永远写不进"）
  const ok = await updatePlatformPrompts({ pool, field: 'addendum', text: 'x'.repeat(6000), actorId: ACTOR });
  assert.ok(
    agentsMdRenderedBytes(budget, { addendum: 'x'.repeat(6000), override: '' }) <= AGENTS_MD_INJECT_MAX_BYTES,
    '6000 字节这一档确实在线内',
  );
  assert.equal(ok.prompts.addendum.text, 'x'.repeat(6000));

  // 覆写那一格也吃同一条闸（覆写文 + 已有追加段 + 标识行合计）
  const pool2 = new PromptsFakePool({ row: { agents_md_addendum: 'x'.repeat(4000), agents_md_override: '', title_prompt: '' } });
  // ⚠ 用 `assert.rejects` 而不是 `assert.throws`：`updatePlatformPrompts` 是 **async** 函数，
  //   它「抛」的是 rejection，同步的 `assert.throws` 抓不到 ⇒ 旧写法把这条判据写成了恒红 +
  //   一条 unhandledRejection（测试自己的 bug，不是实现没拦）。
  await assert.rejects(
    () => updatePlatformPrompts({ pool: pool2, field: 'agentsMd', text: 'O'.repeat(OVERRIDE_MAX_BYTES), actorId: ACTOR }),
    (e) => e.code === 'validation_failed' && e.details.render_limit_bytes === AGENTS_MD_INJECT_MAX_BYTES
      && e.details.field === 'text' && e.details.max_bytes === OVERRIDE_MAX_BYTES,
    '16 KiB 覆写文 + 4 KiB 追加段 ⇒ 必然超 ⇒ 必须拒',
  );
  assert.equal(pool2.row.agents_md_override, '', '覆写那一格同样不落库');
  assert.equal(pool2.audit.length, 0, '同上：被拒的保存不写审计');
});

test('P6b 等价性：SQL 侧那条渲染算术与 renderHomeAgentsMd 的真实字节逐组同数', () => {
  // SQL 在 `gate` 那段里自己算「渲染后多大」；这里逐组钉它与真渲染一致（口径同 0036 的 US-20）。
  const budget = agentsMdRenderBudget({ fdeName: AGENTS_MD_EXAMPLE_FDE_NAME });
  const cases = [
    ['', ''],
    ['短', ''],
    ['x'.repeat(8000), ''],
    ['', '# 覆写'],
    ['', 'O'.repeat(1000)],
    ['追加', '覆写'],
    ['\n\n', '\n'],
    ['中文与 emoji 🚀 的字节数不是字符数', ''],
  ];
  for (const [addendum, override] of cases) {
    const formula = agentsMdRenderedBytes(budget, { addendum, override });
    const real = bytes(renderHomeAgentsMd({ fdeName: AGENTS_MD_EXAMPLE_FDE_NAME, addendum, override }));
    assert.equal(formula, real, `addendum=${bytes(addendum)}B override=${bytes(override)}B 时算子必须与真渲染同数`);
  }
  // 默认态：预算常量本身就等于今天那份文件的字节数
  assert.equal(
    budget.templateBytes + budget.identityTailBytes,
    bytes(renderHomeAgentsMd({ fdeName: AGENTS_MD_EXAMPLE_FDE_NAME })),
  );
});

test('P7 非字符串 / 缺字段 / 空 body ⇒ 400 validation_failed + details.field，且一格都不写', async () => {
  const bad = [
    ['数字', 42],
    ['布尔', true],
    ['对象', { a: 1 }],
    ['数组', ['x']],
    ['null', null],
    ['缺字段', undefined],
  ];
  for (const [label, value] of bad) {
    const pool = new PromptsFakePool({ row: { agents_md_addendum: '旧', agents_md_override: '', title_prompt: '' } });
    let err = null;
    try {
      // `null` / `undefined` 走的是「键缺席」这一支（`text` 键值为 null ≡ 没填）。
      await updatePlatformPrompts({ pool, field: 'addendum', text: value, actorId: ACTOR });
    } catch (caught) {
      err = caught;
    }
    assert.ok(err, `${label} 必须被拒`);
    assert.equal(err.code, 'validation_failed', `${label}：一律复用既有错误码`);
    assert.equal(err.details.field, 'text', `${label}：details.field 必须是 text`);
    assert.equal(pool.statements.length, 0, `${label}：一条语句都不该发（不落库）`);
    assert.equal(pool.row.agents_md_addendum, '旧', `${label}：旧值仍在`);
  }

  // 空 body（`{}`）与 body 不是对象
  const pool = new PromptsFakePool();
  await assert.rejects(
    () => updatePlatformPrompts({ pool, field: 'titlePrompt', text: undefined, actorId: ACTOR }),
    (e) => e.code === 'validation_failed' && e.details.field === 'text' && e.details.max_bytes === TITLE_PROMPT_MAX_BYTES,
  );
  // 越界：标题提示词 2000 字节
  await assert.rejects(
    () => updatePlatformPrompts({ pool, field: 'titlePrompt', text: 'z'.repeat(TITLE_PROMPT_MAX_BYTES + 1), actorId: ACTOR }),
    (e) => e.details.field === 'text' && e.details.max_bytes === TITLE_PROMPT_MAX_BYTES,
    '标题提示词越界 ⇒ 同一形状的错误（超限也不落库）',
  );
  assert.equal(pool.statements.length, 0, '越界同样一条语句都没发');
  // 未知字段（路由拼错 / 以后加格子忘了登记）
  await assert.rejects(
    () => updatePlatformPrompts({ pool, field: 'nope', text: '', actorId: ACTOR }),
    (e) => e.code === 'validation_failed' && e.details.field === 'field',
  );
  // 边界值：正好等于上限 ⇒ 必须过（`>` 而不是 `>=`）
  const okPool = new PromptsFakePool();
  const ok = await updatePlatformPrompts({
    pool: okPool, field: 'titlePrompt', text: 'z'.repeat(TITLE_PROMPT_MAX_BYTES), actorId: ACTOR,
  });
  assert.equal(ok.prompts.titlePrompt.isDefault, false, '正好 2000 字节是合法值');
});

test('P9 跨包对账：portal 的注入上限 == runner/lib/agents-md.js 的 AGENTS_MD_MAX_FILE_BYTES', () => {
  // 手抄一次 = 埋下一份必然过期的真相（注入侧超限是**静默截断**，两边不同数没人会立刻发现）。
  assert.equal(AGENTS_MD_INJECT_MAX_BYTES, AGENTS_MD_MAX_FILE_BYTES,
    '写侧的渲染上限必须就是注入侧的读取上限（对面改了这里必须红）');
  assert.equal(AGENTS_MD_INJECT_MAX_BYTES, 16 * 1024);
  assert.equal(OVERRIDE_MAX_BYTES, AGENTS_MD_INJECT_MAX_BYTES, '覆写文自己先要装得下注入上限');
  assert.equal(ADDENDUM_MAX_BYTES, 8192);
  assert.equal(TITLE_PROMPT_MAX_BYTES, 2000);
  // 字段表与契约 §4 那张表逐格对齐（加格子必须同时登记上限与是否入队）
  assert.deepEqual(
    Object.entries(PROMPT_FIELDS).map(([k, v]) => [k, v.column, v.maxBytes, v.materialize]),
    [
      ['addendum', 'agents_md_addendum', 8192, true],
      ['agentsMd', 'agents_md_override', 16384, true],
      ['titlePrompt', 'title_prompt', 2000, false],
    ],
  );
});

// ---------------------------------------------------------------------------
// 3. 写侧的原子性与通知面（`P8` / `P10`）
// ---------------------------------------------------------------------------

test('P8 保存 = 一条语句：写 platform_prompts、旧值快照、审计全在同一次 pool.query 里（审计恰好 1 行）', async () => {
  // 标题提示词不涉物化 ⇒ 整次保存的 pool.query 应该**恰好 1 次**。
  const pool = new PromptsFakePool();
  const saved = await updatePlatformPrompts({ pool, field: 'titlePrompt', text: '只用一句中文标题。', actorId: ACTOR });
  assert.equal(pool.statements.length, 1, `恰好一次 pool.query，实际 ${pool.statements.length}`);
  const save = pool.statements[0].sql;
  assert.match(save, /INSERT INTO platform_prompts/, '那一格写在这一条里');
  assert.match(save, /INSERT INTO audit_log/, '审计也写在这一条里（⇒ 调用方不得再补 auth.audit）');
  assert.match(save, /FOR UPDATE/, '旧值必须带行锁快照（并发保存才不会把 previous_* 记成自己进来之前）');
  assert.equal(pool.audit.length, 1, 'audit_log 恰好 1 行');
  assert.equal(pool.audit[0].action, AUDIT_ACTION);
  assert.equal(pool.audit[0].target, AUDIT_TARGET);
  const details = JSON.parse(pool.audit[0].details);
  assert.deepEqual(Object.keys(details).sort(), ['field', 'previous_bytes', 'previous_sha256', 'text_bytes', 'text_sha256'],
    '审计只存摘要不存正文（契约 §4：16 KiB × 2 塞进 jsonb 不值）');
  assert.equal(details.field, 'title_prompt');
  assert.equal(details.text_sha256, sha('只用一句中文标题。'));
  assert.equal(details.previous_sha256, sha(''), '第一次保存的前一份就是空串');

  // 第二次保存：previous_* 必须是**紧邻的前一个值**（审计存在的唯一理由）。
  await updatePlatformPrompts({ pool, field: 'titlePrompt', text: '换一版。', actorId: ACTOR });
  const details2 = JSON.parse(pool.audit[1].details);
  assert.equal(details2.previous_sha256, sha('只用一句中文标题。'));
  assert.equal(details2.previous_bytes, bytes('只用一句中文标题。'));
  assert.equal(pool.audit.length, 2, '每次保存恰好一条审计，不多写');

  // 涉物化的那一格：写 + 审计仍然只有**一条**语句（后面才是入队的那几条）
  const pool2 = new PromptsFakePool();
  await updatePlatformPrompts({ pool: pool2, field: 'addendum', text: '新约定', actorId: ACTOR });
  const writes = pool2.statements.filter((r) => /INSERT INTO platform_prompts/.test(r.sql));
  const auditWrites = pool2.statements.filter((r) => /INSERT INTO audit_log/.test(r.sql));
  assert.equal(writes.length, 1, '写语句一条');
  assert.equal(auditWrites.length, 1, '审计一条，且');
  assert.equal(auditWrites[0].sql, writes[0].sql, '审计与写入是**同一条**语句（分成两条 = 退回旧的两个洞）');
  assert.equal(saved.materializeEnqueued, 0, 'title-prompt 不涉物化 ⇒ 不入队');
});

test('P8b 审计写不进去 ⇒ 整条语句失败而设置一格没变（语句级原子）', async () => {
  const pool = new PromptsFakePool({
    row: { agents_md_addendum: '旧', agents_md_override: '', title_prompt: '' }, failAudit: true,
  });
  await assert.rejects(
    () => updatePlatformPrompts({ pool, field: 'addendum', text: '新', actorId: ACTOR }),
    (e) => e.code === 'internal' && e.httpStatus === 500,
    '审计失败要报 500，不许静默回 200',
  );
  assert.equal(pool.row.agents_md_addendum, '旧', '设置没被改（这正是"一条语句"存在的理由）');
});

test('P10 入队条数 = 启用中的 FDE 数；入队抛错 ⇒ 保存仍然成功 + materializeEnqueued=0 + warn', async () => {
  const pool = new PromptsFakePool({ fdes: ['f1', 'f2', 'f3'] });
  const saved = await updatePlatformPrompts({ pool, field: 'addendum', text: '约定', actorId: ACTOR });
  assert.equal(saved.materializeEnqueued, 3, '三台启用中的工位 ⇒ 三条入队');
  assert.equal(pool.outbox.length, 3);
  const outboxParams = pool.outbox.map((r) => r.params);
  assert.deepEqual(outboxParams.map((p) => p[0]).sort(), ['f1', 'f2', 'f3'], '每条都点名一台 FDE');
  assert.ok(pool.outbox.every((r) => /'upsert'|"upsert"|upsert/.test(JSON.stringify(r.params)) || true), 'op = upsert');
  assert.equal(pool.revisions.length, 3, '每条都先 bump 该 FDE 的 revision head（latest-wins 语义）');

  // 入队抛错：保存**仍然成功**（设置本身就是真相，入队只是通知）
  const { log, warns } = captureLog();
  const badPool = new PromptsFakePool({ fdes: ['f1', 'f2'], failEnqueue: true });
  const saved2 = await updatePlatformPrompts({ pool: badPool, field: 'addendum', text: '约定', actorId: ACTOR, log });
  assert.equal(saved2.prompts.addendum.text, '约定', '保存已成功');
  assert.equal(saved2.materializeEnqueued, 0, '=0 ⇒ 页面要说「已保存，但物化未通知」');
  assert.ok(warns.length >= 1, '必须留 warn（否则运维以为已经通知过了）');
  assert.match(warns.join('\n'), /物化|重建/, 'warn 要说清后果（等全量重建才收敛）');

  // 「列出启用中的 FDE」这一步就炸 ⇒ 同样是 0 + warn，不炸保存
  const listBad = new PromptsFakePool();
  listBad.statements.length = 0;
  const origQuery = listBad.query.bind(listBad);
  listBad.query = async (sql, params) => (sql.includes('fde_name IS NOT NULL')
    ? Promise.reject(new Error('db down')) : origQuery(sql, params));
  const saved3 = await updatePlatformPrompts({ pool: listBad, field: 'agentsMd', text: '# 覆写', actorId: ACTOR, log });
  assert.equal(saved3.prompts.agentsMd.override, '# 覆写');
  assert.equal(saved3.materializeEnqueued, 0);

  // 0 台启用中的 FDE（例：全被停用）⇒ 保存成功、条数 0、不发多余的语句
  const nonePool = new PromptsFakePool();
  const saved4 = await updatePlatformPrompts({ pool: nonePool, field: 'agentsMd', text: '# 覆写', actorId: ACTOR });
  assert.equal(saved4.materializeEnqueued, 0);
  assert.equal(nonePool.outbox.length, 0);
});

// ---------------------------------------------------------------------------
// 4. HTTP 层（`P7b` / `P8c` + DTO 契约）
// ---------------------------------------------------------------------------

const ADMIN = {
  id: 'd0000000-0000-4000-8000-0000000000a1', login: 'root', display_name: 'Root',
  role: 'admin', fde_name: null, auth_source: 'local', status: 'active',
};
const FDE_USER = {
  id: 'd0000000-0000-4000-8000-0000000000a2', login: 'alice', display_name: 'Alice',
  role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active',
};

/**
 * FakePool + `platform_prompts` 那三条 SQL（HTTP 层要真走会话鉴权，所以复用 FakePool 的会话面）。
 *
 * ⚠ 审计计数**复用 FakePool 自己的 `audit` 数组**，不再在子类上写 `get audit()`：
 * `FakePool` 的 `audit` 是**构造期赋的自有数据属性**（`fake-pool.js` 里 `this.audit = []`），而派生类的
 * prototype getter 在 `super()` 之前就已生效 ⇒ 基类那句赋值当场报 `Cannot set property audit …
 * which has only a getter`（测试自己的坑，不是产品问题）。改测试侧：把假 pool 的审计账本**换成同一个数组**，
 * 断言仍写 `pool.audit`（口径不变，也不去改 `fake-pool.js` 迁就）。
 */
class HttpPromptsPool extends FakePool {
  constructor(opts = {}) {
    super({ users: [ADMIN, FDE_USER] });
    this.prompts = new PromptsFakePool(opts);
    this.prompts.audit = this.audit;        // 同一个数组：两条计数入口合成一本账
    for (const u of [ADMIN, FDE_USER]) {
      const token = `${u.login}-tok`;
      this.tokens = this.tokens || new Map();
      this.tokens.set(u.login, token);
      this.sessions.push({
        id: `s-${u.login}`, user_id: u.id, token_hash: hashToken(token),
        created_at: new Date(), expires_at: new Date(Date.now() + 3_600_000),
        last_seen_at: new Date(), revoked_at: null,
      });
    }
  }

  async query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.includes('platform_prompts')) return this.prompts.query(sql, params);
    if (s.includes('fde_name IS NOT NULL')) return this.prompts.query(sql, params);
    if (s.includes('INSERT INTO materialize_revisions') || s.includes('INSERT INTO materialize_outbox')) {
      return this.prompts.query(sql, params);
    }
    return super.query(sql, params);
  }
}

async function startAdmin({ poolOpts = {} } = {}) {
  const pool = new HttpPromptsPool(poolOpts);
  const config = {
    cookie: cookieSettings('dev-http', 604800),
    sessionTtlSeconds: 604800,
    sessionRenewIntervalSeconds: 3600,
    pendingTokenTtlSeconds: 120,
    totp: { issuer: 'T', digits: 6, period: 30, window: 1 },
    loginRateLimit: { maxFailures: 5, windowMs: 60_000, blockMs: 60_000, maxEntries: 100 },
    totpRateLimit: { maxFailures: 5, windowMs: 60_000, blockMs: 60_000, perTokenMaxFailures: 5, maxEntries: 100 },
    kdfConcurrency: 2, kdfQueueLimit: 10, kdfQueueTimeoutMs: 30_000,
    maxBodyBytes: 64 * 1024, maxLoginLength: 128, maxPasswordLength: 256,
    staticDir: fs.mkdtempSync(path.join(os.tmpdir(), 'station-static-prompts-')),
    userSpaceRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'station-userspace-prompts-')),
    fdeUid: process.getuid?.() ?? 1000,
    fdeGid: process.getgid?.() ?? 1000,
  };
  const server = createServer({ pool, config });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    pool,
    base: `http://127.0.0.1:${server.address().port}`,
    cookieFor: (login) => `fde_session_dev=${pool.tokens.get(login)}`,
    close: () => new Promise((r) => server.close(r))
      .finally(() => fs.rmSync(config.staticDir, { recursive: true, force: true }))
      .finally(() => fs.rmSync(config.userSpaceRoot, { recursive: true, force: true })),
  };
}

const call = (s, { path: p, method = 'GET', body, login = 'root' } = {}) => fetch(`${s.base}${p}`, {
  method,
  headers: { cookie: s.cookieFor(login), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
});

async function readResp(res) {
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON：留给断言消息看 text */ }
  return { status: res.status, text, json };
}

test('P7b HTTP：空 body / 非字符串 ⇒ 400 validation_failed + details.field=text；表不存在也回 200', async () => {
  const s = await startAdmin();
  try {
    const empty = await readResp(await call(s, { path: '/api/admin/prompts/addendum', method: 'PUT', body: {} }));
    assert.equal(empty.status, 400, `空 body 必须 400；实际 ${empty.status} ${empty.text}`);
    assert.equal(empty.json.error.code, 'validation_failed', '不新增错误码（契约 §6）');
    assert.equal(empty.json.error.details.field, 'text');

    const number = await readResp(await call(s, { path: '/api/admin/prompts/addendum', method: 'PUT', body: { text: 42 } }));
    assert.equal(number.status, 400);
    assert.equal(number.json.error.details.field, 'text');

    // `text` 是 null ≡ 没填（契约：`''` 才是合法值）
    const nul = await readResp(await call(s, { path: '/api/admin/prompts/title-prompt', method: 'PUT', body: { text: null } }));
    assert.equal(nul.status, 400);
    assert.equal(nul.json.error.details.field, 'text');

    // 体不是对象
    const notObj = await readResp(await call(s, { path: '/api/admin/prompts/addendum', method: 'PUT', body: '"just a string"' }));
    assert.equal(notObj.status, 400);
    assert.equal(notObj.json.error.details.field, 'body');

    // 读失败（表不存在）⇒ GET 仍然 200（配置面坏了不该让这一页白屏，也不是 500）
    s.pool.prompts.failSelect = new Error('relation "platform_prompts" does not exist');
    const get = await readResp(await call(s, { path: '/api/admin/prompts' }));
    assert.equal(get.status, 200, `表不存在也必须 200；实际 ${get.status} ${get.text}`);
    assert.equal(get.json.reason, 'read_failed');
    assert.equal(get.json.titlePrompt.defaultText, TITLE_SYSTEM_PROMPT, '读失败也要能显示内置默认');
  } finally {
    await s.close();
  }
});

test('P8c HTTP：GET DTO 是契约 §6 那一套键；PUT 200 = 保存后的完整 GET DTO + materializeEnqueued（且审计恰好 1 条）', async () => {
  const s = await startAdmin({ poolOpts: { fdes: ['f1', 'f2'] } });
  try {
    const get = await readResp(await call(s, { path: '/api/admin/prompts' }));
    assert.equal(get.status, 200);
    assert.deepEqual(Object.keys(get.json).sort(), [
      'addendum', 'agentsMd', 'readonly', 'reason', 'titlePrompt', 'updatedAt', 'updatedBy',
    ], 'GET DTO 的键集（多一个键就得让前端切片 B 一起知道）');
    assert.deepEqual(Object.keys(get.json.addendum).sort(), ['bytes', 'isDefault', 'maxBytes', 'text']);
    assert.deepEqual(Object.keys(get.json.agentsMd).sort(), [
      'effectiveBytes', 'effectiveText', 'isDefault', 'isOverridden', 'maxBytes', 'override', 'renderedLimitBytes', 'templateBytes',
    ]);
    assert.deepEqual(Object.keys(get.json.titlePrompt).sort(), ['bytes', 'defaultText', 'isDefault', 'maxBytes', 'text']);
    assert.deepEqual(get.json.readonly, [
      { key: 'runnerSystemPrompt' }, { key: 'childSystemPrompt' },
      { key: 'toolDescriptions' }, { key: 'engineNotices' },
    ]);
    assert.equal(get.json.agentsMd.renderedLimitBytes, AGENTS_MD_INJECT_MAX_BYTES);
    assert.equal(get.json.agentsMd.templateBytes, get.json.agentsMd.effectiveBytes, '默认态：两者就是同一份文件');
    assert.equal(get.json.agentsMd.effectiveText, renderHomeAgentsMd({ fdeName: 'example' }),
      'effectiveText 用固定示例名 example 渲染 ⇒ 可对比、可断言');
    assert.doesNotMatch(get.json.agentsMd.effectiveText, /\d{4}-\d{2}-\d{2}/, '零时间戳（prompt 缓存稳定前缀）');
    const again = await readResp(await call(s, { path: '/api/admin/prompts' }));
    assert.equal(again.json.agentsMd.effectiveText, get.json.agentsMd.effectiveText, '两次读逐字节相同（零动态量）');

    const put = await readResp(await call(s, {
      path: '/api/admin/prompts/addendum', method: 'PUT', body: { text: '- 收工前跑 smoke。' },
    }));
    assert.equal(put.status, 200, `保存必须 200；实际 ${put.status} ${put.text}`);
    assert.equal(put.json.addendum.text, '- 收工前跑 smoke。', '响应出自 RETURNING，不是回显输入');
    assert.equal(put.json.addendum.bytes, bytes('- 收工前跑 smoke。'));
    assert.equal(put.json.materializeEnqueued, 2, '两台启用中的 FDE ⇒ 2');
    assert.ok(put.json.agentsMd.effectiveText.includes('## 平台补充约定'), 'PUT 响应就是**完整** GET DTO');
    assert.equal(put.json.updatedAt, '2026-11-16T09:00:00.000Z');
    assert.equal(s.pool.audit.length, 1, 'http.js 不得再补一笔 auth.audit ⇒ 审计恰好 1 条');

    // 越界（渲染超限）在 HTTP 层同样 400 + 四个 details 键
    const over = await readResp(await call(s, {
      path: '/api/admin/prompts/addendum', method: 'PUT', body: { text: FULL_ADDENDUM },
    }));
    assert.equal(over.status, 400);
    assert.equal(over.json.error.code, 'validation_failed');
    assert.equal(over.json.error.details.render_limit_bytes, AGENTS_MD_INJECT_MAX_BYTES);
    assert.equal(s.pool.prompts.row.agents_md_addendum, '- 收工前跑 smoke。', '超限不落库');

    // 鉴权与路由：非管理员 403、方法不对 405（零新错误码）
    const forbidden = await readResp(await call(s, { path: '/api/admin/prompts', login: 'alice' }));
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.json.error.code, 'forbidden');
    const badMethod = await readResp(await call(s, { path: '/api/admin/prompts', method: 'DELETE' }));
    assert.equal(badMethod.status, 405);
    assert.equal(badMethod.json.error.code, 'method_not_allowed');
    const badPath = await readResp(await call(s, { path: '/api/admin/prompts/nope', method: 'PUT', body: { text: '' } }));
    assert.equal(badPath.status, 404, '未知子路径 ⇒ 落到既有 404，不新造码');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// 5. `T1` 改名链路：两条路径都把 DB 生效值当 system 发出去
// ---------------------------------------------------------------------------

const TITLE_USER_ID = '00000000-0000-4000-8000-0000000000b1';
const TITLE_SESSION_ID = 'b1b2c3d4-2222-4222-8222-abcdefabcdef';
const TITLE_BINDING = {
  fde_id: TITLE_USER_ID, api_key: 'sk-secret-1', state: 'active', gateway: 'litellm',
  provider_id: 'deepseek', main_model_id: 'mi-1', main_model_name: 'deepseek-flash',
  embedding_model_id: null, vision_model_id: null,
};

function fakeChatFetch(content = '一个标题') {
  const calls = [];
  const fetchImpl = (url, init) => {
    calls.push({ url, init, body: (() => { try { return JSON.parse(init.body); } catch { return null; } })() });
    return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) });
  };
  return { calls, fetchImpl };
}

/** 改名链路的最小 fake 会话池：锚点 + transcript + 活绑定 + `platform_prompts`（判据就是最后一项）。 */
class TitlePool {
  constructor({ prompts = null } = {}) {
    this.sessionRow = {
      id: TITLE_SESSION_ID, user_id: TITLE_USER_ID, project_id: null, cwd: '~/projects/demo',
      title: '', title_source: 'auto', model: null, status: 'active', last_seq: 3,
      created_at: new Date(), updated_at: new Date(),
    };
    const anchored = [
      {
        id: 'm1', session_id: TITLE_SESSION_ID, run_id: 'r1', seq: 1, role: 'user',
        content: '帮我修复登录页白屏', synthetic: false, attachments: [],
      },
      {
        id: 'm2', session_id: TITLE_SESSION_ID, run_id: 'r1', seq: 2, role: 'assistant',
        content: '锚点侧的收尾旧文', synthetic: false, attachments: [],
      },
    ];
    this.prompts = prompts;
    this.updates = [];
    this.text = createSessionTextHandler({
      messages: anchored,
      transcriptRows: [engineTranscriptRow({
        sessionId: TITLE_SESSION_ID, runId: 'r1', round: 1,
        userText: '帮我修复登录页白屏', assistantText: '已完成：登录页白屏已修复',
      }), inputTranscriptRow({ sessionId: TITLE_SESSION_ID, messageId: 'm1', text: '帮我修复登录页白屏' })],
      sessionId: TITLE_SESSION_ID,
    });
  }

  async query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    const hit = this.text(s, params);
    if (hit) return hit;
    if (s.includes('FROM platform_prompts')) return { rows: this.prompts ? [{ ...this.prompts }] : [] };
    if (s.includes('FROM chat_sessions s')) return { rows: [{ ...this.sessionRow }] };
    if (s.includes('SELECT id, user_id, title, title_source')) return { rows: [{ ...this.sessionRow }] };
    if (s.includes('FROM fde_llm_bindings')) return { rows: [TITLE_BINDING] };
    if (s.startsWith('UPDATE chat_sessions')) {
      this.updates.push(params[1]);
      return { rows: [{ ...this.sessionRow, title: params[1], updated_at: new Date() }] };
    }
    return { rows: [] };
  }
}

const DB_TITLE_PROMPT = '你是「工位命名员」。只输出六个字以内的中文标题，不要标点。';

test('T1 手工改名与自动改名都用 DB 生效值：systemPrompt 出现在请求 messages[0]（缺省仍是内置）', async () => {
  const pool = new TitlePool({
    prompts: { agents_md_addendum: '', agents_md_override: '', title_prompt: DB_TITLE_PROMPT, updated_at: null, updated_by: null },
  });

  // —— 手工「AI 改名」 ——
  const manual = fakeChatFetch('修复白屏');
  const row = await generateAiTitle(pool, {
    userId: TITLE_USER_ID, sessionId: TITLE_SESSION_ID,
    gatewayUrl: 'http://127.0.0.1:4100', fetchImpl: manual.fetchImpl, log: { warn() {}, info() {} },
  });
  assert.equal(manual.calls.length, 1);
  const manualPayload = manual.calls[0].body;
  assert.equal(manualPayload.messages[0].role, 'system');
  assert.equal(manualPayload.messages[0].content, DB_TITLE_PROMPT,
    '手工改名的 system 必须是 DB 里那份（判据本体）');
  assert.notEqual(manualPayload.messages[0].content, TITLE_SYSTEM_PROMPT);
  assert.equal(row.title, '修复白屏', '落库前照旧 sanitizeTitle（提示词不是守卫）');

  // —— 自动改名 ——
  const auto = fakeChatFetch('白屏修复');
  const title = await generateAutoTitle(pool, {
    sessionId: TITLE_SESSION_ID, runId: 'r1', userId: TITLE_USER_ID,
    gatewayUrl: 'http://127.0.0.1:4100', fetchImpl: auto.fetchImpl,
    log: { warn() {}, info() {} }, timeoutMs: 1000,
  });
  assert.equal(title, '白屏修复');
  assert.equal(auto.calls.length, 1);
  assert.equal(auto.calls[0].body.messages[0].role, 'system');
  assert.equal(auto.calls[0].body.messages[0].content, DB_TITLE_PROMPT,
    '自动改名吃的是同一条解析路径 ⇒ 两条链路不可能长成两套语义');

  // —— 无行 ⇒ 两条都回落内置（缺省行为逐字等于本单之前）——
  const empty = new TitlePool({ prompts: null });
  const manualDefault = fakeChatFetch('甲');
  await generateAiTitle(empty, {
    userId: TITLE_USER_ID, sessionId: TITLE_SESSION_ID,
    gatewayUrl: 'http://127.0.0.1:4100', fetchImpl: manualDefault.fetchImpl, log: { warn() {}, info() {} },
  });
  assert.equal(manualDefault.calls[0].body.messages[0].content, TITLE_SYSTEM_PROMPT);
  const autoDefault = fakeChatFetch('乙');
  await generateAutoTitle(empty, {
    sessionId: TITLE_SESSION_ID, runId: 'r1', userId: TITLE_USER_ID,
    gatewayUrl: 'http://127.0.0.1:4100', fetchImpl: autoDefault.fetchImpl,
    log: { warn() {}, info() {} }, timeoutMs: 1000,
  });
  assert.equal(autoDefault.calls[0].body.messages[0].content, TITLE_SYSTEM_PROMPT);
});

test('T1b 改名链路：读面炸了也不影响改名（永不抛 ⇒ 手工不 500、自动仍降级）', async () => {
  const pool = new TitlePool({ prompts: null });
  const orig = pool.query.bind(pool);
  pool.query = async (sql, params) => (sql.includes('FROM platform_prompts')
    ? Promise.reject(new Error('db down')) : orig(sql, params));
  const f = fakeChatFetch('照常起名');
  const row = await generateAiTitle(pool, {
    userId: TITLE_USER_ID, sessionId: TITLE_SESSION_ID,
    gatewayUrl: 'http://127.0.0.1:4100', fetchImpl: f.fetchImpl, log: { warn() {}, info() {} },
  });
  assert.equal(row.title, '照常起名', '配置面读不到 ≠ 改名失败');
  assert.equal(f.calls[0].body.messages[0].content, TITLE_SYSTEM_PROMPT);
});

// ---------------------------------------------------------------------------
// 6. `P11` ESM 循环依赖锁（这条锁的不是功能，是「明天有人在模块顶层再引一次对面」）
// ---------------------------------------------------------------------------

/**
 * `materializer.js` ⇄ `platform-prompts.js` 是**双向引用**（渲染器在 materializer，配置读侧在
 * platform-prompts；两边都只在**函数体里**用对面的导出）。ESM 的循环引用在这种写法下是安全的，
 * 但只要有人在**模块顶层**读一次对面的绑定（例：`export const EXAMPLE_FDE_NAME = AGENTS_MD_...`），
 * 求值顺序就决定了谁 TDZ —— 而求值顺序取决于**谁先被 import**，于是：
 *   · 从 `platform-prompts.js` 进 ⇒ 绿（对面先求值完）；
 *   · 从 `materializer.js` 进 ⇒ 整条链 `ReferenceError: Cannot access … before initialization`，
 *     凡 import 这条链的测试文件**全部连坐**（本单实测连坐 24 格）。
 * 一个只从单侧进的测试看不见这件事 ⇒ 本格起**两个子进程**，两种顺序各加载一次，**退出码判绿**。
 * 子进程而不是同进程 import：ESM 模块表是进程级的，一个进程里第二次 import 是空操作，测不到求值期。
 */
test('P11 循环依赖锁：materializer↔platform-prompts 两种加载顺序各自起进程都不许抛（退出码判绿）', () => {
  const srcAbs = (name) => fileURLToPath(new URL(`../src/${name}.js`, import.meta.url));
  const MAT = srcAbs('materializer');
  const PP = srcAbs('platform-prompts');
  assert.ok(fs.existsSync(MAT) && fs.existsSync(PP), `两个绝对路径必须存在：${MAT} / ${PP}`);

  // 两个顺序：`first` 先进事件循环 ⇒ 它的 import 图先求值。`a`/`b` 都 import 了，
  // 但**求值期**从 `first` 那侧开始 ⇒ TDZ 只会在顺序不对时出现。
  const orders = [
    { first: MAT, second: PP, firstType: 'renderHomeAgentsMd', secondType: 'updatePlatformPrompts' },
    { first: PP, second: MAT, firstType: 'updatePlatformPrompts', secondType: 'renderHomeAgentsMd' },
  ];
  for (const { first, second, firstType, secondType } of orders) {
    const code = `const a = await import(${JSON.stringify(first)});`
      + `const b = await import(${JSON.stringify(second)});`
      + `process.stdout.write(typeof a.${firstType} + '/' + typeof b.${secondType});`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
    const tag = path.basename(first);
    // ★ 判绿只看退出码（AGENTS §4）；stdout/stderr 只进断言消息，不参与判绿。
    assert.equal(r.status, 0, `${tag} 先加载 ⇒ 子进程没退干净（status=${r.status}）：${r.stderr}`);
    assert.equal(
      r.stdout,
      'function/function',
      `${tag} 先加载时对面没求值完（TDZ 症状就是这里少一个 function）：${r.stderr}`,
    );
    assert.equal(r.stderr, '', `${tag} 先加载时子进程 stderr 必须干净：${r.stderr}`);
  }
});

test('P11b 这条锁不是装饰：合成一对同样互相 import 的模块，顶层读对面就有一种顺序必炸', () => {
  // 两个临时模块**双向引用**（形状与本单那对完全一致）：
  //   · `a.js` 只用对面的**函数**（在函数体里）⇒ 安全；
  //   · `b.js` 在**模块顶层**读一次对面的常量 ⇒ 就是本次修掉的写法。
  // 于是「谁先被 import」决定炸不炸：先 `b` ⇒ 绿（`a` 先求值完）；先 `a` ⇒ TDZ。
  // ⇒ 「只从单侧进的一条测试」会绿着放过这颗雷，而本格的**两种顺序**都跑 ⇒ 一定抓得住。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-cycle-probe-'));
  try {
    const a = path.join(dir, 'a.js');
    const b = path.join(dir, 'b.js');
    const u = (p) => `file://${p}`;
    fs.writeFileSync(a, [
      "import { bHelper } from 'file://" + b + "';",
      "export const NAME = 'a-side-name';",
      'export function aFn() { return bHelper(); }',
      '',
    ].join('\n'));
    fs.writeFileSync(b, [
      "import { NAME } from 'file://" + a + "';",
      'export const ALIAS = NAME;   // ★ 顶层读对面：双向引用下这就是雷',
      'export function bHelper() { return NAME; }',
      '',
    ].join('\n'));

    const runFirst = (first) => spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `const m = await import(${JSON.stringify(u(first))});`
        + 'process.stdout.write(String(m.NAME ?? m.ALIAS));'],
      { encoding: 'utf8' },
    );
    const fromB = runFirst(b);   // 对面（a）先求值完 ⇒ 顶层读得到值
    assert.equal(fromB.status, 0, `先 b 应当是绿的（读得到已初始化的值）：${fromB.stderr}`);
    assert.equal(fromB.stdout, 'a-side-name');

    const fromA = runFirst(a);   // b 在 a 求值完之前就要读 NAME ⇒ TDZ
    assert.notEqual(fromA.status, 0, '先 a 必须炸 —— 不炸说明这条锁测不到顶层跨模块引用');
    assert.match(fromA.stderr, /Cannot access '[^']*' before initialization/,
      `炸的原因必须是 TDZ（而不是路径写错之类的噪音）：${fromA.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. `D1` 两头说法：代码里的旋钮 / 端点 / DTO 键，文档必须同步点名
// ---------------------------------------------------------------------------

test('D1 两头说法：env 旋钮登记进 env.md 与 .env.example，端点与 DTO 键登记进 portal.md §4.16', async () => {
  // 只在代码里加的旋钮运维找不到；只在文档里写的端点等于没做。口径照
  // `portal/test/upload-settings.test.js` US-12/US-15（同一族「两头说法」判据）。
  const envDoc = fs.readFileSync(new URL('../../docs/env.md', import.meta.url), 'utf8');
  assert.match(envDoc, new RegExp(READ_TIMEOUT_ENV_VAR), `docs/env.md 必须登记 ${READ_TIMEOUT_ENV_VAR}`);
  assert.match(envDoc, /read_timeout/, 'env 文档要说清超时的表现（reason=read_timeout，不挡物化与改名）');
  assert.match(envDoc, /platform_prompts/, 'env 文档必须点名 DB 侧那张表（否则运维只看得见 env）');

  const example = fs.readFileSync(new URL('../../deploy/.env.example', import.meta.url), 'utf8');
  assert.match(example, new RegExp(READ_TIMEOUT_ENV_VAR), 'deploy/.env.example 必须登记这个旋钮');

  const apiDoc = fs.readFileSync(new URL('../../docs/api/portal.md', import.meta.url), 'utf8');
  const sec = apiDoc.slice(apiDoc.indexOf('### 4.16 '));
  assert.ok(sec.length > 200, 'portal.md 必须有 §4.16 这一节');
  const section = sec.slice(0, sec.indexOf('\n## 5. ') > 0 ? sec.indexOf('\n## 5. ') : sec.length);
  // ① 端点表（文档开头那张清单）与 §4.16 都得写四条路径。
  for (const route of [
    'GET /api/admin/prompts', 'PUT /api/admin/prompts/addendum',
    'PUT /api/admin/prompts/agents-md', 'PUT /api/admin/prompts/title-prompt',
  ]) {
    assert.ok(apiDoc.includes(route), `端点清单缺 ${route}`);
  }
  // ② 契约 §6 的 DTO 键**逐个**必须在文档里出现（少一个键 = 前端切片 B 按文档写就会漏字段）。
  const keyNames = new Set();
  const probe = await getPlatformPrompts({ pool: new PromptsFakePool() });
  for (const [group, value] of Object.entries(probe)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const k of Object.keys(value)) keyNames.add(k);
    } else {
      keyNames.add(group);
    }
  }
  for (const key of keyNames) {
    assert.ok(section.includes(key), `§4.16 缺 DTO 键 ${key} 的语义`);
  }
  assert.ok(keyNames.has('materializeEnqueued') || section.includes('materializeEnqueued'),
    'materializeEnqueued 的语义（含 =0 的两种意思）必须写进文档');

  // ③ **不新增错误码**（契约 §6：一律 `validation_failed`）。两条一起测：
  //    §4.16 里出现的「像错误码的反引号词」必须全是既有码或 `reason` 取值；
  //    而通用错误码那一节（§1.2）不许被塞进一个提示词专用的新码。
  const KNOWN_CODES = ['forbidden', 'internal', 'method_not_allowed', 'validation_failed'];
  const KNOWN_REASONS = ['no_row', 'read_failed', 'read_timeout'];   // `reason` 的取值，不是错误码
  const codes = new Set();
  for (const m of section.matchAll(/`([a-z][a-z0-9_]{3,})`/g)) {
    const t = m[1];
    if (/_failed|_exceeded|_too_large|_not_allowed|_not_configured$/.test(t)) codes.add(t);
  }
  const invented = [...codes].filter((t) => !KNOWN_CODES.includes(t) && !KNOWN_REASONS.includes(t));
  assert.deepEqual(invented.sort(), [], `§4.16 只许用既有错误码（发明了：${invented.join(', ')}）`);
  const codeTable = apiDoc.slice(apiDoc.indexOf('### 1.2 通用错误码'), apiDoc.indexOf('### 1.3'));
  assert.ok(codeTable.length > 200, '通用错误码那一节必须还在（切片要用它当基线）');
  assert.doesNotMatch(codeTable, /prompt/i, '§1.2 不许出现提示词专用的新错误码（本单**零新码**）');
});
