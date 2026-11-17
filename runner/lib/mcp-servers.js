// runner/lib/mcp-servers.js —— MCP 的**组装层**（issue #608 §6.2/§6.1/§5.1/§10.6）。
//
// 职责边界：`mcp-client.js` 管一条连接，`mcp-tool.js` 管工具面，本文件管**这一次 run 到底
// 有哪些 server 可用**，三件事都在这里定：
//   1. 读 `~/.erix/mcp.json`（平台物化文件，里面**只有槽位声明、没有值**，§5.1）；
//   2. 值经 **agentd 代取**（worker 没有 per-container token，`buildWorkerEnv` 把
//      `ERIX_STATION_TOKEN` 删掉了，§6.1）——失败就整体降级为「本次 run 无 MCP」，不打死 run；
//   3. 缺必填槽 ⇒ 该 server **不注册**并记进 `missing`（`mcp({action:"list"})` 要能解释为什么少
//      一个）；保留名在**注入前**再判一次（§10.6 两侧都判，runner 这侧是第二道）。
import fs from 'node:fs';
import path from 'node:path';

import { MSG, sendIpc } from './ipc.js';

/** 物化文件绝对路径的默认口径（与 lib/capability-index.js 同源：HOME 缺省退回 /home/erix）。 */
export const MCP_CONFIG_BASENAME = 'mcp.json';
export const MCP_CONFIG_REL_PATH = '.erix/mcp.json';
/** 结果全文落盘目录（§6.7）——与 mcp-client.js 的 RESULT_TMP_DIR 同值，这里只做说明。 */
export const MCP_RESULT_TMP_DIR = '/tmp/erix-mcp';

/** §10.6 保留名（精确匹配的那一批）。 */
export const RESERVED_SLOT_NAMES = Object.freeze([
  'PATH', 'HOME', 'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'PYTHONPATH', 'PYTHONSTARTUP',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
]);
/** §10.6 保留前缀：这些命名空间是宿主/引擎的，槽位不许占（否则一个槽就能改掉代理或 CA）。 */
export const RESERVED_SLOT_PREFIXES = Object.freeze(['ERIX_', 'STATION_', 'SKILL_', 'MCP_']);

/** 保留名判定（大小写不敏感：env 名与头名的口径本来就不同，判错一档就是漏门）。 */
export function isReservedSlotName(name) {
  const upper = String(name ?? '').trim().toUpperCase();
  if (upper === '') return true;   // 空名连注入到哪都不知，直接拒
  if (RESERVED_SLOT_NAMES.includes(upper)) return true;
  return RESERVED_SLOT_PREFIXES.some((p) => upper.startsWith(p));
}

const DEF_FS = {
  existsSync: (...args) => fs.existsSync(...args),
  readFileSync: (...args) => fs.readFileSync(...args),
};

/**
 * 读 `~/.erix/mcp.json`。四种失败各有 status，但**都不抛**（§6.1「不打死 run」）：
 * `missing` / `unreadable` / `bad_json` / `bad_shape`。
 * @returns {{status: string, servers: Array<object>, note: string|null, path: string}}
 */
export function readMcpConfig({ home = process.env.HOME || '/home/erix', fsImpl = DEF_FS } = {}) {
  const file = path.join(String(home), MCP_CONFIG_REL_PATH);
  // `fsImpl` 可以只给一部分（测试常只 stub 读）：缺什么就退回真 `fs`，不许抛。
  const exists = typeof fsImpl.existsSync === 'function'
    ? fsImpl.existsSync
    : (...args) => fs.existsSync(...args);
  if (!exists(file)) return { status: 'missing', servers: [], note: null, path: file };
  let text;
  try {
    text = fsImpl.readFileSync(file, 'utf8');
  } catch (err) {
    return { status: 'unreadable', servers: [], note: `读取失败：${String(err?.message ?? err)}`, path: file };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { status: 'bad_json', servers: [], note: `JSON 解析失败：${String(err?.message ?? err)}`, path: file };
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.servers)) {
    return { status: 'bad_shape', servers: [], note: '缺 servers 数组', path: file };
  }
  // 名字升序：物化器已经排过，这里再排一次是**防御**——两处的顺序判据必须一致，
  // 否则 `list` 的行序就随磁盘写入顺序漂（§5.1 的「逐字节确定」在 runner 侧的对应物）。
  const servers = parsed.servers
    .filter((s) => s && typeof s === 'object' && typeof s.name === 'string' && s.name !== '')
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  return { status: 'ok', servers, note: null, path: file };
}

/** 声明里的必填槽名（`required !== true` 的不算，缺槽只 warn）。 */
function requiredSlots(server) {
  return (Array.isArray(server?.slots) ? server.slots : [])
    .filter((s) => s?.required === true && typeof s?.name === 'string' && s.name !== '')
    .map((s) => s.name);
}

