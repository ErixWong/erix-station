-- 0023-preview-miss-stats.sql —— 预览未命中计数（issue #366 P0：Office 预览的需求数据）
-- 背景：/api/file 的 JSON 预览只认 文本/Markdown/图片，其余二进制一律 415、超 2MB 一律 413
--   （portal/test/file-preview.test.js 钉着）。是否值得为 Office/PDF/压缩包引入 kkFileView（#356/#366 P2），
--   决策依据只能是真实点击数据——所以先把埋点装上：每次 JSON 预览通道抛 415/413，就按
--   (kind, ext, day) 聚合计数（不存路径：既够回答「哪些扩展名在被点」，又不把用户文件路径抄进平台库）。
-- 形状：按天聚合表而非流水表——(kind, ext, day) 主键 + UPSERT 累加，行数被「扩展名种类 × 2 × 天数」封顶；
--   读侧按天数窗口求和（admin 端点 GET /api/admin/preview-misses）。「按天」而不是「总计数」才能回答
--   「最近两周有多少」与「需求是否在增长」，计数不随重启丢。
-- 授权：station_portal 的 DML 由 baseline 的 ALTER DEFAULT PRIVILEGES 自动覆盖（migrations/README
--   「单文件约定」），本文件不写 GRANT。baseline（docs/data/schema.sql）冻结，零字节不动。
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS preview_miss_stats (
  kind          text NOT NULL CHECK (kind IN ('binary', 'too_large')),  -- binary = 415 unsupported_file_type；too_large = 413 file_too_large
  ext           text NOT NULL,                                          -- 归一化小写扩展名（无点；无扩展名/不可识别为 ''），只回答「哪类文件在被点」
  day           date NOT NULL,                                          -- 按天聚合（current_date 写入侧归一，读侧按窗口求和）
  hits          bigint NOT NULL DEFAULT 0,
  last_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,           -- 当日最后一次点击者（排障/回访线索；用户注销不挡计数）
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, ext, day)
);
