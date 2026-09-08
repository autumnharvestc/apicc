-- apicc 元数据 H2 库初始化脚本（规格 m3 §2 D5/D6）。
-- 约束：
--   1. 全部使用幂等 DDL（CREATE TABLE IF NOT EXISTS），配合 spring.sql.init.mode=always 每次启动执行；
--   2. SQL 保持可移植子集（避免 H2 专有语法，未来可换 Postgres）；
--   3. 主键取型（裁定 A）：对外暴露 id 一律 VARCHAR(36)（UUID.randomUUID() 文本形态），
--      关联表用自然复合主键；后续任务全部经由仓储接口存取，不感知列型；
--   4. 时间戳列（裁定 B）：一律 TIMESTAMP WITH TIME ZONE 存绝对时刻，写入统一经 OffsetDateTime(UTC)，
--      读取以 OffsetDateTime → Instant 还原；API 序列化形状（ISO-8601 UTC）由任务 3-5 契约测试钉住；
--   5. 角色列：VARCHAR + CHECK IN（可移植写法），枚举外脏值在库层拦下；
--   6. 未发布阶段（规格 §8）表结构变更不做迁移：旧库启动若因结构不符报错（未知列等），
--      删库重开（删 server-data）即可，生产化前的破坏性变更均走此口径。

-- 账号（规格 §3.1：bcrypt 哈希入库，服务端不存明文密码；§2：role/disabled 支撑账号管家）
CREATE TABLE IF NOT EXISTS users (
    id            VARCHAR(36)  NOT NULL,
    username      VARCHAR(32)  NOT NULL,
    password_hash VARCHAR(100) NOT NULL,
    display_name  VARCHAR(64)  NOT NULL,
    role          VARCHAR(16)  NOT NULL DEFAULT 'USER',
    disabled      BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMP WITH TIME ZONE NOT NULL,
    CONSTRAINT pk_users PRIMARY KEY (id),
    CONSTRAINT uk_users_username UNIQUE (username),
    CONSTRAINT ck_users_role CHECK (role IN ('USER','SUPERADMIN'))
);

-- 认证令牌（规格 §2 D4：不透明 Bearer token，仅存 SHA-256 哈希；token_hash 即自然主键）
CREATE TABLE IF NOT EXISTS tokens (
    token_hash VARCHAR(64)  NOT NULL,
    user_id    VARCHAR(36)  NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    revoked    BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    CONSTRAINT pk_tokens PRIMARY KEY (token_hash)
);

-- 团队工作区（规格 §3.2；内容随 file_versions.content 入库，规格 §5——磁盘内容树已退役）
-- 规格 2026-09-08 §1：首启自动建唯一「默认工作区」；name 全局唯一（并发安全靠唯一约束）
CREATE TABLE IF NOT EXISTS workspaces (
    id         VARCHAR(36) NOT NULL,
    name       VARCHAR(64) NOT NULL,
    created_by VARCHAR(36) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    CONSTRAINT pk_workspaces PRIMARY KEY (id),
    CONSTRAINT uk_workspaces_name UNIQUE (name)
);

-- 工作区成员角色（规格 §2 D5 第一层：OWNER > ADMIN > EDITOR > VIEWER）
CREATE TABLE IF NOT EXISTS memberships (
    workspace_id VARCHAR(36) NOT NULL,
    user_id      VARCHAR(36) NOT NULL,
    role         VARCHAR(16) NOT NULL CHECK (role IN ('OWNER','ADMIN','EDITOR','VIEWER')),
    created_at   TIMESTAMP WITH TIME ZONE NOT NULL,
    CONSTRAINT pk_memberships PRIMARY KEY (workspace_id, user_id)
);

-- 项目级 ACL 覆盖（规格 §2 D5 第二层：NONE/VIEWER/EDITOR/ADMIN；无行 = 继承工作区角色）
CREATE TABLE IF NOT EXISTS project_acl (
    workspace_id VARCHAR(36) NOT NULL,
    project_id   VARCHAR(64) NOT NULL,
    user_id      VARCHAR(36) NOT NULL,
    role         VARCHAR(16) NOT NULL CHECK (role IN ('NONE','VIEWER','EDITOR','ADMIN')),
    updated_at   TIMESTAMP WITH TIME ZONE NOT NULL,
    CONSTRAINT pk_project_acl PRIMARY KEY (workspace_id, project_id, user_id)
);

-- 文件版本行 = 元数据 + 内容正文（规格 §2 D6 + §5：每 (workspace, path) 一份；version 从 1 起，
-- 乐观并发以 UPDATE ... WHERE version = ? 单条 SQL 原子递增；version 仅供并发比对，不追溯历史）
CREATE TABLE IF NOT EXISTS file_versions (
    workspace_id VARCHAR(36)  NOT NULL,
    path         VARCHAR(512) NOT NULL,
    content_hash VARCHAR(64)  NOT NULL,
    version      BIGINT       NOT NULL,
    updated_by   VARCHAR(36)  NOT NULL,
    updated_at   TIMESTAMP WITH TIME ZONE NOT NULL,
    content      CLOB,
    CONSTRAINT pk_file_versions PRIMARY KEY (workspace_id, path),
    CONSTRAINT ck_file_versions_version CHECK (version >= 1)
);

-- 分组（规格 2026-09-08 §4）：同工作区内名称唯一；默认分组 name='默认分组' 不可删改
CREATE TABLE IF NOT EXISTS groups (
    id           VARCHAR(36) NOT NULL,
    workspace_id VARCHAR(36) NOT NULL,
    name         VARCHAR(64) NOT NULL,
    is_default   BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMP WITH TIME ZONE NOT NULL,
    CONSTRAINT pk_groups PRIMARY KEY (id),
    CONSTRAINT uk_groups_ws_name UNIQUE (workspace_id, name)
);

-- 项目（规格 §4）：允许同名（身份=id）；挂分组；内容树按项目挂载
CREATE TABLE IF NOT EXISTS projects (
    id           VARCHAR(36) NOT NULL,
    workspace_id VARCHAR(36) NOT NULL,
    group_id     VARCHAR(36) NOT NULL,
    name         VARCHAR(64) NOT NULL,
    created_at   TIMESTAMP WITH TIME ZONE NOT NULL,
    CONSTRAINT pk_projects PRIMARY KEY (id),
    CONSTRAINT fk_projects_group FOREIGN KEY (group_id) REFERENCES groups(id)
);

-- groups 增默认分组标记（seeder/create 落 TRUE；改名/删除守卫判据）
-- ALTER 仅服务既有库兼容（新库 CREATE TABLE 已含 is_default；未发布阶段口径=删库重开，此处双保险）
ALTER TABLE groups ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;

-- file_versions 扩内容列（规格 §5 内容入库）：一行 = 元数据 + 字节（CLOB/PG text）
-- ALTER 形态（幂等：H2 支持 ADD COLUMN IF NOT EXISTS；新库走 CREATE TABLE 已含）：
ALTER TABLE file_versions ADD COLUMN IF NOT EXISTS content CLOB;
