// FDE Station P1 mock LLM 网关（dev-only，零真实凭据）。
// OpenAI-compatible 最小实现：POST /v1/chat/completions（流式 SSE + 非流式）。
// 依据：docs/design/deploy-contract.md §7.3、docs/design/fde-platform.md §11。
// 红线：不持任何真实 LLM key、不访问任何上游；虚拟 key 只做形态校验（erix-* 占位形态，P1 不做额度）。
//
// issue #38 Phase C：GET /__debug/last-request —— **dev/验收专用**调试端点，返回内存中最近一次
// chat 请求的 { authorization, model, ts }（无请求 → 204）。仅 e2e 注入链路断言使用；生产网关
// （P3 LiteLLM）不存在此端点。记录只在内存、不落盘、不含会话内容。
import http from 'node:http';

const PORT = Number(process.env.PORT || 4000);
// 可选人为延迟（ms）：让 mock 完成请求变慢，供 e2e 真机崩溃恢复在 run 进行中重启容器（默认 0 无延迟）。
const LATENCY_MS = Math.max(0, Number(process.env.MOCK_LATENCY_MS || 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// P1 虚拟 key 形态：接受 erix-placeholder / erix-mock / erix-<任意> 形态，拒绝其它（fde-platform §11.3）。
const VIRTUAL_KEY_RE = /^erix-[a-z0-9_-]+$/i;

// issue #38 Phase C（dev/验收专用）：最近一次 chat 请求的记录（GET /__debug/last-request 返回）。
let lastRequest = null; // { authorization: string|null, model: string|null, ts: number }

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function extractUserContent(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const last = msgs[msgs.length - 1];
  if (last && typeof last.content === 'string') return last.content;
  if (last && Array.isArray(last.content)) {
    return last.content
      .map((p) => (typeof p === 'string' ? p : p?.text ?? ''))
      .join('');
  }
  return '';
}

/** 固定假响应：回显最后一条用户消息 + 固定 token 计数（无真实模型调用）。 */
function mockContent(userContent) {
  const echo = userContent ? `（mock 回显）${userContent}` : '（mock）no user message';
  return `${echo}\n\n这是 P1 零凭据 mock 网关的固定响应，未调用任何真实 LLM。`;
}

// ---- tool_calls 支持（WP5 UI 验收：触发词让 agent 真实执行工具，验证浏览器工具卡片渲染） ----
const TOOL_TRIGGER_RE = /用工具|USE_TOOL/i;
const MOCK_TOOL = { id: 'call_mock_tree_1', name: 'tree', args: '{"path":"."}' };

function messagesHaveToolResult(messages) {
  return (Array.isArray(messages) ? messages : []).some((m) => m?.role === 'tool');
}

function mockToolCall() {
  return [{ index: 0, id: MOCK_TOOL.id, type: 'function', function: { name: MOCK_TOOL.name, arguments: MOCK_TOOL.args } }];
}

function mockFinalAfterTool() {
  return '（mock）已执行 tree 工具：目录结构与预期一致。这是工具卡片链路的固定收尾响应。';
}

function usageFor(body) {
  const promptTokens = Math.max(1, Math.ceil(JSON.stringify(body?.messages ?? []).length / 4));
  const completionTokens = 24;
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
}

function completionChunk(id, model, content, { finish = null, delta = false } = {}) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: delta ? { role: 'assistant', content } : {},
        message: delta ? undefined : { role: 'assistant', content },
        finish_reason: finish,
      },
    ],
  };
}

