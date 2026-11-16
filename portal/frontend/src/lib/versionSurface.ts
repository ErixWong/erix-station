// 管理台「关于」面板（issue #586）的纯逻辑：端点响应 → 三格 + 不猜数归一化。
// 契约唯一来源：`docs/api/portal.md` §4.16（`GET /api/admin/version`）。
//
// 本单要治的事故（发 v0.1.69 时 portal 烘了停在 0.1.68 的旧工作树，两边分裂一小时无人发现）说明的不是
// 「缺一个显示版本的地方」，而是**三个版本号此前只在人脑里分开**。所以本文件的硬口径不是格式化，是：
//   1. **三格各自从自己的字段读**，前端一个字都不推算（不拼、不取整、不「和平台侧一样吧」）。
//      尤其 `fdes[].agentVersion` **只**读 `agent_version`——把它当平台侧引擎版本显示就是本单的返工点。
//   2. **`unknown` 是数据不是空**：服务端缺字段时给字面量 `unknown`（`build-info` 的降级链）。
//      这里把它收成 `null` 并由页面渲染成显式的「未知（unknown）」，**绝不**渲染成空串或 `0`。
//   3. **快照口径不许丢**：FDE 段每一项都带 `snapshot`（来自服务端的 `provision` 标注），
//      页面据此显示「provision 时快照」字样（判据 C）。
import type { ApiError } from '../api';

/** 端点路径（唯一拼法）。 */
export const VERSION_PATH = '/api/admin/version';

/** 服务端缺字段时给的字面量（`runner/lib/build-info.js` 的降级链；不是我们编的哨兵）。 */
export const UNKNOWN_LITERAL = 'unknown';

/** `server.source` 的取值：这一格到底从哪儿读到的（`build-info` = 镜像里烘的构建产物）。 */
export type VersionSource = 'build-info' | 'env' | 'package' | 'unknown' | 'other';

/** 服务端段 = **portal 镜像**自己（`station_version` / `revision` / `built_at`）。 */
export interface ServerCell {
  station: string | null;
  revision: string | null;
  builtAt: string | null;
  source: VersionSource;
}

/** 每台 FDE 的引擎段 = `containers.agent_version`（**派生副本**，不是权威载体）。 */
export interface FdeCell {
  name: string;
  agentVersion: string | null;
  image: string | null;
  provisionedAt: string | null;
  lastHeartbeatAt: string | null;
  revoked: boolean;
  /** 服务端标的快照口径（`provision`）；缺失 ⇒ `null` = 服务端没说，页面要显式说「口径未给出」。 */
  snapshot: string | null;
  versionSource: string | null;
}

export interface VersionInfo {
  server: ServerCell;
  /**
   * 服务端实际去读的那条 build-info 路径（复验阻断：`STATION_BUILD_INFO_PATH` / `ERIX_BUILD_INFO_PATH`
   * 这三个注入旋钮能把路径换掉 ⇒ 「读的是哪条路径」必须在界面上看得见）。`null` = 服务端没说。
   * ⚠ 它只证明「读了这条路径」，证明不了「读到了」——有没有读到看 `provenance`。
   */
  buildInfoPath: string | null;
  /** 平台侧引擎 = **portal 镜像里的 erix-agent**，与 FDE 段那个数**不是**一回事。 */
  platformEngineVersion: string | null;
  fdes: FdeCell[];
  /** 服务端真的给了 FDE 列表（false ⇒ 页面说「读不到」，不说「没有 FDE」，#350 同口径）。 */
  fdesPresent: boolean;
  provenance: { server: string | null; platformEngine: string | null; fdes: string | null };
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 版本字符串：只认非空字符串，且把 `unknown` 收成 `null`（判据 2：`unknown` 不许显示成 `unknown`
 * 之外的任何东西，但页面要能说「这是未知」而不是「这里没数据」）。
 */
function versionOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === UNKNOWN_LITERAL) return null;
  return trimmed;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function booleanish(value: unknown): boolean {
  return value === true || value === 1 || value === 'true';
}

