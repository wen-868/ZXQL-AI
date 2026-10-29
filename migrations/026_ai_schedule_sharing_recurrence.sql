-- 026 日程共享、代管与重复日程（AI-P2-2）
-- 依据：派单卡 AI-P2-2 §四.1「自包含迁移：共享角色、共享人员、代管人员、seriesId、
--   recurrenceRule、occurrenceAt、exception」；§五.9「026 在真实 MySQL 8 独立 scratch
--   连续执行两遍 EXIT=0」
--
-- 一、定位
--   - 本仓独占业务库表 t_ai_schedule 的**扩展**；不改 001-025 任一支历史迁移（红线）
--   - 全部改动用 `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` 语义等价手法
--     （MySQL 8 无 ADD COLUMN IF NOT EXISTS ⇒ 用 information_schema + PREPARE 条件执行）
--   - 裸写表名，不用 USE 切库；注释内不得出现分号（部署器按分号拆分）
--
-- 二、权限模型（三档，与卡面 §四.3 / §五.1 对齐）
--   - participants（021 已交付，语义**不变**）：参与人 = **可读**（提醒/摘要接收面）
--   - viewer_roles / viewer_user_ids：**显式共享**给角色与指定人员 ⇒ 只读（viewer）
--     取并集（角色命中的用户 ∪ 指定用户）；PRIVATE 为默认（两列均空）
--   - manager_user_ids：**代管**人员 ⇒ 在只读之上**额外**具备编辑/完成/取消权
--   ⇒ 权限判定：owner/platform = admin；manager ∈ manager_user_ids = write；
--     participants ∪ viewer = read；其余 none。**全部带 tenant_id 边界**。
--
-- 三、重复日程（recurrence 安全子集，卡面 §四.4）
--   - series_id：同一次「重复规则」创建的 occurrence 共享一个 series（首条亦写入自身 series）
--   - recurrence_rule：规则原文（JSON 字符串）——DAILY/WEEKLY/MONTHLY/YEARLY + INTERVAL
--     + BYDAY + BYMONTHDAY + COUNT 或 UNTIL（**二选一**）；时区固定 Asia/Shanghai
--   - occurrence_at：该行代表的**这一次发生**的基准时刻（展开器的唯一身份维度）
--   - exception：该 occurrence 的例外（如单次改动/取消），JSON；NULL = 无例外
--
-- 四、唯一键调整（关键：不破坏既有幂等，又支持同系列多 occurrence）
--   021 的唯一键 `luk_ai_schedule_dedupe (tenant_id,title,owner,start_at)` 在重复日程下
--   会**阻止同一系列展开出的多个 occurrence 落库**（它们 title/owner 相同、start_at 不同，
--   实际不冲突；但「同一天多次同标题」与「单次日程重复提交」需要区分）。
--   ⇒ 026 追加 series 维度唯一键 `luk_ai_schedule_series_occ (tenant_id, series_id, occurrence_at)`：
--      仅当 series_id 非空时生效（MySQL 唯一键对 NULL 不判重 ⇒ 单次日程 series_id=NULL 不受影响）
--   ⇒ **保留** 021 的 luk_ai_schedule_dedupe 不动（红线：不改既有迁移的结构）
--
-- 五、审计（卡面 §五.3「共享范围变化产生可核审计」）
--   - t_ai_schedule_share_audit 记录每次共享/代管范围变更的前后值与操作者
--   - 不新建 AI 旁路通知（红线）；本表仅审计留痕
--
-- 六、执行
--   - 本文件只写 + scratch 连续执行两遍验证幂等，不得在业务库/生产库执行
--
-- 负责人: 阿洲（AI 底座 owner）| 创建日期: 2026-10-28

-- ─────────────────────────────────────────────────────────────
-- 六之一、日程表扩展列（information_schema + PREPARE 条件执行 ⇒ 可重复跑）
-- ─────────────────────────────────────────────────────────────

