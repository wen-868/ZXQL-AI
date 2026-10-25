-- 024 AI 域提醒投递状态表 t_ai_reminder_delivery —— AI-P2-3F1
-- 依据：AI-P2-3F1 派单卡 §二.2「不得继续用单一 reminded_at 同时代表"通知完成"和"推送完成"」
--
-- 一、为什么新建（而不是加列到 t_ai_schedule）
--   - `reminded_at` 只有"提醒过"一个语义，无法区分：通知已入箱 / 单推已成功 / 摘要已成功；
--   - 混在一列会导致「push 成功但通知失败」被误标为完成（P2-3 的 B3 驳回事实）；
--   - 独立表可按 (tenant, schedule_id, occurrence_at, kind) 精确记每个投递维度的状态。
--
-- 二、为什么不用 t_push_log
--   - t_push_log 属 **MS 跨线表**（migration 012 仅 ALTER 加 tenant_id），本仓不得改其结构（派单卡红线）；
--   - 它是 append-only 投递审计日志，无语义承载"某提醒的通知/摘要是否已完成"。
--
-- 三、身份口径（B4 驳回：禁止用 title 匹配）
--   唯一身份 = `(tenant_id, schedule_id, occurrence_at)`：
--     - schedule_id  = t_ai_schedule.id（同名不同 id 不会互相冒充）；
--     - occurrence_at = 该次提醒的 remind_at（同一日程有多次提醒时区分 occurrence）。
--   `kind` 区分投递维度（AI-P2-3F2 定稿）：
--     - 'notice' = 逐条入通知中心；
--     - 'push'   = 逐条即时推送（含摘要覆盖收口——摘要成功后给本批每条写 push=success）。
--   摘要批次自身的幂等**不在本表**，走下方 t_ai_reminder_digest_sent（粒度不同，混表会丢单条幂等）。
--
-- 四、幂等与终态（承重）
--   唯一键 `(tenant_id, schedule_id, occurrence_at, kind)`
--   ⇒ 同一提醒同一维度**只成功一次**；cron 每分钟重跑不会重复插入。
--   `status` 语义（F2）：
--     - notice：success=已入箱（重试只补 failed 的）；
--     - push：success=已推送；skipped=owner 不可定向（禁止广播收口，属**终态**不再重扫）；
--       failed=渠道失败（下轮重试）。
--   扫描"未送达"= notice 无 success **或** push 无 (success/skipped) ⇒ 两维都闭合才退出。
--
-- 五、执行
--   - `CREATE TABLE IF NOT EXISTS`（可重复执行）；注释内不得出现分号（部署器按分号拆分）
--   - **本文件只写 + scratch 执行一次 + 幂等复跑一次**，不得在业务库/生产库执行
--
-- 负责人: 阿洲 | 创建日期: 2026-10-25

CREATE TABLE IF NOT EXISTS t_ai_reminder_delivery (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  tenant_id      VARCHAR(36)   NOT NULL COMMENT '租户ID',
  schedule_id    VARCHAR(64)   NOT NULL COMMENT '日程ID（t_ai_schedule.id）',
  occurrence_at  DATETIME(3)   NOT NULL COMMENT '本次提醒的 occurrence（remind_at）',
  kind           VARCHAR(16)   NOT NULL COMMENT '投递维度：notice=入通知中心 / push=即时推送（摘要覆盖也记此维度）',
  status         VARCHAR(16)   NOT NULL COMMENT '状态：success / failed=待重试 / skipped=不可定向已收口（push 终态）',
  dedupe_key     VARCHAR(191)  NULL COMMENT '去重键（tenant:schedule:occurrence:kind）',
  error_msg      VARCHAR(500)  NULL COMMENT '失败原因（仅失败时写）',
  attempts       INT UNSIGNED  NOT NULL DEFAULT 1 COMMENT '尝试次数（重试累加）',
  created_at     DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（毫秒）',
  updated_at     DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '更新时间（毫秒）',
  PRIMARY KEY (id),
  UNIQUE KEY luk_ai_reminder_delivery (tenant_id, schedule_id, occurrence_at, kind),
  KEY idx_ai_reminder_delivery_kind (tenant_id, kind, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='AI 提醒投递状态（通知/推送分维度幂等）';

-- ─────────────────────────────────────────────────────────────
-- 摘要幂等表：t_ai_reminder_digest_sent
--
-- 为什么单独一张表（而不是复用 t_ai_reminder_delivery）：
--   摘要的粒度是"一批"（N 条漏提醒合成 1 条摘要），其身份不是单条 (scheduleId, occurrenceAt)，
--   而是"这批的稳定集合指纹"（batch_key = 排序后 id@occurrence 的哈希）。
--   把两种粒度混在一张表需要放宽唯一键，反而丢掉单条幂等。
--
-- 幂等（B4 驳回的正面要求）：
--   唯一键 (tenant_id, batch_key) ⇒ 同一批摘要**只成功发一次**；
--   连续 cron 每分钟重跑，只要批指纹不变就不会重复推送。
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS t_ai_reminder_digest_sent (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  tenant_id   VARCHAR(36)  NOT NULL COMMENT '租户ID',
  batch_key   VARCHAR(191) NOT NULL COMMENT '批次指纹（排序后 scheduleId@occurrenceAt 哈希）',
  sent_at     DATETIME(3)  NOT NULL COMMENT '成功发送时间（毫秒）',
  PRIMARY KEY (id),
  UNIQUE KEY luk_ai_reminder_digest (tenant_id, batch_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='AI 提醒摘要幂等（同批只发一次）';
