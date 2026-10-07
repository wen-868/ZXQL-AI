-- ai_sample.task_type 存量回填：工具名口径归一为裸 docType（阶段 4-1 · P0 断链修复）
-- 依据：docs/reports/阶段4-1-taskType归一-任务卡.md
--   采集侧（src/evolution/capture.service.ts）历史上把工具名（如 createSalesOrder）
--   写进 ai_sample.task_type，而消费侧（src/brain/extraction/structured-extractor.ts:141-145）
--   的 few-shot 回流按裸 docType（如 sales_order）精确相等查询
--   ⇒ 永不相等 ⇒ 自动捕获的样本 100% 进不了 few-shot 池。
--   代码侧已在 capture.service.ts 落库前用 docTypeForTool() 归一，本脚本只补存量。
--
-- 映射来源：src/brain/extraction/write-schema-registry.ts 的 WRITE_SCHEMAS
--   （14 类 docType / 19 个工具名，实施方已逐条 Read 核实）。
--   工具名 → docType 为多对一（promotion 有 6 个工具名），无二义。
--
-- 幂等：每条 UPDATE 都以 WHERE task_type = '<工具名>' 精确限定。
--   重跑时命中 0 行（工具名已被改成 docType），结果与跑一次完全一致。
--   不使用 ADD COLUMN / ADD INDEX，故无需 information_schema 判定 + PREPARE，
--   也不触碰「加列/加索引条件存在」这类 MariaDB 专有写法（MySQL 8.0 语法不支持）红线。
--
-- ⚠️ 前置检查（人工确认后再执行）：
--   docType 与工具名大小写/下划线形态完全不相交（docType 全 snake_case，
--   工具名全 camelCase 或 api_ 前缀），因此本脚本 19 条 UPDATE 互不干扰，
--   执行顺序无关。utf8mb4 默认不区分大小写的排序规则下结论同样成立。
--
-- ⚠️ 本脚本【只写不执行】：生产是否回填由审查方/用户决策。
--   确认方式：先跑末段核验 SELECT（回填前应全部为 0）。
--
-- ⚠️ 依赖：本文件是纯 DML，无会话变量，mysql < 文件 整文件执行即可，
--   也可按分号拆分到多条连接逐条执行（与 007/008/009/011 不同，无 PREPARE 依赖）。
--
-- ⚠️ 注释规范：每行注释的破折号后必须留一个空白，否则 MySQL 报 1064。

-- ── 1:1 映射（13 个 docType，各对应 1 个工具名）──
-- createCustomer → customer_create
UPDATE ai_sample SET task_type = 'customer_create' WHERE task_type = 'createCustomer';
-- createProduct → product_create
UPDATE ai_sample SET task_type = 'product_create' WHERE task_type = 'createProduct';
-- updateProductPrice → price_update
UPDATE ai_sample SET task_type = 'price_update' WHERE task_type = 'updateProductPrice';
-- createSalesOrder → sales_order
UPDATE ai_sample SET task_type = 'sales_order' WHERE task_type = 'createSalesOrder';
-- createSalesReturn → sales_return
UPDATE ai_sample SET task_type = 'sales_return' WHERE task_type = 'createSalesReturn';
-- createPurchaseOrder → purchase_order
UPDATE ai_sample SET task_type = 'purchase_order' WHERE task_type = 'createPurchaseOrder';
-- api_create_purchase_return → purchase_return
UPDATE ai_sample SET task_type = 'purchase_return' WHERE task_type = 'api_create_purchase_return';
-- createDelivery → delivery
UPDATE ai_sample SET task_type = 'delivery' WHERE task_type = 'createDelivery';
-- createPaymentReconciliation → receipt
UPDATE ai_sample SET task_type = 'receipt' WHERE task_type = 'createPaymentReconciliation';
-- api_create_purchase_payment → payment
UPDATE ai_sample SET task_type = 'payment' WHERE task_type = 'api_create_purchase_payment';
-- createRefund → refund
UPDATE ai_sample SET task_type = 'refund' WHERE task_type = 'createRefund';
-- inventoryTransfer → inventory_transfer
UPDATE ai_sample SET task_type = 'inventory_transfer' WHERE task_type = 'inventoryTransfer';
-- stockCheck → inventory_check
UPDATE ai_sample SET task_type = 'inventory_check' WHERE task_type = 'stockCheck';

-- 1:N 映射（promotion 对应 6 个工具名，单条 IN 一次改完）
-- api_create_flash_sale / createCouponTemplate / createFullReduction /
-- createGroupBuy / createGiftRule / createLimitedDiscount → promotion
UPDATE ai_sample SET task_type = 'promotion' WHERE task_type IN (
  'api_create_flash_sale',
  'createCouponTemplate',
  'createFullReduction',
  'createGroupBuy',
  'createGiftRule',
  'createLimitedDiscount'
);

-- 核验 SELECT：以下两列均应为 0（非 0 说明仍有工具名残留，需排查后再执行本脚本）
--   remaining_tool_name_rows：仍以工具名存储的样本行数
--   total_rows：样本总行数
SELECT
  (SELECT COUNT(*) FROM ai_sample WHERE task_type IN (
     'createCustomer','createProduct','updateProductPrice','createSalesOrder',
     'createSalesReturn','createPurchaseOrder','api_create_purchase_return',
     'createDelivery','createPaymentReconciliation','api_create_purchase_payment',
     'createRefund','inventoryTransfer','stockCheck','api_create_flash_sale',
     'createCouponTemplate','createFullReduction','createGroupBuy',
     'createGiftRule','createLimitedDiscount'
   )) AS remaining_tool_name_rows,
  (SELECT COUNT(*) FROM ai_sample) AS total_rows;

-- 回填后分布核对（人工阅读输出即可，无需断言）：确认 14 类 docType 已出现，
-- 且原本就合规的存量值（如 office_document / write / analysis）原样保留。
SELECT task_type, COUNT(*) AS cnt
  FROM ai_sample
 GROUP BY task_type
 ORDER BY cnt DESC;