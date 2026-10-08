-- 0017-port-allocations-hostname-check.sql —— port_allocations.hostname 的 DB 侧兜底 CHECK（#202）
-- 背景：单标签 >63 字符的 hostname（根因：FDE 名 57..63 字符 + "-p-" + 4 位端口 = 首标签 64..70）
--   过去只在路由生成阶段被拒（routes.js isValidHostname，fail-closed 抛内部错 → 用户只见「预览打不开」）。
--   主修复在应用层：开户时即 400（admin.js createUser → projects.validateFdeNameForHostname，
--   FDE 名预览域名预算 56 = 63 − 固定段 "-p-<port4>" 7 字符）。本迁移是 **DB 侧兜底**：
--   任何绕过应用校验的写入（SQL 直改/脚本回填）也进不了非法 hostname。
-- 口径：与 routes.js DNS_LABEL_RE / projects.validateHostnameGrammar 同构的**整域名**正则——
--   逐标签 ≤63（1+61+1，小写字母数字、不以 - 开头/结尾）+ 总长 ≤253（RFC 1035）。
-- NOT VALID（而非「核存量后 VALIDATE」）：本 PR 按纪律不跑 docker/e2e，无法实机确认目标库存量行
--   全部合规（#202 的病灶正是可能已存在的 57..63 名字派生行；0008 只重写形态、不裁长度）。
--   NOT VALID 的 CHECK 对**新 INSERT/UPDATE 即刻生效**，且省掉一次全表校验扫描（不长时间持锁）。
--   存量收敛动作（在目标库人工执行，非本迁移职责）：
--     SELECT id, hostname FROM port_allocations
--      WHERE char_length(hostname) > 253
--         OR hostname !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$';
--     -- 结果集清空后：
--     ALTER TABLE port_allocations VALIDATE CONSTRAINT port_allocations_hostname_dns_check;
-- 幂等：DROP CONSTRAINT IF EXISTS → ADD，可整体重放（README「单文件约定」；已应用后不再回改）。
-- 冻结 baseline：docs/data/schema.sql 不回写（sha256 失配 runner 拒启，README baseline 说明）。
SET lock_timeout = '5s';

ALTER TABLE port_allocations DROP CONSTRAINT IF EXISTS port_allocations_hostname_dns_check;
ALTER TABLE port_allocations ADD CONSTRAINT port_allocations_hostname_dns_check
  CHECK (
    char_length(hostname) <= 253
    AND hostname ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$'
  ) NOT VALID;
