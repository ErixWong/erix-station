// 预览 ticket / 预览 cookie 签发与校验（forward-auth 授权核心）。
// 依据：docs/api/portal.md §2.7/§2.8、docs/design/fde-platform.md §8.6（allocated→active 由首次 forward-auth 放行触发）、
//       docs/data/schema.sql §4（preview_grants）、docs/design/principles.md §2（认证在边缘）。
//
// 安全口径：ticket/session 只存 sha256 哈希（不存明文）；凭证查询显式 state='active'；
//           forward-auth 不解析 cookie.sub（按 token 哈希查 preview_grants 解析主体）。

import crypto from 'node:crypto';
import { hashToken } from './auth.js';
import * as projects from './projects.js';

/** 确定性派生预览 session token（portal.md §2.7 第 6 步；重放时能重放同一 token）。 */
export function derivePreviewSessionToken(ticket, signingKey) {
  const mac = crypto.createHmac('sha256', signingKey).update(`preview-session:${ticket}`).digest('base64url');
  return `s_${mac}`;
}

/** 从 X-Forwarded-Uri 解析 ?preview_ticket=<t>（未找到返回 null）。 */
export function parsePreviewTicket(uri) {
  if (typeof uri !== 'string') return null;
  const q = uri.split('?')[1];
  if (!q) return null;
  for (const part of q.split('&')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx);
    if (k === 'preview_ticket') {
      const v = part.slice(idx + 1);
      return v.length > 0 ? v : null;
    }
  }
  return null;
}

/** 从 URI 剔除 preview_ticket 参数（302 Location 脱敏，portal.md §2.7 第 6 步 / B3）。 */
export function stripPreviewTicket(uri) {
  if (typeof uri !== 'string') return '/';
  const qIndex = uri.indexOf('?');
  if (qIndex === -1) return uri;
  const pathPart = uri.slice(0, qIndex);
  const query = uri.slice(qIndex + 1);
  const kept = query
    .split('&')
    .filter((part) => part.split('=')[0] !== 'preview_ticket')
    .filter(Boolean);
  if (kept.length === 0) return pathPart;
  return `${pathPart}?${kept.join('&')}`;
}

function deny(status, code, message, extra = {}) {
  return { outcome: 'deny', status, code, message, ...extra };
}

function allow(allocation, extra = {}) {
  return {
    outcome: 'allow',
    status: 200,
    allocation,
    headers: {},
    ...extra,
  };
}

function redirect(allocation, extra = {}) {
  return {
    outcome: 'redirect',
    status: 302,
    allocation,
    headers: {},
    ...extra,
  };
}

/** exposure 判定（portal.md §2.7 第 5 步）：用凭证主体（user_id）比对；返回 deny 或 null。 */
async function checkExposure(pool, allocation, subjectId) {
  const r = await pool.query(`SELECT id, role, status FROM users WHERE id = $1`, [subjectId]);
  const u = r.rows?.[0];
  if (!u || u.status !== 'active') return deny(403, 'forbidden', 'forbidden');
  if (allocation.exposure === 'private') {
    if (u.role === 'admin' || u.id === allocation.fde_id) return null;
    return deny(403, 'forbidden', 'forbidden');
  }
  // org-visible（public 已在入口短路）：任意 active 用户。
  return null;
}

/** 查 ticket 的活跃派生 session（安全重放，portal.md §2.7 第 6 步）。 */
async function findActiveSessionByParent(pool, parentTicketId, now) {
  const r = await pool.query(
    `SELECT id, user_id, allocation_id, expires_at, revoked_at, state
       FROM preview_grants
      WHERE parent_ticket_id = $1 AND kind = 'session'
      ORDER BY created_at DESC LIMIT 1`,
    [parentTicketId],
  );
  const s = r.rows?.[0];
  if (!s) return null;
  if (s.state === 'active' && !s.revoked_at && new Date(s.expires_at) > now) return s;
  return null;
}

/**
 * CORS 预检形态判定（#241，口径唯一入口）：`OPTIONS` **且**带非空 `Access-Control-Request-Method`。
 * 这是 Fetch 规范里「预检」的定义；预检请求**按规范不携带任何凭据**（cookie / Authorization 都不发），
 * 所以它不可能通过票据/预览 cookie 校验——若照旧要求凭证，任何需要自定义头（如 Authorization）的
 * 跨端口请求会整片不可用（issue #241）。只带 `OPTIONS` 而无 ACRM（非 CORS 预检，如能力探测）
 * **不算**预检，仍走原鉴权路径（fail-closed 面不扩大）。
 */
export function isCorsPreflight({ method = 'GET', accessControlRequestMethod = null } = {}) {
  if (String(method).toUpperCase() !== 'OPTIONS') return false;
  return typeof accessControlRequestMethod === 'string' && accessControlRequestMethod.trim() !== '';
}

