// runner/lib/mcp-tool.js —— MCP 的**工具面**（issue #608 §6.2/§6.3/§4.3/§6.6/§6.7）。
//
// 两面并存（§4.3 的 exposure 旋钮在这里变成可观察差异）：
//   · 网关工具 `mcp`：形状**固定**（不随 server 数变化），list/search/call/status 四动作；
//   · `direct` 档：把该 server 的每个工具展开成独立工具 `mcp__<server>__<tool>`，省一次 search 往返。
// 为什么两套并存而不是只留 direct：direct 每个工具 ≈200 token/轮，12 个工具就是每轮白烧两千多
// token，而 deferred 的成本是 0（只有网关那段固定描述）。
//
// 安全口径（§10）：`hidden` 三处都挡——物化不出现（portal）、`search` 不返回、`call` 直接
// `mcp_tool_hidden`。本模块是后两处，并且**不信任**上游：即使有人把 hidden 的 server 塞进
// pool，这里也照样拒（fail-closed，绝不允许「没接审批所以先自动执行」）。
import { MCP_ERRORS, RESULT_TMP_DIR } from './mcp-client.js';

/** 网关工具名（§6.3，固定）。 */
export const MCP_GATEWAY_TOOL = 'mcp';
/** direct 工具名前缀（与 pi 内置 MCP 同构，便于日后迁移，§4.3）。 */
export const DIRECT_PREFIX = 'mcp__';

/**
 * 工具面错误码（§6.3 + §7.3）：与传输层的 `MCP_ERRORS` 分开，因为这四个码**不是**「连不上」，
 * 而是「你这样调不行」——模型能读懂并当场改道，传输层码则多半要人去修配置。
 */
export const MCP_TOOL_ERRORS = Object.freeze({
  UNKNOWN: 'mcp_tool_unknown',
  HIDDEN: 'mcp_tool_hidden',
  AMBIGUOUS: 'mcp_tool_ambiguous',
  BAD_REQUEST: 'mcp_bad_request',
});
/** §4.3：direct 工具**计入 direct 预算 ≤8 个**，超出降级为 deferred（否则工具面成本失控）。 */
export const DIRECT_TOOL_BUDGET = 8;
/** §4.3：单 server 的 schema 总量 ≤64 KiB，超出该 server 整体降级为 deferred + warn。 */
export const DIRECT_SCHEMA_BUDGET_BYTES = 64 * 1024;
/** `search` 一次最多回多少条（否则一个宽泛关键词就能把上下文灌满）。 */
export const SEARCH_RESULT_LIMIT = 20;
/** `search` 里描述的一行截断宽度（描述是管理员写的，可以很长）。 */
export const SEARCH_DESC_CLIP_CHARS = 120;

/** 网关工具 schema（§6.3 **逐字**：字段名、enum、required、描述文案都不许改）。 */
export const MCP_GATEWAY_SCHEMA = Object.freeze({
  name: MCP_GATEWAY_TOOL,
  description: '调用平台配置的 MCP 服务器。list 看有哪些 server；search 找工具（用本地元数据缓存，'
    + 'server 没连也能搜）；call 调工具；status 看连接态。',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'search', 'call', 'status'] },
      server: { type: 'string', description: 'server 名（call 时必填）' },
      tool: { type: 'string', description: '工具名（call 时必填）' },
      args: { type: 'object', description: '工具参数，原样透传' },
      query: { type: 'string', description: 'search 关键词' },
    },
    required: ['action'],
  },
});

/** §4.3：server 名与工具名里的非 `[a-zA-Z0-9_]` 字符替换为 `_`（引擎的工具名有字符集约束）。 */
export function sanitizeToolNamePart(part) {
  return String(part ?? '').replace(/[^a-zA-Z0-9_]/g, '_');
}

/** direct 工具名：`mcp__<server>__<tool>`（§4.3）。 */
export function directToolName(serverName, toolName) {
  return `${DIRECT_PREFIX}${sanitizeToolNamePart(serverName)}__${sanitizeToolNamePart(toolName)}`;
}

/** 把一个失败包成工具结果（**不抛**：MCP 的失败是模型要读并据此改道的信息，不是宿主异常）。 */
function toolError(code, message, details = {}) {
  const extra = Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : '';
  return {
    content: `MCP 失败：${code} — ${message}${extra}`,
    metadata: { isError: true, mcpError: code, ...details },
  };
}