export function versionSourceOf(value: unknown): VersionSource {
  return value === 'build-info' || value === 'env' || value === 'package' || value === 'unknown'
    ? value
    : 'other';
}

/** 端点响应 → 三格。入参 `unknown`：服务端换形、桩给半截、字段脏值都不许炸，也不许猜。 */
export function normalizeVersionInfo(raw: unknown): VersionInfo {
  const root = recordOf(raw) ?? {};
  const serverRaw = recordOf(root.server);
  const engineRaw = recordOf(root.platformEngine);
  const provenanceRaw = recordOf(root.provenance);

  const fdesRaw = root.fdes;
  // 「服务端给了列表」与「服务端说这一段读不到」是两件事（#350 同口径）：
  // 服务端用 `fdesPresent` 说这句话 ⇒ 它给了旗标就听它的，没给（老版 / 桩）才退到「是不是数组」。
  const fdesPresent = typeof root.fdesPresent === 'boolean' ? root.fdesPresent : Array.isArray(fdesRaw);
  const fdes: FdeCell[] = (Array.isArray(fdesRaw) ? (fdesRaw as unknown[]) : [])
    .map((item) => recordOf(item))
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => ({
      name: stringOrNull(item.name) ?? UNKNOWN_LITERAL,
      agentVersion: versionOrNull(item.agent_version ?? item.agentVersion),
      image: versionOrNull(item.image),
      provisionedAt: versionOrNull(item.provisioned_at ?? item.provisionedAt),
      lastHeartbeatAt: versionOrNull(item.last_heartbeat_at ?? item.lastHeartbeatAt),
      revoked: booleanish(item.revoked),
      snapshot: stringOrNull(item.snapshot),
      versionSource: stringOrNull(item.versionSource ?? item.version_source),
    }));

  return {
    server: {
      station: versionOrNull(serverRaw?.station),
      revision: versionOrNull(serverRaw?.revision),
      builtAt: versionOrNull(serverRaw?.builtAt),
      source: versionSourceOf(serverRaw?.source),
    },
    platformEngineVersion: versionOrNull(engineRaw?.version),
    fdes,
    fdesPresent,
    // `unknown` 收成 null（判据 2 同口径）：服务端没说就是「未知」，不显示成字面量路径。
    buildInfoPath: versionOrNull(root.buildInfoPath ?? root.build_info_path),
    provenance: {
      // 来源标注**由服务端推导后给出**（`portal/src/version-info.js#provenanceFor`）：前端只搬运，
      // 不自己判「看起来像不像 build-info」——判一次就是第二份口径，而本单的返工点正是口径有第二份。
      server: stringOrNull(provenanceRaw?.server),
      platformEngine: stringOrNull(provenanceRaw?.platformEngine),
      fdes: stringOrNull(provenanceRaw?.fdes),
    },
  };
}

/**
 * 时间戳的展示形态：能解析就用本地时间，解析不了**原样给出**（判据：不许把脏值静默丢掉）。
 * `null` ⇒ 调用方渲染「未知」。
 */
export function formatInstant(raw: string | null): { kind: 'unknown' } | { kind: 'formatted'; text: string } | { kind: 'raw'; text: string } {
  if (raw === null) return { kind: 'unknown' };
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return { kind: 'raw', text: raw };
  return { kind: 'formatted', text: at.toLocaleString() };
}

/** revision 太长（40 位 sha）会撑破版面；显示前 12 位，完整值留在 `title` 里可复制。 */
export function shortRevision(revision: string | null): string | null {
  if (revision === null) return null;
  return revision.length <= 12 ? revision : `${revision.slice(0, 12)}…`;
}

/**
 * `ApiError` → 页面错误行（服务端 message 原文不翻译，只加本地化前缀；与 #350 同口径）。
 */
export function versionErrorText(err: unknown): string {
  const error = err as Partial<ApiError> | null | undefined;
  if (error && typeof error.message === 'string' && error.message !== '') return error.message;
  if (err instanceof Error && err.message !== '') return err.message;
  return String(err);
}
