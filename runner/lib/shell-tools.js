// station shell 工具（issue #72 v1）：给 runner worker 加进程内命令执行能力。
// runner worker 工具面此前 = file 工具 + note_*（runner/worker.js 只注册 fileTools），无命令执行能力；
// issue #71 清退 code-server 后，agent 是 FDE 唯一执行主体，本工具补齐验证闭环（构建/测试跑通再交付）。
//
// 安全模型（v1，已在 issue #72 拍板，勿自行改动）：
//   - shell 有意越过 worktree 文件牢笼——容器是信任边界（不变式 1）；文件 jail 只管 file 工具，
//     不约束本工具（cwd 仅做词法 `..` 逃逸拒绝，防模型笔误，不做 symlink/realpath 防御）。
//   - 出口管控归安全团队网络层（runner-integration.md §11）。
//   - 审批 v1 = 自动执行 + 既有 tool_use/tool_result 事件审计；runToolLoop approvals 钩子
//     留作后续交互式审批槽位（本文件不接）。
//   - env 继承 worker 进程 env：worker fork 时 agentd 已剔除 ERIX_STATION_TOKEN（agentd.js §11），
//     worker 不持任何平台凭据；LLM key 走 config.json 占位（§6.3），不在 env。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { onAbort } from './abort.js';

// 三件套 env 可调（issue #84 配套，2026-09-24）：长构建场景可放宽默认超时；
// DEFAULT 自动钳到 ≤ MAX（防误配出「默认即非法」）。
const DEFAULT_TIMEOUT_MS = Math.min(
  parseIntEnv(process.env.ERIX_SHELL_TIMEOUT_MS, 60_000, { min: 1_000, max: 3_600_000 }),
  parseIntEnv(process.env.ERIX_SHELL_MAX_TIMEOUT_MS, 600_000, { min: 1_000, max: 3_600_000 }),
);
const MAX_TIMEOUT_MS = parseIntEnv(process.env.ERIX_SHELL_MAX_TIMEOUT_MS, 600_000, { min: 1_000, max: 3_600_000 });
const MAX_OUTPUT_BYTES = parseIntEnv(process.env.ERIX_SHELL_OUTPUT_MAX_BYTES, 32 * 1024, { min: 1024, max: 1024 * 1024 });

function parseIntEnv(raw, defaultValue, { min, max }) {
  const n = Number(raw);
  if (raw === undefined || raw === null || raw === '' || !Number.isInteger(n) || n < min || n > max) {
    return defaultValue;
  }
  return n;
}
// 输出截断：保留尾部最多 32KiB + 头部截断标记（报错/测试摘要都在尾部，头部舍弃）。
// （MAX_OUTPUT_BYTES 已上移至 env 解析段，与三件套同处定义）
const TRUNCATION_MARKER = `[... output truncated, showing last ${MAX_OUTPUT_BYTES} bytes ...]`;