/**
 * `direct` 展开（§4.3）：三条降级线都在此，且**只降级不报错**——一个 server 的 schema 太大
 * 不该让整轮工具面装配失败。
 * @param {Array<{server:string,tool:string,description?:string,definition?:object}>} rows
 * @returns {{tools: Array<object>, downgraded: Array<object>}}
 */
export function expandDirectTools(rows = [], {
  log = null,
  budget = DIRECT_TOOL_BUDGET,
  schemaBudgetBytes = DIRECT_SCHEMA_BUDGET_BYTES,
  hiddenServers = [],
} = {}) {
  const hidden = new Set(hiddenServers.map((s) => String(s)));
  // 先按 server 分桶：schema 预算是**每 server** 的口径（§4.3），而条数预算是全局的。
  const byServer = new Map();
  for (const row of rows) {
    const server = String(row?.server ?? '');
    const tool = String(row?.tool ?? '');
    if (server === '' || tool === '' || hidden.has(server)) continue;
    if (!byServer.has(server)) byServer.set(server, []);
    byServer.get(server).push(row);
  }
  const tools = [];
  const downgraded = [];
  for (const [server, list] of [...byServer.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const bytes = list.reduce((sum, r) => sum + Buffer.byteLength(JSON.stringify(r.definition ?? {}), 'utf8'), 0);
    if (bytes > schemaBudgetBytes) {
      // 降级理由要留痕：管理员在管理台看到的是 direct，模型面却是 deferred，不记就是灵异事件。
      downgraded.push({ server, reason: 'schema_budget', bytes, limit: schemaBudgetBytes });
      continue;
    }
    for (const row of list.slice().sort((a, b) => String(a.tool).localeCompare(String(b.tool)))) {
      const name = directToolName(server, row.tool);
      const inputSchema = row.definition?.inputSchema && typeof row.definition.inputSchema === 'object'
        ? row.definition.inputSchema
        : { type: 'object', properties: {}, additionalProperties: true };
      tools.push({
        name,
        server,
        tool: row.tool,
        description: `${row.description ?? ''}（MCP server ${server}；网关调用等价于 `
          + `mcp({action:"call",server:"${server}",tool:"${row.tool}"})）`,
        inputSchema,
      });
    }
  }
  // 名字冲突（清洗后撞名）**两边都不留**：留一个就等于「同一个工具名有时打到 A 有时打到 B」，
  // 而工具名是模型唯一能抓住的把手，歧义比少一个工具严重得多（§4.3：冲突 ⇒ 降级为 deferred）。
  const counts = new Map();
  for (const t of tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  const unique = tools.filter((t) => {
    if ((counts.get(t.name) ?? 0) > 1) {
      downgraded.push({ server: t.server, tool: t.tool, reason: 'name_conflict', name: t.name });
      return false;
    }
    return true;
  });
  if (unique.length > budget) {
    for (const t of unique.slice(budget)) {
      downgraded.push({ server: t.server, tool: t.tool, reason: 'tool_budget', limit: budget });
    }
  }
  const kept = unique.slice(0, budget);
  for (const d of downgraded) {
    if (log) log('warn', 'mcp direct exposure downgraded to deferred', d);
  }
  return { tools: kept, downgraded };
}

/** 描述/文本压成一行（工具描述里常有换行，多行会把索引段撑坏）。 */
function oneLine(text, maxChars = SEARCH_DESC_CLIP_CHARS) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars)}…`;
}

/**
 * 组装工具面。
 * @param {{pool: object, hidden?: string[], log?: Function, runId?: string|null,
 *   fsImpl?: object, tmpRoot?: string, searchLimit?: number,
 *   onToolsCache?: (slug: string, tools: Array<object>) => void}} options
 * @returns {{schemas: Array<object>, executeTool: Function, direct: Array<object>}}
 */
export function createMcpTool({
  pool,
  hidden = [],
  log = null,
  runId = null,
  fsImpl,
  tmpRoot = RESULT_TMP_DIR,
  searchLimit = SEARCH_RESULT_LIMIT,
  onToolsCache = () => {},
} = {}) {
  const hiddenServers = new Set((Array.isArray(hidden) ? hidden : [hidden]).map((s) => String(s)));
  const { tools: directTools, downgraded } = expandDirectTools(
    typeof pool?.directTools === 'function' ? pool.directTools() : [],
    { log, hiddenServers: [...hiddenServers] },
  );
  const byName = new Map(directTools.map((t) => [t.name, t]));

  const schemas = [MCP_GATEWAY_SCHEMA, ...directTools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }))];

  /** 缓存里含这个工具的 server（`call` 的门禁与歧义判据都读它，§6.3）。 */
  function serversWithTool(toolName) {
    const out = [];
    for (const s of pool.list()) {
      if ((s.tools ?? []).some((t) => t?.name === toolName)) out.push(s.name);
    }
    return out.sort();
  }

  /** §6.6：`list` 对空缓存的 server 触发一次发现，并把新清单回填（缓存是 `search` 的命）。 */
  async function discover(serverName, { signal } = {}) {
    const client = pool.get(serverName);
    if (!client) return { ok: false, error: 'server 未注册' };
    try {
      const tools = await client.listTools({ signal });
      if (typeof pool.registerTools === 'function') pool.registerTools(serverName, tools);
      // slug：`mcp.json`（§5.1）只有 `name`，没有独立的 slug 字段 ⇒ 用 name 顶替。
      // portal 的 `POST /api/internal/mcp/tools-cache` 若要求条目 slug，需要物化器在 mcp.json
      // 里补一个 `slug` 字段（本文件按「有则用、无则 name」实现，见工单报告第 4 节）。
      const slug = client.slug ?? serverName;
      if (Array.isArray(tools) && tools.length > 0) onToolsCache(slug, tools);
      return { ok: true, count: tools.length };
    } catch (err) {
      return { ok: false, error: oneLine(err?.message ?? err, 200) };
    }
  }

  async function actList(input, { signal } = {}) {
    const rows = pool.list();
    const lines = [];
    for (const s of rows.sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
      if (hiddenServers.has(String(s.name))) continue;   // §10.7：hidden 连「存在」都不承认
      let toolCount = (s.tools ?? []).length;
      let discovered = '';
      if (toolCount === 0) {
        // 懒启动（§13：run 启动不拉任何 server）+ 元数据回填（§6.6）。
        const out = await discover(s.name, { signal });
        discovered = out.ok ? ` [已发现 ${out.count} 个工具]` : ` [发现失败：${out.error}]`;
        const after = pool.get(s.name)?.tools ?? [];
        toolCount = after.length;
      }
      lines.push(`- ${s.name} — exposure=${s.exposure} state=${s.status?.state ?? 'unknown'} `
        + `工具 ${toolCount} 个${discovered}`);
    }
    for (const m of pool.missing ?? []) {
      lines.push(`- ${m?.name ?? '?'} — 未注册（缺配置槽：${(m?.slots ?? []).join(', ')}）`);
    }
    for (const name of hiddenServers) lines.push(`- ${name} — exposure=hidden（本平台不可调用）`);
    if (lines.length === 0) return { content: '没有可用的 MCP server（未安装或全部 hidden）。', metadata: {} };
    return {
      content: `MCP server ${rows.length} 个：\n${lines.join('\n')}`,
      metadata: { servers: rows.length, downgraded: downgraded.length },
    };
  }

  function actSearch(input) {
    const query = String(input?.query ?? '').trim().toLowerCase();
    if (query === '') return toolError(MCP_TOOL_ERRORS.BAD_REQUEST, 'search 需要 query');
    const hits = [];
    for (const s of pool.list()) {
      if (hiddenServers.has(String(s.name))) continue;   // §10.7
      const serverHit = String(s.name).toLowerCase().includes(query);
      for (const t of s.tools ?? []) {
        const name = String(t?.name ?? '');
        if (name === '') continue;
        const desc = String(t?.description ?? '');
        const hit = serverHit || name.toLowerCase().includes(query)
          || desc.toLowerCase().includes(query);
        if (!hit) continue;
        hits.push(`- ${s.name}.${name} — ${oneLine(desc) || '（无描述）'}`);
      }
    }
    if (hits.length === 0) {
      // 空手而归也要给下一步动作：否则模型会以为「没有这个能力」，而事实是缓存还没被发现过。
      return {
        content: '无命中；若该 server 从未连过，先 mcp({action:"list"}) 触发发现。',
        metadata: { hits: 0 },
      };
    }
    const shown = hits.slice(0, searchLimit);
    const more = hits.length - shown.length;
    return {
      content: `命中 ${hits.length} 个工具${more > 0 ? `（只列前 ${searchLimit} 个，还有 ${more} 个）` : ''}：\n`
        + `${shown.join('\n')}\n调用：mcp({action:"call",server:"<server>",tool:"<tool>",args:{…}})`,
      metadata: { hits: hits.length },
    };
  }

  async function actCall(input, { signal } = {}) {
    const serverName = input?.server === undefined || input?.server === null
      ? '' : String(input.server).trim();
    const toolName = input?.tool === undefined || input?.tool === null
      ? '' : String(input.tool).trim();
    if (toolName === '') {
      return toolError(MCP_TOOL_ERRORS.BAD_REQUEST, 'call 需要 tool',
        { servers: pool.list().map((s) => s.name) });
    }
    // §10.7：hidden 的 server **连调用都不承认存在**（P1 没有审批通道，fail-closed）。
    if (hiddenServers.has(serverName)) {
      return toolError(MCP_TOOL_ERRORS.HIDDEN,
        `server ${serverName} 被标为 hidden，本平台不可调用`, { server: serverName, tool: toolName });
    }
    if (serverName === '') {
      // 只给 tool：本站**不猜**（§6.3）。candidates 给全，模型下一轮自己补 server。
      const candidates = serversWithTool(toolName);
      return toolError(MCP_TOOL_ERRORS.AMBIGUOUS,
        'call 必须显式给 server', { candidates, tool: toolName });
    }
    const client = pool.get(serverName);
    if (!client) {
      return toolError(MCP_ERRORS.UNREACHABLE, `server ${serverName} 未注册`,
        { server: serverName, known: pool.list().map((s) => s.name), missing: pool.missing ?? [] });
    }
    // 门禁读**缓存视图**：缓存里没有这个工具就不许调（防歧义与越权，§6.3）。
    const known = (client.tools ?? []).some((t) => t?.name === toolName);
    if (!known) {
      return toolError(MCP_TOOL_ERRORS.UNKNOWN,
        `server ${serverName} 的缓存里没有工具 ${toolName}`,
        { server: serverName, tool: toolName, known: (client.tools ?? []).map((t) => t?.name) });
    }
    const args = input?.args && typeof input.args === 'object' ? input.args : {};
    let out;
    try {
      out = await client.callTool(toolName, args, { signal });
    } catch (err) {
      const code = err?.code ?? MCP_ERRORS.UNREACHABLE;
      // ⚠ 值不进错误详情（§10.3）：`err.message` 在传输层已经过 redactValues。
      return toolError(code, oneLine(err?.message ?? err, 300), { server: serverName, tool: toolName });
    }
    return {
      content: out?.text ?? '',
      // §6.7：`server` / `tool` 进 metadata，UI 才能显示来源而不是「一坨文本」。
      metadata: {
        server: serverName,
        tool: toolName,
        isError: out?.isError === true,
        truncated: out?.truncated === true,
        fullPath: out?.fullPath ?? null,
      },
    };
  }

  function actStatus() {
    const rows = pool.list()
      .filter((s) => !hiddenServers.has(String(s.name)))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const lines = rows.map((s) => `- ${s.name} — state=${s.status?.state ?? 'unknown'}`
      + ` toolsCached=${s.status?.toolsCached === true}`
      + (s.status?.lastError || s.status?.error ? ` lastError=${oneLine(s.status.lastError ?? s.status.error, 160)}` : ''));
    if (lines.length === 0) return { content: '没有已注册的 MCP server。', metadata: { servers: 0 } };
    return { content: `MCP 状态（不触发连接）：\n${lines.join('\n')}`, metadata: { servers: rows.length } };
  }

  /**
   * 网关 + direct 的统一入口（引擎侧 `executeTool(name, input, ctx)`，ctx 带 signal/runId）。
   * §6.4/§1：`options.signal` 一路传到传输层——用户点停止时必须能掐断在途的 MCP 调用。
   */
  async function executeTool(name, input = {}, ctx = {}) {
    const signal = ctx?.signal ?? null;
    if (name === MCP_GATEWAY_TOOL) {
      const action = String(input?.action ?? '').trim();
      if (action === 'list') return actList(input, { signal });
      if (action === 'search') return actSearch(input);
      if (action === 'call') return actCall(input, { signal });
      if (action === 'status') return actStatus();
      return toolError(MCP_TOOL_ERRORS.BAD_REQUEST,
        `action 未知：${action || '(空)'}`, { allowed: ['list', 'search', 'call', 'status'] });
    }
    const direct = byName.get(String(name));
    if (!direct) {
      return toolError(MCP_TOOL_ERRORS.UNKNOWN, `不是本工具面的工具：${String(name)}`);
    }
    return actCall({ server: direct.server, tool: direct.tool, args: input }, { signal });
  }

  return {
    schemas,
    executeTool,
    direct: directTools,
    downgraded,
    /** §6.7：全文落盘目录（worker 收尾与测试都用得到，避免两处硬编码）。 */
    tmpRoot,
    runId,
    fsImpl,
  };
}