/**
 * Host 头归一化（#57 阶段2 收口；沿 fix-250923-01 的既有语义）：**剥端口 + 小写**。
 * 查表（port_allocations.hostname 按无端口、小写存储）必须用本函数的输出；
 * **302 Location 仍用原始 Host 头（含非默认端口）**，dev 8090/8443 否则跳 :80 拒连（fix-250923-01 行为不变）。
 * 全仓只保留这一份实现（http.js forwardAuth 与任何后续 Host 消费方均复用）。
 * IPv6 字面量 `[::1]:8090` 的端口后缀同样被剥到 `[::1]`。
 */
export function normalizeHostHeader(rawHost) {
  if (typeof rawHost !== 'string') return '';
  return rawHost.trim().replace(/:\d+$/, '').toLowerCase();
}

/** 校验一次性 ticket 凭证（portal.md §2.7 第 4/6 步）。 */
async function handleTicket(pool, config, { ticket, allocation, uri, scheme, hostHeader = null, now }) {
  const h = hashToken(ticket);
  const r = await pool.query(
    `SELECT id, user_id, issuer_id, allocation_id, state, expires_at, used_at, revoked_at
       FROM preview_grants WHERE token_hash = $1 AND kind = 'ticket'`,
    [h],
  );
  const g = r.rows?.[0];
  const audit = { allocation, subjectId: g?.user_id ?? null, issuerId: g?.issuer_id ?? null, grantId: g?.id ?? null, grantKind: 'ticket' };

  if (!g) return deny(401, 'preview_ticket_invalid', 'preview ticket invalid', audit);
  // F13：跨 hostname 重放必须 403 preview_ticket_mismatch——先于安全重放分支（防已消费 ticket 用派生 session 打到别的 allocation）。
  if (g.allocation_id !== allocation.id) {
    return deny(403, 'preview_ticket_mismatch', 'preview ticket does not match allocation', audit);
  }
  if (g.state === 'revoked') return deny(403, 'preview_ticket_revoked', 'preview ticket revoked', audit);
  if (g.state === 'used') {
    // 响应丢失后的安全重放：有活跃派生 session 则返回同一 bootstrap 结果，否则真·重放 403。
    const sess = await findActiveSessionByParent(pool, g.id, now);
    if (sess) {
      const sessionToken = derivePreviewSessionToken(ticket, config.previewSessionSigningKey);
      return redirect(allocation, {
        ...audit,
        sessionToken,
        location: buildLocation(scheme, allocation.hostname, stripPreviewTicket(uri), hostHeader),
      });
    }
    return deny(403, 'preview_ticket_used', 'preview ticket already used', audit);
  }
  if (g.state === 'expired' || new Date(g.expires_at) <= now) {
    return deny(401, 'preview_ticket_expired', 'preview ticket expired', audit);
  }

  const exposureDeny = await checkExposure(pool, allocation, g.user_id);
  if (exposureDeny) return { ...exposureDeny, ...audit };

  // 第 6 步：单事务原子消费 ticket + 确定性派生 session + 幂等建 session grant（crash-safe）。
  const sessionToken = derivePreviewSessionToken(ticket, config.previewSessionSigningKey);
  const sessionHash = hashToken(sessionToken);
  const expiresAt = new Date(now.getTime() + config.previewSessionTtlSeconds * 1000);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const consumed = await client.query(
      `UPDATE preview_grants SET state = 'used', used_at = now()
        WHERE id = $1 AND state = 'active' AND used_at IS NULL
        RETURNING id`,
      [g.id],
    );
    if (consumed.rows.length === 0) {
      await client.query('ROLLBACK');
      // 并发下已被消费：走安全重放分支。
      const sess = await findActiveSessionByParent(pool, g.id, now);
      if (sess) {
        return redirect(allocation, {
          ...audit,
          sessionToken,
          location: buildLocation(scheme, allocation.hostname, stripPreviewTicket(uri), hostHeader),
        });
      }
      return deny(403, 'preview_ticket_used', 'preview ticket already used', audit);
    }
    await client.query(
      `INSERT INTO preview_grants
          (token_hash, user_id, issuer_id, allocation_id, parent_ticket_id, kind, state, expires_at, last_seen_at)
        VALUES ($1, $2, NULL, $3, $4, 'session', 'active', $5, $5)
        ON CONFLICT (token_hash) DO NOTHING`,
      [sessionHash, g.user_id, allocation.id, g.id, expiresAt],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return redirect(allocation, {
    ...audit,
    sessionToken,
    location: buildLocation(scheme, allocation.hostname, stripPreviewTicket(uri), hostHeader),
  });
}

/** 校验 steady-state 预览 cookie（portal.md §2.7 第 7 步）。 */
async function handleSessionCookie(pool, config, { cookie, allocation, now }) {
  const h = hashToken(cookie);
  const r = await pool.query(
    `SELECT id, user_id, allocation_id, state, expires_at, revoked_at
       FROM preview_grants WHERE token_hash = $1 AND kind = 'session'`,
    [h],
  );
  const g = r.rows?.[0];
  const audit = { allocation, subjectId: g?.user_id ?? null, issuerId: null, grantId: g?.id ?? null, grantKind: 'session' };

  if (!g || g.state === 'revoked') {
    return deny(401, 'preview_session_invalid', 'preview session invalid', audit);
  }
  if (g.state === 'expired' || new Date(g.expires_at) <= now) {
    return deny(401, 'preview_session_expired', 'preview session expired', audit);
  }
  if (g.allocation_id !== allocation.id) {
    return deny(403, 'forbidden', 'forbidden', audit);
  }
  const exposureDeny = await checkExposure(pool, allocation, g.user_id);
  if (exposureDeny) return { ...exposureDeny, ...audit };

  // 滚动续期（刷新 expires_at / last_seen_at 并重发 cookie）。
  const expiresAt = new Date(now.getTime() + config.previewSessionTtlSeconds * 1000);
  await pool.query(
    `UPDATE preview_grants SET expires_at = $2, last_seen_at = $3 WHERE id = $1`,
    [g.id, expiresAt, now],
  );
  return allow(allocation, { ...audit, cookieToken: cookie });
}

/**
 * 302 Location 的 host 来源：优先用请求的原始 Host（含非默认端口，fix-250923-01）。
 * 安全性：hostHeader 已在 authorizeForwardAuth 里剥端口后与 port_allocations.hostname 精确匹配
 * （查不到即 404），故 hostHeader 的 host 部分必等于 allocation.hostname，无开放重定向面。
 */
function buildLocation(scheme, hostname, cleanUri, hostHeader = null) {
  const s = scheme === 'http' ? 'http' : 'https';
  const host = typeof hostHeader === 'string' && hostHeader !== '' ? hostHeader : hostname;
  return `${s}://${host}${cleanUri || '/'}`;
}

/**
 * forward-auth 授权核心（portal.md §2.7）。返回结构化结果，由 http.js 映射为 HTTP 响应。
 * fail-closed：无凭证 / 凭证无效一律 deny，绝不放行。
 * 唯一例外（#241）：CORS 预检（OPTIONS + Access-Control-Request-Method）免**凭证**，
 * 但第 1/2 步（hostname 精确查表、`released` 拒绝）**照旧**——未知 host 仍 404、已释放仍 403。
 */
export async function authorizeForwardAuth(pool, config, { hostname, hostHeader = null, uri = '/', cookieValue = null, method = 'GET', scheme = 'https', accessControlRequestMethod = null, now = new Date() } = {}) {
  // ⚠ **#275：这条查表必须自带「活行优先」的确定性排序，不能只按 hostname 取第一行。**
  // `port_allocations_live_hostname_key`（`docs/data/schema.sql` §4，baseline 冻结）与迁移 0019 的
  // `port_allocations_live_global_port_key` 都是**部分**唯一索引，谓词字面同为 `state <> 'released'`
  // ⇒ **`released` 行不占位** ⇒ 同一 hostname 允许「1 条活行 + N 条 released 历史行」共存
  //（#246 交付② 的管理员改块把旧行置 released、又把块搬回**曾用过**的号段（22000→22030→22000）
  //   就会造出这种形状：新活行的 hostname 与上一轮遗留的 released 行**逐字相同**）。
  // hostname 上只有部分索引、没有全表索引 ⇒ 无 ORDER BY 的 `LIMIT 1` 拿到的是执行计划扫到的第一行
  // （真库 `Seq Scan` 先扫到 released 行）⇒ 恒定 403 `allocation_released`，ticket 分支永远走不到。
  // ⇒ **读侧必须自带优先级**：`(a.state <> 'released') DESC` 让活行恒排在前；同组内再按
  //   `released_at DESC NULLS LAST, a.id` 定序（AGENTS §8.5：不得依赖行的偶然顺序，released 多行时
  //   `released_at` 可同值，`a.id` 是全序兜底）。
  // ⚠ **不能改成只加 `AND a.state <> 'released'` 的过滤**：那会让只有 released 行的 host 落进「查不到」，
  //   `allocation_released`(403) 变死代码、portal.md §2.7 第 1/2 步的既有契约被改掉
  //  （契约：**有活行 → 放行**；**只有 released 行 → 403 `allocation_released`**；**完全没有行 → 404**）。
  const r = await pool.query(
    `SELECT a.id, a.fde_id, a.state, a.exposure, a.hostname, u.fde_name, u.status AS user_status
       FROM port_allocations a
       JOIN users u ON u.id = a.fde_id
      WHERE a.hostname = $1
      ORDER BY (a.state <> 'released') DESC, a.released_at DESC NULLS LAST, a.id
      LIMIT 1`,
    [hostname],
  );
  const allocation = r.rows?.[0];
  // #57：给可操作提示，替代 bare not found（书签失效/未分配预览域时用户看不出发生了什么）。
  if (!allocation) return deny(404, 'not_found', 'preview host not found (unassigned preview domain or stale bookmark)');
  if (allocation.state === 'released') {
    return deny(403, 'allocation_released', 'allocation released', { allocation });
  }

  // #241：CORS 预检免凭证放行（预检按规范不带凭据，见 isCorsPreflight）。位置**在 hostname/state
  // 两条 fail-closed 校验之后**，所以预检不能用来探测未知/已释放的预览 host；也不做 exposure 判定
  // （预检不携带、不返回任何业务数据）。`preflight: true` 让 http.js 跳过 allocated→active 升级
  //（升级语义仍是「首次**凭证**放行」，紧随其后的真身请求会照常触发）。
  if (isCorsPreflight({ method, accessControlRequestMethod })) {
    return allow(allocation, {
      subjectId: null,
      issuerId: null,
      grantId: null,
      grantKind: 'preflight',
      cookieToken: null,
      fdeName: allocation.fde_name,
      preflight: true,
    });
  }

  // public：不要求凭证（仍须过 hostname/state 校验）。
  if (allocation.exposure === 'public') {
    return allow(allocation, {
      subjectId: null,
      issuerId: null,
      grantId: null,
      grantKind: 'public',
      cookieToken: null,
      fdeName: allocation.fde_name,
    });
  }

  const ticket = parsePreviewTicket(uri);
  if (ticket) {
    const res = await handleTicket(pool, config, { ticket, allocation, uri, scheme, hostHeader, now });
    return { ...res, fdeName: allocation.fde_name };
  }
  if (cookieValue) {
    const res = await handleSessionCookie(pool, config, { cookie: cookieValue, allocation, now });
    return { ...res, fdeName: allocation.fde_name };
  }
  return deny(403, 'preview_ticket_required', 'preview ticket required', {
    allocation,
    subjectId: null,
    issuerId: null,
    grantId: null,
    grantKind: null,
  });
}

/**
 * 签发一次性预览 ticket（portal.md §2.8）。返回 { ticket, url, expires_in } 或 { error }。
 * 可见性：private → owner/admin；org-visible/public → 任意已认证用户；他人资源 404（不泄露存在性）。
 */
export async function issuePreviewTicket(pool, config, { allocationId, session, ip = null, ua = null, now = new Date() } = {}) {
  const r = await pool.query(
    `SELECT id, fde_id, state, exposure, hostname, url FROM port_allocations WHERE id = $1`,
    [allocationId],
  );
  const allocation = r.rows?.[0];
  if (!allocation || allocation.state === 'released') {
    return { error: { status: 404, code: 'not_found' } };
  }

  const user = session.user;
  let visible = false;
  if (allocation.exposure === 'private') {
    visible = user.role === 'admin' || user.id === allocation.fde_id;
  } else {
    visible = true; // org-visible / public：任意已认证用户
  }
  if (!visible) return { error: { status: 404, code: 'not_found' } };

  const ticket = `pt_${crypto.randomBytes(32).toString('base64url')}`;
  const tokenHash = hashToken(ticket);
  const expiresAt = new Date(now.getTime() + config.previewTicketTtlSeconds * 1000);
  await pool.query(
    `INSERT INTO preview_grants
        (token_hash, user_id, issuer_id, allocation_id, kind, state, expires_at, created_ip, created_ua)
      VALUES ($1, $2, $3, $4, 'ticket', 'active', $5, $6, $7)`,
    [tokenHash, user.id, user.id, allocation.id, expiresAt, ip, ua],
  );

  // 预览 URL 的 scheme/端口按**公开入口**派生（#57 阶段2，dev http:8090 / 生产 https 同一代码路径）：
  // 有 hostname 时用 projects.previewUrl(hostname, { publicBaseUrl: config.portalPublicBaseUrl }) 生成；
  // 无 hostname（存量旧形 / 测试桩）时回退库内 url，行为与旧口径一致。
  const base = allocation.hostname
    ? projects.previewUrl(allocation.hostname, { publicBaseUrl: config?.portalPublicBaseUrl ?? null })
    : allocation.url;

  return {
    ticket,
    url: `${base}?preview_ticket=${ticket}`,
    expires_in: config.previewTicketTtlSeconds,
  };
}
