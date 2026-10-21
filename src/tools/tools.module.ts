import { Module } from '@nestjs/common';
import { ToolRegistry } from './tool-registry';
import { ToolExecutor } from './tool-executor';
import { ToolBootstrap } from './tool-bootstrap';
import { EmployeeModule } from '../brain/employee/employee.module';
// R101-AI-47：ReadinessService 归位独立 ReadinessModule（只依赖 database 叶子 ⇒ 无环；
//   放 OpsModule 会 ToolsModule→OpsModule→ProactiveModule→BrainModule→ToolsModule 成环）
import { ReadinessModule } from '../ops/readiness.module';
import { DispatchEmployeeTaskTool } from './definitions/dispatch-employee-task.tool';
// R70-14: 智能价格填充引擎（可复用服务）
import { PriceEngineService } from './price-engine.service';
import { UnitConverterService } from './unit-converter.service';
import { SearchCustomerTool } from './definitions/search-customer.tool';
import { SearchProductTool } from './definitions/search-product.tool';
import { CreateProductTool } from './definitions/create-product.tool';
import { CheckInventoryTool } from './definitions/check-inventory.tool';
import { CreateSalesOrderTool } from './definitions/create-sales-order.tool';
import { QuerySaleBillsTool } from './definitions/query-sale-bills.tool';
import { GetSaleBillDetailTool } from './definitions/get-sale-bill-detail.tool';
import { CancelOrderTool } from './definitions/cancel-order.tool';
import { CancelPurchaseOrderTool } from './definitions/cancel-purchase-order.tool';
import { ToolGeneratorService } from './catalog/tool-generator.service';
import { CircuitBreakerService } from './circuit-breaker.service';
// R70-10: 库存管理 3 个工具
import { InventoryTransferTool } from './definitions/inventory-transfer.tool';
import { StockCheckTool } from './definitions/stock-check.tool';
import { QueryInventoryTool } from './definitions/query-inventory.tool';
// R70-11: 商品管理 + 客户管理 4 个工具
import { UpdateProductPriceTool } from './definitions/update-product-price.tool';
import { QueryProductDetailTool } from './definitions/query-product-detail.tool';
import { CreateCustomerTool } from './definitions/create-customer.tool';
import { QueryCustomerDetailTool } from './definitions/query-customer-detail.tool';
import { CreatePurchaseOrderTool } from './definitions/create-purchase-order.tool';
import { QueryPurchaseOrdersTool } from './definitions/query-purchase-orders.tool';
import { QueryDeliveryStatusTool } from './definitions/query-delivery-status.tool';
import { CreateDeliveryTool } from './definitions/create-delivery.tool';
// R70-13: 财务管理 + 报表分析 8 个工具
import { QueryReceivablesTool } from './definitions/query-receivables.tool';
import { QueryPayablesTool } from './definitions/query-payables.tool';
import { CreateSalesReturnTool } from './definitions/create-sales-return.tool';
import { CreateRefundTool } from './definitions/create-refund.tool';
import { CreatePaymentReconciliationTool } from './definitions/create-payment-reconciliation.tool';
import { SalesReportTool } from './definitions/sales-report.tool';
// R101-AI-32/33 ③：销售预测（读工具，走 ToolExecutor 治理链）
import { ForecastSalesTool } from './definitions/forecast-sales.tool';
import { AnalyzePriceTrendTool } from './definitions/analyze-price-trend.tool';
// R101-AI-34 P1-4：系统状态自检（读工具）
import { GetSystemStatusTool } from './definitions/get-system-status.tool';
// R101-AI-35 S2：文档中心（办公能力第一批）—— 读/写工具
import { AiDocCreateTool } from './definitions/ai-doc-create.tool';
import { AiDocListTool } from './definitions/ai-doc-list.tool';
import { AiDocUpdateTool } from './definitions/ai-doc-update.tool';
import { AiDocGetTool } from './definitions/ai-doc-get.tool';
// R101-AI-36：取消销售单 SO/SB（写工具，高危；P1-3 兑现）
import { CancelSalesOrderTool } from './definitions/cancel-sales-order.tool';
import { AiDocArchiveTool } from './definitions/ai-doc-archive.tool';
import { AiDocSearchTool } from './definitions/ai-doc-search.tool';
// R101-AI-37 步骤 3：待办清单（读工具；ACL 可见集作为库查询条件）
import { AiTodoListTool } from './definitions/ai-todo-list.tool';
// R101-AI-37 步骤 3：新建待办（写工具；幂等双保险 + 复用既有派单）
import { AiTodoCreateTool } from './definitions/ai-todo-create.tool';
// R101-AI-37 步骤 3：修改/完成待办（写工具）
import { AiTodoUpdateTool } from './definitions/ai-todo-update.tool';
import { AiTodoCompleteTool } from './definitions/ai-todo-complete.tool';
// R101-AI-38 办公批次 3：审批流（Approve/Reject 共用 ApprovalDecisionBase 状态机）
import { AiApprovalApproveTool } from './definitions/ai-approval-approve.tool';
import { AiApprovalRejectTool } from './definitions/ai-approval-reject.tool';
// R101-AI-38 办公批次 3：审批（提交/列表/撤回/改草稿）
import { AiApprovalCreateTool } from './definitions/ai-approval-create.tool';
import { AiApprovalListTool } from './definitions/ai-approval-list.tool';
import { AiApprovalCancelTool } from './definitions/ai-approval-cancel.tool';
import { AiApprovalUpdateTool } from './definitions/ai-approval-update.tool';
// R101-AI-39 办公批次 4：日程（List/Create/Update/Complete/Cancel）
import { AiScheduleListTool } from './definitions/ai-schedule-list.tool';
import { AiScheduleCreateTool } from './definitions/ai-schedule-create.tool';
import { AiScheduleUpdateTool } from './definitions/ai-schedule-update.tool';
import { AiScheduleCompleteTool } from './definitions/ai-schedule-complete.tool';
import { AiScheduleCancelTool } from './definitions/ai-schedule-cancel.tool';
// R101-AI-40 办公批次 5：站内通知（List/MarkRead/Archive/UnreadCount）
import { AiNoticeListTool } from './definitions/ai-notice-list.tool';
import { AiNoticeMarkReadTool } from './definitions/ai-notice-mark-read.tool';
import { AiNoticeArchiveTool } from './definitions/ai-notice-archive.tool';
import { AiNoticeUnreadCountTool } from './definitions/ai-notice-unread-count.tool';
// R101-AI-41：取消待办 + 丢弃审批草稿（补齐两处缺失的状态/生命周期入口）
import { AiTodoCancelTool } from './definitions/ai-todo-cancel.tool';
import { AiApprovalDraftDiscardTool } from './definitions/ai-approval-draft-discard.tool';
import { OfficeAclService } from '../rag/office-acl.service';
import { InventoryReportTool } from './definitions/inventory-report.tool';
import { ProfitReportTool } from './definitions/profit-report.tool';
// R70 完善度 P1: 营销/采购计划/信用 6 个精调写操作工具（清单第一批 P0）
import { CreateCouponTemplateTool } from './definitions/create-coupon-template.tool';
import { SetCouponStatusTool } from './definitions/set-coupon-status.tool';
import { CreateFlashSaleTool } from './definitions/create-flash-sale.tool';
import { CreatePurchasePlanTool } from './definitions/create-purchase-plan.tool';
import { ConvertPurchasePlanTool } from './definitions/convert-purchase-plan.tool';
import { AdjustCreditLimitTool } from './definitions/adjust-credit-limit.tool';
// R70 完善度 P1: 营销/采购/费用 8 个精调写操作工具（清单第一批 P1）
import { CreateFullReductionTool } from './definitions/create-full-reduction.tool';
import { CreateGroupBuyTool } from './definitions/create-group-buy.tool';
import { CreateGiftRuleTool } from './definitions/create-gift-rule.tool';
import { SetMarketingActivityStatusTool } from './definitions/set-marketing-activity-status.tool';
import { CreatePurchasePaymentTool } from './definitions/create-purchase-payment.tool';
import { CreatePurchaseReturnTool } from './definitions/create-purchase-return.tool';
import { CreatePurchaseContractTool } from './definitions/create-purchase-contract.tool';
import { CreateExpenseTool } from './definitions/create-expense.tool';
// R70 完善度 P1: 客户/佣金/催收/限量折扣 6 个精调写操作工具（清单第一批收口）
import { CreateCustomerSegmentTool } from './definitions/create-customer-segment.tool';
import { ExecuteCareRuleTool } from './definitions/execute-care-rule.tool';
import { CreateCustomerVisitTool } from './definitions/create-customer-visit.tool';
import { CalculateCommissionTool } from './definitions/calculate-commission.tool';
import { AutoGenerateCollectionsTool } from './definitions/auto-generate-collections.tool';
import { CreateLimitedDiscountTool } from './definitions/create-limited-discount.tool';
// R70 完善度 P1: 审批处理（第二批，高危强制审核）
import { HandleApprovalTool } from './definitions/handle-approval.tool';
// R70 完善度 P1: 总平台级 2 个精调写操作工具（第三批，scope=platform）
import { CreatePlatformAnnouncementTool } from './definitions/create-platform-announcement.tool';
import { HandleSubscriptionApplyTool } from './definitions/handle-subscription-apply.tool';
import { BridgeModule } from '../bridge/bridge.module';
import { CommonModule } from '../common/common.module';
import { DatabaseModule } from '../database/database.module';
// R101-AI-34 P1-4：getSystemStatus 需要 AiConfigService（TenantModule 导出；同 brain/bridge/evolution 范式，无环）
import { TenantModule } from '../tenant/tenant.module';
// R101-AI-35 S3：文档 ↔ RAG 贯通（DocRagService 由 RagModule 导出；RagModule 不依赖 ToolsModule，无环）
import { RagModule } from '../rag/rag.module';
// R101-AI-35 S3：文档↔RAG 贯通。RagModule 的 providers/exports 是 R70-21 精确契约（其 spec 断言精确列表）
// ⇒ **不改 RagModule**：在本模块提供 DocRagService；Embedding/VectorStore 复用 RagModule 导出单例
//（VectorStore 持有内存态，必须共用！），TextSplitterService 无状态 ⇒ 本模块独立实例无害
import { DocRagService } from '../rag/doc-rag.service';
import { TextSplitterService } from '../rag/text-splitter.service';
import { IdempotencyGateService } from './idempotency-gate.service';