SET @col_exists := (
  SELECT COUNT(1) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't_ai_schedule' AND COLUMN_NAME = 'series_id'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE t_ai_schedule ADD COLUMN series_id BIGINT UNSIGNED NULL COMMENT ''重复日程系列ID（单次日程为 NULL）''',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(1) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't_ai_schedule' AND COLUMN_NAME = 'recurrence_rule'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE t_ai_schedule ADD COLUMN recurrence_rule VARCHAR(1000) NULL COMMENT ''重复规则原文（JSON，安全子集，时区固定 Asia/Shanghai）''',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(1) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't_ai_schedule' AND COLUMN_NAME = 'occurrence_at'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE t_ai_schedule ADD COLUMN occurrence_at DATETIME(3) NULL COMMENT ''该 occurrence 的基准时刻（展开器唯一身份维度）''',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(1) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't_ai_schedule' AND COLUMN_NAME = 'exception'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE t_ai_schedule ADD COLUMN exception VARCHAR(1000) NULL COMMENT ''该 occurrence 的例外（JSON，如单次改动/取消）''',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(1) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't_ai_schedule' AND COLUMN_NAME = 'viewer_roles'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE t_ai_schedule ADD COLUMN viewer_roles VARCHAR(1000) NULL COMMENT ''共享角色（逗号分隔 role id，首尾逗号归一化；NULL=PRIVATE）''',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(1) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't_ai_schedule' AND COLUMN_NAME = 'viewer_user_ids'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE t_ai_schedule ADD COLUMN viewer_user_ids VARCHAR(1000) NULL COMMENT ''共享指定人员（逗号分隔 user id，首尾逗号归一化；NULL=PRIVATE）''',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(1) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't_ai_schedule' AND COLUMN_NAME = 'manager_user_ids'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE t_ai_schedule ADD COLUMN manager_user_ids VARCHAR(1000) NULL COMMENT ''代管人员（逗号分隔 user id，独立于 viewer 的编辑权）''',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- series/occurrence 唯一键：仅约束"同系列同一 occurrence"（series_id 为 NULL 时 MySQL 不判重）
SET @idx_exists := (
  SELECT COUNT(1) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't_ai_schedule'
     AND INDEX_NAME = 'luk_ai_schedule_series_occ'
);
SET @ddl := IF(@idx_exists = 0,
  'ALTER TABLE t_ai_schedule ADD UNIQUE KEY luk_ai_schedule_series_occ (tenant_id, series_id, occurrence_at)',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(1) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't_ai_schedule'
     AND INDEX_NAME = 'idx_ai_schedule_series'
);
SET @ddl := IF(@idx_exists = 0,
  'ALTER TABLE t_ai_schedule ADD KEY idx_ai_schedule_series (tenant_id, series_id, occurrence_at)',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ─────────────────────────────────────────────────────────────
-- 六之二、共享范围变更审计（卡面 §五.3）
--   每次 viewer/manager 范围变化留一行：who / before / after / 时间
--   幂等：表本身 CREATE IF NOT EXISTS；行由业务写入（天然按变更事件追加）
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS t_ai_schedule_share_audit (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  tenant_id        VARCHAR(36)  NOT NULL COMMENT '租户ID',
  schedule_id      BIGINT UNSIGNED NOT NULL COMMENT '日程ID',
  actor            VARCHAR(128) NOT NULL COMMENT '操作者 principal（user:{id}/employee:{id}）',
  before_viewer_roles   VARCHAR(1000) NULL COMMENT '变更前共享角色',
  after_viewer_roles    VARCHAR(1000) NULL COMMENT '变更后共享角色',
  before_viewer_users   VARCHAR(1000) NULL COMMENT '变更前共享人员',
  after_viewer_users    VARCHAR(1000) NULL COMMENT '变更后共享人员',
  before_manager_users  VARCHAR(1000) NULL COMMENT '变更后代管人员（前）',
  after_manager_users   VARCHAR(1000) NULL COMMENT '变更后代管人员（后）',
  created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（毫秒）',
  PRIMARY KEY (id),
  KEY idx_ai_schedule_share_audit (tenant_id, schedule_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='AI 日程共享/代管范围变更审计';
