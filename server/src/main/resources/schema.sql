-- apicc 元数据 H2 库初始化脚本（规格 m3 §2 D6）。
-- 约束：
--   1. 全部使用幂等 DDL（CREATE TABLE IF NOT EXISTS），配合 spring.sql.init.mode=always 每次启动执行；
--   2. SQL 保持可移植子集（避免 H2 专有语法，未来可换 Postgres）。
-- 任务 1 仅骨架：六张表（users / tokens / workspaces / memberships / project_acl / file_versions）
-- 在任务 2 按规格 D5/D6 逐一定义，此处不抢跑。
-- 注意：spring.sql.init 要求脚本至少含一条可执行语句（纯注释脚本启动即报
-- "'script' must not be null or empty"），故以零副作用占位语句顶住，任务 2 落真表后删除。
SELECT 1;
