// runner/lib/capability-index.js —— 把 `~/.erix/capabilities.json` 变成提示词里的「平台技能」段（issue #595 §6）
//
// 四条判据全部继承 `lib/agents-md.js`（#451 定稿的那一套，问题形状完全同构）：
//   ① 内容**只来自原文**：这一段的每一个字都来自 capabilities.json，渲染器不加任何事实性描述；
//   ② **字节确定性**：同一份输入必须逐字节同一输出——system 是引擎标记的 prompt 缓存稳定前缀，
//      渲染里出现时间戳 / run id / 随机序 = 每次 run 都让整条前缀缓存失效；
//   ③ **失败降级**：文件缺失、读不到、JSON 坏了、形状不对 ⇒ 返回空串 + 一条 note，**绝不抛**。
//      本段在 `startRun` 里、`runToolLoop` 之前，抛出去就是 worker 进程死 ⇒ agentd 当崩溃
//      → requeue → attempts exhausted（#451 返修 F1b 的同一条红线）；
//   ④ **上限**：整段 ≤ 4 KiB，超限按 slug 序**截尾**并写明「（还有 N 项未列出）」。
//      为什么截尾而不是丢整段：前 N 条仍然可用，而「模型不知道有 N 条技能」是静默的信息丢失。
//
// 排序在这里做一次、portal 侧 SQL 也做一次（`ORDER BY i.slug`）：两件事各自都该成立，
// 判据不同源 ⇒ 任一侧漏了都不会把漂移送进上下文。
import fs from 'node:fs';
import path from 'node:path';

/** 平台物化的清单路径（§5）；相对 `$HOME`，与 ports.json / AGENTS.md 同一层。 */
export const CAPABILITIES_BASENAME = 'capabilities.json';
export const CAPABILITIES_REL_PATH = '.erix/capabilities.json';
/** 整段上限：4 KiB（§6）。比 AGENTS.md 的 48 KiB 小一个量级——技能索引是**路由信号**，不是文档。 */
export const CAPABILITY_MAX_SECTION_BYTES = 4 * 1024;
/** 单个字段进上下文前的截断点（一条超长的 when_to_use 不该把整段挤掉）。 */
export const CAPABILITY_FIELD_MAX_CHARS = 300;

/** 读面注入点（单测给一个假 fs 就能跑完四种降级，不必造真目录）。 */
const DEF_FS = {
  existsSync: (p) => fs.existsSync(p),
  readFileSync: (p) => fs.readFileSync(p),
  statSync: (p) => fs.statSync(p),
};

function clip(s, max = CAPABILITY_FIELD_MAX_CHARS) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * 形状校验：只认 §5 的 `{version, skills: [...]}`，其余一律降级。
 * 为什么不做宽松兼容（比如裸数组）：这份文件只有一个生产者（portal/src/materializer.js），
 * 形状对不上就说明**两侧版本不同步**，此时静默兼容会把「平台以为装了、模型一条都看不见」藏起来。
 * @returns {{skills: Array<object>, mcp: Array<object>, note: string|null}}
 */
export function normalizeCapabilities(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { skills: [], mcp: [], note: 'capabilities.json 顶层不是对象，忽略' };
  }
  if (!Array.isArray(raw.skills)) {
    return { skills: [], mcp: [], note: 'capabilities.json 缺少 skills 数组，忽略' };
  }
  const out = [];
  let dropped = 0;
  for (const s of raw.skills) {
    // `id` 是唯一硬要求：它同时是目录名、excludeSkillIds 的值、模型眼里的技能名。
    if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !s.id) { dropped += 1; continue; }
    out.push({
      id: s.id,
      name: typeof s.name === 'string' ? s.name : s.id,
      summary: typeof s.summary === 'string' ? s.summary : '',
      when_to_use: typeof s.when_to_use === 'string' ? s.when_to_use : '',
      enabled: s.enabled !== false,          // 缺省按启用：§2 的 `enabled` 默认就是 true
      tools: (Array.isArray(s.tools) ? s.tools : []).filter((t) => typeof t === 'string'),
      readme: typeof s.readme === 'string' ? s.readme : null,
    });
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));   // 字节确定性的一半
  // issue #608 §5.2：`mcp` 段是**可选**的（旧版 portal 不写它）。缺省 ⇒ `[]`，绝不能因为缺段
  // 就把 skills 一起降级——那会让「加一个 MCP」把技能全弄没（P0 行为回退）。
  const mcp = [];
  for (const s of Array.isArray(raw.mcp) ? raw.mcp : []) {
    // `name` 是唯一硬要求：它是 `mcp({action:"call", server:<name>})` 的寻址键，名字没了就调不到。
    if (!s || typeof s !== 'object' || typeof s.name !== 'string' || !s.name) { continue; }
    mcp.push({
      name: s.name,
      description: typeof s.description === 'string' ? s.description : '',
      // 缺省按 `deferred`：§4.3 里 deferred 是「只走网关」的保守档，误判成 direct 会多塞工具面。
      exposure: typeof s.exposure === 'string' ? s.exposure : 'deferred',
      tool_count: Number.isInteger(s.tool_count) && s.tool_count >= 0 ? s.tool_count : 0,
    });
  }
  mcp.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const note = dropped > 0
    ? `capabilities.json 里有 ${dropped} 条缺 id 的条目，已忽略`
    : null;
  return { skills: out, mcp, note };
}

