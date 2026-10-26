-- 025 逐接收人投递状态表 t_ai_reminder_recipient_delivery —— AI-P2-3F3
-- 依据：中央卡 AI-P2-3F3 §四.5「新增逐接收人投递状态，禁止只按 schedule 记录一条 push
--   就代表所有接收人已完成」；§五硬验收 5「部分投递失败只重试失败用户」
--
-- 一、为什么必须新增（024 的表达力不足）
--   024 的 t_ai_reminder_delivery 身份是 (tenant, schedule_id, occurrence_at, kind)，
--   一条日程只有**一个** push 维度状态 ⇒ 无法表达"owner 已收到、参与者 B 未收到"。
--   一条 push=success 若代表全部接收人，就等于把"部分失败"伪装成全成功（卡面红线）。
--
-- 二、身份口径（逐接收人）
--   唯一身份 = (tenant_id, schedule_id, occurrence_at, recipient_user_id)
--     - schedule_id + occurrence_at 沿用 024 口径（日程 + 该次提醒）；
--     - recipient_user_id = 解析后的真实用户 ID（JWT payload.id 语义，落 t_push_log.user_id）；
--     - state 区分该接收人的投递结局（见下）。
--   **principal 原文**（如 user:7 / role:fin / employee:e9）单独留列，
--   用于回答"这个 principal 为什么没送达"（可解析 / 不可解析 / 无映射）。
--
-- 三、state 语义（不允许静默 success）
--     - 'delivered'        = 该接收人的定向摘要已成功投递
--     - 'failed'           = 渠道失败，下轮只重试该接收人
--     - 'unresolved_role'  = role:{id} 成员无法在 AI 侧解析（缺服务级鉴权 ⇒ 未投递，非成功）
--     - 'unresolved_employee' = employee:{id} 无到用户的可靠映射（未投递，非成功）
--     - 'unresolved_principal' = principal 形态无法识别（未投递，非成功）
--     - 'deduped'          = 同一用户既是 owner 又是参与者，已并入同一份投递（不多发）
--   ⇒ 只有 'delivered' / 'deduped' 是"该接收人已覆盖"；其余都不算成功。
--
-- 四、为什么不能用 024 加列
--   卡面红线「不得修改 024 历史迁移」⇒ 新建表；两表并存，024 继续承载
--   **日程维度的通知/push 闭合判定**，025 承载**接收人维度的投递真相**。
--
-- 五、执行
--   - `CREATE TABLE IF NOT EXISTS`（可重复执行）；注释内不得出现分号（部署器按分号拆分）
--   - 只写文件 + scratch 执行两遍，不得在业务库/生产库执行
--
-- 负责人: 阿洲 | 创建日期: 2026-10-26

CREATE TABLE IF NOT EXISTS t_ai_reminder_recipient_delivery (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  tenant_id          VARCHAR(36)   NOT NULL COMMENT '租户ID',
  schedule_id        VARCHAR(64)   NOT NULL COMMENT '日程ID（t_ai_schedule.id）',
  occurrence_at      DATETIME(3)   NOT NULL COMMENT '本次提醒的 occurrence（remind_at）',
  recipient_user_id  BIGINT UNSIGNED NOT NULL COMMENT '接收人用户ID（解析后真实用户，JWT payload.id 语义）',
  principal          VARCHAR(128)  NOT NULL COMMENT 'principal 原文（user:7 / role:fin / employee:e9），用于解释未投递原因',
  state              VARCHAR(24)   NOT NULL COMMENT 'delivered / failed / unresolved_role / unresolved_employee / unresolved_principal / deduped',
  dedupe_key         VARCHAR(191)  NULL COMMENT '幂等键（tenant:schedule:occurrence:recipient）',
  error_msg          VARCHAR(500)  NULL COMMENT '失败或未投递原因',
  attempts           INT UNSIGNED  NOT NULL DEFAULT 1 COMMENT '尝试次数（仅失败重试累加）',
  created_at         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（毫秒）',
  updated_at         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '更新时间（毫秒）',
  PRIMARY KEY (id),
  UNIQUE KEY luk_ai_reminder_recipient (tenant_id, schedule_id, occurrence_at, recipient_user_id),
  KEY idx_ai_reminder_recipient_state (tenant_id, state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='AI 提醒逐接收人投递状态（部分失败只重试失败用户）';

-- ─────────────────────────────────────────────────────────────
-- 不可解析 principal 登记表：t_ai_reminder_unresolved_principal
--
-- 为什么需要单独一张表：
--   上表的唯一键含 recipient_user_id，而**无法解析到用户的 principal 没有 user_id**
--   （role:/employee: 未映射）⇒ 塞不进上表（会被迫编造 user_id = 数据造假）。
--   ⇒ 未投递的 principal 单独按 (tenant, principal) 登记，明确"知道有这个人/角色，
--     但 AI 侧无可靠映射 ⇒ 未投递"，供运维与后续补单核对。
--
-- 幂等：唯一键 (tenant_id, schedule_id, occurrence_at, principal)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS t_ai_reminder_unresolved_principal (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  tenant_id     VARCHAR(36)   NOT NULL COMMENT '租户ID',
  schedule_id   VARCHAR(64)   NOT NULL COMMENT '日程ID',
  occurrence_at DATETIME(3)   NOT NULL COMMENT '本次提醒的 occurrence',
  principal     VARCHAR(128)  NOT NULL COMMENT '无法解析的 principal（role:/employee:/未知形态）',
  reason        VARCHAR(24)   NOT NULL COMMENT 'unresolved_role / unresolved_employee / unresolved_principal',
  detail        VARCHAR(500)  NULL COMMENT '原因说明（如缺服务级鉴权、无员工到用户映射）',
  created_at    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（毫秒）',
  updated_at    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '更新时间（毫秒）',
  PRIMARY KEY (id),
  UNIQUE KEY luk_ai_reminder_unresolved (tenant_id, schedule_id, occurrence_at, principal),
  KEY idx_ai_reminder_unresolved_reason (tenant_id, reason)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='AI 提醒不可解析接收人登记（明确未投递，不冒充成功）';
