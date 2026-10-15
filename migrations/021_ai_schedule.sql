-- 021 办公批次 4：日程表 t_ai_schedule —— R101-AI-39 步骤 1
-- 依据：R101-AI-39 派单卡（凌舟框架）+ S0 提醒路径侦察结论
--
-- 一、定位与边界
--   - 归属：业务库侧、本仓独占；裸写表名，不使用 USE 切库（migrations/README.md 二.6）
--   - 边界：**重复日程（recurrence）不做**；日程共享/代管不做；与外部日历同步不做
--
-- 二、幂等键设计（对照规范 §2.2）
--   唯一键 `(tenant_id, title, owner, start_at)` —— 四列**全部 NOT NULL**
--   ⇒ **DB 层对本表有效**（不像 `due_at`/`related_biz` 那样因 NULL 不判重）
--   `end_at` / `remind_at` 可空但**不参与**唯一键 ⇒ 空值不影响判重
--   工具层仍保留业务幂等前置检查作双层（DB 挡并发、业务层挡日常重复提交）
--
-- 三、提醒（S0 结论：复用既有通道，不新建）
--   - 复用 `ProactivePushService.push(tenantId, taskName, push)`（写 t_push_log + `pushGateway.broadcast`）
--   - 复用 `ProactiveService` 的 `@Cron` 框架（AppModule 已 ScheduleModule.forRoot()）：新增每分钟扫描
--     到期日程（`status='planned' AND remind_at <= NOW() AND reminded_at IS NULL`）⇒ 推送后写 `reminded_at`
--   - `reminded_at` 即**提醒幂等标记**（非空不再提醒），防止重复打扰
--
-- 四、执行
--   - `CREATE TABLE IF NOT EXISTS`（可重复执行）
--   - **本文件只写 + scratch 执行一次 + 幂等复跑一次**，不得在业务库/生产库执行
--   - 注释内不得出现分号（部署器按分号拆分语句）
--   - 执行：mysql -u<user> -p <业务库> < migrations/021_ai_schedule.sql
--
-- 负责人: 阿坚 | 创建日期: 2026-10-16

CREATE TABLE IF NOT EXISTS t_ai_schedule (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  tenant_id    VARCHAR(36)  NOT NULL COMMENT '租户ID',
  title        VARCHAR(255) NOT NULL COMMENT '日程标题',
  start_at     DATETIME(3)  NOT NULL COMMENT '开始时间（毫秒；唯一键组成）',
  end_at       DATETIME(3)  NULL COMMENT '结束时间（可空；不参与唯一键）',
  owner        VARCHAR(128) NOT NULL COMMENT '归属人（user:{id}/employee:{id}，ACL owner）',
  participants VARCHAR(1000) NULL COMMENT '参与者（逗号分隔 principal，亦为 ACL 主体）',
  status       ENUM('planned','done','cancelled') NOT NULL DEFAULT 'planned' COMMENT '状态',
  remind_at    DATETIME(3)  NULL COMMENT '提醒时间（可空）',
  reminded_at  DATETIME(3)  NULL COMMENT '已提醒时间（幂等标记，非空不再提醒）',
  source       ENUM('user','ai','employee') NOT NULL DEFAULT 'ai' COMMENT '来源',
  created_by   VARCHAR(64)  NULL COMMENT '创建者',
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（毫秒）',
  updated_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '更新时间（毫秒）',
  PRIMARY KEY (id),
  UNIQUE KEY luk_ai_schedule_dedupe (tenant_id, title, owner, start_at),
  KEY idx_ai_schedule_start_at (tenant_id, start_at),
  KEY idx_ai_schedule_owner_status (tenant_id, owner, status),
  KEY idx_ai_schedule_remind (tenant_id, status, remind_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='办公-日程';

-- 五、回滚 SQL（文档·勿执行；按 migrations/README.md 二.5，回滚走反向迁移）
--     DROP TABLE IF EXISTS t_ai_schedule
--   注意：DROP 会丢失日程与提醒状态，执行前须确认日程工具与提醒扫描已下线
