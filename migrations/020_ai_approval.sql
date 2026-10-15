-- 020 办公批次 3：审批实例表 t_ai_approval（AI 原生轻量审批）—— R101-AI-38 步骤 1
-- 依据：R101-AI-38 派单卡；边界见凌舟裁定
--
-- 一、定位与边界
--   - 归属：业务库侧、本仓独占（与 002/005/006/008/015/016/017/018/019 同类）；裸写表名，不使用 USE 切库
--   - 作用：**AI 底座原生轻量审批**（AI 辅助填单 + 人审批，standalone 可用）
--   - 🔴 **不替代、不重复造 MS 审批**（MS 侧 `api_query_approval_*`）；本批不做与 MS 审批打通（跨线独立立项）
--   - 单级审批（一个审批人）；多级/会签本批不做
--
-- 二、状态机（迁移只负责结构，迁移约束由工具层原子 UPDATE 保证）
--   draft → pending → approved | rejected（终态）；pending → cancelled（撤回）
--   索引按查询路径设计：待办式"我的待审"走 (tenant_id, approver, status)；
--   "我提交的"走 (tenant_id, applicant)；列表按状态走 (tenant_id, status)
--
-- 三、幂等键
--   唯一键 `(tenant_id, applicant, type, related_biz)` —— 同申请人同类型同关联单据只应有一个实例。
--   ⚠️ `related_biz` 可空，而 MySQL/sqlite 对含 NULL 的唯一键**不判重**（多行 NULL 允许）
--   ⇒ 应用层另有业务幂等兜底（与批次 2 的 due_at 同族处理），工具层说明哪层承重。
--
-- 四、幂等与执行
--   - `CREATE TABLE IF NOT EXISTS`（可重复执行）
--   - **本文件只写 + scratch 执行一次 + 幂等复跑一次**，不得在业务库/生产库执行
--   - 注释内不得出现分号（部署器按分号拆分语句）
--   - 执行：mysql -u<user> -p <业务库> < migrations/020_ai_approval.sql
--
-- 负责人: 阿坚 | 创建日期: 2026-10-16

CREATE TABLE IF NOT EXISTS t_ai_approval (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  tenant_id       VARCHAR(36)  NOT NULL COMMENT '租户ID',
  title           VARCHAR(255) NOT NULL COMMENT '审批标题',
  type            VARCHAR(64)  NOT NULL COMMENT '类型 expense/leave/purchase/other',
  applicant       VARCHAR(128) NOT NULL COMMENT '申请人（user:{id}/employee:{id}，ACL owner）',
  approver        VARCHAR(128) NOT NULL COMMENT '审批人（user:/role:/employee:，单级）',
  status          ENUM('draft','pending','approved','rejected','cancelled') NOT NULL DEFAULT 'draft' COMMENT '状态',
  payload         MEDIUMTEXT   NULL COMMENT '申请内容（JSON 文本）',
  decision_reason VARCHAR(500) NULL COMMENT '审批意见',
  related_biz     VARCHAR(128) NULL COMMENT '关联业务单据（幂等键组成）',
  created_by      VARCHAR(64)  NULL COMMENT '创建者',
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（毫秒）',
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '更新时间（毫秒）',
  PRIMARY KEY (id),
  UNIQUE KEY uk_ai_approval_dedupe (tenant_id, applicant, type, related_biz),
  KEY idx_ai_approval_status (tenant_id, status),
  KEY idx_ai_approval_applicant (tenant_id, applicant),
  KEY idx_ai_approval_approver (tenant_id, approver, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='办公-AI 原生轻量审批实例';

-- 五、回滚 SQL（文档·勿执行；按 migrations/README.md 二.5，回滚走反向迁移）
--     DROP TABLE IF EXISTS t_ai_approval
--   注意：DROP 会丢失审批数据，执行前须确认审批工具已下线并已导出备份
