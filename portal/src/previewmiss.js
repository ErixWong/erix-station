// 预览未命中计数（#366 P0）：JSON 预览通道每次抛 415/413 就按 (kind, ext, day) UPSERT 一笔。
// 为什么存在：Office/PDF/压缩包值不值得引入 kkFileView（#356/#366 P2），不能靠感觉——
// 这些点击今天全部以 415 死掉，平台看不见。本模块把「死掉的点击」变成可查的聚合数（不存路径/文件名，
// 只存扩展名与类别）。表结构见 deploy/migrations/0023-preview-miss-stats.sql。
// 失败口径：埋点是增强物不是关键路径——写失败只 warn（log 注入，测试可断言），绝不打断预览响应。

const KIND_BINARY = 'binary'; // 415 unsupported_file_type
const KIND_TOO_LARGE = 'too_large'; // 413 file_too_large

/** 扩展名归一：小写、去点、只留 [a-z0-9]，无扩展名/不可识别 → ''（仍计数，聚合成"无扩展名"一类）。 */
export function normalizeExt(relPath) {
  const base = String(relPath ?? '').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return ''; // 无点或点开头（.gitignore 视为无扩展名族）
  return base.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
}

/** 从 DirError 映射埋点类别；与预览计数无关的错误返回 null（不记）。 */
export function missKindFor(err) {
  if (err?.code === 'unsupported_file_type') return KIND_BINARY;
  if (err?.code === 'file_too_large') return KIND_TOO_LARGE;
  return null;
}

/**
 * 记一笔未命中（UPSERT 累加，(kind, ext, day) 主键）。
 * pool 注入；await 由调用方决定是否 fire-and-forget（http 层 catch 后不等待）。
 */
export async function recordPreviewMiss({ pool, userId, kind, relPath, log = console } = {}) {
  try {
    await pool.query(
      `INSERT INTO preview_miss_stats (kind, ext, day, hits, last_user_id, last_seen_at)
       VALUES ($1, $2, current_date, 1, $3, now())
       ON CONFLICT (kind, ext, day) DO UPDATE
         SET hits = preview_miss_stats.hits + 1,
             last_user_id = EXCLUDED.last_user_id,
             last_seen_at = now()`,
      [kind, normalizeExt(relPath), userId ?? null],
    );
  } catch (err) {
    log.warn?.(`[preview-miss] count write failed (ignored): ${String(err?.message ?? err)}`);
  }
}

/**
 * 读端聚合（admin 端点 GET /api/admin/preview-misses）：按 (kind, ext) 求和窗口内计数。
 * days 非法值退到 14；上限 365（聚合表按天长，窗口再大也是全表，不伺候）。
 */
export async function summarizePreviewMisses({ pool, days = 14 } = {}) {
  const d = Number.isInteger(days) && days >= 1 && days <= 365 ? days : 14;
  const res = await pool.query(
    `SELECT kind, ext, SUM(hits)::bigint AS hits, MAX(last_seen_at) AS last_seen_at
       FROM preview_miss_stats
      WHERE day >= current_date - ($1 || ' days')::interval
      GROUP BY kind, ext
      ORDER BY SUM(hits) DESC
      LIMIT 200`,
    [String(d)],
  );
  return {
    days: d,
    items: (res.rows ?? []).map((r) => ({
      kind: r.kind,
      ext: r.ext,
      hits: Number(r.hits),
      last_seen_at: r.last_seen_at,
    })),
  };
}
