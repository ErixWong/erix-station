// 项目 CRUD + 项目级端口分配 + hostname/url 生成 + IPAM 触发 + 端口回收（tombstone）。
// 依据：docs/api/portal.md §3、docs/design/fde-platform.md §8（端口块/hostname grammar/不可变性）、
//       docs/design/user-space.md §7.1、docs/data/schema.sql §2/§4/§9。

import { allocateNetworkInTx } from './ipam.js';
import {
  enqueueRouteChange,
  enqueueMaterializeChange,
} from './outbox.js';

export const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const FDE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const PORT_BLOCK_BASE = 4000;
export const PORT_BLOCK_SIZE = 8;
export const DEFAULT_PORT_QUOTA = 40; // 每用户项目 slot 配额（规格 §8.2「如 40 个端口」）

export class ProjectError extends Error {
  constructor(code, message, { httpStatus = 400, details } = {}) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export function validateProjectName(name) {
  if (typeof name !== 'string' || !PROJECT_NAME_RE.test(name)) {
    return { ok: false, reason: 'name 必须是 [a-z0-9][a-z0-9-]{0,62}' };
  }
  return { ok: true };
}

export function validateFdeName(fdeName) {
  if (typeof fdeName !== 'string' || !FDE_NAME_RE.test(fdeName)) {
    return { ok: false };
  }
  return { ok: true };
}

/**
 * hostname grammar（fde-platform.md §8.5，写死）：
 *   <fde>-p-<projectName>-<port>.fde.<base>
 * 项目名是分配时的快照，改名不重生成已有 allocation（不可变性）。
 */
export function buildHostname({ fdeName, projectName, port, baseDomain }) {
  const port4 = String(port).padStart(4, '0');
  return `${fdeName}-p-${projectName}-${port4}.fde.${baseDomain}`;
}

export function buildUrl(hostname) {
  return `https://${hostname}`;
}

/** 项目级固定端口 = 块首 4000 + slot*8（规格 §8.2）。 */
export function slotToPort(slot) {
  return PORT_BLOCK_BASE + slot * PORT_BLOCK_SIZE;
}

/** 从活跃项目列表求下一个空闲 slot；无则抛 port_quota_exceeded（409）。 */
export function findFreeSlot(usedSlots, quota = DEFAULT_PORT_QUOTA) {
  const used = new Set(usedSlots.map((s) => Number(s)));
  for (let s = 0; s < quota; s++) {
    if (!used.has(s)) return s;
  }
  const err = new ProjectError('port_quota_exceeded', `端口配额已满（${quota}）`, { httpStatus: 409 });
  throw err;
}

/** 把一个 project 行映射为 Project 对象（portal.md §3.1）。 */
export function toProject(row) {
  return {
    id: row.id,
    name: row.name,
    repo_url: row.repo_url,
    root_path: row.root_path,
    slot: Number(row.slot),
    template: row.template,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

/** 把一个 port_allocations 行映射为 PortAllocation 对象（portal.md §3.3/§4.7）。 */
export function toPort(row) {
  return {
    id: row.id,
    scope: row.scope,
    port: Number(row.port),
    role: row.role,
    run_id: row.run_id,
    hostname: row.hostname,
    url: row.url,
    exposure: row.exposure,
    state: row.state,
    released_at: row.released_at instanceof Date ? row.released_at.toISOString() : row.released_at,
  };
}

async function lockUserProjectSpace(client, userId) {
  // 串行化同用户的项目创建/删除（slot 分配、端口回收），避免 gap 竞争。
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`project:${userId}`]);
}

/** 读取当前登录用户（须有 fde_name，否则无法生成 hostname）。 */
async function loadUser(client, userId) {
  const r = await client.query(
    `SELECT id, login, display_name, role, fde_name, auth_source, status FROM users WHERE id = $1 AND status = 'active'`,
    [userId],
  );
  return r.rows[0] ?? null;
}

/**
 * 创建项目（同一事务：projects + 端口分配 + IPAM 确保网络 + route/materialize outbox）。
 * @returns { project, port }
 */
export async function createProject(pool, { userId, name, repoUrl, template = 'default', config }) {
  const v = validateProjectName(name);
  if (!v.ok) throw new ProjectError('validation_failed', v.reason, { httpStatus: 400, details: { field: 'name' } });
  if (typeof repoUrl !== 'string' || repoUrl.trim() === '') {
    throw new ProjectError('validation_failed', 'repo_url 为必填字段', { httpStatus: 400, details: { field: 'repo_url' } });
  }
  // repo_url 仅作登记元数据（平台不 clone），做最小 URL 形状校验（不强制 git 协议）。
  let repoUrlParsed;
  try {
    repoUrlParsed = new URL(repoUrl);
  } catch {
    throw new ProjectError('validation_failed', 'repo_url 非法', { httpStatus: 400, details: { field: 'repo_url' } });
  }
  if (!['http:', 'https:', 'git:', 'ssh:'].includes(repoUrlParsed.protocol)) {
    throw new ProjectError('validation_failed', 'repo_url 非法（仅支持 http/https/git/ssh）', {
      httpStatus: 400,
      details: { field: 'repo_url' },
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockUserProjectSpace(client, userId);
    const user = await loadUser(client, userId);
    if (!user) throw new ProjectError('not_found', 'not found', { httpStatus: 404 });
    if (!user.fde_name) {
      throw new ProjectError('validation_failed', '当前用户未配置 fde_name，无法创建项目', {
        httpStatus: 400,
        details: { field: 'fde_name' },
      });
    }
    if (!validateFdeName(user.fde_name).ok) {
      throw new ProjectError('validation_failed', 'fde_name 非法', { httpStatus: 400, details: { field: 'fde_name' } });
    }

    // 名字冲突（projects_live_name_key 兜底）。
    const dup = await client.query(
      `SELECT 1 FROM projects WHERE user_id = $1 AND name = $2 AND deleted_at IS NULL`,
      [userId, name],
    );
    if (dup.rows.length > 0) {
      throw new ProjectError('name_conflict', `项目名 ${name} 已存在`, { httpStatus: 409 });
    }

    // 确保 FDE 网络（IPAM）存在：写 fde_networks（WP2a 只做 DB 分配，docker 网络由测试脚本手工建）。
    await allocateNetworkInTx(client, userId, user.fde_name, {
      poolName: config?.fdePool ?? 'default',
      reservedSubnets: config?.reservedSubnets ?? [],
    });

    // 端口块分配：slot → 块首端口。
    const used = await client.query(
      `SELECT slot FROM projects WHERE user_id = $1 AND deleted_at IS NULL ORDER BY slot`,
      [userId],
    );
    const slot = findFreeSlot(used.rows.map((r) => r.slot), config?.portQuota ?? DEFAULT_PORT_QUOTA);
    const port = slotToPort(slot);
    const hostname = buildHostname({
      fdeName: user.fde_name,
      projectName: name,
      port,
      baseDomain: config.baseDomain,
    });
    const url = buildUrl(hostname);

    const projectRow = await client.query(
      `INSERT INTO projects (user_id, name, repo_url, root_path, slot, template)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, repo_url, root_path, slot, template, created_at`,
      [userId, name, repoUrl, `~/projects/${name}`, slot, template],
    );
    const projectId = projectRow.rows[0].id;

    const allocRow = await client.query(
      `INSERT INTO port_allocations (fde_id, scope, project_id, run_id, port, role, hostname, url, exposure, state)
       VALUES ($1, 'project', $2, NULL, $3, 'frontend', $4, $5, 'private', 'allocated')
       RETURNING id, fde_id, scope, project_id, run_id, port, role, hostname, url, exposure, state, released_at`,
      [userId, projectId, port, hostname, url],
    );
    const allocation = allocRow.rows[0];

    // 同事务写 route outbox（per-allocation upsert）+ materialize outbox（per-FDE upsert）。
    await enqueueRouteChange(client, {
      aggregate: 'port_allocation',
      aggregateId: allocation.id,
      op: 'upsert',
      payload: { allocation_id: allocation.id, project_id: projectId, hostname, url, port },
    });
    await enqueueMaterializeChange(client, {
      fdeId: userId,
      op: 'upsert',
      payload: { project_id: projectId, project_name: name, allocation_id: allocation.id },
    });

    await client.query('COMMIT');
    return { project: toProject(projectRow.rows[0]), port: toPort(allocation) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** 项目列表（cursor 分页，portal.md §1.3/§3.2）。 */
export async function listProjects(pool, { userId, cursor, limit = 20 }) {
  const n = Math.max(1, Math.min(100, Number(limit) || 20));
  const params = [userId, n];
  let where = 'user_id = $1 AND deleted_at IS NULL';
  if (cursor) {
    where += ' AND created_at < $3';
    params.push(new Date(cursor));
  }
  const r = await pool.query(
    `SELECT id, name, repo_url, root_path, slot, template, created_at
       FROM projects WHERE ${where} ORDER BY created_at DESC LIMIT $2`,
    params,
  );
  const items = r.rows.map(toProject);
  const nextCursor = items.length === n ? items[items.length - 1].created_at : null;
  return { items, next_cursor: nextCursor };
}

/** 项目详情 + 端口列表（portal.md §3.4）。 */
export async function getProject(pool, { userId, projectId }) {
  const r = await pool.query(
    `SELECT id, name, repo_url, root_path, slot, template, created_at
       FROM projects WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [projectId, userId],
  );
  if (r.rows.length === 0) throw new ProjectError('not_found', 'not found', { httpStatus: 404 });
  const ports = await pool.query(
    `SELECT id, fde_id, scope, project_id, run_id, port, role, hostname, url, exposure, state, released_at
       FROM port_allocations WHERE project_id = $1 AND state <> 'released' ORDER BY port`,
    [projectId],
  );
  return { project: toProject(r.rows[0]), ports: ports.rows.map(toPort) };
}

/**
 * 改名（portal.md §3.5）：更新 projects.name（容器内目录名），
 * 不重生成已有 allocation 的 hostname/url（项目名快照，不可变性）；不改 route outbox。
 */
export async function renameProject(pool, { userId, projectId, name }) {
  const v = validateProjectName(name);
  if (!v.ok) throw new ProjectError('validation_failed', v.reason, { httpStatus: 400, details: { field: 'name' } });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockUserProjectSpace(client, userId);
    const exists = await client.query(
      `SELECT 1 FROM projects WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [projectId, userId],
    );
    if (exists.rows.length === 0) throw new ProjectError('not_found', 'not found', { httpStatus: 404 });
    const dup = await client.query(
      `SELECT 1 FROM projects WHERE user_id = $1 AND name = $2 AND deleted_at IS NULL AND id <> $3`,
      [userId, name, projectId],
    );
    if (dup.rows.length > 0) throw new ProjectError('name_conflict', `项目名 ${name} 已存在`, { httpStatus: 409 });
    const r = await client.query(
      `UPDATE projects SET name = $3, root_path = $4 WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING id, name, repo_url, root_path, slot, template, created_at`,
      [projectId, userId, name, `~/projects/${name}`],
    );
    // F7：改名也须 enqueue materialize change（新目录生成 + 旧目录收敛）。
    // 不改 route outbox（hostname/url 是项目名快照，不可变，portal.md §3.5 / fde-platform §8.5）。
    await enqueueMaterializeChange(client, {
      fdeId: userId,
      op: 'upsert',
      payload: { project_id: projectId, project_name: name },
    });
    await client.query('COMMIT');
    return toProject(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 删除项目（portal.md §3.6）：回收端口（state→released）+ route tombstone + materialize tombstone，
 * 同一事务；项目软删除（deleted_at）。有进行中 run 时 409 active_runs。
 */
export async function deleteProject(pool, { userId, projectId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockUserProjectSpace(client, userId);
    const proj = await client.query(
      `SELECT id, user_id FROM projects WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [projectId, userId],
    );
    if (proj.rows.length === 0) throw new ProjectError('not_found', 'not found', { httpStatus: 404 });

    const activeRuns = await client.query(
      `SELECT 1 FROM runs r JOIN chat_sessions s ON s.id = r.session_id
        WHERE s.project_id = $1 AND r.status IN ('queued', 'running', 'cancelling') LIMIT 1`,
      [projectId],
    );
    if (activeRuns.rows.length > 0) {
      throw new ProjectError('active_runs', '项目下有进行中的 run，须先停止', { httpStatus: 409 });
    }

    // 回收该项目全部未释放端口。
    const allocs = await client.query(
      `UPDATE port_allocations SET state = 'released', released_at = now()
        WHERE project_id = $1 AND state <> 'released'
        RETURNING id`,
      [projectId],
    );
    for (const a of allocs.rows) {
      await enqueueRouteChange(client, {
        aggregate: 'port_allocation',
        aggregateId: a.id,
        op: 'delete',
        payload: { allocation_id: a.id, project_id: projectId },
      });
    }

    // 同事务吊销该 allocation 的 active 预览凭证（portal.md §2.8；P1 尚无预览，语义保留）。
    await client.query(
      `UPDATE preview_grants SET state = 'revoked', revoked_at = now()
        WHERE allocation_id IN (
          SELECT id FROM port_allocations WHERE project_id = $1
        ) AND state = 'active'`,
      [projectId],
    );

    await enqueueMaterializeChange(client, {
      fdeId: userId,
      op: 'delete',
      payload: { project_id: projectId },
    });

    await client.query(
      `UPDATE projects SET deleted_at = now() WHERE id = $1 AND user_id = $2`,
      [projectId, userId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
