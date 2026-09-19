// 探针（issue #22 方案②验收，PR #32 评审 F4/F2 定向复核采用）：heartbeat 401 token_revoked
// 必须成为唯一收敛信号（SSE /stream 保持打开不参与）——验证 beginRevoke 三信号同径。
//   新代码：heartbeat 401 → beginRevoke → 收敛退出（~300ms）→ PROBE_OK
//   旧代码：catch 吞成 warn 无限循环 → 10s 超时 PROBE_FAIL_TIMEOUT
// 跑法：node runner/probes/heartbeat-revoke-probe.mjs（仓库根目录）。⚠️ 必须放在 test/ 目录外：
// node --test 会自动发现 test/**/*.mjs 并执行（copilot 复审抓出，2026-09-19 实测 ok 22 计入套件）——
// 本探针 spawn 子进程 + http server + process.exit，属副作用性文件，不得进套件。
// 负向对照：git show <旧ref>:runner/agentd.js 配 lib 副本跑同探针。
// 探针 v2（issue #22 评审 F4 改造）：SSE /stream 保持打开（200 event-stream），仅 heartbeat 返回
// 401 token_revoked —— heartbeat 401 成为唯一收敛信号。
//   旧代码（main）：heartbeat 401 被 catch 吞成 warn 继续转，agentd 永不退出 → PROBE_FAIL（超时）
//   新代码（beginRevoke）：heartbeat 401 → beginRevoke → abort runs + 收敛退出 → PROBE_OK
import { spawn } from 'node:child_process';
import http from 'node:http';

const server = http.createServer((req, res) => {
  const body = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'POST' && req.url === '/api/internal/claim') return res.writeHead(204).end();
  if (req.method === 'POST' && req.url === '/api/internal/heartbeat') {
    return body(401, { error: { code: 'token_revoked', message: 'token revoked' } });
  }
  if (req.method === 'GET' && req.url === '/api/internal/stream') {
    // SSE：保持打开（客户端断开时才会 end）——不作为收敛信号
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('event: ping\ndata: {"ts":0}\n\n');
    return; // 挂住不 end
  }
  return body(404, { error: { code: 'not_found', message: req.url } });
});
server.on('connection', (socket) => socket.setKeepAlive(true));

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const child = spawn(process.execPath, ['runner/agentd.js'], {
  env: {
    ...process.env,
    ERIX_STATION_TOKEN: 'probe-token',
    ERIX_STATION_BASE_URL: `http://127.0.0.1:${port}/api/internal`,
    ERIX_HEARTBEAT_MS: '300',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });

const timer = setTimeout(() => {
  console.error('PROBE_FAIL_TIMEOUT: agentd 未在 10s 内收敛（旧行为：心跳 401 被吞，永不退出）');
  console.log('--- agentd 输出 ---\n' + out);
  child.kill('SIGKILL');
  process.exit(1);
}, 10000);

child.on('exit', (code) => {
  clearTimeout(timer);
  const gotHeartbeatSignal = out.includes('revoke begin') && out.includes('token_revoked');
  const gotExiting = out.includes('agentd exiting') && out.includes('token_revoked');
  // 接入点回归锚点（审计 #34 评审 A 的变异 ①：删掉 main 尾部的 drainRuns 调用时 npm test 仍全绿）：
  // 退出日志必须带 drain 结果——缺它就是接入点被删/绕过。
  const gotDrainReport = out.includes('"drained"');
  console.log(`exit=${code} heartbeatSignal=${gotHeartbeatSignal} exitingWithRevoke=${gotExiting} drainReport=${gotDrainReport}`);
  if (code === 0 && gotHeartbeatSignal && gotExiting && gotDrainReport) {
    console.log('PROBE_OK: heartbeat 401 token_revoked → beginRevoke → 收敛退出（issue #22 方案②）');
    process.exit(0);
  }
  console.log('--- agentd 输出 ---\n' + out);
  console.error('PROBE_FAIL');
  process.exit(1);
});
