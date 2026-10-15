-- 022 办公批次 5：站内通知表 t_ai_notice —— R101-AI-40 步骤 1
-- 依据：R101-AI-40 派单卡 + S0 侦察结论（不复用跨线审计表 t_push_log）
--
-- 一、定位
--   - 通知中心：**持久化 + 已读/未读 + 归档**，补"错过推送即丢"（WebSocket broadcast 尽力而为）
--   - 归属：业务库侧、本仓独占；裸写表名，不使用 USE 切库
--
-- 二、为什么新建而非复用 t_push_log（S0 结论）
--   - t_push_log **不在本仓**（migration 012 仅 ALTER 加 tenant_id）⇒ 由既有系统拥有 = **跨线表**
--   - 它是 append-only **投递审计日志**（含 status/error_msg）⇒ 加"已读/归档"会破坏审计语义
--
-- 三、去重（对照规范 §2.2）
--   唯一键 `(tenant_id, dedupe_key)`；但 `dedupe_key` **可空**，而含 NULL 的唯一键不判重
--   ⇒ **业务幂等（同租户同键未读已存在 ⇒ 不再插）承重**；DB 唯一键仅在**并发**时兜底
--
-- 四、执行
--   - `CREATE TABLE IF NOT EXISTS`（可重复执行）；注释内不得出现分号（部署器按分号拆分）
--   - **本文件只写 + scratch 执行一次 + 幂等复跑一次**，不得在业务库/生产库执行
--
-- 负责人: 阿坚 | 创建日期: 2026-10-16

CREATE TABLE IF NOT EXISTS t_ai_notice (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  tenant_id   VARCHAR(36)   NOT NULL COMMENT '租户ID',
  receiver    VARCHAR(1000) NOT NULL COMMENT '接收人（首尾逗号归一化 principal 串）',
  title       VARCHAR(255)  NOT NULL COMMENT '通知标题',
  content     MEDIUMTEXT    NULL COMMENT '通知正文',
  type        VARCHAR(32)   NOT NULL COMMENT '类型（推送口径 system/order/inventory/marketing）',
  priority    VARCHAR(16)   NOT NULL COMMENT '优先级（urgent/important/reminder/suggestion）',
  read_at     DATETIME(3)   NULL COMMENT '已读时间（NULL=未读）',
  archived_at DATETIME(3)   NULL COMMENT '归档时间（NULL=未归档）',
  source      ENUM('biz','schedule','system') NOT NULL DEFAULT 'system' COMMENT '来源',
  ref_id      VARCHAR(128)  NULL COMMENT '关联对象 ID',
  dedupe_key  VARCHAR(191)  NULL COMMENT '去重键（可空 ⇒ 业务幂等承重）',
  created_at  DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（毫秒）',
  updated_at  DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '更新时间（毫秒）',
  PRIMARY KEY (id),
  UNIQUE KEY luk_ai_notice_dedupe (tenant_id, dedupe_key),
  KEY idx_ai_notice_receiver (tenant_id, receiver),
  KEY idx_ai_notice_unread (tenant_id, read_at),
  KEY idx_ai_notice_created (tenant_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='办公-站内通知';

-- 四之二、扩展 ACL 资源类型（通知中心引入 resource_type='notice'）
--   - MySQL 的 t_ai_acl.resource_type 是 ENUM，必须显式扩展才能落 'notice'
--   - `MODIFY COLUMN` 天然幂等（重复执行结果一致）
ALTER TABLE t_ai_acl
  MODIFY COLUMN resource_type ENUM('doc','todo','approval','schedule','notice') NOT NULL DEFAULT 'doc' COMMENT '资源类型 doc/todo/approval/schedule/notice';

-- 五、回滚 SQL（文档·勿执行；按 migrations/README.md 二.5，回滚走反向迁移）
--     DROP TABLE IF EXISTS t_ai_notice
--   注意：DROP 会丢失通知与已读状态，执行前须确认通知工具已下线