const schema = {
  name: 'shell',
  description: 'Run a shell command with bash -c inside the run container. '
    + 'Use for verification (build/test/lint) before delivering. '
    + 'Commands run with worker privileges; do not modify state outside the worktree. '
    + 'Output is truncated to the last 32KiB.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Command line passed to bash -c.' },
      cwd: { type: 'string', description: 'Working directory, relative to the worktree root (default: root).' },
      timeout_ms: { type: 'integer', description: `Timeout in ms (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).` },
    },
    required: ['command'],
    additionalProperties: false,
  },
};

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`)
      && relative !== '..'
      && !path.isAbsolute(relative));
}

function normalizeTimeoutMs(value) {
  if (value === undefined || value === null) return DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`shell: timeout_ms must be a positive number, got ${JSON.stringify(value)}`);
  }
  // 上限封顶而非拒绝：超上限按上限执行（v1 拍板语义）。
  return Math.min(Math.floor(value), MAX_TIMEOUT_MS);
}

function resolveWorkDir(root, cwd) {
  if (cwd === undefined || cwd === null || cwd === '' || cwd === '.') return root;
  if (typeof cwd !== 'string') {
    throw new TypeError('shell: cwd must be a worktree-relative path string');
  }
  if (path.isAbsolute(cwd)) {
    throw new Error(`shell: cwd must be relative to the worktree root, got absolute path: ${cwd}`);
  }
  const resolved = path.resolve(root, cwd);
  if (!isWithin(root, resolved)) {
    throw new Error(`shell: cwd escapes worktree root: ${cwd}`);
  }
  return resolved;
}

function formatResult({ exitCode, durationMs, truncated, output, timedOut = false, spawnError = null }) {
  const header = [
    `exit_code: ${exitCode === null ? 'null' : exitCode}${timedOut ? ' (timed out, process group killed)' : ''}`,
    `duration_ms: ${Math.round(durationMs)}`,
    `truncated: ${truncated}`,
    ...(spawnError ? [`error: ${spawnError}`] : []),
  ].join('\n');
  return `${header}\n${truncated ? `${TRUNCATION_MARKER}\n` : ''}${output}`;
}

/**
 * 中止专用错误：形状对齐上游 erix-agent abort.js 的 AbortError（name='AbortError'），
 * 并带 code='aborted' / commandAborted 标供上层识别。
 * ⚠ 不直接复用 signal.reason 对象改 message：Node 默认 reason 是 DOMException，其 message 是
 * 原型上的只读 getter，ESM 严格模式下赋值会抛 TypeError——所以一律新建 Error，reason 只挂 cause。
 */
function abortFailure(signal, capturedBytes) {
  const error = new Error(
    `shell: aborted by host signal, process group SIGKILLed`
    + ` (captured ${capturedBytes} bytes before abort)`,
  );
  error.name = 'AbortError';
  error.code = 'aborted';
  error.commandAborted = true;
  if (signal?.reason !== undefined) error.cause = signal.reason;
  return error;
}

/**
 * 进程内执行命令：spawn('bash', ['-c', command], { cwd, detached: true })。
 * 超时与中止共用同一条进程组 SIGKILL 路径（detached + process.kill(-pid)，防孑遗子进程——与 agentd M2 同款）；
 * stdout/stderr 各自累计后拼接（stdout 在前）；spawn 失败返回结构化错误文本（不抛）。
 *
 * issue #211：新增 signal（来自 run 的 abortController，经 worker.js executeTool 包装→context 转入）。
 * abort 时：① 进进程组 SIGKILL；② 清超时定时器（不留一个已无意义的 60s~3600s 定时器）；
 * ③ 摘 abort 监听（防长 run 多次调用在下行 signal 上越积越多监听）；
 * ④ 等 child 'close' 才 reject——保证「promise 落定 = 子进程真没了」，不在报告里留下孤儿。
 * @returns {Promise<string>} 格式化文本：exit_code/duration_ms/truncated 头 + 输出体；中止则 reject(AbortError)。
 */
function runCommand({ command, workDir, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    // 已中止（或 abort 比 spawn 更早）：直接不 spawn，免得杀一个刚出生的进程。
    if (signal?.aborted === true) {
      reject(abortFailure(signal, 0));
      return;
    }
    let child;
    try {
      // env 不传 = 继承 worker 进程 env（§11 已剔除平台凭据）。
      child = spawn('bash', ['-c', command], { cwd: workDir, detached: true });
    } catch (err) {
      resolve(formatResult({
        exitCode: null,
        durationMs: Date.now() - startedAt,
        truncated: false,
        output: '',
        spawnError: `spawn failed: ${String(err?.message ?? err)}`,
      }));
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout?.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk) => stderrChunks.push(chunk));

    let timedOut = false;
    let aborted = false;
    // 超时与中止共用：detached: true → 独立进程组，负 pid 整组 SIGKILL（shell fork 出的 sleep 等一并清）。
    const killProcessGroup = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // 进程可能刚好自然退出（竞态）：忽略，等 close 事件正常收尾。
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup();
    }, timeoutMs);
    // onAbort 返回摘除函数（signal 缺失时为空操作），所有收尾路径必须调用。
    const removeAbortListener = onAbort(signal, () => {
      aborted = true;
      killProcessGroup();
    });

    let spawnError = null;
    child.on('error', (err) => {
      // spawn 失败（bash 不存在等）：error 后无 exit/close，这里直接收尾。
      clearTimeout(timer);
      removeAbortListener();
      if (aborted) {
        reject(abortFailure(signal, 0));
        return;
      }
      resolve(formatResult({
        exitCode: null,
        durationMs: Date.now() - startedAt,
        truncated: false,
        output: '',
        spawnError: `spawn failed: ${String(err?.message ?? err)}`,
      }));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      removeAbortListener();
      // stdout/stderr 各自累计后拼接。
      const combined = Buffer.concat([...stdoutChunks, ...stderrChunks]);
      // 中止优先于超时/退出码：命令是被宿主叫停的，不是一条「跑完了的命令」，
      // 把它当成正常 tool_result 喂给模型会谎报结果（exit_code: null 看起来像命令自己挂了）。
      if (aborted) {
        reject(abortFailure(signal, combined.length));
        return;
      }
      const truncated = combined.length > MAX_OUTPUT_BYTES;
      // 保留尾部最多 32KiB；从字节边界切，尾部多字节 UTF-8 可能被切断——可接受（标记已明示截断）。
      const tail = truncated ? combined.subarray(combined.length - MAX_OUTPUT_BYTES) : combined;
      resolve(formatResult({
        exitCode: timedOut ? null : code,
        durationMs: Date.now() - startedAt,
        truncated,
        output: tail.toString('utf8'),
        timedOut,
        spawnError,
      }));
    });
  });
}

/**
 * 创建 shell 工具（结构与 file-tools.js 同构：{schemas, executors}，worker.js 直接并入 registry）。
 * @param {{worktreeRoot:string}} options worktree 绝对根路径（RUN_START.cwd）。
 * @returns {{schemas:object[], executors:Record<string, Function>}}
 */
export function createShellTools({ worktreeRoot }) {
  if (typeof worktreeRoot !== 'string' || worktreeRoot.length === 0) {
    throw new TypeError('createShellTools: worktreeRoot must be a non-empty string');
  }
  // realpath 一次定根；cwd 参数只做词法 resolve + isWithin（shell 有意越笼，不做 realpath 防御）。
  const root = fs.realpathSync(path.resolve(worktreeRoot));

  // issue #211：第二参 context 是引擎经 registry 原样下传的（registry.js:143 executor(input, context)），
  // run 的 abort signal 由 worker.js executeTool 包装注入到 context.signal。不传 signal 时
  // 行为与修前逐字一致（无中止能力，只有超时），保证存量调用方/单测路径零行为变化。
  async function shell({ command, cwd, timeout_ms: timeoutMs } = {}, context = {}) {
    if (typeof command !== 'string' || command.length === 0) {
      throw new TypeError('shell: command must be a non-empty string');
    }
    const workDir = resolveWorkDir(root, cwd);
    const timeout = normalizeTimeoutMs(timeoutMs);
    return runCommand({ command, workDir, timeoutMs: timeout, signal: context?.signal });
  }

  return {
    schemas: [structuredClone(schema)],
    executors: { shell },
  };
}