/**
 * Tool 系统模块
 *
 * 注册并导出 ToolRegistry + ToolExecutor，供 Brain Engine（R70-08）和 Gateway（R70-06）注入使用。
 * ToolBootstrap 负责在模块初始化时将所有工具注册到 ToolRegistry（不导出，仅触发注册副作用）。
 *
 * 依赖关系：
 * - ToolRegistry 无外部依赖（纯内存 Map）
 * - ToolExecutor 依赖 ToolRegistry（同模块内注入）+ AuditLogger（BridgeModule 提供，异步写审计日志）
 * - ToolBootstrap 依赖 ToolRegistry + 所有 ITool 实现（触发注册）
 * - 业务工具依赖 ServiceClient（调用后端 API）→ BridgeModule 提供
 *
 * 已注册工具（R70-09）：
 * - SearchCustomerTool：搜索客户（customer）
 * - SearchProductTool：搜索商品（product）
 * - CheckInventoryTool：查询库存（inventory）
 * - CreateSalesOrderTool：创建销售单（order，写操作+预览）
 * - QuerySaleBillsTool：查询销售单列表（order）
 * - GetSaleBillDetailTool：查询销售单详情（order）
 * - CancelOrderTool：取消订单（order，写操作）
 *
 * 后续 R70-10~13 新增业务工具（inventory/product/customer/purchase/delivery/finance/report）时：
 * 1. 创建 src/tools/definitions/xxx.tool.ts（实现 ITool 接口）
 * 2. 在本模块 providers 数组中注册该工具
 * 3. 在 ToolBootstrap 构造函数注入该工具，并在 onModuleInit 的 registerAll 数组中添加
 */
