// 预览 ticket / 预览 cookie 签发与校验（forward-auth 授权核心）。
// 依据：docs/api/portal.md §2.7/§2.8、docs/design/fde-platform.md §8.6（allocated→active 由首次 forward-auth 放行触发）、
//       docs/data/schema.sql §4（preview_grants）、docs/design/principles.md §2（认证在边缘）。
//
// 安全口径：ticket/session 只存 sha256 哈希（不存明文）；凭证查询显式 state='active'；
//           forward-auth 不解析 cookie.sub（按 token 哈希查 preview_grants 解析主体）。

import crypto from 'node:crypto';
import { hashToken } from './auth.js';

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

/** 校验一次性 ticket 凭证（portal.md §2.7 第 4/6 步）。 */
async function handleTicket(pool, config, { ticket, allocation, uri, scheme, now }) {
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
        location: buildLocation(scheme, allocation.hostname, stripPreviewTicket(uri)),
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
          location: buildLocation(scheme, allocation.hostname, stripPreviewTicket(uri)),
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
    location: buildLocation(scheme, allocation.hostname, stripPreviewTicket(uri)),
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

function buildLocation(scheme, hostname, cleanUri) {
  const s = scheme === 'http' ? 'http' : 'https';
  return `${s}://${hostname}${cleanUri || '/'}`;
}

/**
 * forward-auth 授权核心（portal.md §2.7）。返回结构化结果，由 http.js 映射为 HTTP 响应。
 * fail-closed：无凭证 / 凭证无效一律 deny，绝不放行。
 */
export async function authorizeForwardAuth(pool, config, { hostname, uri = '/', cookieValue = null, method = 'GET', scheme = 'https', now = new Date() } = {}) {
  const r = await pool.query(
    `SELECT a.id, a.fde_id, a.state, a.exposure, a.hostname, u.fde_name, u.status AS user_status
       FROM port_allocations a
       JOIN users u ON u.id = a.fde_id
      WHERE a.hostname = $1
      LIMIT 1`,
    [hostname],
  );
  const allocation = r.rows?.[0];
  if (!allocation) return deny(404, 'not_found', 'not found');
  if (allocation.state === 'released') {
    return deny(403, 'allocation_released', 'allocation released', { allocation });
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
    const res = await handleTicket(pool, config, { ticket, allocation, uri, scheme, now });
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
    `SELECT id, fde_id, state, exposure, url FROM port_allocations WHERE id = $1`,
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

  return {
    ticket,
    url: `${allocation.url}?preview_ticket=${ticket}`,
    expires_in: config.previewTicketTtlSeconds,
  };
}
