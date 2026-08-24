/**
 * 总台注册表 → AI 工具目录（完善度 P0-8「功能即技能」）
 *
 * 说明：
 * 管理系统后端（Express 8080）的真实 API 端点清单（来源 backend/src/routes/*.routes.ts
 * 与 ServiceClient.API_ENDPOINTS 映射），以结构化目录形式供 ToolGeneratorService
 * 半自动生成 AI 工具——新增后端 API 只需在此登记一条目录即可成为 AI 技能。
 *
 * 命名约定：工具名 api_ 前缀（如 api_query_sale_bills），与现有业务工具（如 searchProduct）
 * 区分；查询类 low 风险，写操作类按实际标注 medium/high。
 */
import { ToolCategory, ToolRisk, ToolScope } from '../tool.interface';

/** API 路由定义（注册表条目） */
export interface ApiRouteDef {
  /** 工具名（api_ 前缀，唯一） */
  name: string;
  /** 工具描述（给 LLM 的用途/前置/出参说明） */
  description: string;
  /** 业务域分类 */
  category: ToolCategory;
  /** HTTP 方法 */
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** 端点路径（{param} 占位符从入参替换） */
  path: string;
  /** 参数 JSON Schema */
  parameters: object;
  /** 是否写操作 */
  isWriteOperation: boolean;
  /** 风险分级 */
  risk: ToolRisk;
  /** 强制人工审核 */
  needsReview?: boolean;
  /** 工具作用域（可选，默认 mgmt；platform 仅总台对话暴露） */
  scope?: ToolScope;
}

/**
 * 管理系统 API 目录（总台注册表映射）
 *
 * 初始覆盖高频查询端点（low 风险）；写操作与运营域端点按需登记扩展。
 */
