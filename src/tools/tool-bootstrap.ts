import { Injectable, OnModuleInit } from '@nestjs/common';
import { ToolRegistry } from './tool-registry';
import { SearchCustomerTool } from './definitions/search-customer.tool';
import { SearchProductTool } from './definitions/search-product.tool';
import { CreateProductTool } from './definitions/create-product.tool';
import { CheckInventoryTool } from './definitions/check-inventory.tool';
import { CreateSalesOrderTool } from './definitions/create-sales-order.tool';
import { QuerySaleBillsTool } from './definitions/query-sale-bills.tool';
import { GetSaleBillDetailTool } from './definitions/get-sale-bill-detail.tool';
import { CancelOrderTool } from './definitions/cancel-order.tool';
import { CancelPurchaseOrderTool } from './definitions/cancel-purchase-order.tool';
import { InventoryTransferTool } from './definitions/inventory-transfer.tool';
import { StockCheckTool } from './definitions/stock-check.tool';
import { QueryInventoryTool } from './definitions/query-inventory.tool';
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
import { ToolGeneratorService } from './catalog/tool-generator.service';

/**
 * Tool 注册引导器
 *
 * 职责：在 NestJS 模块初始化阶段，将所有 ITool 实现集中注册到 ToolRegistry。
 *
 * 设计理由：
 * - ToolRegistry 保持纯粹（只负责存储/查询/生成定义），不依赖具体工具实现
 * - ToolBootstrap 集中管理工具注册，后续新增工具只需在此处注入并 registerAll
 * - 利用 NestJS OnModuleInit 生命周期，确保工具在服务接收请求前完成注册
 *
 * 已注册工具（R70-09）：
 * - echo：回显测试工具（utility）
 * - searchCustomer：搜索客户（customer）
 * - searchProduct：搜索商品（product）
 * - checkInventory：查询库存（inventory）
 * - createSalesOrder：创建销售单（order，写操作）
 * - querySaleBills：查询销售单列表（order）
 * - getSaleBillDetail：查询销售单详情（order）
 * - cancelOrder：取消订单（order，写操作）
 *
 * R70-10 新增（库存管理）：
 * - inventoryTransfer：库存调拨（inventory，写操作+预览）
 * - stockCheck：库存盘点（inventory，写操作+预览）
 * - queryInventory：查询库存汇总（inventory，按仓库/分类维度）
 *
 * R70-11 新增（商品管理 + 客户管理）：
 * - updateProductPrice：更新商品SKU价格（product，写操作+预览）
 * - queryProductDetail：查询商品详情（product，含SKU明细与价格）
 * - createCustomer：创建客户（customer，写操作+预览）
 * - queryCustomerDetail：查询客户详情（customer，含类型/等级/欠款）
 *
 * 注意：本 provider 不被任何模块 export，仅用于触发注册副作用，
 * 必须在 ToolsModule.providers 中声明才能生效。
 */
