import { Module } from '@nestjs/common';
import { ToolRegistry } from './tool-registry';
import { ToolExecutor } from './tool-executor';
import { ToolBootstrap } from './tool-bootstrap';
// R70-14: 智能价格填充引擎（可复用服务）
import { PriceEngineService } from './price-engine.service';
import { UnitConverterService } from './unit-converter.service';
import { EchoTool } from './definitions/echo.tool';
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
 * - EchoTool：回显测试工具（utility）
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
  imports: [BridgeModule, CommonModule],
  providers: [
    ToolRegistry,
    ToolExecutor,
    CircuitBreakerService,
    ToolBootstrap,
    // R70-14: 智能价格填充引擎（可复用服务）
    PriceEngineService,
    UnitConverterService,
    EchoTool,
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
