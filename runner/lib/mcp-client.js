// runner/lib/mcp-client.js —— MCP 通道 P1 的**传输层**（issue #608 §1 + §6.2）
//
// 为什么宿主自己写客户端：`erix-llm-kit/docs/requirements.md:45` 把 MCP 列为**永久非目标**
// ⇒ 上游不会给我们一个 MCP client（§0 结论 1）。本站只实现 §1 表里的最小集：
// `initialize` → `notifications/initialized` → `tools/list` / `tools/call` /
// `notifications/cancelled`，resources / prompts / sampling / elicitation / OAuth 一律不做（§12）。
//
// 三条会在重构里被悄悄改坏的语义，注释点名留住：
//   ① **`tools/call` 永不重试**（§0 结论 6 / §10.4）：工具可能已经执行完副作用，
//      重试 = 把「删掉全部」跑两遍。只有 `initialize` / `tools/list` 允许一次重试。
//   ② **子进程 `detached:true` 自成进程组**（§0 结论 5）：它**不随 worker 退出**，
//      所以 spawn/exit 必须经 `onProcess` 上报给 worker → `MSG.MCP_PROCESS` → agentd 补杀（§6.8）。
//   ③ **凭据只在内存里活一次 run**（§10.2/§10.3）：值来自 agentd 代取（§6.1），
//      本文件的任何日志**只许出现槽位名**，绝不打值（canary 测试会 grep 全部日志）。
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** 客户端声明的协议版本；服务端回别的版本时**接受服务端的**（§1，不重试不报错）。 */
export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MCP_CLIENT_INFO = Object.freeze({ name: 'station-runner', version: '1.0.0' });
/** 单请求默认超时（§1：默认 60 s，1..300000）。 */
export const DEFAULT_TIMEOUT_MS = 60_000;
/** §10.8 硬上限：`timeout_ms` ≤ 300 s，stdio 首帧同值。 */
export const MAX_TIMEOUT_MS = 300_000;
/** stderr 只留末 4 KiB 供报错（§1）：全留会把一个话痨 server 的日志灌进上下文。 */
export const STDERR_KEEP_BYTES = 4 * 1024;
/** 结果内联上限：>20 KiB 掐中间（§6.7，与 pi 同口径）。 */
export const RESULT_INLINE_BYTES = 20 * 1024;
export const RESULT_HEAD_BYTES = 12 * 1024;
export const RESULT_TAIL_BYTES = 8 * 1024;
/** 全文落盘目录：容器内 /tmp，**不落用户项目目录**（§6.7——否则每个大结果都弄脏 D9 那颗灯）。 */
export const RESULT_TMP_DIR = '/tmp/erix-mcp';
/** stdio 子进程环境白名单（§10.9）：**不继承 worker 全量 env**。 */
export const STDIO_ENV_ALLOWLIST = Object.freeze(['PATH', 'HOME', 'LANG', 'TZ', 'TMPDIR']);
/** 连续失败熔断阈值（§6.4）：≥3 次直接 `mcp_unreachable`，不再烧 30 s 超时。 */
export const CIRCUIT_BREAK_FAILURES = 3;
/** `close()` 的 SIGTERM → SIGKILL 宽限（§6.8）。 */
export const CLOSE_GRACE_MS = 200;

/** 运行期错误码（§7.3 运行期那一组 + 取消/坏响应两类本地细分）。 */
export const MCP_ERRORS = Object.freeze({
  UNREACHABLE: 'mcp_unreachable',
  TIMEOUT: 'mcp_call_timeout',
  ABORTED: 'mcp_aborted',
  BAD_RESPONSE: 'mcp_bad_response',
});

function emitLog(log, level, msg, fields) {
  if (typeof log !== 'function') return;
  try {
    log(level, msg, fields ?? {});
  } catch {
    // 日志器坏掉不许把传输层带倒（降级口径同 lib/agents-md.js）。
  }
}

/** 错误对象工厂：`code` 是给工具面/界面看的稳定名字，`message` 是人看的中文说明。 */
export function mcpError(code, message, details) {
  const err = new Error(message);
  err.name = 'McpError';
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

/** §1：单请求超时钳制（默认 60 s、上限 300 s）。非法值退回默认而不是抛——配置写错不该炸 run。 */
export function resolveTimeoutMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(n), MAX_TIMEOUT_MS);
}

/** 槽位名 → HTTP 头名（§4.2：http 只允许 `inject='header'`）。`X_API_KEY` → `x-api-key`。 */
export function headerNameFor(slotName) {
  return String(slotName ?? '').trim().replace(/_/g, '-').toLowerCase();
}

/** 槽位名 → 环境变量名（§4.2：stdio 只允许 `inject='env'`，原名注入）。 */
export function envNameFor(slotName) {
  return String(slotName ?? '').trim();
}

/**
 * stdio 子进程的 env（§10.9）：白名单 + 槽位值，`ERIX_*` / `STATION_*` 一律不传。
 * 为什么不继承全量：worker 的 env 里有平台身份（HOME/FDE_* / git 身份），
 * 第三方 server 拿到就是白送的身份信息；而它**必须**拿到的只有槽位声明的那几个。
 * @param {{server: object, values?: Record<string,string>, baseEnv?: NodeJS.ProcessEnv}} options
 */
