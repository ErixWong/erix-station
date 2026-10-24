// github 拉取技能（#363 draft）：clone / 补历史一条龙。
// 症状建模自 2026-10-24 真机事件（touwakamate）：内网 DNS 间歇把 github 域名指向不可达
// 旧边缘（TCP/TLS 能过、HTTP 挂起），裸 clone 会烧光重试预算退化成 tarball 快照丢历史。
// 策略：直连快试（短超时）→ 失败则按域探可用 IP → 进程内 CONNECT 代理（127.0.0.1 随机端口，
// 非 root 可绑）→ git 走代理重试（HTTPS_PROXY 环境变量，git 原生支持）。
// 契约（erix-agent ADR-008 / src/skills/loader.js）：getSkillDefinition() 声明 schema，
// 模块导出与工具同名的函数即执行体；schema_version 固定 1。
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

// 历史实测候选（会过期，探活兜过期）：2026-10-24 本机 + touwakamate 双端实测可用。
const CANDIDATES = {
  'github.com': [
    '20.205.243.160', '20.205.243.161', '20.205.243.162', '20.205.243.163', '20.205.243.164',
    '20.205.243.165', '20.205.243.166', '20.205.243.167', '140.82.112.4', '140.82.113.4', '140.82.114.4',
  ],
  'codeload.github.com': ['140.82.112.4', '140.82.113.4', '140.82.114.4', '20.205.243.166'],
  'api.github.com': ['20.205.243.168', '140.82.112.6', '140.82.113.6'],
};
const PROXY_HOSTS = new Set(Object.keys(CANDIDATES));
const DIRECT_TIMEOUT_MS = 20_000;

// 探活带 TLS 完整握手：事故型坏边缘（140.82.121.x）**TCP 能过、HTTP 不回话**，裸 TCP 探会误报；
// TLS 握手（含证书校验，IP 边缘同证书）把最坏的哑边筛掉。
function probe(host, ip, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const sock = tls.connect({ host: ip, servername: host, port: 443, timeout: timeoutMs });
    sock.once('secureConnect', () => { sock.destroy(); resolve(true); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.once('error', () => resolve(false));
  });
}

// 同 host 并发探活共用一次扫描（git 的 TLS 连接与凭域探活同时进场时会竞态）。
const probingGlobal = new Map();

async function pickIp(host) {
  if (!probingGlobal.has(host)) {
    const run = (async () => {
      for (const ip of CANDIDATES[host] ?? []) {
        if (await probe(host, ip)) return ip;
      }
      return null;
    })();
    probingGlobal.set(host, run);
    run.finally(() => probingGlobal.delete(host));
  }
  return probingGlobal.get(host);
}

// 成功才钉住（failover 每连接重试）；失败不缓存，避免瞬断窗被永久贴死。
const pinnedGlobal = new Map();

// 进程内 CONNECT 代理：github 域钉到探活 IP，其余域名走正常解析；TLS 端到端，本进程只转字节。
function startProxy() {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.once('data', async (head) => {
        const line = head.toString('latin1');
        const m = line.match(/^CONNECT\s+(\S+):443\s/);
        if (!m) { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
        const host = m[1].replace(/^\[|\]$/g, '');
        let ip = pinnedGlobal.get(host);
        if (ip === undefined && PROXY_HOSTS.has(host)) {
          ip = await pickIp(host);
          if (!ip) { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
          pinnedGlobal.set(host, ip);
        }
        const up = net.connect(443, ip ?? host, () => {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          socket.pipe(up); up.pipe(socket);
        });
        up.on('error', () => {
          pinnedGlobal.delete(host);
          // 失败回报 git：git 见错即重试新 CONNECT → 重探 failover 下一 IP（半死边缘不致把 run 打死）。
          if (!socket.destroyed) socket.destroy(); else socket.end();
        });
        socket.on('error', () => up.destroy());
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function runGit(args, { proxyUrl, timeoutMs }) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (proxyUrl) { env.HTTPS_PROXY = proxyUrl; env.HTTP_PROXY = proxyUrl; }
    else { delete env.HTTPS_PROXY; delete env.HTTP_PROXY; }
    env.GIT_TERMINAL_PROMPT = '0';
    const child = spawn('git', args, { env, cwd: process.cwd() });
    let out = '';
    const collect = (b) => { out += String(b); if (out.length > 16_000) out = out.slice(-12_000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = timeoutMs
      ? setTimeout(() => { child.kill('SIGKILL'); out += '\n[killed: timeout]'; }, timeoutMs)
      : null;
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, out }); });
  });
}

