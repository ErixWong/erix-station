-- 0042-mcp-plaintext-values.sql —— 配置槽的值改**明文**存（issue #608 决策变更，2026-11-17）
--
-- 为什么改（决策与理由，不是实现细节）：
--   0040 把槽值做成 AES-256-GCM 密文，key 放 `deploy/.env`（`MCP_SECRET_KEY`）。评估后判定这笔加密
--   **在本机这个形态下收益不抵成本**：portal 与 DB 同机、`.env` 与 DB 同盘 ⇒ 主机沦陷时两样一起丢；
--   它只挡得住「DB 单点泄漏」（dump / 备份 / 只读账号）那三条，而代价是「多一个必须保管的部署变量 +
--   换 key 要全员重填」。内部平台、单个 IT 角色、token 个位数 ⇒ 先按明文来，等真出现「DB 要给第三方
--   只读」或「备份要出内网」再上（那时是加一列 + 懒迁移，不动对外接口）。
--
-- 数据处置：`value_encrypted` 里的旧内容是密文，明文世界里无法解释 ⇒ **整列丢弃，不迁移**。
--   P1 从未在生产存过真实凭据；dev 库里只有一条 e2e 用的密文，丢掉即可（管理员重填一次）。
--
-- 仍然成立的边界（与本迁移无关，别一起删）：
--   ① 接口层**只写不读**：GET 只回 `has_value` 元数据，任何响应/DOM/日志里都不出现值；
--   ② 值**不进任何文件**：`~/.erix/mcp.json` 只有槽位声明；
--   ③ 明文只在 run 内存里活一次（agentd 代取 → 注入子进程 env）。

ALTER TABLE capability_param_values ADD COLUMN IF NOT EXISTS value_plain text;

-- 密文列整列撤掉（旧值不可用，见上面「数据处置」）。
ALTER TABLE capability_param_values DROP COLUMN IF EXISTS value_encrypted;

-- 明文世界里「没有值」只能用**没有行**表达（空串与未设置在语义上分不开，代码也拒空串）。
DELETE FROM capability_param_values WHERE value_plain IS NULL;

ALTER TABLE capability_param_values ALTER COLUMN value_plain SET NOT NULL;

-- 重放证据（只读：不写任何数据）。首参必须是字面量，`RAISE NOTICE 'a' || 'b'` 会语法错（#608 踩过）。
DO $$
DECLARE
  has_plain boolean;
  has_enc boolean;
  n bigint;
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'capability_param_values' AND column_name = 'value_plain')
    INTO has_plain;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'capability_param_values' AND column_name = 'value_encrypted')
    INTO has_enc;
  SELECT count(*) INTO n FROM capability_param_values;
  RAISE NOTICE '0042: value_plain=% value_encrypted=% rows=%', has_plain, has_enc, n;
END $$;
