// issue #64 R1：run 终态 worktree 产物回收——portal 侧登记与取回。
// 依据：docs/design/runner-integration.md §4.2 U13 / §6.6；docs/data/model.md §1.13。
//
// 存储：tar.gz 落 portal 持久卷（config.artifactsRoot/<runId>.tar.gz，bind mount，deploy-contract §2.2 ④）；
// 登记：artifacts 表一行（kind='worktree_bundle'，UNIQUE(run_id, kind)，迁移 0005），manifest 落 jsonb。
// 上传发生在 run 终态之后（agentd 在 U2 终态确认后、清场前捕获）——此时租约已释放，
// 故上传鉴权 = per-container token + run 属主校验（与读端点族「终态放宽租约」同口径），
// 不校验 X-Claim-Token（runner §4.2 U13 / portal.md §9.7 口径延伸）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { InternalError } from './internal.js';

export const ARTIFACT_KIND = 'worktree_bundle';

// ---------------------------------------------------------------------------
// 极简 tar.gz 读取：只支持 ustar 常规条目（name ≤100B，无 longname/pax 扩展）。
// agentd 侧 writer（runner/lib/artifacts.js）按此约定生成：文件条目一律短名 files/NNNNNN，
// 真实路径在 manifest.json 内——规避长文件名编码，读写两侧都保持极简。
// ---------------------------------------------------------------------------

/**
 * 从 tar.gz 字节中提取单个条目的内容。未找到 / 解析失败返回 null。
 * @param {Buffer} gzData
 * @param {string} entryName
 * @returns {Buffer|null}
 */
export function extractTarGzEntry(gzData, entryName) {
  let data;
  try {
    data = zlib.gunzipSync(gzData);
  } catch {
    return null;
  }
  let off = 0;
  while (off + 512 <= data.length) {
    const header = data.subarray(off, off + 512);
    if (header.every((b) => b === 0)) return null; // 全零块 = 结束
    const type = String.fromCharCode(header[156] || 0x30);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    // size 字段：11 位八进制 + NUL/空格。
    const sizeRaw = header.subarray(124, 136).toString('ascii').replace(/[\0 ]/g, '');
    const size = /^[0-7]+$/.test(sizeRaw) ? parseInt(sizeRaw, 8) : NaN;
    if (!Number.isFinite(size) || size < 0) return null;
    const bodyOff = off + 512;
    if (bodyOff + size > data.length) return null;
    if (type === '0' && name === entryName) {
      return Buffer.from(data.subarray(bodyOff, bodyOff + size));
    }
    off = bodyOff + Math.ceil(size / 512) * 512;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 上传（internal：PUT /api/internal/runs/:id/artifact）
// ---------------------------------------------------------------------------

/**
 * 登记并落盘 run 产物 bundle。幂等：UNIQUE(run_id, kind) 冲突 → 409 artifact_exists（不覆盖）。
 * @returns {Promise<{artifact_id:string,size:number,sha256:string,truncated:boolean}>}
 */
export async function putRunArtifact(pool, {
  user, runId, data, sha256, artifactsRoot, maxBytes, log = console,
}) {
  if (!Buffer.isBuffer(data) || data.length === 0) {
    throw new InternalError(400, 'validation_failed', 'artifact body 必须为非空字节流');
  }
  if (data.length > maxBytes) {
    throw new InternalError(413, 'artifact_too_large', 'artifact 超过大小上限', {
      details: { max_bytes: maxBytes },
    });
  }
  const actualSha = crypto.createHash('sha256').update(data).digest('hex');
  if (typeof sha256 === 'string' && sha256.length > 0 && sha256 !== actualSha) {
    throw new InternalError(400, 'sha256_mismatch', 'X-Sha-256 与 body 实际摘要不一致');
  }

  // 归属校验：容器 token 已鉴权（authenticateContainer），此处校验 run 属于该 user（fetchRun 同语义）。
  const own = await pool.query(
    `SELECT r.id
       FROM runs r
       JOIN chat_sessions s ON s.id = r.session_id
      WHERE r.id = $1 AND s.user_id = $2`,
    [runId, user.id],
  );
  if (!own.rows?.[0]) throw new InternalError(404, 'run_not_found', 'run not found');

  // manifest 以 tar 内 manifest.json 为准（agentd 生成，随包下行，下载侧同一份）。
  let manifest = null;
  try {
    manifest = JSON.parse(extractTarGzEntry(data, 'manifest.json')?.toString('utf8') ?? 'null');
  } catch { /* 落入下方 400 */ }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new InternalError(400, 'invalid_artifact', 'artifact 内 manifest.json 缺失或不可解析');
  }

  // 落盘：tmp + rename 原子替换（materializer 同款模式，user-space §4）；同 run 重复上传不覆盖。
  fs.mkdirSync(artifactsRoot, { recursive: true });
  const finalPath = path.join(artifactsRoot, `${runId}.tar.gz`);
  const tmpPath = path.join(artifactsRoot, `.tmp-${runId}-${process.pid}`);
  fs.writeFileSync(tmpPath, data);
  let inserted;
  try {
    const r = await pool.query(
      `INSERT INTO artifacts (run_id, kind, path, size, sha, manifest)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (run_id, kind) DO NOTHING
       RETURNING id`,
      [runId, ARTIFACT_KIND, finalPath, data.length, actualSha, JSON.stringify(manifest)],
    );
    inserted = r.rows?.[0] ?? null;
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
  if (!inserted) {
    // 幂等命中：已有产物，删除临时文件并拒绝（409，不覆盖既有产物）。
    fs.rmSync(tmpPath, { force: true });
    throw new InternalError(409, 'artifact_exists', 'artifact already uploaded for this run');
  }
  fs.renameSync(tmpPath, finalPath);
  log.info?.(`[artifacts] run=${runId} bundle stored (${data.length}B, truncated=${manifest.truncated === true})`);
  return {
    artifact_id: inserted.id,
    size: data.length,
    sha256: actualSha,
    truncated: manifest.truncated === true,
  };
}

// ---------------------------------------------------------------------------
// 取回（用户面：GET /api/runs/:id/artifact，admin 或 run 属主）
// ---------------------------------------------------------------------------

/**
 * 定位 run 产物 bundle。鉴权：admin 或 run 属主；非属主一律 404（不泄露存在性，对齐 GET /api/runs/:id）。
 * @returns {Promise<{filePath:string, row:object}>}
 */
export async function getRunArtifact(pool, { sessionUser, runId, artifactsRoot }) {
  const r = await pool.query(
    `SELECT a.id, a.path, a.size, a.sha, a.manifest, a.created_at, s.user_id AS owner_id
       FROM artifacts a
       JOIN runs r ON r.id = a.run_id
       JOIN chat_sessions s ON s.id = r.session_id
      WHERE a.run_id = $1 AND a.kind = $2`,
    [runId, ARTIFACT_KIND],
  );
  const row = r.rows?.[0];
  if (!row) throw new InternalError(404, 'artifact_not_found', 'no artifact for this run');
  if (sessionUser.role !== 'admin' && row.owner_id !== sessionUser.id) {
    throw new InternalError(404, 'artifact_not_found', 'no artifact for this run');
  }
  const filePath = row.path || path.join(artifactsRoot, `${runId}.tar.gz`);
  if (!fs.existsSync(filePath)) {
    throw new InternalError(500, 'artifact_file_missing', 'artifact file missing on volume');
  }
  return { filePath, row };
}
