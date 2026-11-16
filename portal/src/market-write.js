// portal/src/market-write.js —— 技能落盘/删除的**降权执行体**（issue #595 评审 MEDIUM/8）
//
// 为什么要有这个文件（一句话：把「root 的手」换成「FDE 的手」）：
//   portal 以 root 运行（portal/Dockerfile `USER root`、deploy-contract §1 PORTAL_RUNTIME_UID=0），
//   而它要写的 `<userSpaceRoot>/<fde>/home/.erix/skills/` 以及**它的每一级祖先**（`~/.erix`、`~/home`…）
//   属主都是 FDE 自己（uid 1000）。root 用**路径式** `writeFileSync` / `rmSync(recursive)` 落盘时，
//   「校验路径」与「真正使用路径」之间有一个窗口：FDE 可以在那中间把某一级换成 symlink，
//   让 root 写到 / 删到用户空间**之外**（典型后果：`skills/<slug>` → `/etc/cron.d/x` ⇒ 容器逃逸成宿主 root）。
//   路径检查补不上这个窗口——它本身就是 check-then-use。
//   **安全来自降权**：调用方 `spawn(..., { uid: fdeUid, gid: fdeGid })` 把动作放到 uid 1000 的身份里执行，
//   于是竞态即便被赢下，写入也只发生在「uid 1000 本来就写得进去」的位置（= 零提权）。
//   （非 root 环境——单测/开发——调用方会跳过 uid/gid，见 market.js 的 `canDropPrivileges()`。）
//
// 纪律：**本文件不含任何业务判断**。没有 slug 规则、没有布局白名单、没有市场语义、不读 config，
//   连「什么是技能目录」都不知道。它只做一件事：把 stdin 上的 JSON 指令逐条翻译成 `fs` 调用。
//   任何「因为 X 所以不许写」的判据都留在 `market.js`（那里才有 config 与 HTTP 错误信封）。
//   反过来也是纪律：这里**不许**加路径策略——策略加在这里就等于把安全边界搬回 check-then-use 那一侧。
//
// 协议（payload 走 **stdin**，不走 argv）：
//   Linux 对**单个** argv 串有 MAX_ARG_STRLEN=128 KiB 的硬限，而 bundle 上限是 2 MiB
//   （`LIMITS.maxTotalBytes`，base64 后约 2.75 MiB）⇒ 塞 argv 会在大包上直接 E2BIG。
//   stdin 没有这个限制，也不进 `/proc/<pid>/cmdline`（包内容不外泄给同容器其他进程）。
//   代价：payload 必须先序列化再喂子进程——所以**不许**改成「父进程写临时文件、子进程去读」，
//   那等于为了省一次管道又引入一条 check-then-use 的路径（本文件存在的理由被自己抵消）。
//
//   { "ops": [
//       { "op": "write",  "path": "/abs/x", "contentBase64": "…", "mode": 420 },  // 0o644
//       { "op": "mkdir",  "path": "/abs/x", "mode": 493 },                        // 0o755，递归
//       { "op": "rename", "from": "/abs/a", "to": "/abs/b" },
//       { "op": "remove", "path": "/abs/x" }                                      // recursive+force
//     ] }
//   成功：exit 0，stdout 一行 JSON `{ ok:true, results:[{ op, path, existed? }] }`
//     （`existed` 只有 `remove` 带，语义是「删之前它在不在」⇒ 调用方用它判卸载幂等，不自己 stat）。
//   失败：exit 1，stderr 一行 JSON `{ ok:false, error, code, op, path, index }`（`code` = errno 名，
//     `index` = 第几条指令，调用方把它们塞进 `capability_install_failed` 的 details）。
//   顺序执行、遇错即停：**原子性由指令序列本身表达**（写完 → rename 就位），
//   所以调用方把「一次安装的整串动作」放进一个 payload，让一次子进程跑完。
import fs from 'node:fs';
import path from 'node:path';

