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

// —— #202 预览域名预算（开户时前置校验，与路由生成期 routes.js isValidHostname 同口径）——
// buildHostname 的首标签 = <fde> + "-p-" + 4 位端口（port4 恒 4 位）→ 固定段占 7 字符；
// DNS 单标签上限 63（RFC 1035）⇒ **FDE 名参与预览域名的有效预算 56**（63 − 7）。
// 57..63 字符的名字能过 FDE_NAME_RE，却要等到路由生成阶段（routes.js）才被拒 →
// 用户只看到「预览打不开」，看不出是名字太长（#202 实况）。FDE 开户路径必须先挡（admin.js createUser）。
// 为什么不动 FDE_NAME_RE（≤63）本身：validateFdeName 还被目录名/容器名（fde-<name>）/
// git-credential/offboarding 等路径复用（dirs.js、provisioner.js、git-credential.js、offboarding.js），
// 那些消费方不受 DNS 标签约束，57..63 字符仍合法；故**另加**「参与预览域名」口径的校验（本节），
// 由开户路径显式调用，而不是收窄那个正则的语义。
export const MAX_FDE_NAME_LEN_FOR_HOSTNAME = 56;

// 与 routes.js DNS_LABEL_RE 同构（单标签 ≤63 = 1+61+1，小写字母数字、不以 - 开头/结尾）。
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** 完整 hostname 校验（不是分段校验）：总长 ≤253（RFC 1035）+ 逐标签 ≤63 且 DNS 字符集。 */
export function validateHostnameGrammar(hostname) {
  if (typeof hostname !== 'string' || hostname.length === 0) {
    return { ok: false, reason: 'hostname 为空' };
  }
  if (hostname.length > 253) {
    return { ok: false, reason: `总长 ${hostname.length} 字符，超过整域名上限 253` };
  }
  for (const label of hostname.split('.')) {
    if (!DNS_LABEL_RE.test(label)) {
      return { ok: false, reason: `单标签「${label}」${label.length} 字符，超过 DNS 上限 63 或含非法字符`, label };
    }
  }
  return { ok: true };
}

/**
 * 开户（及任何要落 hostname 的路径）的 FDE 名校验：先按 buildHostname 语法拼出**最终 hostname**
 * 再整体校验（逐标签 ≤63 + 总长 ≤253），不是只验各段。port4 恒 4 位 → 首标签长度只取决于 FDE 名
 * （len + 7），与端口取值无关；baseDomain 缺省时退化为只校验首标签（预算与 base 域无关）。
 * 失败回可操作的 400 文案（含超限行长度与 FDE 名预算 56）。
 */
export function validateFdeNameForHostname(fdeName, { baseDomain = null } = {}) {
  if (!validateFdeName(fdeName).ok) {
    return { ok: false, message: 'fde_name 非法（小写字母/数字/连字符，不以连字符开头或结尾）' };
  }
  const firstLabel = `${fdeName}-p-4000`;
  const hostname = baseDomain ? buildHostname({ fdeName, port: 4000, baseDomain }) : firstLabel;
  if (hostname.length > 253) {
    return { ok: false, message: `预览域名过长：生成的预览域名总长 ${hostname.length} 字符，超过整域名上限 253` };
  }
  for (const label of hostname.split('.')) {
    if (DNS_LABEL_RE.test(label)) continue;
    if (label === firstLabel) {
      return {
        ok: false,
        message: `FDE 名过长：生成的预览域名单标签 ${label.length} 字符，超过 DNS 上限 63（FDE 名请缩短到 ${MAX_FDE_NAME_LEN_FOR_HOSTNAME} 以内）`,
      };
    }
    return { ok: false, message: `预览域名非法：base 域标签「${label}」${label.length} 字符，超过 DNS 上限 63 或含非法字符` };
  }
  return { ok: true };
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