export function buildStdioEnv({ server, values = {}, baseEnv = process.env }) {
  const out = {};
  for (const key of STDIO_ENV_ALLOWLIST) {
    const v = baseEnv[key];
    if (typeof v === 'string' && v !== '') out[key] = v;
  }
  for (const slot of server?.slots ?? []) {
    if (slot?.inject !== 'env') continue;
    const name = envNameFor(slot.name);
    const value = values[slot.name];
    if (name && typeof value === 'string' && value !== '') out[name] = value;
  }
  return out;
}

/** http 的注入头（§4.2）：只有 `inject='header'` 的槽位进这里；`Mcp-Session-Id` 由传输层自己管。 */
export function buildHttpHeaders({ server, values = {} }) {
  const out = {};
  for (const slot of server?.slots ?? []) {
    if (slot?.inject !== 'header') continue;
    const name = headerNameFor(slot.name);
    const value = values[slot.name];
    if (name && typeof value === 'string' && value !== '') out[name] = value;
  }
  return out;
}

/** §1 URL 策略：只允许 http / https（`file:`/`gopher:`/`data:` 一律拒）。私网允许。 */
export function assertHttpUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch (err) {
    throw mcpError(MCP_ERRORS.UNREACHABLE, `MCP url 非法：${String(err?.message ?? err)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw mcpError(MCP_ERRORS.UNREACHABLE, `MCP url 协议不允许：${parsed.protocol}（只支持 http/https）`);
  }
  return parsed;
}

/** 日志脱敏的兜底：把值从任何字符串里换成 `***`（§10.3，写日志前调）。 */
export function redactValues(text, values = {}) {
  let out = String(text ?? '');
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== 'string' || value.length < 4) continue;
    out = out.split(value).join(`***${name}`);
  }
  return out;
}

/**
 * stderr 累加并只留末 `maxBytes` **字节**（§1）。
 * 单独抽出且按字节裁：按 `String.length` 裁会在中文上裁出越界的尾巴，而这个上限存在的
 * 目的就是给一个话痨 server 定住内存。越界的半个多字节字符会变成替代符（显示层代价，不是错）。
 */
export function appendStderrTail(tail, chunk, maxBytes = Number.POSITIVE_INFINITY) {
  const merged = `${String(tail ?? '')}${String(chunk ?? '')}`;
  const bytes = Buffer.byteLength(merged, 'utf8');
  if (bytes <= maxBytes) return merged;
  return Buffer.from(merged, 'utf8').subarray(bytes - maxBytes).toString('utf8');
}

// ---------------------------------------------------------------------------
// 结果处理（§6.7）
// ---------------------------------------------------------------------------

/**
 * `tools/call` 的返回体 → 纯文本。
 * 只拼 `content[].type==='text'`；`image` / `resource` ⇒ `[image omitted]`（§6.7）——
 * 本站没有多模态回传通道，把 base64 塞进上下文等于白烧几千 token。
 */
export function flattenToolContent(result) {
  const parts = [];
  const blocks = Array.isArray(result?.content) ? result.content : [];
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block?.type != null) parts.push('[image omitted]');
  }
  if (parts.length === 0 && typeof result?.structuredContent === 'string') parts.push(result.structuredContent);
  return parts.join('\n');
}

/**
 * 超长结果：头 12 KiB + 尾 8 KiB + `…N chars truncated…`，全文另落文件（§6.7）。
 * 掐**中间**而不是掐尾巴：工具结果的结论常常在末尾（列表计数、错误行），尾部是模型最需要的。
 * @returns {{text: string, truncated: boolean, fullPath: string|null}}
 */
export function clipLargeResult(text, { runId, tmpRoot = RESULT_TMP_DIR, fsImpl = fs, rand, log = null } = {}) {
  const full = String(text ?? '');
  if (Buffer.byteLength(full, 'utf8') <= RESULT_INLINE_BYTES) {
    return { text: full, truncated: false, fullPath: null };
  }
  let fullPath = null;
  try {
    const tag = String(runId ?? 'run').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64) || 'run';
    const suffix = (rand ?? (() => randomBytes(4).toString('hex')))();
    fsImpl.mkdirSync(tmpRoot, { recursive: true });
    fullPath = path.join(tmpRoot, `${tag}-${String(suffix).replace(/[^A-Za-z0-9_.-]/g, '_')}.txt`);
    fsImpl.writeFileSync(fullPath, full, 'utf8');
  } catch (err) {
    // 落盘失败只意味着「全文没了」，内联的掐中间版仍要用上（不许因为写不进临时目录就丢结果）。
    emitLog(log, 'warn', `mcp result file write failed: ${String(err?.message ?? err)}`);
    fullPath = null;
  }
  const head = Buffer.from(full, 'utf8').subarray(0, RESULT_HEAD_BYTES).toString('utf8');
  const tail = Buffer.from(full, 'utf8').subarray(Math.max(0, Buffer.byteLength(full, 'utf8') - RESULT_TAIL_BYTES))
    .toString('utf8');
  const dropped = Math.max(0, full.length - head.length - tail.length);
  const marker = `…${dropped} chars truncated…`;
  const tailText = fullPath ? `${marker}\n[全文已存 ${fullPath}（用 readFile 或 shell 的 head/tail 取）]` : marker;
  return { text: `${head}\n${tailText}\n${tail}`, truncated: true, fullPath };
}

// ---------------------------------------------------------------------------
// stdio 传输（§1：换行分隔 JSON-RPC 2.0，stderr 单独收）
// ---------------------------------------------------------------------------

/**
 * @param {{server: object, values?: object, log?: Function, spawnImpl?: Function,
 *   onProcess?: Function, killImpl?: Function, killGraceMs?: number, baseEnv?: object,
 *   delay?: Function, timeoutMs?: number}} options
 */
function createStdioTransport({
  server,
  values = {},
  log = null,
  spawnImpl = nodeSpawn,
  onProcess = () => {},
  // 子进程自己死了（不是我们关的）时把死因上报给上层状态机；上层用它填 `status().error`。
  onExited = () => {},
  killImpl = (pid, sig) => process.kill(pid, sig),
  killGraceMs = CLOSE_GRACE_MS,
  baseEnv = process.env,
  // ⚠ **故意不 `unref()`**：这些定时器是在途请求唯一的生命维持；unref 后「事件循环已干而
  // promise 还挂着」= 测试里成批 `cancelledByParent`，生产里 = worker 可能在请求在途时提前退出。
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  let child = null;
  let stdoutBuf = '';
  let stderrTail = '';
  let nextId = 1;
  let closed = false;
  let gone = null;   // {code, signal} —— 子进程已退出的事实
  const pending = new Map();

  const notifyProcess = (phase, pid) => {
    try {
      onProcess({ phase, pgid: pid, name: server?.name ?? '?' });
    } catch {
      // 记账上报失败不能把传输层带倒（agentd 侧还有兜底扫描）。
    }
  };

  function settleAll(err) {
    for (const [, entry] of pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
    pending.clear();
  }

  function handleLine(line) {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      // 不少 server 会往 stdout 漏一行日志：只记字节数，**不记内容**（内容里可能带值，§10.3）。
      emitLog(log, 'debug', 'mcp stdio line is not JSON-RPC, ignored', { bytes: Buffer.byteLength(trimmed) });
      return;
    }
    if (msg && msg.id !== undefined && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(mcpError(
          MCP_ERRORS.BAD_RESPONSE,
          `MCP 返回错误 ${String(msg.error?.code ?? '?')}：${String(msg.error?.message ?? '未知')}`,
          msg.error,
        ));
      } else entry.resolve(msg.result);
      return;
    }
    // 通知与自发消息（进度、日志）：只数一下，不进上下文。
    emitLog(log, 'debug', 'mcp stdio notification', { method: String(msg?.method ?? '?') });
  }

  function ensureChild() {
    if (child && !gone) return child;
    if (closed) throw mcpError(MCP_ERRORS.UNREACHABLE, 'MCP client 已关闭');
    let spawned;
    try {
      spawned = spawnImpl(server.command, Array.isArray(server.args) ? server.args.map(String) : [], {
        // `detached:true` = 自成进程组 ⇒ 杀它必须打 `-pgid`，也意味着 worker 死了它不会跟着死（§6.8）。
        detached: true,
        env: buildStdioEnv({ server, values, baseEnv }),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      throw mcpError(MCP_ERRORS.UNREACHABLE, `MCP server 启动失败：${String(err?.message ?? err)}`);
    }
    child = spawned;
    if (Number.isInteger(child.pid)) notifyProcess('spawn', child.pid);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdoutBuf += chunk;
      let idx = stdoutBuf.indexOf('\n');
      while (idx >= 0) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        handleLine(line);
        idx = stdoutBuf.indexOf('\n');
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      // 只留末 4 KiB（§1）：留全文等于让一个话痨 server 决定我们的内存上限。
      // 上限在**调用处**写明（而不是当默认参数）：这个函数同时给测试用来自证「按字节裁」。
      stderrTail = appendStderrTail(stderrTail, chunk, STDERR_KEEP_BYTES);
    });
    child.on('exit', (code, signal) => {
      gone = { code, signal };
      // 组长退出**不补刀**：pgid 可能已被 OS 复用（杀掉无关进程组的代价远大于漏杀一个孤儿），
      // 与 shell 子进程组（`agentd.js` 的 `shellPgids`）同一口径。真正的兜底在宿主侧：
      // worker 任何一条终止路径都会过 `killChildGroups`，那里按账本整组补杀（§6.8）。
      notifyProcess('exit', child?.pid ?? 0);
      const why = mcpError(
        MCP_ERRORS.UNREACHABLE,
        `MCP server 进程退出（code=${String(code)} signal=${String(signal)}）`
        + ` stderr_tail=${redactValues(stderrTail, values).slice(-200)}`,
      );
      // 没在途请求时也要把死因报给上层：否则 `status()` 只能回 `ready`，而进程早没了
      // ——运维看 `mcp({action:"status"})` 会得到一个与事实相反的答案。
      onExited(why);
      settleAll(why);
    });
    child.on('error', (err) => {
      gone = { code: null, signal: null };
      const why = mcpError(MCP_ERRORS.UNREACHABLE, `MCP 子进程错误：${String(err?.message ?? err)}`);
      onExited(why);
      settleAll(why);
    });
    return child;
  }

  function writeMessage(msg) {
    const c = ensureChild();
    if (!c.stdin?.writable) throw mcpError(MCP_ERRORS.UNREACHABLE, 'MCP server stdin 不可写');
    c.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  return {
    kind: 'stdio',
    /** 握手：`initialize` → `notifications/initialized`（§1 的顺序，反过来服务端会拒）。 */
    async initialize({ signal, timeoutMs: perCall } = {}) {
      const result = await this.request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: MCP_CLIENT_INFO,
      }, { signal, timeoutMs: perCall });
      // 版本不一致时**接受服务端的**（§1）：记一条日志，不重试——协商不是失败。
      if (result?.protocolVersion && result.protocolVersion !== MCP_PROTOCOL_VERSION) {
        emitLog(log, 'info', 'mcp server negotiated a different protocolVersion, accepted', {
          server: server?.name, theirs: String(result.protocolVersion),
        });
      }
      await this.notify('notifications/initialized', {});
      return result;
    },
    request(method, params, { signal, timeoutMs: perCall } = {}) {
      const limit = resolveTimeoutMs(perCall ?? timeoutMs);
      const id = nextId++;
      const promise = new Promise((resolve, reject) => {
        const finish = (fn, arg) => {
          if (signal) signal.removeEventListener('abort', onAbort);
          fn(arg);
        };
        // 超时后**不重试**（§1）：直接 abort 这一条请求并把它从账上摘掉，
        // 否则迟到的响应会去 resolve 一个模型早就忘了的调用。
        const timer = setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          finish(reject, mcpError(MCP_ERRORS.TIMEOUT, `MCP 请求超时（${method}，${limit} ms）`));
        }, limit);
        const onAbort = () => {
          if (!pending.has(id)) return;
          pending.delete(id);
          // §1：用户点停止时发 `notifications/cancelled`（尽力而为，发不出去也要把 promise 落定）。
          // ⚠ 只在子进程还活着时写：为发一条取消通知而把已死的 server **再 spawn 一次**是白烧。
          if (child && !gone) {
            try {
              child.stdin?.write(`${JSON.stringify({
                jsonrpc: '2.0',
                method: 'notifications/cancelled',
                params: { requestId: id, reason: 'host abort' },
              })}\n`);
            } catch { /* 通道已死：没得通知 */ }
          }
          finish(reject, mcpError(MCP_ERRORS.ABORTED, `MCP 请求被宿主中止（${method}）`));
        };
        // 账必须**先登记再写帧**：响应可能在 `write()` 的同一个调用栈里就回来（测试里的假
        // server 就是同进程 PassThrough），晚一步登记就等于把响应认成 notification 扔掉，
        // 然后干等到超时——这条不是理论风险，是实测到的。
        const entry = {
          timer,
          resolve: (v) => finish(resolve, v),
          reject: (e) => finish(reject, e),
        };
        pending.set(id, entry);
        if (signal) {
          if (signal.aborted) {
            clearTimeout(timer);
            pending.delete(id);
            reject(mcpError(MCP_ERRORS.ABORTED, `MCP 请求被宿主中止（${method}）`));
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
        }
        try {
          writeMessage({ jsonrpc: '2.0', id, method, params: params ?? {} });
        } catch (err) {
          pending.delete(id);
          clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', onAbort);
          reject(err);
        }
      });
      return promise;
    },
    notify(method, params) {
      try {
        // 通知**不携带** id（JSON-RPC 定义），但**要占号**：与请求共用一个计数器，
        // 这样同一条会话上永远不会出现「响应 id 撞车」这种无法归因的歧义。
        nextId += 1;
        writeMessage({ jsonrpc: '2.0', method, params: params ?? {} });
      } catch (err) {
        emitLog(log, 'debug', 'mcp notify dropped', { method, err: String(err?.message ?? err) });
      }
      return Promise.resolve();
    },
    /** §6.8：`stdin.end()` → `SIGTERM(-pgid)` → 200 ms → `SIGKILL(-pgid)`；**幂等**。 */
    async close() {
      if (closed) return;
      closed = true;
      const pid = child?.pid ?? null;
      settleAll(mcpError(MCP_ERRORS.UNREACHABLE, 'MCP client closed'));
      try {
        child?.stdin?.end();
      } catch { /* 已关 */ }
      if (!pid || gone) return;
      try {
        killImpl(-pid, 'SIGTERM');
      } catch { /* ESRCH：自然退出，正常竞态 */ }
      await delay(killGraceMs);
      if (gone) return;
      try {
        killImpl(-pid, 'SIGKILL');
      } catch { /* 同上 */ }
    },
    stderrTail() {
      return redactValues(stderrTail, values);
    },
    get state() {
      return closed ? 'closed' : (gone ? 'exited' : (child ? 'open' : 'idle'));
    },
  };
}

// ---------------------------------------------------------------------------
// streamable HTTP 传输（§1）
// ---------------------------------------------------------------------------

/**
 * SSE 逐帧解析（§1）：只认 `data:` 行，`event:` 行忽略（我们不用 stream 事件）；
 * 遇到 id 匹配的 JSON-RPC 响应就结束并**取消流**（服务端常把 SSE 一直开着，
 * 不主动结束就等于每条请求挂一条永远不关的连接）。
 */
async function readJsonRpcFromResponse(res, id, { log = null } = {}) {
  const contentType = String(res.headers?.get?.('content-type') ?? '');
  if (!contentType.includes('text/event-stream')) {
    const text = await (res.text ? res.text() : Promise.resolve(''));
    if (text === '' || text == null) return null;   // 202/204：通知类请求没有响应体
    try {
      return JSON.parse(text);
    } catch (err) {
      throw mcpError(MCP_ERRORS.BAD_RESPONSE, `MCP HTTP 响应不是 JSON：${String(err?.message ?? err)}`);
    }
  }
  let buf = '';
  const finish = (msg) => {
    // 提前 break 会让 undici 取消剩余流——正是我们要的。
    return msg;
  };
  const handleFrame = (frame) => {
    const dataLines = String(frame).split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart());
    if (dataLines.length === 0) return null;
    const body = dataLines.join('\n').trim();
    if (body === '' || body === '[DONE]') return null;
    try {
      const msg = JSON.parse(body);
      if (msg && (id === undefined || msg.id === id)) return msg;
      // 批次里的**响应数组**（streamable HTTP 允许多路复用一帧）：挑出我们要的那条。
      if (Array.isArray(msg)) return msg.find((m) => m && (id === undefined || m.id === id)) ?? null;
    } catch {
      emitLog(log, 'debug', 'mcp sse frame is not JSON-RPC, ignored', { bytes: Buffer.byteLength(body) });
    }
    return null;
  };
  if (res.body && typeof res.body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of res.body) {
      buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      let sep = buf.indexOf('\n\n');
      while (sep >= 0) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const hit = handleFrame(frame);
        if (hit) return finish(hit);
        sep = buf.indexOf('\n\n');
      }
    }
  } else if (typeof res.text === 'function') {
    const hit = handleFrame(await res.text());
    if (hit) return hit;
  }
  throw mcpError(MCP_ERRORS.BAD_RESPONSE, 'MCP SSE 流里没有匹配的 JSON-RPC 响应');
}

/** 跨 origin 判定（§1 重定向红线）：协议或主机不同就是跨 origin。 */
function sameOrigin(a, b) {
  try {
    return new URL(String(a)).origin === new URL(String(b)).origin;
  } catch {
    return false;
  }
}

/**
 * @param {{server: object, values?: object, log?: Function, fetchImpl?: Function,
 *   timeoutMs?: number}} options
 */
function createHttpTransport({
  server,
  values = {},
  log = null,
  fetchImpl = (...args) => fetch(...args),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  assertHttpUrl(server.url);
  let sessionId = null;
  let nextId = 1;
  let closed = false;
  const injected = buildHttpHeaders({ server, values });
  const injectedNames = Object.keys(injected);

  /**
   * 一次 POST（§1 的头 + 手动跟 3 跳重定向）。
   * 为什么手动跟：`fetch` 默认跟随重定向**不会剥**自定义头，第三方一跳就能把
   * `Authorization` 带到另一个域（§1 红线：跨 origin 必须丢弃注入头）。
   */
  async function post(payload, { signal, timeoutMs: perCall, allowSession = true } = {}) {
    const limit = resolveTimeoutMs(perCall ?? timeoutMs);
    const controller = new AbortController();
    // 两种 abort 必须分清（否则超时会被报成「宿主中止」，运维查不到谁干的）：
    // 自己的定时器 ⇒ `mcp_call_timeout`；外层 signal（用户点停止）⇒ `mcp_aborted`。
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, limit);
    const onOuterAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onOuterAbort, { once: true });
    let url = String(server.url);
    let headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...injected,
    };
    if (allowSession && sessionId) headers['mcp-session-id'] = sessionId;
    let res;
    try {
      for (let hop = 0; ; hop += 1) {
        res = await fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          redirect: 'manual',
          signal: controller.signal,
        });
        const location = res.status >= 300 && res.status < 400 ? res.headers?.get?.('location') : null;
        if (!location) break;
        if (hop >= 3) {
          throw mcpError(MCP_ERRORS.UNREACHABLE, 'MCP HTTP 重定向超过 3 跳');
        }
        const next = new URL(location, url).toString();
        if (!sameOrigin(url, next)) {
          // 丢弃注入头（凭据），只留协议必需的两项 + 会话号。
          const kept = {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          };
          if (allowSession && sessionId) kept['mcp-session-id'] = sessionId;
          headers = kept;
          emitLog(log, 'warn', 'mcp http redirect crossed origin, injected headers dropped', {
            server: server?.name, hop, header_names: injectedNames.join(','),
          });
        } else if (allowSession && sessionId) {
          headers['mcp-session-id'] = sessionId;
        }
        url = next;
      }
    } catch (err) {
      if (err?.code === MCP_ERRORS.UNREACHABLE) throw err;
      if (timedOut) {
        throw mcpError(MCP_ERRORS.TIMEOUT, `MCP HTTP 请求超时（${limit} ms，不重试）`);
      }
      if (signal?.aborted === true || controller.signal.aborted) {
        throw mcpError(MCP_ERRORS.ABORTED, 'MCP HTTP 请求被宿主中止');
      }
      throw mcpError(MCP_ERRORS.UNREACHABLE, `MCP HTTP 请求失败：${redactValues(String(err?.message ?? err), values)}`);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onOuterAbort);
    }
    const sid = res.headers?.get?.('mcp-session-id');
    if (sid) sessionId = sid;   // §1：缓存会话号，后续请求带上
    return res;
  }

  return {
    kind: 'http',
    async initialize({ signal, timeoutMs: perCall } = {}) {
      const req = {
        jsonrpc: '2.0',
        id: nextId++,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: MCP_CLIENT_INFO,
        },
      };
      const res = await post(req, { signal, timeoutMs: perCall, allowSession: false });
      if (!res.ok) {
        throw mcpError(MCP_ERRORS.UNREACHABLE, `MCP 握手失败：HTTP ${res.status}`);
      }
      const msg = await readJsonRpcFromResponse(res, req.id, { log });
      if (msg?.error) {
        throw mcpError(MCP_ERRORS.BAD_RESPONSE, `MCP 握手被拒：${String(msg.error?.message ?? '?')}`);
      }
      if (msg?.result?.protocolVersion && msg.result.protocolVersion !== MCP_PROTOCOL_VERSION) {
        emitLog(log, 'info', 'mcp server negotiated a different protocolVersion, accepted', {
          server: server?.name, theirs: String(msg.result.protocolVersion),
        });
      }
      // 握手成功后才有会话号可带（`allowSession:false` 就是为此）。
      await this.notify('notifications/initialized', {}, { signal, timeoutMs: perCall });
      return msg?.result ?? {};
    },
    async request(method, params, { signal, timeoutMs: perCall } = {}) {
      if (closed) throw mcpError(MCP_ERRORS.UNREACHABLE, 'MCP client 已关闭');
      const id = nextId++;
      const payload = { jsonrpc: '2.0', id, method, params: params ?? {} };
      let res = await post(payload, { signal, timeoutMs: perCall });
      // §1：`404/410` ⇒ 会话已失效 ⇒ 清缓存**重握手一次**（这是唯一允许重试的地方，
      // 且只对 `initialize`/`tools/list` 这类无副作用请求成立；`tools/call` 走下面同样的
      // 分支但**不会重跑**——见 `retryCallOnce`，默认 false）。
      if ((res.status === 404 || res.status === 410) && method !== 'tools/call') {
        sessionId = null;
        await this.initialize({ signal, timeoutMs: perCall });
        res = await post(payload, { signal, timeoutMs: perCall });
      }
      if (res.status === 404 || res.status === 410) {
        sessionId = null;
        throw mcpError(MCP_ERRORS.UNREACHABLE, `MCP 会话已失效：HTTP ${res.status}`);
      }
      if (!res.ok) {
        throw mcpError(MCP_ERRORS.UNREACHABLE, `MCP HTTP ${res.status}（${method}）`);
      }
      const msg = await readJsonRpcFromResponse(res, id, { log });
      if (!msg) return null;
      if (msg.error) {
        throw mcpError(
          MCP_ERRORS.BAD_RESPONSE,
          `MCP 返回错误 ${String(msg.error?.code ?? '?')}：${String(msg.error?.message ?? '未知')}`,
          msg.error,
        );
      }
      return msg.result;
    },
    async notify(method, params, { signal, timeoutMs: perCall } = {}) {
      nextId += 1;   // 同 stdio：通知不带 id，但占号，保证 id 在整条会话上唯一
      try {
        await post({ jsonrpc: '2.0', method, params: params ?? {} }, { signal, timeoutMs: perCall });
      } catch (err) {
        emitLog(log, 'debug', 'mcp notify dropped', {
          method, err: redactValues(String(err?.message ?? err), values),
        });
      }
    },
    async close() {
      // 远端服务没有进程可杀（形态①，§2）：只清会话号，幂等。
      closed = true;
      sessionId = null;
    },
    stderrTail() {
      return '';
    },
    get state() {
      return closed ? 'closed' : (sessionId ? 'open' : 'idle');
    },
  };
}

/** 传输选择：`transport` 缺省时按有没有 `url` 猜（物化器总会写，缺只是旧条目）。 */
export function createTransportFor(server, deps) {
  const kind = server?.transport || (server?.url ? 'http' : 'stdio');
  if (kind === 'http') return createHttpTransport({ server, ...deps });
  if (kind === 'stdio') return createStdioTransport({ server, ...deps });
  throw mcpError(MCP_ERRORS.UNREACHABLE, `MCP transport 不支持：${String(kind)}`);
}

// ---------------------------------------------------------------------------
// client（§6.4 状态机 + §6.7 结果处理 + §6.4 熔断）
// ---------------------------------------------------------------------------

/**
 * @param {{server: object, resolved?: {values?: object}, log?: Function,
 *   spawnImpl?: Function, fetchImpl?: Function, onProcess?: Function, runId?: string,
 *   fsImpl?: object, tmpRoot?: string, killImpl?: Function, baseEnv?: object}} options
 * @returns {{name: string, exposure: string, lifecycle: string, tools: Array<object>,
 *   listTools: Function, callTool: Function, status: Function, close: Function}}
 */
export function createMcpClient({
  server,
  resolved = {},
  log = null,
  spawnImpl,
  fetchImpl,
  onProcess = () => {},
  runId = null,
  fsImpl = fs,
  tmpRoot = RESULT_TMP_DIR,
  killImpl,
  baseEnv = process.env,
  delay,
  transportFactory = createTransportFor,
} = {}) {
  if (!server || typeof server !== 'object') {
    throw mcpError(MCP_ERRORS.UNREACHABLE, 'MCP server 声明缺失');
  }
  const values = resolved?.values && typeof resolved.values === 'object' ? resolved.values : {};
  const timeoutMs = resolveTimeoutMs(server.timeout_ms);
  // URL 在**装配时**就判（§1：只允许 http/https）：拖到第一次调用才报错，模型看到的是
  // 「server 挂了」，而事实是配置根本不可用；`direct` 档的工具已经上了工具面，必须当场拒。
  if ((server.transport || (server.url ? 'http' : 'stdio')) === 'http') assertHttpUrl(server.url);
  /** §6.4 状态机：idle → starting → ready → error（连续 3 次 ⇒ fused，直到 run 结束）。 */
  let state = 'idle';
  let lastError = null;
  let failures = 0;
  let transport = null;
  let tools = Array.isArray(server.tools) ? server.tools.slice() : [];
  let toolsCached = tools.length > 0;
  let closing = null;

  const transportDeps = {
    values, log, spawnImpl, fetchImpl, onProcess, killImpl, baseEnv, delay, timeoutMs,
    // 子进程自己死了（OOM / 自己退出）：把死因留在 `status()` 上，并把状态从 `ready`
    // 拉下来。我们主动 `close()` 引发的那个 exit **不算故障**（否则正常收尾也会报 error）。
    onExited: (err) => {
      lastError = err?.message ?? String(err);
      if (!closing && state !== 'fused' && state !== 'closed') state = 'error';
    },
  };

  async function destroyTransport(t) {
    if (!t) return;
    try {
      await t.close();
    } catch (err) {
      emitLog(log, 'debug', 'mcp transport close failed (ignored)', {
        server: server.name, err: String(err?.message ?? err),
      });
    }
  }

  /**
   * 懒启动 + 一次重试（§6.4）。
   * ⚠ 重试只覆盖「握手」这一段：握手没有用户可见副作用；`tools/call` 从来不在这里重试。
   */
  async function ensureReady({ signal, attempt = 2 } = {}) {
    if (state === 'ready' && transport) return transport;
    // ⚠ `closing` 在 `close()` 里同步置位（promise 还没 settle），所以这里必须**一并挡住**：
    // `closeAll()` 是 `finally` 调的，而引擎收尾与在途工具存在竞态——一个迟到的调用如果
    // 悄悄重新 spawn，就会留下一个谁都不再看的孤儿进程（正是 §6.8 要防的那类泄漏）。
    if (state === 'closed' || closing) {
      throw mcpError(MCP_ERRORS.UNREACHABLE, `MCP server ${server.name} 已随 run 关闭`);
    }
    if (state === 'fused') {
      throw mcpError(MCP_ERRORS.UNREACHABLE, `MCP server ${server.name} 本次 run 已熔断（连续失败 ${failures} 次）`);
    }
    state = 'starting';
    let err = null;
    for (let i = 0; i < attempt; i += 1) {
      if (signal?.aborted === true) throw mcpError(MCP_ERRORS.ABORTED, 'MCP 连接被宿主中止');
      const t = transportFactory(server, transportDeps);
      try {
        await t.initialize({ signal, timeoutMs });
        transport = t;
        state = 'ready';
        failures = 0;
        lastError = null;
        return t;
      } catch (caught) {
        err = caught;
        await destroyTransport(t);
        // 超时不重试：那是服务端在装死，再来一次只是再烧 60 s（§1「超时后 abort 连接，不重试」）。
        if (caught?.code === MCP_ERRORS.TIMEOUT || caught?.code === MCP_ERRORS.ABORTED) break;
      }
    }
    failures += 1;
    lastError = err?.message ?? String(err);
    state = failures >= CIRCUIT_BREAK_FAILURES ? 'fused' : 'error';
    throw err ?? mcpError(MCP_ERRORS.UNREACHABLE, `MCP server ${server.name} 起不来`);
  }

  /** 传输断了（进程退出 / 会话失效）⇒ 回到 error，下次调用重新懒启动（§6.4）。 */
  function markBroken(err) {
    lastError = err?.message ?? String(err);
    failures += 1;
    if (failures >= CIRCUIT_BREAK_FAILURES) state = 'fused';
    else if (state !== 'error') state = 'error';
    const dead = transport;
    transport = null;
    void destroyTransport(dead);
  }

  return {
    name: server.name,
    exposure: server.exposure === 'direct' ? 'direct' : 'deferred',
    // §6.4：`run` 与 `run-keep-alive` 在 P1 **行为相同**（都在 run 内保活、run 收尾统一关）。
    // 这个字段是为 P2 的形态②不返工而存在的，不是死配置。
    lifecycle: server.lifecycle === 'run-keep-alive' ? 'run-keep-alive' : 'run',
    get tools() {
      return tools;
    },
    get timeoutMs() {
      return timeoutMs;
    },
    /** `tools/list`：允许一次重试（§10.4）；成功后的清单并进本地视图（`search`/`call` 的门禁）。 */
    async listTools({ signal } = {}) {
      const askOnce = async (t) => {
        try {
          const result = await t.request('tools/list', {}, { signal, timeoutMs });
          return Array.isArray(result?.tools) ? result.tools : [];
        } catch (err) {
          if (err?.code !== MCP_ERRORS.ABORTED) markBroken(err);
          throw err;
        }
      };
      // 重试点在**这里**而不是 `ensureReady` 里：那里已经带了一次握手重试，
      // 再把整段包一遍就会出现 4 次 `initialize`（§10.4 说的是「一次」）。
      let raw;
      try {
        raw = await askOnce(await ensureReady({ signal }));
      } catch (err) {
        // 超时与中止不重试（§1）；其余（进程死、坏响应）允许一次。
        if (err?.code === MCP_ERRORS.TIMEOUT || err?.code === MCP_ERRORS.ABORTED) throw err;
        raw = await askOnce(await ensureReady({ signal }));
      }
      const list = raw
        .filter((tool) => tool && typeof tool.name === 'string' && tool.name !== '')
        .map((tool) => ({
          name: tool.name,
          description: typeof tool.description === 'string' ? tool.description : '',
          ...(tool.inputSchema && typeof tool.inputSchema === 'object' ? { inputSchema: tool.inputSchema } : {}),
        }));
      // 发现到的清单立刻进本地视图：`search` 与 `call` 的门禁读的就是它（§6.3）。
      // ⚠ **原地改，不要重新赋值**：`createMcpClient` 返回的 `tools` 属性指向这个数组，
      // 而 `pool.list()` / `registerTools()` 读的也是它——`tools = list` 会让外部视图永远停在
      // 创建时那份（真机症状：`mcp({action:"list"})` 报「工具 0 个 [已发现 0 个工具]」，
      // 随后 `call` 报 `mcp_tool_unknown`，而客户端自己明明拿到 2 个工具）。
      tools.length = 0;
      tools.push(...list);
      toolsCached = list.length > 0;
      return list;
    },
    /**
     * `tools/call` —— **永不重试**（§0 结论 6）。
     * @returns {Promise<{text: string, isError: boolean, truncated: boolean, fullPath: string|null}>}
     */
    async callTool(tool, args, { signal } = {}) {
      const t = await ensureReady({ signal });   // 握手段的重试允许，调用本身不允许
      let result;
      try {
        result = await t.request('tools/call', {
          name: tool,
          arguments: args && typeof args === 'object' ? args : {},
        }, { signal, timeoutMs });
      } catch (err) {
        if (err?.code === MCP_ERRORS.BAD_RESPONSE && Array.isArray(err?.details?.content)) {
          // MCP 规范：工具执行失败也走 `result.isError`，但不少服务端发的是 JSON-RPC error + content。
          const text = flattenToolContent(err.details);
          const clipped = clipLargeResult(text, { runId, tmpRoot, fsImpl });
          return { text: clipped.text, isError: true, truncated: clipped.truncated, fullPath: clipped.fullPath };
        }
        if (err?.code !== MCP_ERRORS.ABORTED) markBroken(err);
        throw err;
      }
      const text = flattenToolContent(result);
      const clipped = clipLargeResult(text, { runId, tmpRoot, fsImpl });
      return {
        text: clipped.text,
        isError: result?.isError === true,
        truncated: clipped.truncated,
        fullPath: clipped.fullPath,
      };
    },
    status() {
      return {
        state,
        ...(lastError ? { error: lastError, lastError } : {}),
        toolsCached,
        transport: server.transport || (server.url ? 'http' : 'stdio'),
      };
    },
    /** 幂等（§6.2）：`closeAll()` 会被 `finally` 与 abort 两条路各调一次。 */
    close() {
      if (!closing) closing = destroyTransport(transport).then(() => { state = 'closed'; });
      return closing;
    },
  };
}

// ---------------------------------------------------------------------------
// pool（§6.2）
// ---------------------------------------------------------------------------

/**
 * @param {{servers: Array<object>, missing?: Array<object>, log?: Function,
 *   spawnImpl?: Function, fetchImpl?: Function, onProcess?: Function, runId?: string,
 *   fsImpl?: object, tmpRoot?: string}} options
 * @returns {{get: Function, list: Function, directTools: Function, closeAll: Function,
 *   registerTools: Function, missing: Array<object>}}
 */
export function createMcpPool({
  servers = [],
  missing = [],
  log = null,
  spawnImpl,
  fetchImpl,
  onProcess = () => {},
  runId = null,
  fsImpl = fs,
  tmpRoot = RESULT_TMP_DIR,
  clientFactory = createMcpClient,
} = {}) {
  const clients = new Map();
  for (const server of servers) {
    if (!server || typeof server.name !== 'string' || server.name === '') continue;
    clients.set(server.name, clientFactory({
      server, resolved: server.resolved ?? { values: server.values ?? {} },
      log, spawnImpl, fetchImpl, onProcess, runId, fsImpl, tmpRoot,
    }));
  }
  return {
    missing: Array.isArray(missing) ? missing : [],
    get(name) {
      return clients.get(String(name)) ?? null;
    },
    list() {
      return [...clients.values()].map((c) => ({
        name: c.name,
        exposure: c.exposure,
        lifecycle: c.lifecycle,
        toolCount: c.tools.length,
        tools: c.tools,
        status: c.status(),
      }));
    },
    /** `direct` 的原始工具清单（名字清洗与冲突降级在 `lib/mcp-tool.js`，那是工具面的事）。 */
    directTools() {
      const out = [];
      for (const c of clients.values()) {
        if (c.exposure !== 'direct') continue;
        for (const tool of c.tools) {
          // ⚠ 同一个字面量里不能两次写 `tool:`（后者会盖掉前者）：`tool` 是**工具名**，
          // 原始声明另存 `definition`（direct 展开时要用它的 inputSchema）。
          out.push({
            server: c.name,
            tool: tool?.name,
            description: tool?.description ?? '',
            definition: tool,
          });
        }
      }
      return out.filter((row) => typeof row.tool === 'string' && row.tool !== '');
    },
    /** §6.6：发现到的新工具回填缓存（同时把 `status.toolsCached` 刷成事实）。 */
    registerTools(name, tools) {
      const c = clients.get(String(name));
      if (!c || !Array.isArray(tools)) return false;
      c.tools.length = 0;
      c.tools.push(...tools);
      return true;
    },
    async closeAll() {
      // 并发关：串行关会让第 N 个 server 的 200 ms 宽限乘 N 遍。
      await Promise.all([...clients.values()].map((c) => c.close().catch(() => {})));
    },
  };
}
