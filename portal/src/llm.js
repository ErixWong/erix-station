// LLM 配置存储层（issue #38 Phase A）：供应商/模型目录 CRUD + per-FDE LLM 配置读写。
// 依据：docs/data/model.md §1.20、deploy/migrations/0002-llm-config.sql。
//
// 已定稿设计（issue #38，用户决策 2026-09-19）：去 LiteLLM hub，上游直发 per-FDE key，
// 平台存储明文 key（单机自托管，同机加密是安全剧场）。三条存储纪律（本模块强制）：
//   ① 容器永不持有真 key（key 只存在于 DB → portal 内存 → Traefik 动态配置 mode 600）；
//   ② API 回显只给掩码（sk-...last4），编辑需重输（maskKey / getFdeLlmEcho）；
//   ③ key 不进日志/审计/错误信息（audit details 与 route outbox payload 均不含 key）。
// outbox 联动与 projects.js createProject 的 port_allocation 写法完全同构
//（enqueueRouteChange：route_revisions head + route_outbox 行，同事务）。

import { enqueueRouteChange } from './outbox.js';

export const LLM_MODEL_TYPES = ['text', 'embedding', 'vision', 'rerank', 'audio-tts', 'audio-stt', 'image-gen'];

export class LlmError extends Error {
  constructor(code, message, { httpStatus = 400, details } = {}) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

/** API 回显掩码：sk-...last4；过短/空 → '***'（编辑需重输，不回显真 key）。 */
export function maskKey(k) {
  if (typeof k !== 'string' || k.length === 0) return '***';
  if (k.length < 8) return '***';
  return `sk-...${k.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// 行映射
// ---------------------------------------------------------------------------

export function toProvider(row, models = []) {
  return {
    id: row.id,
    name: row.name,
    base_url: row.base_url,
    api_format: row.api_format,
    enabled: row.enabled,
    models,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

export function toModel(row) {
  return {
    id: row.id,
    provider_id: row.provider_id,
    model_id: row.model_id,
    name: row.name,
    type: row.type,
    tool_calling: row.tool_calling,
    context_window: row.context_window == null ? null : Number(row.context_window),
    enabled: row.enabled,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// provider CRUD（全局供应商）
// ---------------------------------------------------------------------------

/** 供应商列表（各含 models 数组）。 */
export async function listProviders(pool) {
  const r = await pool.query(
    `SELECT id, name, base_url, api_format, enabled, created_at, updated_at
       FROM llm_providers ORDER BY name`,
  );
  const items = [];
  for (const row of r.rows) {
    const m = await pool.query(
      `SELECT id, provider_id, model_id, name, type, tool_calling, context_window, enabled, created_at, updated_at
         FROM llm_models WHERE provider_id = $1 ORDER BY model_id`,
      [row.id],
    );
    items.push(toProvider(row, m.rows.map(toModel)));
  }
  return { items };
}

function validateProviderInput({ name, base_url } = {}) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new LlmError('validation_failed', 'name 为必填字段', { httpStatus: 400, details: { field: 'name' } });
  }
  let parsed;
  try {
    parsed = new URL(base_url);
  } catch {
    throw new LlmError('validation_failed', 'base_url 非法', { httpStatus: 400, details: { field: 'base_url' } });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new LlmError('validation_failed', 'base_url 仅支持 http/https', { httpStatus: 400, details: { field: 'base_url' } });
  }
}

export async function createProvider(pool, { name, base_url } = {}) {
  validateProviderInput({ name, base_url });
  const dup = await pool.query(`SELECT 1 FROM llm_providers WHERE name = $1`, [name.trim()]);
  if (dup.rows.length > 0) {
    throw new LlmError('name_conflict', `供应商 ${name} 已存在`, { httpStatus: 409 });
  }
  const r = await pool.query(
    `INSERT INTO llm_providers (name, base_url)
     VALUES ($1, $2)
     RETURNING id, name, base_url, api_format, enabled, created_at, updated_at`,
    [name.trim(), base_url.trim()],
  );
  return toProvider(r.rows[0], []);
}

/** 更新 base_url / enabled（name 不可改，防 UNIQUE 混乱）。 */
export async function updateProvider(pool, id, { base_url, enabled } = {}) {
  if (base_url !== undefined) {
    try {
      const parsed = new URL(base_url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('bad protocol');
    } catch {
      throw new LlmError('validation_failed', 'base_url 非法', { httpStatus: 400, details: { field: 'base_url' } });
    }
  }
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new LlmError('validation_failed', 'enabled 必须为 boolean', { httpStatus: 400, details: { field: 'enabled' } });
  }
  const r = await pool.query(
    `UPDATE llm_providers
        SET base_url = COALESCE($2, base_url),
            enabled  = COALESCE($3, enabled),
            updated_at = now()
      WHERE id = $1
      RETURNING id, name, base_url, api_format, enabled, created_at, updated_at`,
    [id, base_url ?? null, enabled ?? null],
  );
  if (r.rows.length === 0) throw new LlmError('not_found', 'not found', { httpStatus: 404 });
  return toProvider(r.rows[0], []);
}

/** 物理删；被 fde_llm_bindings 引用 → 409 provider_in_use。 */
export async function deleteProvider(pool, id) {
  const r = await pool.query(`SELECT 1 FROM llm_providers WHERE id = $1`, [id]);
  if (r.rows.length === 0) throw new LlmError('not_found', 'not found', { httpStatus: 404 });
  const refs = await pool.query(`SELECT 1 FROM fde_llm_bindings WHERE provider_id = $1 LIMIT 1`, [id]);
  if (refs.rows.length > 0) {
    throw new LlmError('provider_in_use', '供应商仍被 FDE LLM 配置引用，无法删除', { httpStatus: 409 });
  }
  await pool.query(`DELETE FROM llm_models WHERE provider_id = $1`, [id]);
  await pool.query(`DELETE FROM llm_providers WHERE id = $1`, [id]);
}

// ---------------------------------------------------------------------------
// model CRUD（模型目录）
// ---------------------------------------------------------------------------

function validateModelInput({ model_id, name, type } = {}) {
  if (typeof model_id !== 'string' || model_id.trim() === '') {
    throw new LlmError('validation_failed', 'model_id 为必填字段', { httpStatus: 400, details: { field: 'model_id' } });
  }
  if (typeof name !== 'string' || name.trim() === '') {
    throw new LlmError('validation_failed', 'name 为必填字段', { httpStatus: 400, details: { field: 'name' } });
  }
  if (!LLM_MODEL_TYPES.includes(type)) {
    throw new LlmError('validation_failed', `type 必须为 ${LLM_MODEL_TYPES.join('/')}`, {
      httpStatus: 400,
      details: { field: 'type', allowed: LLM_MODEL_TYPES },
    });
  }
}

export async function createModel(pool, { provider_id, model_id, name, type, tool_calling, context_window } = {}) {
  validateModelInput({ model_id, name, type });
  const p = await pool.query(`SELECT id, enabled FROM llm_providers WHERE id = $1`, [provider_id]);
  if (p.rows.length === 0) {
    throw new LlmError('validation_failed', 'provider 不存在', { httpStatus: 400, details: { field: 'provider_id' } });
  }
  if (!p.rows[0].enabled) {
    throw new LlmError('validation_failed', 'provider 已停用，无法挂接模型', { httpStatus: 400, details: { field: 'provider_id' } });
  }
  const dup = await pool.query(`SELECT 1 FROM llm_models WHERE provider_id = $1 AND model_id = $2`, [provider_id, model_id.trim()]);
  if (dup.rows.length > 0) {
    throw new LlmError('name_conflict', `模型 ${model_id} 在该供应商下已存在`, { httpStatus: 409 });
  }
  const r = await pool.query(
    `INSERT INTO llm_models (provider_id, model_id, name, type, tool_calling, context_window)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, provider_id, model_id, name, type, tool_calling, context_window, enabled, created_at, updated_at`,
    [provider_id, model_id.trim(), name.trim(), type, tool_calling === true, context_window ?? null],
  );
  return toModel(r.rows[0]);
}

/** 更新 name / enabled / tool_calling / context_window（model_id 与 type 不可改）。 */
export async function updateModel(pool, id, { name, enabled, tool_calling, context_window } = {}) {
  if (name !== undefined && (typeof name !== 'string' || name.trim() === '')) {
    throw new LlmError('validation_failed', 'name 为必填字段', { httpStatus: 400, details: { field: 'name' } });
  }
  for (const [field, v] of [['enabled', enabled], ['tool_calling', tool_calling]]) {
    if (v !== undefined && typeof v !== 'boolean') {
      throw new LlmError('validation_failed', `${field} 必须为 boolean`, { httpStatus: 400, details: { field } });
    }
  }
  const r = await pool.query(
    `UPDATE llm_models
        SET name = COALESCE($2, name),
            enabled = COALESCE($3, enabled),
            tool_calling = COALESCE($4, tool_calling),
            context_window = COALESCE($5, context_window),
            updated_at = now()
      WHERE id = $1
      RETURNING id, provider_id, model_id, name, type, tool_calling, context_window, enabled, created_at, updated_at`,
    [id, name ?? null, enabled ?? null, tool_calling ?? null, context_window ?? null],
  );
  if (r.rows.length === 0) throw new LlmError('not_found', 'not found', { httpStatus: 404 });
  return toModel(r.rows[0]);
}

/** 物理删；被 fde_llm_bindings 任一模型位引用 → 409 model_in_use。 */
export async function deleteModel(pool, id) {
  const r = await pool.query(`SELECT 1 FROM llm_models WHERE id = $1`, [id]);
  if (r.rows.length === 0) throw new LlmError('not_found', 'not found', { httpStatus: 404 });
  const refs = await pool.query(
    `SELECT 1 FROM fde_llm_bindings
      WHERE main_model_id = $1 OR embedding_model_id = $1 OR vision_model_id = $1 LIMIT 1`,
    [id],
  );
  if (refs.rows.length > 0) {
    throw new LlmError('model_in_use', '模型仍被 FDE LLM 配置引用，无法删除', { httpStatus: 409 });
  }
  await pool.query(`DELETE FROM llm_models WHERE id = $1`, [id]);
}

// ---------------------------------------------------------------------------
// per-FDE LLM 配置
// ---------------------------------------------------------------------------

/**
 * 读取 FDE LLM 配置（内部全量，api_key 明文）。
 * 供心跳下行 / 发布器用；**调用方不得把 api_key 写进日志/响应**。
 * api_key 为 NULL = 未配置（该 FDE 无 LLM 可用）。
 * @returns null（无配置或非 active）| { provider_id, provider_name, base_url, api_key, main, embedding, vision }
 */
export async function getFdeLlmConfig(pool, userId) {
  const r = await pool.query(
    `SELECT b.fde_id, b.api_key, b.state,
            p.id AS provider_id, p.name AS provider_name, p.base_url,
            mm.model_id AS main_upstream, mm.name AS main_name, mm.type AS main_type,
            em.model_id AS embedding_upstream, em.name AS embedding_name, em.type AS embedding_type,
            vm.model_id AS vision_upstream, vm.name AS vision_name, vm.type AS vision_type
       FROM fde_llm_bindings b
       JOIN llm_providers p ON p.id = b.provider_id
       LEFT JOIN llm_models mm ON mm.id = b.main_model_id
       LEFT JOIN llm_models em ON em.id = b.embedding_model_id
       LEFT JOIN llm_models vm ON vm.id = b.vision_model_id
      WHERE b.fde_id = $1 AND b.state = 'active'`,
    [userId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const slot = (upstream, name, type) => (upstream == null ? null : { model_id: upstream, name, type });
  return {
    provider_id: row.provider_id,
    provider_name: row.provider_name,
    base_url: row.base_url,
    api_key: row.api_key,
    main: slot(row.main_upstream, row.main_name, row.main_type),
    embedding: slot(row.embedding_upstream, row.embedding_name, row.embedding_type),
    vision: slot(row.vision_upstream, row.vision_name, row.vision_type),
  };
}

/**
 * 心跳下行模型集（issue #38 Phase B2）：agent 用真模型名的传导通道。
 * 单条轻量 JOIN（fde_llm_bindings active + provider enabled），**不含 api_key**——key 绝不进心跳响应。
 * main 仅取 tool_calling=true 的模型（setFdeLlmConfig 写入时已校验，此处再过滤防目录被改后下行失真）。
 * @returns null（无 active binding / provider 停用 / 无可用模型）| { main?, embedding?, vision? }（均为上游 model_id）
 */
export async function getFdeLlmHeartbeatModels(pool, userId) {
  const r = await pool.query(
    `SELECT mm.model_id AS main_upstream,
            em.model_id AS embedding_upstream,
            vm.model_id AS vision_upstream
       FROM fde_llm_bindings b
       JOIN llm_providers p ON p.id = b.provider_id AND p.enabled = true
       LEFT JOIN llm_models mm ON mm.id = b.main_model_id AND mm.enabled = true AND mm.tool_calling = true
       LEFT JOIN llm_models em ON em.id = b.embedding_model_id AND em.enabled = true AND em.type = 'embedding'
       LEFT JOIN llm_models vm ON vm.id = b.vision_model_id AND vm.enabled = true AND vm.type = 'vision'
      WHERE b.fde_id = $1 AND b.state = 'active'`,
    [userId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const models = {};
  if (row.main_upstream != null) models.main = { model: row.main_upstream, type: 'text' };
  if (row.embedding_upstream != null) models.embedding = { model: row.embedding_upstream, type: 'embedding' };
  if (row.vision_upstream != null) models.vision = { model: row.vision_upstream, type: 'vision' };
  // 不下发空对象：main 为必备位（setFdeLlmConfig 强制），它缺失说明目录被改到不可用 → 整体不下行。
  if (!models.main) return null;
  return models;
}

/** admin 回显版：api_key 只给掩码（红线 ②）；无配置 → null。 */
export async function getFdeLlmEcho(pool, fdeName) {
  const u = await pool.query(`SELECT id FROM users WHERE fde_name = $1 AND status = 'active'`, [fdeName]);
  if (u.rows.length === 0) throw new LlmError('not_found', 'not found', { httpStatus: 404 });
  const cfg = await getFdeLlmConfig(pool, u.rows[0].id);
  if (!cfg) return null;
  return { ...cfg, api_key: cfg.api_key == null ? null : maskKey(cfg.api_key) };
}

/**
 * 按模型位加载并校验模型行（应用层校验，PG 无法跨表查能力标记）。
 * main：type='text' 且 tool_calling=true；embedding/vision：type 匹配。三者均须 enabled 且 provider 匹配。
 */
async function loadSlotModel(client, { slot, modelId, providerId, expectType, requireToolCalling }) {
  const fail = (reason) => {
    throw new LlmError('validation_failed', reason, { httpStatus: 400, details: { field: slot, model_id: modelId } });
  };
  const r = await client.query(
    `SELECT id, model_id, name, type, tool_calling, enabled, provider_id FROM llm_models WHERE id = $1`,
    [modelId],
  );
  const m = r.rows[0];
  if (!m) fail(`${slot} 模型不存在`);
  if (!m.enabled) fail(`${slot} 模型已停用`);
  if (m.provider_id !== providerId) fail(`${slot} 模型与 provider 不匹配`);
  if (m.type !== expectType) fail(`${slot} 模型类型不匹配（期望 ${expectType}，实际 ${m.type}）`);
  if (requireToolCalling && !m.tool_calling) fail(`${slot} 模型不支持 tool_calling`);
  return m;
}

/**
 * 写入 FDE LLM 配置（admin）：单事务 upsert fde_llm_bindings + route outbox（aggregate='llm_binding'）
 * + audit_log（details 不含 key）。api_key 缺省 = 保留旧值；首次写入须给 api_key（否则该 FDE 无 LLM 可用）。
 * @returns 掩码回显（同 getFdeLlmEcho 形状，api_key 掩码）
 */
export async function setFdeLlmConfig(pool, {
  actorId = null, fdeName, provider_id, api_key, main_model_id, embedding_model_id = null, vision_model_id = null,
} = {}) {
  if (typeof provider_id !== 'string' || provider_id === '') {
    throw new LlmError('validation_failed', 'provider_id 为必填字段', { httpStatus: 400, details: { field: 'provider_id' } });
  }
  if (typeof main_model_id !== 'string' || main_model_id === '') {
    throw new LlmError('validation_failed', 'main_model_id 为必填字段', { httpStatus: 400, details: { field: 'main_model_id' } });
  }
  if (api_key !== undefined && api_key !== null && (typeof api_key !== 'string' || api_key === '')) {
    throw new LlmError('validation_failed', 'api_key 必须为字符串', { httpStatus: 400, details: { field: 'api_key' } });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 串行化同 FDE 的配置写入（与 projects.js lockUserProjectSpace 同模式）。
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`llm-binding:${fdeName}`]);

    const u = await client.query(`SELECT id, fde_name FROM users WHERE fde_name = $1 AND status = 'active'`, [fdeName]);
    if (u.rows.length === 0) throw new LlmError('not_found', 'not found', { httpStatus: 404 });
    const userId = u.rows[0].id;

    const p = await client.query(`SELECT id, name, enabled FROM llm_providers WHERE id = $1`, [provider_id]);
    if (p.rows.length === 0 || !p.rows[0].enabled) {
      throw new LlmError('validation_failed', 'provider 不存在或已停用', { httpStatus: 400, details: { field: 'provider_id' } });
    }

    // 模型位校验：type / enabled / provider 匹配 / main 必须 tool_calling（应用层，migration 头注释同款说明）。
    const main = await loadSlotModel(client, {
      slot: 'main', modelId: main_model_id, providerId: provider_id, expectType: 'text', requireToolCalling: true,
    });
    const embedding = embedding_model_id == null ? null : await loadSlotModel(client, {
      slot: 'embedding', modelId: embedding_model_id, providerId: provider_id, expectType: 'embedding', requireToolCalling: false,
    });
    const vision = vision_model_id == null ? null : await loadSlotModel(client, {
      slot: 'vision', modelId: vision_model_id, providerId: provider_id, expectType: 'vision', requireToolCalling: false,
    });

    const existing = await client.query(
      `SELECT api_key FROM fde_llm_bindings WHERE fde_id = $1`,
      [userId],
    );
    const oldKey = existing.rows[0]?.api_key ?? null;
    const newKey = api_key === undefined ? oldKey : api_key;

    if (existing.rows.length > 0) {
      // 更新：gateway 语义收敛为 'direct'（上游直连），generation 不变（无代次轮换语义）。
      await client.query(
        `UPDATE fde_llm_bindings
            SET provider_id = $2, api_key = $3, main_model_id = $4, embedding_model_id = $5, vision_model_id = $6,
                gateway = 'direct', state = 'active', updated_at = now()
          WHERE fde_id = $1`,
        [userId, provider_id, newKey, main.id, embedding?.id ?? null, vision?.id ?? null],
      );
    } else {
      if (newKey == null) {
        throw new LlmError('validation_failed', '首次配置必须提供 api_key', { httpStatus: 400, details: { field: 'api_key' } });
      }
      await client.query(
        `INSERT INTO fde_llm_bindings
           (fde_id, gateway, key_alias, state, generation, provider_id, api_key, main_model_id, embedding_model_id, vision_model_id)
         VALUES ($1, 'direct', $2, 'active', 1, $3, $4, $5, $6, $7)`,
        [userId, `${fdeName}@llm`, provider_id, newKey, main.id, embedding?.id ?? null, vision?.id ?? null],
      );
    }

    // outbox 联动：与 projects.js createProject 的 port_allocation 写法完全同构
    //（route_revisions head 同事务递增 + route_outbox 行）。payload 不含 api_key（红线 ③）。
    await enqueueRouteChange(client, {
      aggregate: 'llm_binding',
      aggregateId: userId,
      op: 'upsert',
      payload: {
        fde_name: fdeName,
        provider_id,
        main_model_id: main.id,
        embedding_model_id: embedding?.id ?? null,
        vision_model_id: vision?.id ?? null,
        has_api_key: newKey != null,
      },
    });

    // audit：details 只含供应商/模型名，不含 key（红线 ③）。
    await client.query(
      `INSERT INTO audit_log (actor_id, action, target, details)
       VALUES ($1, 'llm.config_updated', $2, $3)`,
      [
        actorId,
        fdeName,
        JSON.stringify({
          fde_name: fdeName,
          provider_name: p.rows[0].name,
          main_model: main.model_id,
          embedding_model: embedding?.model_id ?? null,
          vision_model: vision?.model_id ?? null,
          api_key_provided: api_key !== undefined && api_key !== null,
        }),
      ],
    );

    await client.query('COMMIT');
    return {
      provider_id,
      provider_name: p.rows[0].name,
      api_key: newKey == null ? null : maskKey(newKey),
      main: { model_id: main.model_id, name: main.name, type: main.type },
      embedding: embedding ? { model_id: embedding.model_id, name: embedding.name, type: embedding.type } : null,
      vision: vision ? { model_id: vision.model_id, name: vision.name, type: vision.type } : null,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 吊销事务内联动（issue #38 Phase B1，deprovisionFde 前置事务调用）。
 * fde_llm_bindings active → revoked（revoked_at=now()）+ outbox tombstone（aggregate='llm_binding'，op='delete'）。
 *
 * **评审重点**：本函数只接受调用方事务的 client、绝不自行 connect——LLM 吊销必须与 containers/token
 * 吊销**同一事务**。若在独立连接上先吊销容器 token、再独立吊销 LLM，两事务之间会留下「容器已死但
 * Traefik 仍向该 FDE 子网注入上游 api_key」的窗口（且反向顺序亦然）；offboard 语义要求凭据失效
 * 与「离开 desired」原子发生（topology §8 offboarding 行、审计 #34 F-B 同款推理）。
 * tombstone payload 不含 api_key（红线 ③）；本函数不写 audit（offboard 整体审计由调用方负责）。
 *
 * @returns boolean 是否实际吊销了一行 active binding（无行/已 revoked → false，不写 outbox）
 */
export async function revokeFdeLlmConfigTx(client, { fdeId, fdeName } = {}) {
  const r = await client.query(
    `UPDATE fde_llm_bindings
        SET state = 'revoked', revoked_at = now(), updated_at = now()
      WHERE fde_id = $1 AND state = 'active'`,
    [fdeId],
  );
  if (r.rowCount === 0) return false;
  await enqueueRouteChange(client, {
    aggregate: 'llm_binding',
    aggregateId: fdeId,
    op: 'delete',
    payload: { fde_name: fdeName },
  });
  return true;
}

/**
 * onboard 恢复联动（issue #38 Phase B1，onboardFde 调用；独立小事务，容器/网络已就绪后执行）。
 *
 *  - 复用分支（restoreRevoked=true）：binding state='revoked' → 恢复 'active'（revoked_at=NULL）+ outbox
 *    upsert（同事务）——与 #37 revoked_at 复活防御同思路：重新 onboard 的 FDE 其 LLM 配置应复活。
 *    注意复活对象是 **fde_llm_bindings.revoked_at**（本表），与 containers.revoked_at（#22 F1）是两张表，
 *    互不干扰——containers 行复用的 UPDATE 不会顺带清本表状态。
 *  - 全新 onboard（restoreRevoked=false）：**不自动复活** revoked 配置（offboard 是管理员意图，LLM 恢复
 *    应经 admin 重新确认）；仅对仍 'active' 的配置做幂等 upsert 发布（保证 Traefik 动态配置齐全，
 *    幂等可重复执行）。
 *
 * @returns { restored, republished }
 */
export async function syncFdeLlmBindingOnOnboard(pool, { fdeId, fdeName, restoreRevoked = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 与 setFdeLlmConfig 同 advisory key，串行化同 FDE 的配置写入/恢复。
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`llm-binding:${fdeName}`]);
    const r = await client.query(
      `SELECT state FROM fde_llm_bindings WHERE fde_id = $1 FOR UPDATE`,
      [fdeId],
    );
    const row = r.rows[0];
    if (!row) {
      await client.query('COMMIT');
      return { restored: false, republished: false };
    }
    let restored = false;
    if (row.state === 'revoked' && restoreRevoked) {
      await client.query(
        `UPDATE fde_llm_bindings
            SET state = 'active', revoked_at = NULL, updated_at = now()
          WHERE fde_id = $1`,
        [fdeId],
      );
      restored = true;
    }
    // active（原本或刚恢复）→ 幂等 upsert，触发 reconciler 重发布（tombstone 批量 offboard 后
    // 的 re-onboard 场景也靠它补齐 Traefik 配置）。
    const effective = restored || row.state === 'active';
    if (effective) {
      await enqueueRouteChange(client, {
        aggregate: 'llm_binding',
        aggregateId: fdeId,
        op: 'upsert',
        payload: { fde_name: fdeName, restored },
      });
    }
    await client.query('COMMIT');
    return { restored, republished: effective };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 删除 FDE LLM 配置（tombstone op='delete'，与 port_allocation 释放同构）。Phase B/C 使用。
 * @returns boolean 是否存在配置行
 */
export async function deleteFdeLlmConfig(pool, { actorId = null, fdeName } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`llm-binding:${fdeName}`]);
    const u = await client.query(`SELECT id, fde_name FROM users WHERE fde_name = $1 AND status = 'active'`, [fdeName]);
    if (u.rows.length === 0) throw new LlmError('not_found', 'not found', { httpStatus: 404 });
    const userId = u.rows[0].id;
    const existing = await client.query(`SELECT 1 FROM fde_llm_bindings WHERE fde_id = $1`, [userId]);
    if (existing.rows.length === 0) {
      await client.query('COMMIT');
      return false;
    }
    await client.query(`DELETE FROM fde_llm_bindings WHERE fde_id = $1`, [userId]);
    await enqueueRouteChange(client, {
      aggregate: 'llm_binding',
      aggregateId: userId,
      op: 'delete',
      payload: { fde_name: fdeName },
    });
    await client.query(
      `INSERT INTO audit_log (actor_id, action, target, details)
       VALUES ($1, 'llm.config_deleted', $2, $3)`,
      [actorId, fdeName, JSON.stringify({ fde_name: fdeName })],
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
