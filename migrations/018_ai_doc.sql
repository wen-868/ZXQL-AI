-- 018 文档中心：t_ai_doc / t_ai_doc_acl（办公能力第一批 · R101-AI-35 S1）
-- 依据：R101-AI-35 派单卡；规划见《AI底座办公能力规划清单 v1.0》
--
-- 一、定位与归属
--   - 归属：业务库侧、本仓独占（与 002 / 005 / 006 / 008 / 015 / 016 / 017 同类）。
--     裸写表名即落业务库，不使用 USE 切库（migrations/README.md 二.6）。
--   - 作用：办公第五业务域的**文档管理面**（目录/元数据/归属/状态 + ACL 授权）。
--     分块与向量仍由既有 RAG 链路负责，本迁移不重复造。
--
-- 二、⭐ 本迁移同时补一个"仓里无脚本"的暗坑
--   - RAG 落盘表 `t_ai_knowledge_chunks` 在**代码里已使用**（src/rag/vector-store.service.ts:80
--     直查 DataSource），但 **migrations/ 从来没有它的建表脚本**（库里有、仓里无）
--     ⇒ 新环境/桌面端 standalone 基线里 RAG 落盘**无表可写**。
--   - 处置：本文件用 `CREATE TABLE IF NOT EXISTS` 把它补进迁移真相源。
--     ⚠️ 安全性质：生产已存在该表 ⇒ **不会改动任何既有列**（IF NOT EXISTS 直接跳过）；
--     仅对全新库建表。列类型按代码读写口径：embedding 为 `JSON.stringify(...)`（L285 写）
--     / `JSON.parse(...)`（L327 读）⇒ **JSON 文本 ⇒ LONGTEXT**。
--   - 另加 `doc_id`（可空）建立"文档 ↔ 分块"强关联（S3 贯通与按文档清理依据）；
--     存量行不受影响（可空），回填按需在 S3 做。
--
-- 三、ACL 语义（S2 工具层落实）
--   - 无 ACL 行 ⇒ 仅 owner 与平台管理员可读（**默认拒绝**）
--   - 租户隔离优先于 ACL（先 tenant_id 过滤，再判 perm）
--   - 唯一键 (doc_id, principal_type, principal_id) ⇒ upsert 可复跑
--
-- 四、幂等与执行
--   - 建表用 CREATE TABLE IF NOT EXISTS；加列走 information_schema + PREPARE 条件执行（可重复跑）。
--   - **本文件只写 + scratch 执行一次 + 幂等复跑一次**，不得在业务库/生产库执行。
--   - 注释内不得出现分号（部署器按分号拆分语句），本文件已遵守。
--   - 执行方式：mysql -u<user> -p <业务库> < migrations/018_ai_doc.sql
--
-- 负责人: 阿坚 | 创建日期: 2026-10-15

