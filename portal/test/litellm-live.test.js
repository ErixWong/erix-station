import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LIVE = process.env.ERIX_LITELLM_LIVE === '1';
const BASE_URL = 'http://127.0.0.1:4100';

function readMasterKey() {
  const envFile = fs.readFileSync(path.join(ROOT, 'deploy/.env'), 'utf8');
  const line = envFile.split(/\r?\n/).find((item) => /^LITELLM_MASTER_KEY=/.test(item));
  const value = line?.slice('LITELLM_MASTER_KEY='.length).trim().replace(/^(['"])(.*)\1$/, '$2');
  if (!value) throw new Error('deploy/.env must define LITELLM_MASTER_KEY for the live test');
  return value;
}

async function request(pathname, masterKey, body, key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${BASE_URL}${pathname}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${key ?? masterKey}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { /* caller reports status only */ }
    return { response, payload };
  } finally {
    clearTimeout(timer);
  }
}

test('LiteLLM live smoke: mint deepseek-flash key, chat completion usage, delete key', { skip: !LIVE }, async () => {
  const masterKey = readMasterKey();
  const suffix = crypto.randomUUID();
  const alias = `erix-live-smoke-${suffix}`;
  let virtualKey = null;
  try {
    const user = await request('/user/new', masterKey, {
      user_email: `erix-live-smoke-${suffix}@station.invalid`,
    });
    assert.equal(user.response.status, 200, 'LiteLLM user creation failed');
    const userId = user.payload?.user_id;
    assert.equal(typeof userId, 'string', 'LiteLLM did not return user_id');

    const generated = await request('/key/generate', masterKey, {
      models: ['deepseek-flash'],
      user_id: userId,
      key_alias: alias,
      metadata: { smoke_test: true },
    });
    assert.equal(generated.response.status, 200, 'LiteLLM key generation failed');
    virtualKey = generated.payload?.key;
    assert.equal(typeof virtualKey, 'string', 'LiteLLM did not return a virtual key');

    const completion = await request('/v1/chat/completions', masterKey, {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
      stream: false,
    }, virtualKey);
    assert.equal(completion.response.status, 200, 'LiteLLM chat completion failed');
    assert.ok(completion.payload?.usage && typeof completion.payload.usage === 'object', 'chat completion omitted usage');
  } finally {
    if (virtualKey) {
      const deleted = await request('/key/delete', masterKey, { keys: [virtualKey] });
      assert.equal(deleted.response.status, 200, 'LiteLLM key cleanup failed');
    }
  }
});