@Injectable()
export class ToolBootstrap implements OnModuleInit {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly searchCustomerTool: SearchCustomerTool,
    private readonly searchProductTool: SearchProductTool,
    private readonly createProductTool: CreateProductTool,
    private readonly checkInventoryTool: CheckInventoryTool,
    private readonly createSalesOrderTool: CreateSalesOrderTool,
    private readonly querySaleBillsTool: QuerySaleBillsTool,
    private readonly getSaleBillDetailTool: GetSaleBillDetailTool,
    private readonly cancelOrderTool: CancelOrderTool,
    private readonly cancelPurchaseOrderTool: CancelPurchaseOrderTool,
    private readonly inventoryTransferTool: InventoryTransferTool,
    private readonly stockCheckTool: StockCheckTool,
    private readonly queryInventoryTool: QueryInventoryTool,
    // R70-11: 商品管理 + 客户管理 4 个工具
    private readonly updateProductPriceTool: UpdateProductPriceTool,
    private readonly queryProductDetailTool: QueryProductDetailTool,
    private readonly createCustomerTool: CreateCustomerTool,
    private readonly queryCustomerDetailTool: QueryCustomerDetailTool,
    // R70-12: 采购管理 + 配送管理 4 个工具
    private readonly createPurchaseOrderTool: CreatePurchaseOrderTool,
    private readonly queryPurchaseOrdersTool: QueryPurchaseOrdersTool,
    private readonly queryDeliveryStatusTool: QueryDeliveryStatusTool,
    private readonly createDeliveryTool: CreateDeliveryTool,
    // R70-13: 财务管理 + 报表分析 8 个工具
    private readonly queryReceivablesTool: QueryReceivablesTool,
    private readonly queryPayablesTool: QueryPayablesTool,
    private readonly createSalesReturnTool: CreateSalesReturnTool,
    private readonly createRefundTool: CreateRefundTool,
    private readonly createPaymentReconciliationTool: CreatePaymentReconciliationTool,
    private readonly salesReportTool: SalesReportTool,
    private readonly inventoryReportTool: InventoryReportTool,
    private readonly profitReportTool: ProfitReportTool,
    private readonly createCouponTemplateTool: CreateCouponTemplateTool,
    private readonly setCouponStatusTool: SetCouponStatusTool,
    private readonly createFlashSaleTool: CreateFlashSaleTool,
    private readonly createPurchasePlanTool: CreatePurchasePlanTool,
    private readonly convertPurchasePlanTool: ConvertPurchasePlanTool,
    private readonly adjustCreditLimitTool: AdjustCreditLimitTool,
    private readonly createFullReductionTool: CreateFullReductionTool,
    private readonly createGroupBuyTool: CreateGroupBuyTool,
    private readonly createGiftRuleTool: CreateGiftRuleTool,
    private readonly setMarketingActivityStatusTool: SetMarketingActivityStatusTool,
    private readonly createPurchasePaymentTool: CreatePurchasePaymentTool,
    private readonly createPurchaseReturnTool: CreatePurchaseReturnTool,
    private readonly createPurchaseContractTool: CreatePurchaseContractTool,
    private readonly createExpenseTool: CreateExpenseTool,
    private readonly createCustomerSegmentTool: CreateCustomerSegmentTool,
    private readonly executeCareRuleTool: ExecuteCareRuleTool,
    private readonly createCustomerVisitTool: CreateCustomerVisitTool,
    private readonly calculateCommissionTool: CalculateCommissionTool,
    private readonly autoGenerateCollectionsTool: AutoGenerateCollectionsTool,
    private readonly createLimitedDiscountTool: CreateLimitedDiscountTool,
    private readonly handleApprovalTool: HandleApprovalTool,
    private readonly createPlatformAnnouncementTool: CreatePlatformAnnouncementTool,
    private readonly handleSubscriptionApplyTool: HandleSubscriptionApplyTool,
    private readonly toolGenerator: ToolGeneratorService,
  ) {}

  onModuleInit(): void {
    // 集中注册所有工具（2026-09-05：移除 echo 测试工具，不再进入生产注册表与工具数口径）
    this.registry.registerAll([
      // R70-09: 销售管理 7 个工具
      this.searchCustomerTool,
      this.searchProductTool,
      this.createProductTool,
      this.checkInventoryTool,
      this.createSalesOrderTool,
      this.querySaleBillsTool,
      this.getSaleBillDetailTool,
      this.cancelOrderTool,
      // R70 完善度 P1: 取消采购单（自动回滚执行工具）
      this.cancelPurchaseOrderTool,
      // R70-10: 库存管理 3 个工具
      this.inventoryTransferTool,
      this.stockCheckTool,
      this.queryInventoryTool,
      // R70-11: 商品管理 + 客户管理 4 个工具
      this.updateProductPriceTool,
      this.queryProductDetailTool,
      this.createCustomerTool,
      this.queryCustomerDetailTool,
      // R70-12: 采购管理 + 配送管理 4 个工具
      this.createPurchaseOrderTool,
      this.queryPurchaseOrdersTool,
      this.queryDeliveryStatusTool,
      this.createDeliveryTool,
      // R70-13: 财务管理 + 报表分析 8 个工具
      this.queryReceivablesTool,
      this.queryPayablesTool,
      this.createSalesReturnTool,
      this.createRefundTool,
      this.createPaymentReconciliationTool,
      this.salesReportTool,
      this.inventoryReportTool,
      this.profitReportTool,
      // R70 完善度 P1: 营销/采购计划/信用 6 个精调写操作工具
      this.createCouponTemplateTool,
      this.setCouponStatusTool,
      this.createFlashSaleTool,
      this.createPurchasePlanTool,
      this.convertPurchasePlanTool,
      this.adjustCreditLimitTool,
      // R70 完善度 P1: 营销/采购/费用 8 个精调写操作工具
      this.createFullReductionTool,
      this.createGroupBuyTool,
      this.createGiftRuleTool,
      this.setMarketingActivityStatusTool,
      this.createPurchasePaymentTool,
      this.createPurchaseReturnTool,
      this.createPurchaseContractTool,
      this.createExpenseTool,
      // R70 完善度 P1: 客户/佣金/催收/限量折扣 6 个精调写操作工具
      this.createCustomerSegmentTool,
      this.executeCareRuleTool,
      this.createCustomerVisitTool,
      this.calculateCommissionTool,
      this.autoGenerateCollectionsTool,
      this.createLimitedDiscountTool,
      // R70 完善度 P1: 审批处理（高危）
      this.handleApprovalTool,
      // R70 完善度 P1: 总平台级写操作（scope=platform）
      this.createPlatformAnnouncementTool,
      this.handleSubscriptionApplyTool,
    ]);

    // P0-8 功能即技能：开关开启时自动注册 API 目录工具（总台注册表 → AI 技能）
    if (this.toolGenerator.isEnabled()) {
      this.toolGenerator.generateAndRegister(this.registry);
    }
  }
}
