-- 023 办公：审批草稿软弃（t_ai_approval.deleted_at）—— R101-AI-41 S2
-- 依据：R101-AI-41（补齐"审批草稿无删除入口"）；凌舟倾向**软删**
--
-- 一、为什么用 `deleted_at` 列而不是扩展 status 枚举（我采纳并可说明的更优解）
--   - `draft/pending/approved/rejected/cancelled` 是**工作流状态**；"被丢弃"是**生命周期标记**，
--     语义层级不同 ⇒ 混进 status 会让"状态机"承担两件事
--   - 扩展 MySQL ENUM 需 **四处同步**（TS 联合 + 实体 enum + MySQL ENUM + sqlite）——
--     AI-40 刚踩过（`notice` 资源类型）；条件加列只需 **两处**（实体 + applier）
--   - 与既有家族一致：通知用 `archived_at`、日程用 `reminded_at` ⇒ 同样是"时间戳标记"范式
--   - 审计链完整：软删保留记录 ⇒ 可回溯"谁写过又丢了什么草稿"
--   - ❌ 不做物理 DELETE（数据不可追）
--
-- 二、幂等与执行
--   - 条件加列：`information_schema` 判定 + `PREPARE`（同 tags / rag_status / doc_id 范式）
--   - 幂等复跑安全；sqlite 侧同名条件加列由 applier 的 `ensureColumn` 承担
--   - 注释内不得出现分号（部署器按分号拆分语句）
--
-- 负责人: 阿坚 | 创建日期: 2026-10-16

SET @approval_deleted_at_exists := (
  SELECT COUNT(1) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 't_ai_approval'
     AND COLUMN_NAME = 'deleted_at'
);

SET @approval_deleted_at_ddl := IF(
  @approval_deleted_at_exists = 0,
  'ALTER TABLE t_ai_approval ADD COLUMN deleted_at DATETIME(3) NULL COMMENT ''软删时间（仅草稿可弃；NULL=未弃）''',
  'SELECT 1'
);

PREPARE approval_del_stmt FROM @approval_deleted_at_ddl;
EXECUTE approval_del_stmt;
DEALLOCATE PREPARE approval_del_stmt;

-- 三、回滚 SQL（文档·勿执行；按 migrations/README.md 二.5，回滚走反向迁移）
--     ALTER TABLE t_ai_approval DROP COLUMN deleted_at
