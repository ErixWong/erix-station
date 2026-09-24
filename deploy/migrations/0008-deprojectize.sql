-- 0008-deprojectize.sql —— P5 去项目化（目录即项目，docs/design/directory-as-project.md 定稿）
-- 背景：项目注册制退役——「容器 = 小电脑；目录 = 项目」。会话直接绑定 cwd
--   （~/projects/<name> 相对形式），项目列表 = ~/projects/ 一级目录枚举（推导视图，无注册实体）。
-- 本迁移（量小一次到位；projects 表保留不删，退役留档、应用层只读）：
--   ① chat_sessions 加 cwd 列（回填 = 关联 project 的 root_path）；project_id 解除 NOT NULL
--     （新会话不再写 project_id，旧行留档；外键保留，归档语义不变）。
--   ② port_allocations 退役 project_id（DROP COLUMN，随之自动删除 project 部分索引）；
--     存量 hostname/url 重写为 <fde>-p-<port>.fde.<base>（URL 去项目名段，设计 §3）——
--     用 regexp 保留原域名后缀（.fde.<base> 随部署 env 不同），不硬编码 base。
-- 幂等：ADD COLUMN IF NOT EXISTS / ALTER COLUMN DROP NOT NULL 天然幂等；回填只动 cwd IS NULL 行；
--   hostname 重写 WHERE 子句只匹配旧形态（重写后不再命中），重复执行零变化。
-- 约定：单事务（migrate runner）。

-- ① 会话 cwd 绑定体
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS cwd text;
ALTER TABLE chat_sessions ALTER COLUMN project_id DROP NOT NULL;

-- 回填：既有会话 cwd = 其 project 的 root_path（UPDATE from projects join）
UPDATE chat_sessions s
   SET cwd = p.root_path
  FROM projects p
 WHERE s.project_id = p.id
   AND s.cwd IS NULL;

-- ② 端口分配去项目化
-- hostname 旧形态：<fde>-p-<project>-<port4>.fde.<base>；新形态：<fde>-p-<port4>.fde.<base>。
-- port 段恒为紧邻 .fde. 的 4 位数字 → 消去中间的 -<project> 段无歧义（项目名可含 -，但
-- 只有紧邻 .fde. 的 -dddd 一段会被识别为端口）；重写后形态不再命中本 WHERE，幂等。
UPDATE port_allocations a
   SET hostname = regexp_replace(a.hostname,
                   '^([a-z0-9-]+)-p-(.+)-([0-9]{4})(\.fde\..+)$', '\1-p-\3\4'),
       url      = regexp_replace(a.url,
                   '^(https://[a-z0-9-]+)-p-(.+)-([0-9]{4})(\.fde\..+)$', '\1-p-\3\4')
  WHERE a.hostname ~ '^[a-z0-9-]+-p-[a-z0-9-]+-[0-9]{4}\.fde\.'
    AND a.url ~ '^https://[a-z0-9-]+-p-[a-z0-9-]+-[0-9]{4}\.fde\.';

ALTER TABLE port_allocations DROP COLUMN IF EXISTS project_id;