export const API_CATALOG: ApiRouteDef[] = [
  {
    name: 'api_query_sale_bills',
    description:
      '查询销售单列表。入参：customerName(客户名,可选)、status(状态,可选)、page(页码,可选)、pageSize(每页条数,可选)。出参：销售单列表。',
    category: 'order',
    method: 'GET',
    path: '/api/admin/sale-bills',
    parameters: {
      type: 'object',
      properties: {
        customerName: { type: 'string', description: '客户名称（可选）' },
        status: { type: 'string', description: '单据状态（可选）' },
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_query_orders',
    description:
      '查询订单列表。入参：customerName、status、page、pageSize。出参：订单列表。',
    category: 'order',
    method: 'GET',
    path: '/api/admin/orders',
    parameters: {
      type: 'object',
      properties: {
        customerName: { type: 'string', description: '客户名称（可选）' },
        status: { type: 'string', description: '订单状态（可选）' },
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_query_products',
    description:
      '查询商品列表。入参：keyword(关键词,可选)、categoryId(分类,可选)、page、pageSize。出参：商品列表。',
    category: 'product',
    method: 'GET',
    path: '/api/admin/products',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '商品关键词（可选）' },
        categoryId: { type: 'number', description: '分类ID（可选）' },
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_query_members',
    description:
      '查询客户/会员列表。入参：name(客户名,可选)、customerType(类型,可选)、page、pageSize。出参：客户列表。',
    category: 'customer',
    method: 'GET',
    path: '/api/admin/members',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '客户名称（可选）' },
        customerType: {
          type: 'string',
          description: '客户类型：retail/wholesale（可选）',
        },
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_query_suppliers',
    description:
      '查询供应商列表。入参：name、page、pageSize。出参：供应商列表。',
    category: 'purchase',
    method: 'GET',
    path: '/api/admin/suppliers',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '供应商名称（可选）' },
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_query_purchase_orders',
    description:
      '查询采购单列表。入参：supplierName、status、page、pageSize。出参：采购单列表。',
    category: 'purchase',
    method: 'GET',
    path: '/api/admin/purchase-orders',
    parameters: {
      type: 'object',
      properties: {
        supplierName: { type: 'string', description: '供应商名称（可选）' },
        status: { type: 'string', description: '单据状态（可选）' },
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_query_inventory',
    description:
      '查询库存列表。入参：productName(商品名,可选)、warehouseId(仓库,可选)、page、pageSize。出参：库存列表。',
    category: 'inventory',
    method: 'GET',
    path: '/api/admin/inventory-balance',
    parameters: {
      type: 'object',
      properties: {
        productName: { type: 'string', description: '商品名称（可选）' },
        warehouseId: { type: 'number', description: '仓库ID（可选）' },
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_query_receivables',
    description:
      '查询应收账款列表。入参：customerName(客户名,可选)。出参：应收列表。',
    category: 'finance',
    method: 'GET',
    path: '/api/admin/receivables',
    parameters: {
      type: 'object',
      properties: {
        customerName: { type: 'string', description: '客户名称（可选）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_query_reports',
    description:
      '查询经营报表。入参：period(周期,可选：day/week/month)、start、end。出参：报表数据。',
    category: 'report',
    method: 'GET',
    path: '/api/admin/reports',
    parameters: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          description: '统计周期：day/week/month（可选）',
        },
        start: { type: 'string', description: '开始日期（可选）' },
        end: { type: 'string', description: '结束日期（可选）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_get_dashboard',
    description:
      '获取工作台经营概览数据（今日销售/订单/库存预警等）。无入参。出参：概览数据。',
    category: 'report',
    method: 'GET',
    path: '/api/admin/dashboard',
    parameters: { type: 'object', properties: {} },
    isWriteOperation: false,
    risk: 'low',
  },
  // ── 第一批 P0 查询类（营销域，2026-08-16 清单 #1/#4/#6/#8/#16） ──
  {
    name: 'api_query_coupon_templates',
    description:
      '查询优惠券模板列表。入参：status(状态,可选)、page(页码,可选)、pageSize(每页条数,可选)。出参：优惠券模板列表。',
    category: 'marketing',
    method: 'GET',
    path: '/api/admin/marketing/coupons/templates',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: '模板状态（可选）' },
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_query_flash_sales',
    description:
      '查询秒杀活动列表。入参：status(状态,可选)、page、pageSize。出参：秒杀活动列表。',
    category: 'marketing',
    method: 'GET',
    path: '/api/admin/marketing/flash-sales',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: '活动状态（可选）' },
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_query_full_reductions',
    description:
      '查询满减活动列表。入参：status(状态,可选)、page、pageSize。出参：满减活动列表。',
    category: 'marketing',
    method: 'GET',
    path: '/api/admin/marketing/full-reductions',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: '活动状态（可选）' },
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_query_group_buys',
    description:
      '查询拼团活动列表。入参：status(状态,可选)、page、pageSize。出参：拼团活动列表。',
    category: 'marketing',
    method: 'GET',
    path: '/api/admin/marketing/group-buys',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: '活动状态（可选）' },
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_query_marketing_overview',
    description:
      '获取营销总览数据（活动数/参与人次/营销金额等）。无入参。出参：营销总览。',
    category: 'marketing',
    method: 'GET',
    path: '/api/admin/marketing/dashboard/overview',
    parameters: { type: 'object', properties: {} },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_calculate_promotion',
    description:
      '促销计算器：按商品与活动规则计算优惠金额。入参：items(商品明细)、activityType(活动类型)、rules(规则参数)。出参：优惠计算结果。',
    category: 'marketing',
    method: 'POST',
    path: '/api/admin/marketing/calculate',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: '商品明细（skuId/数量/单价）',
          items: { type: 'object' },
        },
        activityType: { type: 'string', description: '活动类型' },
        rules: { type: 'object', description: '活动规则参数' },
      },
      required: ['items'],
    },
    isWriteOperation: false,
    risk: 'low',
  },
  // ── 第一批 P0 查询类（采购供应链域，清单 #18/#21/#22/#24） ──
  {
    name: 'api_suggest_purchase_plan',
    description:
      '获取智能补货建议（按库存/销量/在途计算建议采购量）。入参：storeId(门店,可选)、categoryId(分类,可选)。出参：补货建议清单。',
    category: 'purchase',
    method: 'GET',
    path: '/api/admin/purchase-plans/suggest',
    parameters: {
      type: 'object',
      properties: {
        storeId: { type: 'number', description: '门店ID（可选）' },
        categoryId: { type: 'number', description: '商品分类ID（可选）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_query_purchase_plans',
    description:
      '查询采购计划列表。入参：status(状态,可选)、page、pageSize。出参：采购计划列表。',
    category: 'purchase',
    method: 'GET',
    path: '/api/admin/purchase-plans',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: '计划状态（可选）' },
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_query_purchase_payments',
    description:
      '查询采购付款单列表。入参：supplierName(供应商,可选)、status(状态,可选)、page、pageSize。出参：付款单列表。',
    category: 'purchase',
    method: 'GET',
    path: '/api/admin/purchase-payments',
    parameters: {
      type: 'object',
      properties: {
        supplierName: { type: 'string', description: '供应商名称（可选）' },
        status: { type: 'string', description: '单据状态（可选）' },
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_query_purchase_returns',
    description:
      '查询采购退货单列表。入参：supplierName(供应商,可选)、status(状态,可选)、page、pageSize。出参：退货单列表。',
    category: 'purchase',
    method: 'GET',
    path: '/api/admin/purchase-returns',
    parameters: {
      type: 'object',
      properties: {
        supplierName: { type: 'string', description: '供应商名称（可选）' },
        status: { type: 'string', description: '单据状态（可选）' },
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  // ── 第一批 P0 查询类（客户深度域，清单 #28/#30/#32/#34/#36） ──
  {
    name: 'api_query_customer_segments',
    description: '查询客户分群列表。入参：page、pageSize。出参：客户分群列表。',
    category: 'customer',
    method: 'GET',
    path: '/api/admin/members/segments',
    parameters: {
      type: 'object',
      properties: {
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_query_care_rules',
    description:
      '查询客户关怀规则列表。入参：enabled(是否启用,可选)、page、pageSize。出参：关怀规则列表。',
    category: 'customer',
    method: 'GET',
    path: '/api/admin/members/care/rules',
    parameters: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: '是否启用（可选）' },
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_query_customer_visits',
    description:
      '查询客户拜访记录列表。入参：customerId(客户ID,可选)、status(状态,可选)、page、pageSize。出参：拜访记录列表。',
    category: 'customer',
    method: 'GET',
    path: '/api/admin/customer-visits',
    parameters: {
      type: 'object',
      properties: {
        customerId: { type: 'number', description: '客户ID（可选）' },
        status: { type: 'string', description: '拜访状态（可选）' },
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_query_credit_list',
    description:
      '查询客户信用额度列表。入参：keyword(客户名/编码,可选)、page、pageSize。出参：信用额度列表。',
    category: 'customer',
    method: 'GET',
    path: '/api/admin/credits',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '客户名称或编码（可选）' },
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_query_overdue_collections',
    description:
      '查询逾期催收客户列表。入参：days(逾期天数,可选)、page、pageSize。出参：逾期客户列表。',
    category: 'customer',
    method: 'GET',
    path: '/api/admin/credits/collections/overdue',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'number', description: '逾期天数阈值（可选）' },
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  // ── 第一批 P0 查询类（财务域，清单 #38/#42/#43） ──
  {
    name: 'api_query_expenses',
    description:
      '查询费用单列表。入参：status(状态,可选)、category(类别,可选)、page、pageSize。出参：费用单列表。',
    category: 'finance',
    method: 'GET',
    path: '/api/admin/expenses',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: '单据状态（可选）' },
        category: { type: 'string', description: '费用类别（可选）' },
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_query_reconciliation',
    description:
      '查询客户对账单。入参：customerId(客户ID,可选)、period(账期,可选)。出参：对账单数据。',
    category: 'finance',
    method: 'GET',
    path: '/api/admin/reconciliation/customer',
    parameters: {
      type: 'object',
      properties: {
        customerId: { type: 'number', description: '客户ID（可选）' },
        period: { type: 'string', description: '账期（可选）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_query_receivable_aging',
    description:
      '查询应收账龄分析（按账期分布应收余额）。入参：customerId(客户ID,可选)。出参：账龄分布数据。',
    category: 'finance',
    method: 'GET',
    path: '/api/admin/receivables/aging',
    parameters: {
      type: 'object',
      properties: {
        customerId: { type: 'number', description: '客户ID（可选）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  // ── 第一批 P0 查询类（报表/仪表盘域，清单 #44/#45/#46/#47/#48/#49） ──
  {
    name: 'api_get_business_overview',
    description:
      '获取经营总览（销售/毛利/订单/客单等核心指标）。入参：start(开始日期,可选)、end(结束日期,可选)。出参：经营指标。',
    category: 'report',
    method: 'GET',
    path: '/api/admin/reports/business-overview',
    parameters: {
      type: 'object',
      properties: {
        start: { type: 'string', description: '开始日期（可选）' },
        end: { type: 'string', description: '结束日期（可选）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_get_sales_ranking',
    description:
      '获取商品销售排行。入参：start、end、limit(条数,可选)。出参：销售排行列表。',
    category: 'report',
    method: 'GET',
    path: '/api/admin/reports/sales-ranking',
    parameters: {
      type: 'object',
      properties: {
        start: { type: 'string', description: '开始日期（可选）' },
        end: { type: 'string', description: '结束日期（可选）' },
        limit: { type: 'number', description: '返回条数（默认 10）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_get_sales_trend',
    description:
      '获取销售趋势。入参：period(日/周/月,可选)、start、end。出参：趋势数据。',
    category: 'report',
    method: 'GET',
    path: '/api/admin/reports/sales-trend',
    parameters: {
      type: 'object',
      properties: {
        period: { type: 'string', description: '统计周期（可选）' },
        start: { type: 'string', description: '开始日期（可选）' },
        end: { type: 'string', description: '结束日期（可选）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_get_customer_rfm',
    description:
      '获取客户 RFM 分析（最近消费/频次/金额分层）。入参：page、pageSize。出参：RFM 分层列表。',
    category: 'report',
    method: 'GET',
    path: '/api/admin/reports/customer/rfm',
    parameters: {
      type: 'object',
      properties: {
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_get_inventory_turnover',
    description:
      '获取库存周转分析。入参：storeId(门店,可选)、page、pageSize。出参：周转数据。',
    category: 'report',
    method: 'GET',
    path: '/api/admin/reports/inventory-turnover',
    parameters: {
      type: 'object',
      properties: {
        storeId: { type: 'number', description: '门店ID（可选）' },
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_get_dashboard_overview',
    description:
      '获取工作台首页概览（销售额/订单数/库存预警/待办等）。无入参。出参：概览数据。',
    category: 'report',
    method: 'GET',
    path: '/api/admin/dashboard/overview',
    parameters: { type: 'object', properties: {} },
    isWriteOperation: false,
    risk: 'low',
  },
  // ── 第二批查询类（库存深度/审批/异常，2026-08-16 清单 #52~#62） ──
  {
    name: 'api_query_inventory_batches',
    description:
      '查询库存批次列表（批次号/生产日期/到期日/数量）。入参：skuId(可选)、storeId(可选)、status(可选)、page、pageSize。出参：批次列表。',
    category: 'inventory',
    method: 'GET',
    path: '/api/admin/inventory-batch/batches',
    parameters: {
      type: 'object',
      properties: {
        skuId: { type: 'number', description: 'SKU ID（可选）' },
        storeId: { type: 'number', description: '门店ID（可选）' },
        status: { type: 'string', description: '批次状态（可选）' },
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_query_expiry_alerts',
    description:
      '查询库存到期预警列表（临期商品批次）。入参：storeId(可选)、page、pageSize。出参：到期预警列表。',
    category: 'inventory',
    method: 'GET',
    path: '/api/admin/inventory-batch/expiry-alerts',
    parameters: {
      type: 'object',
      properties: {
        storeId: { type: 'number', description: '门店ID（可选）' },
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_query_inventory_cost',
    description:
      '查询库存成本详情。入参：startDate(开始日期,可选)、endDate(结束日期,可选)。出参：成本数据。',
    category: 'inventory',
    method: 'GET',
    path: '/api/admin/inventory/cost-detail',
    parameters: {
      type: 'object',
      properties: {
        startDate: { type: 'string', description: '开始日期（可选）' },
        endDate: { type: 'string', description: '结束日期（可选）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_query_inventory_loss_gains',
    description:
      '查询库存损溢记录（报损/报溢）。入参：storeId(可选)、type(可选)、page、pageSize。出参：损溢记录列表。',
    category: 'inventory',
    method: 'GET',
    path: '/api/admin/inventory/loss-gains',
    parameters: {
      type: 'object',
      properties: {
        storeId: { type: 'number', description: '门店ID（可选）' },
        type: { type: 'string', description: '损溢类型（可选）' },
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_query_inventory_profit_loss',
    description:
      '查询库存盈亏统计（损耗单/盈利单汇总）。入参：storeId(可选)、startDate/endDate(可选)。出参：盈亏统计。',
    category: 'inventory',
    method: 'GET',
    path: '/api/admin/inventory/profit-loss/stats',
    parameters: {
      type: 'object',
      properties: {
        storeId: { type: 'number', description: '门店ID（可选）' },
        startDate: { type: 'string', description: '开始日期（可选）' },
        endDate: { type: 'string', description: '结束日期（可选）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_query_stock_warnings',
    description:
      '查询库存预警列表（低于安全库存/高于库存上限）。入参：storeId(可选)。出参：预警商品列表。',
    category: 'inventory',
    method: 'GET',
    path: '/api/admin/stock-warnings',
    parameters: {
      type: 'object',
      properties: {
        storeId: { type: 'number', description: '门店ID（可选）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_query_inventory_share_products',
    description:
      '查询共享库存商品列表。入参：keyword(商品名,可选)、categoryId(分类,可选)、status(可选)、page、pageSize。出参：共享商品列表。',
    category: 'inventory',
    method: 'GET',
    path: '/api/admin/inventory-share/products',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '商品关键词（可选）' },
        categoryId: { type: 'number', description: '分类ID（可选）' },
        status: { type: 'number', description: '状态（可选）' },
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_query_order_exceptions',
    description:
      '查询订单异常列表（支付异常/超时未处理等）。入参：status(可选)、page、pageSize。出参：异常订单列表。',
    category: 'order',
    method: 'GET',
    path: '/api/admin/order-exceptions',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: '异常状态（可选）' },
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_query_order_timeouts',
    description:
      '查询订单超时处理日志。入参：page、pageSize。出参：超时日志列表。',
    category: 'order',
    method: 'GET',
    path: '/api/admin/order-timeout/logs',
    parameters: {
      type: 'object',
      properties: {
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_query_approval_tasks',
    description:
      '查询我的审批任务（待办）。入参：page、pageSize。出参：审批任务列表。',
    category: 'system',
    method: 'GET',
    path: '/api/admin/approval/tasks',
    parameters: {
      type: 'object',
      properties: {
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_query_approval_instances',
    description:
      '查询审批实例列表（我发起的/全部）。入参：page、pageSize。出参：审批实例列表。',
    category: 'system',
    method: 'GET',
    path: '/api/admin/approval/instances',
    parameters: {
      type: 'object',
      properties: {
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  {
    name: 'api_query_operation_logs',
    description:
      '查询操作日志列表。入参：module(模块,可选)、action(动作,可选)、page、pageSize。出参：操作日志列表。',
    category: 'system',
    method: 'GET',
    path: '/api/admin/operation-logs',
    parameters: {
      type: 'object',
      properties: {
        module: { type: 'string', description: '模块（可选）' },
        action: { type: 'string', description: '动作（可选）' },
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
  },
  // ── 第三批查询类（总平台级，仅 scope=platform 总台对话暴露，不给租户用） ──
  {
    name: 'api_platform_query_tenants',
    description:
      '查询平台租户列表（总台）。入参：keyword(租户名,可选)、status(状态,可选)、page、pageSize。出参：租户列表。',
    category: 'platform',
    method: 'GET',
    path: '/api/platform/tenants',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '租户名称关键词（可选）' },
        status: { type: 'string', description: '租户状态（可选）' },
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
    scope: 'platform',
  },
  {
    name: 'api_platform_tenant_detail',
    description:
      '查询平台租户详情（总台）。入参：id(租户ID,必填)。出参：租户详情。',
    category: 'platform',
    method: 'GET',
    path: '/api/platform/tenants/{id}',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'number', description: '租户ID（必填）' },
      },
      required: ['id'],
    },
    isWriteOperation: false,
    risk: 'low',
    scope: 'platform',
  },
  {
    name: 'api_platform_query_announcements',
    description:
      '查询平台公告列表（总台）。入参：type(类型,可选)、status(状态,可选)、page、pageSize。出参：公告列表。',
    category: 'platform',
    method: 'GET',
    path: '/api/platform/announcements',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', description: '公告类型（可选）' },
        status: { type: 'number', description: '状态（可选）' },
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
    scope: 'platform',
  },
  {
    name: 'api_platform_query_subscription_applies',
    description:
      '查询平台订阅申请列表（总台）。入参：status(状态,可选)、page、pageSize。出参：申请列表。',
    category: 'platform',
    method: 'GET',
    path: '/api/platform/subscription-applies',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: '申请状态（可选）' },
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
    scope: 'platform',
  },
  {
    name: 'api_platform_query_settlements',
    description:
      '查询平台结算单列表（总台）。入参：page、pageSize。出参：结算单列表。',
    category: 'platform',
    method: 'GET',
    path: '/api/platform/settlements',
    parameters: {
      type: 'object',
      properties: {
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
    scope: 'platform',
  },
  {
    name: 'api_platform_query_audit_logs',
    description:
      '查询平台审计日志列表（总台）。入参：page、pageSize。出参：审计日志列表。',
    category: 'platform',
    method: 'GET',
    path: '/api/platform/audit-logs',
    parameters: {
      type: 'object',
      properties: {
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
    scope: 'platform',
  },
  {
    name: 'api_platform_query_error_logs',
    description:
      '查询平台错误日志列表（总台）。入参：page、pageSize。出参：错误日志列表。',
    category: 'platform',
    method: 'GET',
    path: '/api/platform/error-logs',
    parameters: {
      type: 'object',
      properties: {
        page: { type: 'number', description: '页码（默认 1）' },
        pageSize: { type: 'number', description: '每页条数（默认 20）' },
      },
    },
    isWriteOperation: false,
    risk: 'low',
    scope: 'platform',
  },
  {
    name: 'api_platform_query_monitor',
    description:
      '查询平台运行监控统计（总台）：服务状态/数据库/API 统计。无入参。出参：监控数据。',
    category: 'platform',
    method: 'GET',
    path: '/api/platform/monitor',
    parameters: { type: 'object', properties: {} },
    isWriteOperation: false,
    risk: 'low',
    scope: 'platform',
  },
  {
    name: 'api_platform_query_config',
    description:
      '查询平台配置（总台）：基础配置/系统配置。无入参。出参：配置数据。',
    category: 'platform',
    method: 'GET',
    path: '/api/platform/config',
    parameters: { type: 'object', properties: {} },
    isWriteOperation: false,
    risk: 'low',
    scope: 'platform',
  },
];