function handleChat(req, res) {
  const auth = req.headers.authorization || '';

  // 先读 body 再校验 key（Phase C 调整）：调试记录要在 401 路径也能拿到 model——注入链路 e2e
  // 用真 key 形态（过不了 VIRTUAL_KEY_RE，mock 按设计 401），注入断言靠本记录而非响应。
  // 唯一行为差异：「非法 JSON + 非法 key」组合从 401 变为 400（先解析后校验）；合法 JSON 路径不变。
  readJson(req)
    .then(async (body) => {
      // dev/验收调试（issue #38 Phase C）：无论校验成败都记录最近一次请求（不含任何会话内容）。
      lastRequest = {
        authorization: auth || null,
        model: typeof body?.model === 'string' ? body.model : null,
        ts: Date.now(),
      };
      const m = /^Bearer\s+(.+)$/i.exec(auth);
      const key = m ? m[1].trim() : '';
      if (!VIRTUAL_KEY_RE.test(key)) {
        return sendJson(res, 401, {
          error: { message: 'invalid virtual key', type: 'invalid_request_error', code: 'invalid_api_key' },
        });
      }
      if (LATENCY_MS > 0) await sleep(LATENCY_MS);
      const model = body.model || 'mock-model';
      const id = `chatcmpl-mock-${Date.now().toString(36)}`;
      const stream = body.stream === true;
      const msgs = Array.isArray(body?.messages) ? body.messages : [];
      // 三态：① 对话含 tool 结果 → 收尾文本；② 用户消息带触发词 → 发 tool_call；③ 其它 → 固定回显。
      const mode = messagesHaveToolResult(msgs) ? 'final'
        : TOOL_TRIGGER_RE.test(extractUserContent(body)) ? 'tool_call' : 'echo';
      const content = mode === 'final' ? mockFinalAfterTool() : mockContent(extractUserContent(body));

      if (!stream) {
        if (mode === 'tool_call') {
          return sendJson(res, 200, {
            id,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, message: { role: 'assistant', tool_calls: mockToolCall() }, finish_reason: 'tool_calls' }],
            usage: usageFor(body),
          });
        }
        return sendJson(res, 200, {
          id,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: usageFor(body),
        });
      }

      // SSE 流式：文本分 3 段发出；tool_call 模式单帧发出后 finish=tool_calls；最后 [DONE]。
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      if (mode === 'tool_call') {
        const tc = completionChunk(id, model, '', { delta: true });
        tc.choices[0].delta = { role: 'assistant', tool_calls: mockToolCall() };
        res.write(`data: ${JSON.stringify(tc)}\n\n`);
        res.write(`data: ${JSON.stringify(completionChunk(id, model, '', { delta: true, finish: 'tool_calls' }))}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      const chunks = [content.slice(0, 12), content.slice(12, 32), content.slice(32) || '（完）'];
      const roleChunk = completionChunk(id, model, '', { delta: true });
      res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);
      let i = 0;
      const timer = setInterval(() => {
        if (i >= chunks.length) {
          clearInterval(timer);
          res.write(`data: ${JSON.stringify(completionChunk(id, model, '', { delta: true, finish: 'stop' }))}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.write(`data: ${JSON.stringify(completionChunk(id, model, chunks[i++], { delta: true }))}\n\n`);
      }, 10);
      req.on('close', () => clearInterval(timer));
    })
    .catch((err) => {
      sendJson(res, 400, { error: { message: err.message, type: 'invalid_request_error', code: 'invalid_json' } });
    });
}

/** 构造 mock 网关 HTTP server（不自动 listen，供测试注入随机端口）。 */
export function createGatewayServer() {
  return http.createServer(handler);
}

function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/v1/models')) {
    if (url.pathname === '/v1/models') {
      return sendJson(res, 200, { object: 'list', data: [{ id: 'mock-model', object: 'model', owned_by: 'station' }] });
    }
    return sendJson(res, 200, { status: 'ok' });
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    return handleChat(req, res);
  }
  // issue #38 Phase C（dev/验收专用，生产网关 P3 LiteLLM 无此端点）：返回最近一次 chat 请求记录。
  if (req.method === 'GET' && url.pathname === '/__debug/last-request') {
    if (lastRequest == null) {
      res.writeHead(204);
      res.end();
      return;
    }
    return sendJson(res, 200, lastRequest);
  }
  return sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error', code: 'not_found' } });
}

// 直接以脚本方式运行时监听（Docker 入口 / 本地联调）。
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  createGatewayServer().listen(PORT, '0.0.0.0', () => {
    // eslint-disable-next-line no-console
    console.log(`[mock-llm] listening on :${PORT} (zero-credential OpenAI-compatible mock)`);
  });
}