/** payload 上限：bundle 天花板 2 MiB base64 后 ≈2.75 MiB，这里给足余量只为「别无限吃内存」。 */
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
/** 条数上限（`LIMITS.maxFiles`=50 的两步 rename/清理都远小于它；越界说明调用方算错了）。 */
const MAX_OPS = 4096;

const fail = (message, extra = {}) => {
  const e = new Error(message);
  Object.assign(e, extra);
  throw e;
};

function oneOp(op, index) {
  try {
    return runOp(op);
  } catch (e) {
    // 把「哪一条指令、哪个路径」铉在错误上：payload 可以有 20 多条，只报 errno 等于没报。
    if (e.op == null) e.op = op?.op ?? null;
    if (e.path == null) e.path = op?.path ?? op?.to ?? op?.from ?? null;
    if (e.index == null) e.index = index;
    throw e;
  }
}

function runOp(op) {
  if (!op || typeof op !== 'object') fail('op 不是对象', { op: String(op) });
  const { op: kind } = op;
  // 只认绝对路径：相对路径会落在**子进程的 cwd** 上，那等于把「写到哪」交给父进程之外的东西。
  const abs = (p) => {
    if (typeof p !== 'string' || p.length === 0) fail(`${kind} 缺少 path`, { op: kind });
    if (!path.isAbsolute(p)) fail(`${kind} 的 path 不是绝对路径：${p}`, { op: kind, path: p });
    return p;
  };
  switch (kind) {
    case 'write': {
      const p = abs(op.path);
      if (typeof op.contentBase64 !== 'string') fail('write 缺少 contentBase64', { op: kind, path: p });
      const buf = Buffer.from(op.contentBase64, 'base64');
      const mode = Number.isInteger(op.mode) ? op.mode : 0o644;
      fs.writeFileSync(p, buf, { mode });
      // writeFileSync 的 mode 受 umask 影响（§4 要的是确定的 0644）⇒ 显式 chmod 才算数。
      fs.chmodSync(p, mode);
      return { op: kind, path: p };
    }
    case 'mkdir': {
      const p = abs(op.path);
      fs.mkdirSync(p, { recursive: true, mode: Number.isInteger(op.mode) ? op.mode : 0o755 });
      return { op: kind, path: p };
    }
    case 'rename': {
      const from = abs(op.from);
      const to = abs(op.to);
      fs.renameSync(from, to);
      return { op: kind, path: to, from };
    }
    case 'remove': {
      const p = abs(op.path);
      // `existed` 是给调用方判幂等的**唯一**事实来源（父进程不再自己 existsSync）。
      const existed = fs.existsSync(p);
      fs.rmSync(p, { recursive: true, force: true });
      return { op: kind, path: p, existed };
    }
    default:
      return fail(`未知 op：${String(kind)}`, { op: String(kind), path: op?.path });
  }
}

function main() {
  const raw = fs.readFileSync(0);
  if (raw.length > MAX_PAYLOAD_BYTES) {
    fail(`payload 超过上限 ${MAX_PAYLOAD_BYTES} 字节：${raw.length}`, { op: 'payload' });
  }
  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    fail(`payload 不是合法 JSON：${e.message}`, { op: 'payload' });
  }
  const ops = payload?.ops;
  if (!Array.isArray(ops)) fail('payload.ops 不是数组', { op: 'payload' });
  if (ops.length > MAX_OPS) fail(`ops 条数超过上限 ${MAX_OPS}：${ops.length}`, { op: 'payload' });
  const results = ops.map(oneOp);
  process.stdout.write(JSON.stringify({ ok: true, results }));
}

try {
  main();
} catch (e) {
  // 失败面只有一个出口：一行 JSON + 非 0 退出码。业务映射（HTTP 码、错误信封）全在调用方。
  process.stdout.write('');
  process.stderr.write(JSON.stringify({ ok: false, error: e.message, code: e.code ?? null, op: e.op ?? null, path: e.path ?? null, index: e.index ?? null }));
  process.exit(1);
}
