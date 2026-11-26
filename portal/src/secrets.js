// portal/src/secrets.js —— 配置槽的值：写入前的形态校验 + 运行期解析（issue #608，契约 §3.1）
//
// ⚠ **值以明文存库**（迁移 `0042-mcp-plaintext-values.sql`）。这不是疏漏：0040 原设计是 AES-256-GCM
// 加密（key 放 `deploy/.env`），评估后判定「portal 与 DB 同机、`.env` 与 DB 同盘 ⇒ 主机沦陷时两样
// 一起丢」，它只挡得住 DB 单点泄漏，而代价是多一个必须保管的部署变量 + 换 key 全员重填。
// 决策与何时该加回来的判据写在那个迁移文件头部与契约 §3.1，**别在这里重新发明加密**。
//
// 真正的边界不靠加密，靠这三条（改本文件前先读）：
//   ① **只写不读**：本模块只有「写库前的校验」与「运行期解析成明文」两个方向，**没有任何**
//      「把明文回给 API」的出口——HTTP 层的 GET 只回 `has_value` 元数据，不 import 解析函数。
//   ② **值不进文件**：`~/.erix/mcp.json` 只带槽位声明（name/inject/required），不带值。
//   ③ **明文只在 run 内存里活一次**：agentd 代取 → 注入子进程 env，run 结束即随进程消失。

/** 配置槽域错误（`code` 是 §7 契约的一部分，前端据此显示文案）。 */
export class SecretError extends Error {
  constructor(message, { code = 'capability_slot_invalid', httpStatus = 400, details, en } = {}) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
    // issue #803 S2-D：可选英文对（同 AdminError/HttpError 口径，本类的 message 是第一位置参、en 进 options）。
    // `super(message)` 仍传中文原文，http.js 的 pickMessage 按 locale 读 `err.en`，缺省照旧出中文。
    this.en = en;
  }
}

/**
 * 写入前校验一个槽值。
 * 空串**不允许**：空串与「未设置」在语义上分不开，会做出「设置了但注入空值」的坑
 * （要删除请传 `null`，那条路径在 `market.setSlotValues` 里）。
 * @returns {string} 原样返回（不 trim：有些 token 两端空白是真的）
 */
export function normalizeValue({ name, value }) {
  if (typeof value !== 'string' || value === '') {
    throw new SecretError('值不能为空字符串（要删除请传 null，不要传空串）', {
      code: 'capability_slot_invalid', details: { field: 'values', name },
      en: 'the value must not be an empty string (pass null to delete, not an empty string)',
    });
  }
  // 长度上界：槽值是凭据，不是配置文件。1 KiB 足够任何 token/JWT，超了几乎必然是贴错东西
  // （整段 PEM、整份 JSON），当场拒比让它进 DB 好。
  if (value.length > 1024) {
    throw new SecretError(`槽位 ${name} 的值超过 1024 字符（凭据不该有这么长）`, {
      code: 'capability_slot_invalid', details: { field: 'values', name, length: value.length },
      en: `the value for slot ${name} exceeds 1024 characters (a credential should not be this long)`,
    });
  }
  return value;
}

/**
 * 解析一个条目的全部槽值（**只给运行期用**：内部通道 / 启用前检查）。
 * 优先级：fde 覆盖 > global。缺必填 ⇒ 进 `missing`；非必填缺失 ⇒ 不出现在 values 里。
 * @returns {Promise<{values: Record<string,string>, missing: string[]}>}
 */
export async function resolveSlots({ pool, itemId, fdeId = null }) {
  const params = (await pool.query(
    `SELECT name, kind, inject, required FROM capability_params WHERE item_id = $1 ORDER BY name`,
    [itemId])).rows;
  if (params.length === 0) return { values: {}, missing: [] };

  const rows = (await pool.query(
    `SELECT name, scope, fde_id, value_plain FROM capability_param_values
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
    // 空串按「没有值」处理（历史数据/手工改库都可能有），与 `normalizeValue` 的口径一致。
    if (!row || typeof row.value_plain !== 'string' || row.value_plain === '') {
      if (p.required) missing.push(p.name);
      continue;
    }
    values[p.name] = row.value_plain;
  }
  return { values, missing };
}
