// 项目注册制的退役留档（P5 去项目化，docs/design/directory-as-project.md 定稿）。
// 原职责验尸：会话归属/run cwd/脚手架/slot/template 全部字符串化或退役，仅剩「端口分配锚点」——
// 也随 hostname/url 重写（<fde>-p-<port>.fde.<base>，URL 去项目名段）去项目化。
// 本模块现状：
//   - 写路径（createProject/renameProject/deleteProject）已整体删除——应用层不再产生 projects 行；
//   - 读路径保留（listProjects/getProject + GET 端点），projects 表留档只读（迁移 0008 保留该表）；
//   - buildHostname 新语法 + toPort 映射仍被读路径与 traefik reconciler 的消费链路使用。
// 目录枚举/会话绑定见 dirs.js / sessions.js（cwd）。

export const PROJECT_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const FDE_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

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
 * hostname grammar（P5 去项目化，directory-as-project §3）：
 *   <fde>-p-<port4>.fde.<base>
 * URL 去项目名段——顺带消灭「目录名 → 域名段」的合法化清洗；存量行由迁移 0008 重写。
 */
export function buildHostname({ fdeName, port, baseDomain }) {
  const port4 = String(port).padStart(4, '0');
  return `${fdeName}-p-${port4}.fde.${baseDomain}`;
}

export function buildUrl(hostname) {
  return `https://${hostname}`;
}

/** 把一个 project 行映射为 Project 对象（portal.md §3.1；留档只读的响应形状不变）。 */
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

/** 项目列表（cursor 分页，portal.md §1.3/§3.2）。P5：只读留档。 */
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

/** 项目详情 + 端口列表（portal.md §3.4）。P5：只读留档。 */
export async function getProject(pool, { userId, projectId }) {
  const r = await pool.query(
    `SELECT id, name, repo_url, root_path, slot, template, created_at
       FROM projects WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [projectId, userId],
  );
  if (r.rows.length === 0) throw new ProjectError('not_found', 'not found', { httpStatus: 404 });
  // P5：port_allocations.project_id 已随注册制退役（迁移 0008 DROP）——项目维度端口视图不再可推导，
  // 只读留档端点仅回项目本体；FDE 级实时分配见物化产物 ~/.erix/ports.json。
  return { project: toProject(r.rows[0]), ports: [] };
}
