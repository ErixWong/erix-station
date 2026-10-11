// 项目注册制的退役留档（P5 去项目化，docs/design/directory-as-project.md 定稿）。
// 原职责验尸：会话归属/run cwd/脚手架/slot/template 全部字符串化或退役，仅剩「端口分配锚点」——
// 也随 hostname/url 重写（<fde>-p-<port>.<伞域>，URL 去项目名段）去项目化。
// 本模块现状：
//   - 写路径（createProject/renameProject/deleteProject）已整体删除——应用层不再产生 projects 行；
//   - 读路径保留（listProjects/getProject + GET 端点），projects 表留档只读（迁移 0008 保留该表）；
//   - buildHostname 新语法 + toPort 映射仍被读路径与 traefik reconciler 的消费链路使用。
//     hostname 语法（#57 阶段2 伞域修订）：<fde>-p-<port4>.<BASE_DOMAIN>，BASE_DOMAIN 本身即伞域 fde.<可注册域>。
// 目录枚举/会话绑定见 dirs.js / sessions.js（cwd）。

// 号池常量与预览域名预算从 previewpool.js 取（叶子模块，零依赖）：本模块与 portalloc.js 都要用这批
// 常量，而 portalloc 已单向依赖本模块 ⇒ 反向 import 会构成 ESM 循环并在「先加载 portalloc」的入口上
// 踩 const 的 TDZ。理由与全部常量口径见 portal/src/previewpool.js 顶部。
import {
  MAX_FDE_NAME_LEN_FOR_HOSTNAME,
  PREVIEW_PORT_BUDGET_PROBE_PORT,
  PREVIEW_PORT_LABEL_MIN_WIDTH,
  PREVIEW_PORT_SEGMENT,
} from './previewpool.js';

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
 * hostname grammar（P5 去项目化，directory-as-project §3；#57 阶段2 伞域修订）：
 *   <fde>-p-<portLabel>.<baseDomain>   // portLabel = 端口十进制，不足 4 位零填充（号池端口 5 位则原样）
 * URL 去项目名段——顺带消灭「目录名 → 域名段」的合法化清洗；存量行由迁移 0008 重写。
 * `baseDomain` 语义 = **伞域**（#57：BASE_DOMAIN 从「可注册域」改为伞域 `fde.<可注册域>`，
 * 如 `fde.erix.vip`）⇒ 预览完整域 `eric-p-8001.fde.erix.vip`。语法里原先写死的 `.fde.` 段随之删除
 * （否则伞域下会叠加成 `.fde.fde.erix.vip`）。portal / llm 两条生成式（config.js `station.`/`llm.` 前缀）
 * 在新语义下自动正确，不受本函数影响。
 */
export function buildHostname({ fdeName, port, baseDomain }) {
  // 端口段宽度：不足 PREVIEW_PORT_LABEL_MIN_WIDTH（4）时零填充，**超过就原样拼**（#246：号池端口是
  // 5 位，`padStart` 不截断 ⇒ 首标签从 7 字符固定段变 8；预算同步从 56 收到 55，见下方预算段）。
  const portLabel = String(port).padStart(PREVIEW_PORT_LABEL_MIN_WIDTH, '0');
  return `${fdeName}${PREVIEW_PORT_SEGMENT}${portLabel}.${baseDomain}`;
}

