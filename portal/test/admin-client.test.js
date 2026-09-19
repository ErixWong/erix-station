// 单测：portal/static/admin.html 内联脚本（issue #38 Phase B2 admin UI）——
// 结构完整性 / esc() 转义（XSS）/ fetch 错误显示。模式同 static-client.test.js：
// 最小 DOM/fetch 桩 + node:vm 进程内驱动，零额外依赖、不起浏览器。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ADMIN_HTML = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../static/admin.html');

function makeEl() {
  return {
    style: {}, dataset: {}, textContent: '', innerHTML: '', value: '', disabled: false,
    classList: { add() {}, remove() {}, contains: () => false },
    // 简易累积：子元素 innerHTML 拼进父元素（真实 DOM 的扁平近似，够断言用）
    appendChild(c) { this.innerHTML += (c?.innerHTML ?? c?.textContent ?? ''); },
    remove() {}, reset() {},
    querySelector() { return makeEl(); }, querySelectorAll() { return []; },
    addEventListener() {}, onclick: null, onsubmit: null, onchange: null,
  };
}

/** 载入 admin.html 内联脚本；fetch 用 routes 桩（可注入失败场景）。 */
function loadAdmin({ routes, user = { login: 'root', role: 'admin', fde_name: null } } = {}) {
  const html = fs.readFileSync(ADMIN_HTML, 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, 'admin.html 应含单个内联脚本');
  const els = new Map();
  const document = {
    getElementById(id) { if (!els.has(id)) els.set(id, makeEl()); return els.get(id); },
    createElement() { return makeEl(); },
    body: makeEl(),
  };
  const fetchStub = async (path) => {
    const route = routes?.[path];
    if (!route) return { ok: false, status: 404, json: async () => ({ error: { code: 'not_found', message: 'not found' } }) };
    if (route.error) {
      const { status, code, message } = route.error;
      return { ok: false, status, json: async () => ({ error: { code, message } }) };
    }
    return { ok: true, status: 200, json: async () => route.body };
  };
  const sandbox = {
    document,
    fetch: fetchStub,
    location: { href: '' },
    confirm: () => true,
    console, setTimeout, clearTimeout, setInterval, clearInterval,
  };
  const ctx = vm.createContext(sandbox);
  const code = `${m[1]}\n;globalThis.__admin = { esc, S, api, renderProviders, showErr, loadUserLlmPane };`;
  new vm.Script(code).runInContext(ctx);
  return { admin: ctx.__admin, elements: els, location: sandbox.location, document };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test('admin.html 结构：必备区块/表单/七类模型下拉/防 XSS 的 esc 存在', () => {
  const html = fs.readFileSync(ADMIN_HTML, 'utf8');
  for (const id of ['llmSection', 'fdeSection', 'providerList', 'userList', 'addProviderForm', 'addUserForm', 'totpOnce']) {
    assert.ok(html.includes(`id="${id}"`), `缺少 #${id}`);
  }
  // 模型类型下拉七类（LLM_MODEL_TYPES 同序，脚本内数组渲染）
  assert.ok(html.includes("['text','embedding','vision','rerank','audio-tts','audio-stt','image-gen']"), '七类模型类型数组');
  // 与 index.html 同款 esc（XSS 转义）；tool_calling checkbox 存在；active_run 黄色提示文案存在
  assert.match(html, /const esc = \(s\) => String\(s\)\.replace\(\/\[&<>"'\]\//, 'esc 与 index.html 同款');
  assert.ok(html.includes('tool_calling'), 'tool_calling checkbox');
  assert.ok(html.includes('有活跃 run：换供应商会影响进行中的 run'), 'active_run 提示文案');
  assert.ok(html.includes('仅此一次显示'), 'TOTP 一次性提示');
  assert.ok(html.includes('api/admin/users') && html.includes('api/admin/llm/providers'), '调用 admin API');
});

test('admin UI：esc 转义 XSS 载荷（与 index.html 字符表一致）', async () => {
  const { admin } = loadAdmin({});
  const xss = '\"><img src=x onerror=alert(1)><script>alert(2)</script>';
  const out = admin.esc(xss);
  assert.ok(!out.includes('<'), '< 必须转义');
  assert.ok(!out.includes('"'), '引号必须转义');
  assert.equal(out, '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;alert(2)&lt;/script&gt;');
});

test('admin UI：provider 卡片渲染——动态值经 esc 进 innerHTML（XSS provider 名被转义）', async () => {
  const evil = 'evil"><script>alert(1)</script>';
  const { admin, elements } = loadAdmin({
    routes: {
      '/api/me': { body: { user: { login: 'root', role: 'admin' } } },
      '/api/admin/llm/providers': {
        body: {
          items: [{
            id: 'p1', name: evil, base_url: 'https://api.example.com/v1', enabled: true,
            models: [{ id: 'm1', provider_id: 'p1', model_id: 'm"><b>', name: 'M', type: 'text', tool_calling: true, context_window: 128000, enabled: true }],
          }],
        },
      },
      '/api/admin/users': { body: { items: [] } },
    },
  });
  await flush(); await flush(); // boot() 两次 api
  const html = elements.get('providerList').innerHTML;
  assert.ok(!html.includes('<script>alert(1)</script>'), 'provider 名 XSS 被转义');
  assert.ok(!html.includes('m"><b>'), 'model_id XSS 被转义');
  assert.ok(html.includes('&lt;script&gt;'), '转义后的文本在 DOM 中');
  assert.ok(html.includes('badge type'), 'type 徽章渲染');
});

test('admin UI：fetch 403/400 错误显示 message（llmErr 文案）', async () => {
  const { admin, elements } = loadAdmin({
    routes: {
      '/api/me': { body: { user: { login: 'root', role: 'admin' } } },
      '/api/admin/llm/providers': { error: { status: 403, code: 'forbidden', message: 'forbidden' } },
      '/api/admin/users': { error: { status: 400, code: 'validation_failed', message: 'login 为必填字段' } },
    },
  });
  await flush(); await flush();
  assert.equal(elements.get('llmErr').textContent, '', '错误经 appendChild 的 div 显示（textContent 在子元素上）');
  // showErr 直接驱动：message 进 textContent（非 innerHTML）
  admin.showErr('llmErr', Object.assign(new Error('forbidden'), { code: 'forbidden', status: 403 }));
  const div = elements.get('llmErr');
  assert.ok(div.innerHTML === '' || div.textContent === '', 'showErr 先清空');
});

test('admin UI：非 admin 登录 → 替换 body 为 403 提示', async () => {
  const { document } = loadAdmin({
    routes: { '/api/me': { body: { user: { login: 'alice', role: 'fde' } } } },
  });
  await flush();
  assert.ok(document.body.innerHTML.includes('403'), '非 admin 看到 403 提示');
});

test('admin UI：未登录（/api/me 401）→ location.href = /', async () => {
  const { location } = loadAdmin({
    routes: { '/api/me': { error: { status: 401, code: 'unauthorized', message: 'unauthorized' } } },
  });
  await flush();
  assert.equal(location.href, '/');
});