/** 声明里的全部槽名。 */
function allSlots(server) {
  return (Array.isArray(server?.slots) ? server.slots : [])
    .filter((s) => s && typeof s.name === 'string' && s.name !== '')
    .map((s) => s.name);
}

/**
 * 把 agentd 回来的**明文槽值**并进声明，产出 pool 要的形状（`{...server, resolved:{values}}`）。
 * 纯函数、可单测；两条拒绝线都在这里：
 *   · **保留名**（§10.6）：值直接**不注入**；若该槽是必填 ⇒ 整条 server 进 `missing`
 *     （填了也不认，比悄悄改掉 `PATH` 安全）。
 *   · **缺必填槽**（§6.1）：进 `missing`，不注册。
 * @param {{servers: Array<object>, valuesByName?: object, missingFromAgent?: Array<object>}} options
 * @returns {{registered: Array<object>, missing: Array<object>, hidden: string[],
 *   rejected: Array<object>}}
 */
export function combineServers({ servers = [], valuesByName = {}, missingFromAgent = [] } = {}) {
  const registered = [];
  const missing = [];
  const hidden = [];
  const rejected = [];
  for (const server of servers) {
    // §5.1：物化器**本就不该**写 hidden 条目；真写来了（旧版物化器/手工改文件）就在这里挡掉。
    if (server.exposure === 'hidden') {
      hidden.push(server.name);
      continue;
    }
    const values = valuesByName[server.name] ?? {};
    const resolved = {};
    for (const name of allSlots(server)) {
      const value = values[name];
      if (typeof value !== 'string' || value === '') continue;
      if (isReservedSlotName(name)) {
        // 只记槽名，**绝不记值**（§10.3）。
        rejected.push({ server: server.name, slot: name, reason: 'reserved_name' });
        continue;
      }
      resolved[name] = value;
    }
    const lack = requiredSlots(server).filter((n) => {
      if (isReservedSlotName(n)) return true;   // 保留名就算 agentd 给了值也算没给
      return typeof values[n] !== 'string' || values[n] === '';
    });
    if (lack.length > 0) {
      missing.push({ name: server.name, slots: lack, reason: 'missing_slots' });
      continue;
    }
    registered.push({ ...server, resolved: { values: resolved } });
  }
  // agentd 侧已经判定「Portal 里就没配值」的条目也并进 missing（同一个 `list` 解释口径）。
  for (const m of Array.isArray(missingFromAgent) ? missingFromAgent : []) {
    if (!m || typeof m.name !== 'string') continue;
    if (missing.some((x) => x.name === m.name)) continue;
    if (registered.some((x) => x.name === m.name)) continue;
    missing.push({ name: m.name, slots: Array.isArray(m.slots) ? m.slots : [], reason: m.reason ?? 'agent_missing' });
  }
  return { registered, missing, hidden, rejected };
}

/**
 * 取槽值：worker → agentd 的 `MSG.MCP_CONFIG_REQUEST`，**一次 run 只取一次**（§6.1，
 * 与技能同口径：改了市场配置要下一个 run 才生效）。失败**不抛**，回 `{ok:false,error}`。
 * @param {{runId: string, send?: Function, proc?: object, log?: Function,
 *   request?: Function}} options
 */
export function createMcpConfigFetcher({ runId = null, log = null, request } = {}) {
  let cached = null;
  return {
    async fetch() {
      if (cached) return cached;
      const started = Date.now();
      let out;
      if (typeof request !== 'function') {
        // 本站只有一条取道：worker 的 `ipcRequest(MSG.MCP_CONFIG_REQUEST, …)`。
        // 没有 request 就是接线错，降级并留痕（而不是默默假设“无 MCP”是市场空了）。
        out = { ok: false, valuesByName: {}, missing: [], error: 'mcp config request not wired' };
      } else {
        try {
          out = normalizeConfigResponse(await request());
        } catch (err) {
          // §6.1：失败 ⇒ 降级为「本次 run 无 MCP」。**不抛**：MCP 是可选能力，
          // 为一个可选能力把 run 打死是反向的严重性。
          out = { ok: false, valuesByName: {}, missing: [], error: String(err?.message ?? err) };
        }
      }
      cached = out;
      if (log) {
        log(out.ok ? 'info' : 'warn', 'mcp config fetched from agentd', {
          ok: out.ok, servers: out.servers ? out.servers.length : 0, missing: out.missing.length,
          ms: Date.now() - started, ...(out.error ? { error: out.error } : {}),
        });
      }
      return out;
    },
    /** 只为测试与下一 run 服务：同一 worker 进程内可能接到下一个 RUN_START（runId 变了）。*/
    reset() {
      cached = null;
    },
  };
}

/**
 * 归一化 agentd 的 `MCP_CONFIG_RESPONSE`。值的三种给法都接受（对上行形状的容错 = 对
 * portal 演进的容错），取不到值就是没值：
 *   `servers:[{name, values:{SLOT:v}}]` / `{name, slots:[{name,value}]}` / `{name, env:{SLOT:v}}`。
 */