// —— #202 预览域名预算（开户时前置校验，与路由生成期 routes.js isValidHostname 同口径）——
// buildHostname 的首标签 = <fde> + 固定段 `-p-<port>` ⇒ 首标签长度只取决于「FDE 名长度 + 固定段宽度」。
// DNS 单标签上限 63（RFC 1035）⇒ **FDE 名参与预览域名的有效预算 = 63 − 固定段宽度**：
//   · #240 时代端口恒 4 位 ⇒ 固定段 7 字符 ⇒ 预算 **56**；
//   · #246 起端口进全局号池 22000–29999（5 位）⇒ 固定段 **8** 字符 ⇒ 预算 **55**。
// 两个数都从 `previewpool.js` 的池边界**推导**（`MAX_FDE_NAME_LEN_FOR_HOSTNAME`），不写死端口、
// 也不写死预算：写死 `4000` 就是「56 字符的名字过了应用校验、到 INSERT 才被 0017 的 hostname CHECK
// 以 23514 炸掉」的直接原因（#202 要消灭的正是这种「预览打不开」）。
// 57..63 字符的名字能过 FDE_NAME_RE，却要等到路由生成阶段（routes.js）才被拒 →
// 用户只看到「预览打不开」，看不出是名字太长（#202 实况）。FDE 开户路径必须先挡（admin.js createUser）。
// 为什么不动 FDE_NAME_RE（≤63）本身：validateFdeName 还被目录名/容器名（fde-<name>）/
// git-credential/offboarding 等路径复用（dirs.js、provisioner.js、git-credential.js、offboarding.js），
// 那些消费方不受 DNS 标签约束，57..63 字符仍合法；故**另加**「参与预览域名」口径的校验（本节），
// 由开户路径显式调用，而不是收窄那个正则的语义。
export { MAX_FDE_NAME_LEN_FOR_HOSTNAME } from './previewpool.js';

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
 * 再整体校验（逐标签 ≤63 + 总长 ≤253），不是只验各段。探测端口固定取**池内最宽**的端口（#246 前是写死
 * 的 4000）⇒ 首标签长度只取决于 FDE 名（len + 固定段宽），与端口取值无关；baseDomain 缺省时退化为只校验首标签（预算与 base 域无关）。
 * 失败回可操作的 400 文案（含超限行长度与 FDE 名预算，预算值取自 previewpool 的推导常量）。
 */
export function validateFdeNameForHostname(fdeName, { baseDomain = null, probePort = PREVIEW_PORT_BUDGET_PROBE_PORT } = {}) {
  if (!validateFdeName(fdeName).ok) {
    return { ok: false, message: 'fde_name 非法（小写字母/数字/连字符，不以连字符开头或结尾）' };
  }
  // 探测端口取**池内最宽**的那个（#246）：拼出的首标签就是最坏情况，预算因此不可能被端口位数放宽。
  const firstLabel = `${fdeName}${PREVIEW_PORT_SEGMENT}${String(probePort).padStart(PREVIEW_PORT_LABEL_MIN_WIDTH, '0')}`;
  const hostname = baseDomain ? buildHostname({ fdeName, port: probePort, baseDomain }) : firstLabel;
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

/**
 * 预览 URL（#57 阶段2）：**不再写死 scheme**——从公开入口配置（config.portalPublicBaseUrl，
 * 即容器/浏览器实际可达的 Traefik 入口 `scheme://host[:port]`）派生 scheme 与非默认端口，
 * 保证 dev（`http://station.fde.erix.vip:8090`）与生产（`https://station.fde.erix.vip`）走同一代码路径：
 *   public = http://station.fde.erix.vip:8090 → http://eric-p-8001.fde.erix.vip:8090
 *   public = https://station.fde.erix.vip      → https://eric-p-8001.fde.erix.vip（https 默认端口不进 URL）
 * 预览 host 恒等于 hostname（无端口形态），端口后缀原样继承公开入口。
 * @param {string} hostname port_allocations.hostname（无端口）
 * @param {{ publicBaseUrl?: string | null }} [opts] 公开入口 base URL（config.portalPublicBaseUrl）；
 *        缺省/不可解析时退化为 https 无端口（等价旧 buildUrl 行为，单测与离线路径可用）
 */
export function previewUrl(hostname, { publicBaseUrl = null } = {}) {
  let scheme = 'https';
  let port = '';
  if (typeof publicBaseUrl === 'string' && publicBaseUrl !== '') {
    try {
      const u = new URL(publicBaseUrl);
      scheme = u.protocol === 'http:' ? 'http' : 'https';
      // URL.port 对默认端口（http:80 / https:443）返回空串 ⇒ 默认端口天然不进 URL。
      port = u.port ? `:${u.port}` : '';
    } catch {
      // 不可解析的 publicBaseUrl：保持 https 无端口的保守形态（不猜端口，避免生成不可达 URL）。
    }
  }
  return `${scheme}://${hostname}${port}`;
}

/** 兼容旧名（等价 previewUrl(hostname)，https 无端口）；新代码请用 previewUrl。 */
export function buildUrl(hostname) {
  return previewUrl(hostname);
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
