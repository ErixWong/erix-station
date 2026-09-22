// 公共 e2e helper（issue #38 收尾）：为指定 FDE 建 mock LLM binding，恢复「run finished」语义。
// 背景：Phase B1 起 LLM 路由 fail-closed——无 `fde_llm_bindings`（必须含 api_key）即无 LLM 路由，
//   未配 binding 的 FDE worker 调 LLM 出口 404 → run 终态 failed。wp3a/wp3b/wp4/wp5 需要本 helper
//   在 provision 之后、发消息/建 run 之前补 binding。
// 步骤：bootstrap break-glass admin（CLI，解析一次性 TOTP 种子）→ 两步登录拿 admin 会话 →
//   admin API 建 provider + model + PUT per-FDE binding（权威样例 wp6-llm-e2e.mjs）→
//   轮询 llm-routes.yml 出现 llm-<fdeName>（Traefik file provider 热加载）。
// 幂等：provider/model 重名 409 → GET 复用已有资源；binding PUT 本身 upsert。
// 注意：provider base_url 必须 http://127.0.0.1:4000（Traefik host 网络，回环即 mock-llm）；
//   默认 apiKey=erix-placeholder（mock 只接受 erix-* 形态，且容器占位 key 同为 erix-placeholder）。
// key 只进请求体/断言，不进日志输出。
import assert from 'node:assert/strict';
import path from 'node:path';
import * as totp from '../../src/totp.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, { timeoutMs = 60000, intervalMs = 500, label = 'condition' } = {}) {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { lastErr = e; }
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}${lastErr ? `: ${lastErr.message}` : ''}`);
}

function readCookie(setCookie) {
  const m = /fde_session_dev=([^;]+)/.exec(setCookie ?? '');
  return m ? m[1] : null;
}

/**
 * 确保 fdeName 的 mock LLM binding 存在且 llm-routes.yml 已发布 llm-<fdeName> 路由。
 * @param {object} opts
 * @param {string} [opts.portal]       portal base URL
 * @param {(args: string) => string} opts.docker  docker 执行器（脚本内 `sg docker -c` 包装，返回 stdout）
 * @param {string} opts.dynamicDir     宿主侧 Traefik 动态目录（llm-routes.yml 所在）
 * @param {string} [opts.llmDynamicFile]
 * @param {string} opts.fdeName
 * @param {string} [opts.portalContainerName]  portal 容器名（F8 并行隔离：缺省 station-portal）
 * @param {string} opts.adminLogin     break-glass admin 登录名（每 e2e 独立，避免冲突）
 * @param {string} opts.adminPassword  break-glass admin 口令（无空格）
 * @param {string} [opts.model]        model_id（mock 忽略模型名，route 存在即可跑通）
 * @param {string} [opts.apiKey]       上游 key（默认 erix-placeholder：mock 只认 erix-* 形态）
 * @param {string} [opts.baseUrl]      provider base_url（默认 mock-llm 宿主回环）
 */
export async function ensureMockLlmBinding({
  portal = 'http://127.0.0.1:18080',
  docker,
  dynamicDir,
  llmDynamicFile = 'llm-routes.yml',
  fdeName,
  portalContainerName = 'station-portal',
  adminLogin,
  adminPassword,
  model = 'mock-model',
  apiKey = 'erix-placeholder',
  baseUrl = 'http://127.0.0.1:4000',
} = {}) {
  assert.ok(typeof docker === 'function', 'ensureMockLlmBinding: docker 执行器必填');
  assert.ok(dynamicDir, 'ensureMockLlmBinding: dynamicDir 必填');
  assert.ok(fdeName && adminLogin && adminPassword, 'ensureMockLlmBinding: fdeName/adminLogin/adminPassword 必填');
  assert.ok(!/\s/.test(adminPassword), 'adminPassword 不含空格（CLI 参数传递）');

  // 1) bootstrap break-glass admin → 解析一次性 TOTP 种子（输出不入日志）
  const bootOut = docker(`exec ${portalContainerName} node portal/src/cli.js bootstrap-admin --allow-extra --login ${adminLogin} --password ${adminPassword}`);
  const seedMatch = /种子（[^\n]*）：([A-Z2-7]{16,})/.exec(bootOut);
  assert.ok(seedMatch, `bootstrap-admin 输出含 TOTP 种子行：${bootOut.split('\n')[0] ?? ''}`);
  const adminSecret = seedMatch[1];

  // 2) 两步登录拿 admin 会话 cookie
  const step1 = await fetch(`${portal}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: adminLogin, password: adminPassword }),
  });
  assert.equal(step1.status, 200, `admin login step1（${adminLogin}）`);
  const { pending_token } = await step1.json();
  const step2 = await fetch(`${portal}/api/auth/login/totp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pending_token, code: totp.totp(adminSecret) }),
  });
  assert.equal(step2.status, 200, `admin login step2（${adminLogin}）`);
  const adminCookie = readCookie(step2.headers.get('set-cookie'));
  assert.ok(adminCookie, 'admin session cookie');

  const adminApi = async (p, opts = {}) => {
    const r = await fetch(`${portal}${p}`, {
      method: opts.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', Cookie: `fde_session_dev=${adminCookie}` },
      body: opts.body,
    });
    const body = await r.json().catch(() => ({}));
    return { status: r.status, body };
  };

  // 3) provider（重名 409 → GET 复用；base_url 宿主回环 mock，Traefik host 网络可达）
  const providerName = `mock-e2e-${fdeName}`;
  let providerId;
  const created = await adminApi('/api/admin/llm/providers', {
    method: 'POST',
    body: JSON.stringify({ name: providerName, base_url: baseUrl }),
  });
  if (created.status === 201) {
    providerId = created.body.provider.id;
  } else {
    assert.equal(created.status, 409, `create provider ${providerName}: ${JSON.stringify(created.body)}`);
    const list = await adminApi('/api/admin/llm/providers');
    assert.equal(list.status, 200, 'list providers');
    const found = (list.body.items ?? []).find((p) => p.name === providerName);
    assert.ok(found, `复用已有 provider ${providerName}`);
    providerId = found.id;
  }

  // model（重名 409 → 复用 provider 下已有 model_id）
  let modelId;
  const createdModel = await adminApi(`/api/admin/llm/providers/${providerId}/models`, {
    method: 'POST',
    body: JSON.stringify({ model_id: model, name: model, type: 'text', tool_calling: true }),
  });
  if (createdModel.status === 201) {
    modelId = createdModel.body.model.id;
  } else {
    assert.equal(createdModel.status, 409, `create model ${model}: ${JSON.stringify(createdModel.body)}`);
    const list = await adminApi('/api/admin/llm/providers');
    const found = (list.body.items ?? []).find((p) => p.id === providerId);
    const m = (found?.models ?? []).find((x) => x.model_id === model);
    assert.ok(m, `复用已有 model ${model}`);
    modelId = m.id;
  }

  // binding（PUT upsert；注入该 FDE 真实上游 key）
  const put = await adminApi(`/api/admin/fdes/${fdeName}/llm`, {
    method: 'PUT',
    body: JSON.stringify({ provider_id: providerId, api_key: apiKey, main_model_id: modelId }),
  });
  assert.equal(put.status, 200, `put fde llm (${fdeName}): ${JSON.stringify(put.body)}`);

  // 4) 轮询 llm-<fdeName> 路由发布（llm-routes.yml 0600 root，宿主非 root 进程只能经 docker 读）
  const routesPath = path.posix.join('/d', llmDynamicFile);
  const readLlmRoutes = () => {
    try {
      return docker(`run --rm -v ${JSON.stringify(dynamicDir)}:/d:ro alpine cat ${routesPath} 2>/dev/null`);
    } catch {
      return '';
    }
  };
  await waitFor(() => {
    const txt = readLlmRoutes();
    return txt.includes(`llm-${fdeName}:`) ? txt : null;
  }, { label: `llm-routes.yml 含 llm-${fdeName}（Traefik 热加载）`, timeoutMs: 60000 });

  return { providerId, modelId, adminLogin };
}