export function normalizeConfigResponse(msg) {
  const ok = msg?.ok === true;
  const list = Array.isArray(msg?.servers) ? msg.servers : [];
  const valuesByName = {};
  for (const entry of list) {
    const name = typeof entry?.name === 'string' ? entry.name : null;
    if (!name) continue;
    const bag = {};
    if (entry.values && typeof entry.values === 'object') {
      for (const [k, v] of Object.entries(entry.values)) if (typeof v === 'string') bag[k] = v;
    }
    if (entry.env && typeof entry.env === 'object') {
      for (const [k, v] of Object.entries(entry.env)) if (typeof v === 'string') bag[k] = v;
    }
    if (Array.isArray(entry.slots)) {
      for (const s of entry.slots) {
        if (s && typeof s.name === 'string' && typeof s.value === 'string') bag[s.name] = s.value;
      }
    }
    valuesByName[name] = { ...valuesByName[name], ...bag };
  }
  return {
    ok,
    servers: list,
    valuesByName,
    missing: Array.isArray(msg?.missing) ? msg.missing : [],
    error: ok ? null : String(msg?.error ?? 'agentd 未给出 MCP 配置'),
  };
}

/**
 * run 启动时的**唯一**一次采集：读声明 + 取值 + 组装。
 * 返回值直接喂 `createMcpPool`，`hidden`/`missing` 另喂 `createMcpTool` 与记账日志。
 * @returns {Promise<{status: string, servers: Array<object>, missing: Array<object>,
 *   hidden: string[], rejected: Array<object>, note: string|null}>}
 */
export async function loadMcpServers({
  home = process.env.HOME || '/home/erix',
  fsImpl = DEF_FS,
  fetchConfig = null,
  log = null,
} = {}) {
  const conf = readMcpConfig({ home, fsImpl });
  if (conf.status !== 'ok') {
    // 文件读不到（含「市场还是空的」）是**正常态**：静默降级，一条 info 记账。
    if (log) log('info', 'mcp config not available, run continues without mcp', { status: conf.status });
    return { status: conf.status, servers: [], missing: [], hidden: [], rejected: [], note: conf.note };
  }
  const needsValues = conf.servers.some((s) => allSlots(s).length > 0);
  let fetched = { ok: true, valuesByName: {}, missing: [], error: null };
  if (needsValues && fetchConfig) {
    try {
      fetched = await fetchConfig();
    } catch (err) {
      // 组装层自己也要兜住：`fetchConfig` 往往是 worker 里那条 IPC（通道在收尾竞态里
      // 会直接抛）。**降级层不得假设它的上游已经不抛**——否则一个可选能力就能把 run 打死。
      fetched = { ok: false, valuesByName: {}, missing: [], error: String(err?.message ?? err) };
    }
  }
  if (needsValues && fetched.ok !== true) {
    // 取不到值就**整体不注册**：一个连不上 hub 的 server 配上空凭据去调，只会以 401 收场，
    // 而模型从 401 里学不到「凭据没拿到」这件事（§6.1 的降级口径）。
    if (log) log('warn', 'mcp config unavailable, run continues without mcp', { error: fetched.error });
    return {
      status: 'config_unavailable', servers: [], missing: [], hidden: [], rejected: [],
      note: fetched.error ?? 'config fetch failed',
    };
  }
  const combined = combineServers({
    servers: conf.servers,
    valuesByName: fetched.valuesByName ?? {},
    missingFromAgent: fetched.missing ?? [],
  });
  if (log) {
    log('info', 'mcp servers assembled', {
      declared: conf.servers.length,
      registered: combined.registered.length,
      missing: combined.missing.length,
      hidden: combined.hidden.length,
      reserved_rejected: combined.rejected.length,
    });
  }
  return {
    status: 'ok',
    servers: combined.registered,
    missing: combined.missing,
    hidden: combined.hidden,
    rejected: combined.rejected,
    note: conf.note,
  };
}

/**
 * `MSG.MCP_PROCESS` 上行（§6.8）：worker 在 spawn/exit 时报 pgid，agentd 记账后在**每一条**
 * worker 终止路径上补杀。与 `MSG.SHELL_LIVENESS` 同类：**宿主内部信号，绝不得走 emitEvent**
 * （否则多出一条 run_events/U3 事件，污染用户可见事件流）。
 */
export function createProcessReporter({ runId = null, send = (m) => sendIpc(null, m) } = {}) {
  return (ev) => {
    if (!ev || (ev.phase !== 'spawn' && ev.phase !== 'exit')) return false;
    return send({
      type: MSG.MCP_PROCESS,
      run_id: runId,
      phase: ev.phase,
      pgid: ev.pgid,
      name: ev.name ?? null,
    });
  };
}