-- ────────────────────────────── 1. 文档主表 ──────────────────────────────
CREATE TABLE IF NOT EXISTS t_ai_doc (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  tenant_id    VARCHAR(36)  NOT NULL COMMENT '租户ID',
  title        VARCHAR(255) NOT NULL COMMENT '文档标题',
  category     VARCHAR(64)  NOT NULL DEFAULT 'default' COMMENT '目录（分类）如 contract/policy/manual',
  owner        VARCHAR(64)  NULL COMMENT '文档所有者（用户标识）',
  source_type  ENUM('upload','generated') NOT NULL DEFAULT 'upload' COMMENT '来源 upload=上传 generated=AI生成',
  content_hash VARCHAR(64)  NOT NULL COMMENT '内容哈希（sha256，幂等依据）',
  storage_path VARCHAR(512) NULL COMMENT '原始文件路径（upload 时）',
  status       ENUM('active','archived') NOT NULL DEFAULT 'active' COMMENT '状态 active=可检索 archived=已归档',
  version      INT          NOT NULL DEFAULT 1 COMMENT '版本号（内容更新递增）',
  created_by   VARCHAR(64)  NULL COMMENT '创建者',
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（毫秒）',
  updated_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '更新时间（毫秒）',
  PRIMARY KEY (id),
  UNIQUE KEY uk_ai_doc_tenant_hash (tenant_id, content_hash),
  KEY idx_ai_doc_tenant_category (tenant_id, category),
  KEY idx_ai_doc_tenant_status (tenant_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='文档中心-文档主表';

-- ────────────────────────────── 2. 文档 ACL ──────────────────────────────
CREATE TABLE IF NOT EXISTS t_ai_doc_acl (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  tenant_id      VARCHAR(36) NOT NULL COMMENT '租户ID（先租户后 ACL 过滤）',
  doc_id         BIGINT UNSIGNED NOT NULL COMMENT '文档ID（t_ai_doc.id）',
  principal_type ENUM('user','role','employee') NOT NULL COMMENT '主体类型',
  principal_id   VARCHAR(64) NOT NULL COMMENT '主体ID',
  perm           ENUM('read','write','admin') NOT NULL DEFAULT 'read' COMMENT '权限',
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '授权时间（毫秒）',
  PRIMARY KEY (id),
  UNIQUE KEY uk_ai_doc_acl_principal (doc_id, principal_type, principal_id),
  KEY idx_ai_doc_acl_doc (doc_id),
  KEY idx_ai_doc_acl_principal (tenant_id, principal_type, principal_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='文档中心-文档 ACL';

-- ──────────────── 3. 补建 RAG 分块表（暗坑：仓里无脚本） ────────────────
-- 列严格对齐 vector-store.service.ts 的读写 SQL（tenant_id/doc_name/chunk_index/chunk_text/embedding/created_at）
CREATE TABLE IF NOT EXISTS t_ai_knowledge_chunks (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  tenant_id   VARCHAR(36)  NOT NULL COMMENT '租户ID',
  doc_name    VARCHAR(255) NOT NULL COMMENT '文档名（RAG 既有聚合维度）',
  chunk_index INT          NOT NULL COMMENT '分块序号（同文档内从 0 递增）',
  chunk_text  LONGTEXT     NOT NULL COMMENT '分块正文',
  embedding   LONGTEXT     NULL COMMENT '向量（JSON 文本：JSON.stringify(number[])）',
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '写入时间（毫秒）',
  PRIMARY KEY (id),
  KEY idx_kc_tenant_doc_name (tenant_id, doc_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='RAG 知识库分块（补齐迁移真相源）';

-- ──────────────── 4. 分块表加 doc_id（条件加列，幂等） ────────────────
-- MySQL 8.0 不支持 ADD COLUMN IF NOT EXISTS ⇒ 走 information_schema 判定 + PREPARE
SET @kc_doc_id_exists := (
  SELECT COUNT(1) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 't_ai_knowledge_chunks'
     AND COLUMN_NAME = 'doc_id'
);

SET @kc_ddl := IF(
  @kc_doc_id_exists = 0,
  'ALTER TABLE t_ai_knowledge_chunks ADD COLUMN doc_id BIGINT UNSIGNED NULL COMMENT ''文档ID（t_ai_doc.id，S3 贯通依据）'', ADD KEY idx_kc_tenant_doc (tenant_id, doc_id)',
  'SELECT 1'
);

PREPARE kc_stmt FROM @kc_ddl;
EXECUTE kc_stmt;
DEALLOCATE PREPARE kc_stmt;

-- ──────────── 5. 分块表条件加索引（补 S2 前置 scratch 发现的缺口） ────────────
-- 实测发现：`CREATE TABLE IF NOT EXISTS` 命中**已存在**的表时，整条建表语句（含其中 KEY 定义）
-- 被跳过 ⇒ 既有生产库拿不到 idx_kc_tenant_doc_name（RAG 按 tenant_id + doc_name 查/删，缺索引会全表扫）。
-- 故索引必须**独立条件创建**（与 doc_id 加列同法，幂等）。
SET @kc_idx_exists := (
  SELECT COUNT(1) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 't_ai_knowledge_chunks'
     AND INDEX_NAME = 'idx_kc_tenant_doc_name'
);

SET @kc_idx_ddl := IF(
  @kc_idx_exists = 0,
  'CREATE INDEX idx_kc_tenant_doc_name ON t_ai_knowledge_chunks (tenant_id, doc_name)',
  'SELECT 1'
);

PREPARE kc_idx_stmt FROM @kc_idx_ddl;
EXECUTE kc_idx_stmt;
DEALLOCATE PREPARE kc_idx_stmt;

-- 五、回滚 SQL（文档·勿执行；按 migrations/README.md 二.5，回滚走反向迁移）
--   回滚 = 反向迁移，单独执行下列语句（刻意不在注释内写句末分号，避免破坏分号拆分）：
--     ALTER TABLE t_ai_knowledge_chunks DROP COLUMN doc_id
--     DROP TABLE IF EXISTS t_ai_doc_acl
--     DROP TABLE IF EXISTS t_ai_doc
--   注意：DROP 会丢失文档与授权数据，执行前须确认文档中心工具已下线、且已导出备份