@Module({
  imports: [
    BridgeModule,
    CommonModule,
    EmployeeModule,
    DatabaseModule,
    TenantModule,
    RagModule,
    // R101-AI-47：ReadinessModule（ReadinessService 归位后可被本模块工具注入；
    //   get-system-status 切换到 readiness.check() 属后续单，先打通依赖且无环）
    ReadinessModule,
  ],
  providers: [
    ToolRegistry,
    ToolExecutor,
    // R101-AI-21：写工具幂等闸门（Redis SET NX 前置 + MySQL 唯一键认领兜底）
    IdempotencyGateService,
    // R101-AI-32/33 ③：销售预测（读工具）
    ForecastSalesTool,
    // R101-AI-32/33 ④：价格走势分析（读工具）
    AnalyzePriceTrendTool,
    // R101-AI-34 P1-4：系统状态自检（读工具）
    GetSystemStatusTool,
    // R101-AI-35 S2：文档中心写工具（aiDocCreate；preview→confirm + 幂等）
    AiDocCreateTool,
    // R101-AI-35 S2：文档中心读工具（aiDocList；必经 OfficeAclService）
    AiDocListTool,
    // R101-AI-35 S2：文档中心写工具（aiDocUpdate；乐观锁 + preview→confirm）
    AiDocUpdateTool,
    // R101-AI-35 S2：文档中心读工具（aiDocGet；无权统一"不存在"口径）
    AiDocGetTool,
    // R101-AI-36：取消销售单 SO/SB（写工具；高危 + source:'ai' + 业务键幂等）
    CancelSalesOrderTool,
    // R101-AI-35 S2：文档中心写工具（aiDocArchive；canAdmin + 重复归档回放）
    AiDocArchiveTool,
    // R101-AI-35 S2：文档中心读工具（aiDocSearch；结构化检索，必经 ACL）
    AiDocSearchTool,
    // R101-AI-37 步骤 3：待办读工具
    AiTodoListTool,
    // R101-AI-37 步骤 3：待办写工具
    AiTodoCreateTool,
    AiTodoUpdateTool,
    AiTodoCompleteTool,
    // R101-AI-38 办公批次 3：审批决策（通过/驳回）
    AiApprovalApproveTool,
    AiApprovalRejectTool,
    AiApprovalCreateTool,
    AiApprovalListTool,
    AiApprovalCancelTool,
    AiApprovalUpdateTool,
    AiScheduleListTool,
    AiScheduleCreateTool,
    AiScheduleUpdateTool,
    AiScheduleCompleteTool,
    AiScheduleCancelTool,
    AiNoticeListTool,
    AiNoticeMarkReadTool,
    AiNoticeArchiveTool,
    AiNoticeUnreadCountTool,
    AiTodoCancelTool,
    AiApprovalDraftDiscardTool,
    // R101-AI-35 S2：文档 ACL 判定服务（独立可单测；依赖 AiDocEntity/AiAclEntity 仓储，
    // 与 IdempotencyGateService 同范式在本模块提供 ⇒ 无需跨模块导出）
    OfficeAclService,
    // R101-AI-35 S3：文档↔RAG 贯通服务（见文件顶部 import 处说明：不动 RagModule 的精确契约）
    DocRagService,
    TextSplitterService,
    DispatchEmployeeTaskTool,
    CircuitBreakerService,
    ToolBootstrap,
    // R70-14: 智能价格填充引擎（可复用服务）
    PriceEngineService,
    UnitConverterService,
    // R70-09: 销售管理 7 个工具
    SearchCustomerTool,
    SearchProductTool,
    CreateProductTool,
    CheckInventoryTool,
    CreateSalesOrderTool,
    QuerySaleBillsTool,
    GetSaleBillDetailTool,
    CancelOrderTool,
    // R70 完善度 P1: 取消采购单（写操作 + 自动回滚执行工具）
    CancelPurchaseOrderTool,
    ToolGeneratorService,
    // R70-10: 库存管理 3 个工具
    InventoryTransferTool,
    StockCheckTool,
    QueryInventoryTool,
    // R70-11: 商品管理 + 客户管理 4 个工具
    UpdateProductPriceTool,
    QueryProductDetailTool,
    CreateCustomerTool,
    QueryCustomerDetailTool,
    // R70-12: 采购管理 + 配送管理 4 个工具
    CreatePurchaseOrderTool,
    QueryPurchaseOrdersTool,
    QueryDeliveryStatusTool,
    CreateDeliveryTool,
    // R70-13: 财务管理 + 报表分析 8 个工具
    QueryReceivablesTool,
    QueryPayablesTool,
    CreateSalesReturnTool,
    CreateRefundTool,
    CreatePaymentReconciliationTool,
    SalesReportTool,
    InventoryReportTool,
    ProfitReportTool,
    // R70 完善度 P1: 营销/采购计划/信用 6 个精调写操作工具
    CreateCouponTemplateTool,
    SetCouponStatusTool,
    CreateFlashSaleTool,
    CreatePurchasePlanTool,
    ConvertPurchasePlanTool,
    AdjustCreditLimitTool,
    // R70 完善度 P1: 营销/采购/费用 8 个精调写操作工具
    CreateFullReductionTool,
    CreateGroupBuyTool,
    CreateGiftRuleTool,
    SetMarketingActivityStatusTool,
    CreatePurchasePaymentTool,
    CreatePurchaseReturnTool,
    CreatePurchaseContractTool,
    CreateExpenseTool,
    // R70 完善度 P1: 客户/佣金/催收/限量折扣 6 个精调写操作工具
    CreateCustomerSegmentTool,
    ExecuteCareRuleTool,
    CreateCustomerVisitTool,
    CalculateCommissionTool,
    AutoGenerateCollectionsTool,
    CreateLimitedDiscountTool,
    // R70 完善度 P1: 审批处理（高危）
    HandleApprovalTool,
    // R70 完善度 P1: 总平台级写操作（scope=platform）
    CreatePlatformAnnouncementTool,
    HandleSubscriptionApplyTool,
  ],
  exports: [
    ToolRegistry,
    ToolExecutor,
    CircuitBreakerService,
    ToolGeneratorService,
  ],
})
export class ToolsModule {}
