// FDE Station P1 mock LLM 网关（dev-only，零真实凭据）。
// OpenAI-compatible 最小实现：POST /v1/chat/completions（流式 SSE + 非流式）。
// 依据：docs/design/deploy-contract.md §7.3、docs/design/fde-platform.md §11。
// 红线：不持任何真实 LLM key、不访问任何上游；虚拟 key 只做形态校验（erix-* 占位形态，P1 不做额度）。
import http from 'node:http';

const PORT = Number(process.env.PORT || 4000);
// P1 虚拟 key 形态：接受 erix-placeholder / erix-mock / erix-<任意> 形态，拒绝其它（fde-platform §11.3）。
const VIRTUAL_KEY_RE = /^erix-[a-z0-9_-]+$/i;

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
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  const key = m ? m[1].trim() : '';
  if (!VIRTUAL_KEY_RE.test(key)) {
    return sendJson(res, 401, {
      error: { message: 'invalid virtual key', type: 'invalid_request_error', code: 'invalid_api_key' },
    });
  }

  readJson(req)
    .then((body) => {
      const model = body.model || 'mock-model';
      const id = `chatcmpl-mock-${Date.now().toString(36)}`;
      const content = mockContent(extractUserContent(body));
      const stream = body.stream === true;

      if (!stream) {
        return sendJson(res, 200, {
          id,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: usageFor(body),
        });
      }

      // SSE 流式：分 3 段发出，最后 [DONE]。
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
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