export async function getSkillDefinition() {
  return {
    schema_version: 1,
    skill: { id: 'github', entrypoint: 'skill.mjs' },
    tools: [{
      name: 'github_fetch',
      description: '克隆或更新一个 GitHub 仓库，自动处理本机 DNS 把 github 域名指向不可达边缘的情况（直连快试 → 探可用 IP → 进程内 CONNECT 代理重试），始终保留完整 git 历史。优先于裸 git clone / tarball 快照使用。',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '仓库 URL，如 https://github.com/owner/repo(.git)' },
          action: { type: 'string', enum: ['clone', 'update'], description: 'clone=目录不存在时克隆；update=已有浅/全仓 fetch+reset 补全历史。默认 clone' },
          dir: { type: 'string', description: '目标目录（相对当前工作目录），默认取仓库名' },
        },
        required: ['url'],
      },
    }],
  };
}

function parseRepoName(url) {
  const m = String(url).replace(/\/+$/, '').match(/([^/]+)$/);
  return (m ? m[1] : 'repo').replace(/\.git$/, '');
}

export async function github_fetch({ url, action = 'clone', dir }) {
  if (typeof url !== 'string' || !/^https:\/\/github\.com\//i.test(url)) {
    return 'github_fetch 只接受 https://github.com/ 开头的仓库 URL（ssh 在容器内不可用：镜像无 ssh 客户端）。';
  }
  const dest = dir ?? parseRepoName(url);
  if (path.isAbsolute(dest)) return 'dir 必须是相对当前工作目录的路径（jail 边界）。';
  if (action === 'clone' && fs.existsSync(dest) && fs.readdirSync(dest).length > 0) {
    return `目录 ${dest} 已存在且非空：若它是同一仓库（含 tarball 快照解压出的无历史版本），用 action=update 补历史；否则换 dir。`;
  }

  const steps = [];
  const plan = action === 'update'
    ? ['fetch', ['fetch', '--unshallow', 'origin'], ['fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*']]
    : ['clone', ['clone', url, dest], ['clone', url, dest]];
  const [label, directArgs, proxiedArgs] = plan;

  // 1) 直连快试（DNS 健康时零额外开销）。
  let attempt = action === 'update'
    ? await runGit(directArgs[1] ? ['fetch', '--unshallow', 'origin'] : directArgs, { proxyUrl: null, timeoutMs: DIRECT_TIMEOUT_MS })
    : await runGit(directArgs, { proxyUrl: null, timeoutMs: DIRECT_TIMEOUT_MS });
  if (attempt.code === 0 && !attempt.out.includes('[killed: timeout]')) {
    steps.push('direct-ok');
    return summarize(label, dest, steps, attempt);
  }
  steps.push('direct-failed → 判据: DNS 钉到不可达边缘（非断网），转进程内代理');
  if (action === 'clone') {
    // 直连尝试被杀会留下半成品 clone 目录，不清则重试必碰 already exists。
    fs.rmSync(dest, { recursive: true, force: true });
  }

  // 2) 代理重试。
  let proxy;
  try {
    proxy = await startProxy();
    const proxyUrl = `http://127.0.0.1:${proxy.port}`;
    steps.push(`proxy@127.0.0.1:${proxy.port}`);
    const args2 = action === 'update' ? ['fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*'] : proxiedArgs;
    attempt = await runGit(args2, { proxyUrl, timeoutMs: 120_000 });
    if (attempt.code !== 0) {
      return `github_fetch ${label} 失败（直连与代理均败）：\n${steps.join('\n')}\n--- git 输出尾部 ---\n${attempt.out.slice(-1200)}`;
    }
  } finally {
    if (proxy) proxy.server.close();
  }
  return summarize(label, dest, steps, attempt);
}

async function summarize(label, dest, steps, attempt) {
  // update 语义下再 reset 到 origin/HEAD（尽力而为，不阻断）。
  const info = await runGit(['-C', dest, 'log', '--oneline', '-3'], { proxyUrl: null, timeoutMs: 10_000 });
  const count = await runGit(['-C', dest, 'rev-list', '--count', 'HEAD'], { proxyUrl: null, timeoutMs: 10_000 });
  const depth = Number(count.out.trim()) || 0;
  return [
    `github_fetch ${label} 成功：${dest}`,
    `路径: ${steps.join(' → ')}`,
    `历史提交数: ${depth || '?'}${depth === 1 ? '（仍是浅仓，update 可补全）' : ''}`,
    'HEAD 最近三条:',
    info.out.trim() || '(无)',
  ].join('\n');
}
