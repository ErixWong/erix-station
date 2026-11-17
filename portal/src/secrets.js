// portal/src/secrets.js —— 配置槽值的加解密与解析（issue #608，契约 docs/design/mcp-integration.md §3.1）
//
// 三条硬口径（改这个文件前先读）：
//   ① **只写不读**：本模块只给「解析成运行时明文」与「加密入库」两个方向，**没有任何**
//      「把明文回给 API」的出口——HTTP 层的 GET 只回 has_value 元数据，不 import 解密函数。
//   ② **AAD 必须包含 fde_id**：`item:name:scope:fde_id`。少了它，把 A 工位的密文行改绑到 B 工位
//      仍然解得开（v1 设计漏了这条，copilot 审计指出）；AAD 也顺带防「密文在槽位之间搬移」。
//   ③ **没有 key 时一律失败**：`MCP_SECRET_KEY` 缺失 ⇒ 加密/解密都抛 `secret_key_missing`。
//      「读 has_value 元数据」不经过本模块（那是 DB 列），所以缺 key 时页面仍能显示「已设置/未设置」，
//      但**任何注入都不可能发生** ⇒ 该 server 视为 missing slots，不注册、不可启用。
//
// 存储格式：`iv(12) || tag(16) || ciphertext`（GCM tag 固定 16 字节）。不存版本号：
// 换算法时用 key 轮换路径（旧密文解不开 ⇒ 槽位显示未设置、管理员重填），不靠密文自描述。

import crypto from 'node:crypto';

/** AES-256-GCM 的固定尺寸（写死而不是从密文里推：格式变了必须显式改代码 + 迁移）。 */
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const KEY_BYTES = 32;

export class SecretError extends Error {
  constructor(message, { code = 'secret_key_missing', httpStatus = 503, details } = {}) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

/**
 * 从 base64 串解析 32 字节 key。**没有默认值**：缺就抛，绝不用固定 key 兜底
 * （兜底等于所有人共用一把公开的钥匙，比不加密更糟——它会让人以为「已加密」）。
 * @param {string|undefined} raw
 * @returns {Buffer}
 */
export function parseKey(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new SecretError('MCP_SECRET_KEY 未配置：无法加密或解析配置槽的值', {
      code: 'secret_key_missing',
      details: { field: 'MCP_SECRET_KEY' },
    });
  }
  let buf;
  try {
    buf = Buffer.from(raw.trim(), 'base64');
  } catch {
    throw new SecretError('MCP_SECRET_KEY 不是合法 base64', { code: 'secret_key_missing' });
  }
  if (buf.length !== KEY_BYTES) {
    throw new SecretError(`MCP_SECRET_KEY 必须是 ${KEY_BYTES} 字节（base64 编码后 44 字符）`, {
      code: 'secret_key_missing',
      details: { actual_bytes: buf.length },
    });
  }
  return buf;
}

/** AAD 的唯一构造点：任何一侧自己拼字符串都会漂。 */
export function aadFor({ itemId, name, scope, fdeId = null }) {
  if (typeof itemId !== 'string' || itemId === '') throw new TypeError('aadFor: itemId 必填');
  if (typeof name !== 'string' || name === '') throw new TypeError('aadFor: name 必填');
  if (scope !== 'global' && scope !== 'fde') throw new TypeError('aadFor: scope 只允许 global|fde');
  return Buffer.from(`${itemId}:${name}:${scope}:${fdeId ?? ''}`, 'utf8');
}

/**
 * 加密一个槽值。空串**不允许**（空串与「未设置」在语义上分不开，会做出「设置了但注入空值」的坑）。
 * @returns {Buffer} `iv || tag || ciphertext`
 */
export function encryptValue({ itemId, name, scope, fdeId = null, plaintext, key }) {
  if (typeof plaintext !== 'string' || plaintext === '') {
    throw new SecretError('值不能为空字符串（要删除请传 null，不要传空串）', {
      code: 'capability_slot_invalid', httpStatus: 400, details: { field: 'values', name },
    });
  }
  const k = Buffer.isBuffer(key) ? key : parseKey(key);
  if (k.length !== KEY_BYTES) throw new SecretError(`key 必须是 ${KEY_BYTES} 字节`, { code: 'secret_key_missing' });
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  cipher.setAAD(aadFor({ itemId, name, scope, fdeId }));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

/** 解密。任何失败（错 key / AAD 不匹配 / 密文被截断）都抛，**绝不返回空串冒充成功**。 */
export function decryptValue({ itemId, name, scope, fdeId = null, blob, key }) {
  const k = Buffer.isBuffer(key) ? key : parseKey(key);
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob ?? []);
  if (buf.length < IV_BYTES + TAG_BYTES + 1) {
    throw new SecretError('密文长度不合法（缺 iv/tag 或正文为空）', { code: 'secret_key_missing' });
  }
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = buf.subarray(IV_BYTES + TAG_BYTES);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', k, iv);
    d.setAAD(aadFor({ itemId, name, scope, fdeId }));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch (e) {
    throw new SecretError(`配置槽解密失败（key 轮换过或密文被搬移）：${e.message}`, {
      code: 'secret_key_missing',
      details: { name, scope, fde_id: fdeId ?? null },
    });
  }
}

/**
 * 解析一个条目的全部槽值（**只给运行期用**：内部通道 / 启用前检查）。
 * 优先级：fde 覆盖 > global。缺必填 ⇒ 进 `missing`；非必填缺失 ⇒ 不出现在 values 里。
 * @returns {Promise<{values: Record<string,string>, missing: string[]}>}
 */
export async function resolveSlots({ pool, itemId, fdeId = null, key }) {
  const params = (await pool.query(
    `SELECT name, kind, inject, required FROM capability_params WHERE item_id = $1 ORDER BY name`,
    [itemId])).rows;
  if (params.length === 0) return { values: {}, missing: [] };

  const rows = (await pool.query(
    `SELECT name, scope, fde_id, value_encrypted FROM capability_param_values
      WHERE item_id = $1 AND (scope = 'global' OR fde_id = $2)`,
    [itemId, fdeId])).rows;

  const byName = new Map();
  for (const r of rows) {
    const cur = byName.get(r.name);
    // fde 覆盖 global：同 name 时 scope='fde' 的那行赢。
    if (!cur || (r.scope === 'fde' && cur.scope !== 'fde')) byName.set(r.name, r);
  }

  const values = {};
  const missing = [];
  for (const p of params) {
    const row = byName.get(p.name);
    if (!row) {
      if (p.required) missing.push(p.name);
      continue;
    }
    try {
      values[p.name] = decryptValue({
        itemId, name: p.name, scope: row.scope, fdeId: row.fde_id ?? null, blob: row.value_encrypted, key,
      });
    } catch {
      // 解不开 = 对运行期而言「没有这个值」。**不**把它当 500 抛出去：一条坏值不该让整个 run 起不来，
      // 但它必须进 missing，从而让该 server 不注册（fail-closed）。
      if (p.required) missing.push(p.name);
    }
  }
  return { values, missing };
}