/**
 * 读 `~/.erix/capabilities.json`。
 * 四种降级各有各的 note（排查时要能分清「没装过」与「读不到」）：
 *   missing / unreadable / bad_json / bad_shape ⇒ skills 恒为 []。
 * @param {{home?: string, fs?: object}} options
 * @returns {{status: 'ok'|'missing'|'unreadable'|'bad_json'|'bad_shape', skills: Array<object>, path: string, note: string|null}}
 */
export function readCapabilityIndex(options = {}) {
  const home = options.home || process.env.HOME || '/home/erix';
  const f = { ...DEF_FS, ...(options.fs ?? {}) };
  const file = path.join(home, '.erix', CAPABILITIES_BASENAME);
  const degrade = (status, note) => ({ status, skills: [], mcp: [], path: file, note });

  if (!f.existsSync(file)) return degrade('missing', null);   // 没装过任何技能：完全正常，不记 note
  let text;
  try {
    text = f.readFileSync(file, 'utf8');
  } catch (err) {
    return degrade('unreadable', `capabilities.json 读失败：${err?.message ?? err}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return degrade('bad_json', `capabilities.json 不是合法 JSON：${err?.message ?? err}`);
  }
  const { skills, mcp, note } = normalizeCapabilities(parsed);
  // 形状不对时两侧**一起**降级（不“只信 mcp 段”）：同一份文件只有一个生产者，半信半疑会把
  // “两侧版本不同步”藏得更深。
  if (skills.length === 0 && note) return { ...degrade('bad_shape', note), note };
  return { status: 'ok', skills, mcp, path: file, note };
}

/** L2 的输入：停用项的 id 交给 `buildSkillTools({excludeSkillIds})`（目录仍在磁盘，必须显式排除）。 */
export function splitByEnabled(skills) {
  const list = Array.isArray(skills) ? skills : [];
  return {
    enabled: list.filter((s) => s.enabled),
    excludeSkillIds: list.filter((s) => !s.enabled).map((s) => s.id),
  };
}

/** 一条技能 → 一行。字段顺序固定：id / 名称 / 一句话 / 何时用 / 工具 / 说明文件。 */
function lineFor(s) {
  const parts = [`\`${s.id}\`（${clip(s.name) || s.id}）— ${clip(s.summary)}`];
  if (s.when_to_use) parts.push(`何时用：${clip(s.when_to_use)}`);
  if (s.tools?.length) parts.push(`工具：${s.tools.join(', ')}`);
  if (s.readme) parts.push(`说明：${s.readme}（需要时 readFile）`);
  return `- ${parts.join('；')}`;
}

/**
 * 渲染「## 平台技能」段（§6）。
 * @param {Array<object>} skills 只传**启用**的（停用的走 excludeSkillIds，不进上下文）
 * @param {{maxBytes?: number}} [options]
 * @returns {string} 前导 `\n\n`；空输入 ⇒ `''`（此时 `SYSTEM_PROMPT + section` 逐字节等于原提示词）
 */
export function renderCapabilityIndex(skills, options = {}) {
  const max = Number.isInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes : CAPABILITY_MAX_SECTION_BYTES;
  const list = Array.isArray(skills) ? skills : [];
  if (list.length === 0) return '';   // 口径同 #451：没有内容 ⇒ 逐字节不变
  // 渲染侧再排一次 id 升序：上游（SQL / 文件）排过也要排——本函数自己就要能兑现字节确定性，
  // 否则「谁忘了排序」会把漂移送进 prompt 缓存前缀（§5 与 §6 两处判据必须各自站得住）。
  const sorted = [...list].sort((a, b) => (String(a?.id ?? '') < String(b?.id ?? '') ? -1
  : String(a?.id ?? '') > String(b?.id ?? '') ? 1 : 0));   // 不排调用方的数组（纯函数）

  const head = [
    '## 平台技能（能力市场，宿主在 run 启动时读取）',
    '',
    '> 下面是本容器**已安装且已启用**的技能工具。它们与内置工具同层，直接调用即可。',
    '> 「工具」列就是可调用的工具名；没列出技能不代表 shell / 文件工具不能做那件事，'
      + '只是平台没有为它提供专用工具。',
    '> 这份清单来自 `~/.erix/' + CAPABILITIES_BASENAME + '`，由平台在页面操作后重写；'
      + '本 run 内改它不会立刻生效。',
    '',
  ];
  const notes = [];
  if (options.note) notes.push(options.note);

  const lines = [...head];
  let used = Buffer.byteLength(head.join('\n'), 'utf8');
  let shown = 0;
  for (const s of sorted) {
    const line = lineFor(s);
    const cost = Buffer.byteLength(`${line}\n`, 'utf8');
    // 预留一行给「还有 N 项未列出」：宁可少列一条，也不让整段越过上限（越上限 = 这段被上游截断，
    // 模型看到的是断句而不是「清单还有更多」）。
    if (used + cost + 96 > max) break;
    lines.push(line);
    used += cost;
    shown += 1;
  }
  const omitted = list.length - shown;
  if (omitted > 0) {
    lines.push('');
    lines.push(`（还有 ${omitted} 项未列出）`);
  }
  if (notes.length > 0) {
    lines.push('');
    lines.push('### 采集记账（宿主侧提示，可忽略）');
    lines.push('');
    for (const n of notes) lines.push(`- ${n}`);
  }
  return `\n\n${lines.join('\n')}`;
}

/**
 * 渲染「## 平台 MCP 服务」段（§6.5）。与技能段共享同一个 4 KiB，所以预算从外部递进来。
 * 只渲染走网关的 server：`direct` 的工具已是独立工具（模型在工具面里直接看得到，再列一遍
 * 白花字节），`hidden` 永不出现（§6.3：连 `search` 都拦，更不能在提示词里给它打广告）。
 * @param {Array<object>} servers `normalizeCapabilities` 的 `mcp` 段（已过形状筛）
 * @param {{maxBytes?: number}} [options] 剩余预算（skills 段先拿）
 * @returns {string} 前导 `\n\n`；无可渲染条目 ⇒ `''`（保证“没 MCP ⇒ 逐字节等于 v1”）
 */
export function renderMcpIndex(servers, options = {}) {
  const max = Number.isInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes : CAPABILITY_MAX_SECTION_BYTES;
  const list = (Array.isArray(servers) ? servers : [])
    .filter((s) => s && s.exposure !== 'direct' && s.exposure !== 'hidden');
  if (list.length === 0) return '';
  // 渲染侧再排一次 name 升序（与技能段同理：本函数自己就要兑现字节确定性）。
  const sorted = [...list].sort((a, b) => (String(a.name) < String(b.name) ? -1
    : String(a.name) > String(b.name) ? 1 : 0));
  const head = ['## 平台 MCP 服务（能力市场）', ''];
  const lines = [...head];
  let used = 2 + Buffer.byteLength(head.join('\n'), 'utf8');   // 2 = 前导 `\n\n`
  let shown = 0;
  for (const s of sorted) {
    // 行形状逐字照 §6.5 的样例；「用法」后缀是契约原文（不是我们编的事实）。
    const line = `- ${s.name} — ${clip(s.description) || s.name}；工具 ${s.tool_count} 个；`
      + '用法：mcp({action:"search"}) 找工具后 call';
    const cost = Buffer.byteLength(`${line}\n`, 'utf8');
    // 预留一行给「还有 N 个 server 未列出」，口径同技能段：宁可少列一条也不越上限。
    if (used + cost + 96 > max) break;
    lines.push(line);
    used += cost;
    shown += 1;
  }
  const omitted = sorted.length - shown;
  if (omitted > 0) {
    lines.push('');
    lines.push(`（还有 ${omitted} 个 server 未列出）`);
  }
  return `\n\n${lines.join('\n')}`;
}

/**
 * worker 用的**一次调用**：读 → 拆 → 渲染。
 * 整段自带 try/catch：注入的 fs 门面自己抛（比如 `existsSync` 没实现）也只降级成空段。
 * @returns {{section: string, excludeSkillIds: string[], skills: Array<object>, mcp: Array<object>, status: string, note: string|null}}
 */
export function buildCapabilityIndex(options = {}) {
  try {
    const read = readCapabilityIndex(options);
    const { enabled, excludeSkillIds } = splitByEnabled(read.skills);
    const total = Number.isInteger(options.maxBytes) && options.maxBytes > 0
      ? options.maxBytes : CAPABILITY_MAX_SECTION_BYTES;
    const skillsSection = renderCapabilityIndex(enabled, { ...options, maxBytes: total });
    // 共享 4 KiB 的**分配顺序就是契约**（§5.2）：skills 先按 v1 原行为拿满，MCP 只吃剩下的。
    // 倒过来就是「多装一个 MCP 把技能挤掉」——那是 P0 行为回退，也是反向用例要红的地方。
    const remaining = total - Buffer.byteLength(skillsSection, 'utf8');
    const mcpSection = renderMcpIndex(read.mcp, { maxBytes: remaining });
    return {
      section: skillsSection + mcpSection,
      skillsSection,
      mcpSection,
      excludeSkillIds,
      skills: read.skills,
      mcp: read.mcp,
      status: read.status,
      note: read.note,
    };
  } catch (err) {
    return {
      section: '', skillsSection: '', mcpSection: '', excludeSkillIds: [], skills: [], mcp: [],
      status: 'unreadable',
      note: `capabilities 采集失败：${err?.message ?? err}`,
    };
  }
}
