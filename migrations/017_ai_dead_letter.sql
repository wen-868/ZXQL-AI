-- 017 t_ai_dead_letter：bestEffort 死信落库表（死信 sink 生产注册 · 阶段1 遗留 TODO 收口）
-- 依据：R101-AI-22 派单卡（上游 = R101-AI-21 自报备第 1 条：死信在生产只进日志+指标，无法复盘）
--
-- 一、定位与归属
--   - 归属：业务库侧、本仓独占（与 002 / 005 / 006 / 008 / 015 / 016 同类）。
--     裸写表名即落业务库，不使用 USE 切库（migrations/README.md 二.6）。
--   - 作用：`setDefaultDeadLetterSink` 的生产落库端 —— bestEffort 失败（可最终一致的旁路：
--     审计流水/用量上报/消息推送/幂等闸门 fail-open 等）的死信在此可复盘、可重放。
--   - 逐字段对齐 DeadLetterRecord（src/common/error-semantics.ts:48）：
--       op / tenantId / detail / error / stack / level（恒 best_effort） / at（ISO8601）
--     其中 level 由写入方固定为 best_effort，列默认值同值；at 保留毫秒 ⇒ DATETIME(3)。
--
-- 二、清理与保留期
--   - 保留 30 天（与 016 t_ai_idempotency 对齐）：覆盖故障复盘/对账窗口。
--   - 清理走每日 03:00 分批 DELETE（LIMIT 5000 循环），依赖 idx_dead_letter_created_at。
--   - 清理任务在 src/ops/dead-letter-sink.service.ts（R101-AI-17 同款 @Cron 命名任务范式）。
--
-- 三、幂等与执行
--   - 建表用 CREATE TABLE IF NOT EXISTS（MySQL 8.0 支持），可重复执行。
--   - **本文件只写 + scratch 执行一次 + 幂等复跑一次**，不得在业务库/生产库执行。
--   - 注释内不得出现分号（部署器按分号拆分语句），本文件已遵守。
--   - 执行方式：mysql -u<user> -p <业务库> < migrations/017_ai_dead_letter.sql
--
-- 负责人: 阿坚 | 创建日期: 2026-10-12

CREATE TABLE IF NOT EXISTS t_ai_dead_letter (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  op         VARCHAR(64)  NOT NULL COMMENT '失败的操作名（模块.动作，如 idem.claim）',
  tenant_id  VARCHAR(36)  NULL COMMENT '租户ID（可空：非租户链路失败）',
  detail     TEXT         NULL COMMENT '补充说明（如 key、订单号）',
  error      TEXT         NOT NULL COMMENT '错误消息',
  stack      TEXT         NULL COMMENT '错误堆栈（便于复盘，可能为空）',
  level      VARCHAR(16)  NOT NULL DEFAULT 'best_effort' COMMENT '语义级别（恒 best_effort）',
  at         DATETIME(3)  NOT NULL COMMENT '失败发生时间（ISO8601 转 DATETIME，保留毫秒）',
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '写入时间（清理依据）',
  PRIMARY KEY (id),
  KEY idx_dead_letter_op (op),
  KEY idx_dead_letter_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='bestEffort 死信落库表（可复盘/可重放）';

-- 四、回滚 SQL（文档·勿执行；按 migrations/README.md 二.5，回滚走反向迁移）
--   回滚 = 反向迁移，单独执行下列语句（刻意不在注释内写句末分号，避免破坏分号拆分）：
--     DROP TABLE IF EXISTS t_ai_dead_letter
--   注意：DROP 会丢失死信复盘凭据，执行前须确认 sink 注册已下线（代码回滚完成）
