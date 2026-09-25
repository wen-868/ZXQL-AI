# 管理系统 AI 技能化落地清单

> 制定：2026-08-16 ｜ 负责人：凌舟（AI 底座专职）
> 依据：`docs/ai-base/管理系统AI底座完善计划.md`（功能即技能）＋ 后端 `backend/src/routes/*.routes.ts` 真实端点（routeConfig prefix 为准）
> 目标：管理系统全部系统功能逐步封装为 AI 技能；第一档跑通「营销＋供应链＋客户＋财务＋报表」业务闭环后，AI 实用价值上台阶

## 一、实施约束

1. **端点真实**：所有工具端点以 `routeConfig.prefix` 为准（已逐一核对），禁止臆造路径；新增端点需在 `ServiceClient.API_ENDPOINTS` 登记。
2. **第三档仅总平台级**：平台域工具（`requirePlatformAuth`）只在总台场景注册/暴露，**不给租户用**；租户侧不开放平台工具。
3. **写操作安全**：写操作工具带预览确认卡（前端通用机制）；高危（改信用额度/删除/审批类）标注 `risk=high` 并强制人工审核闸。
4. **实施方式**：
   - 查询类（low 风险）：在 `api-catalog.ts` 登记目录即可成为技能（半自动生成），补单测。
   - 写操作类（medium/high）：精调工具（复用 create-sales-order 模式：参数校验→预览→确认→执行→回滚），补单测。
5. **验收标准**：每批完成需通过 ai-base 全量测试＋lint＋build＋启动门禁；主后端测试不回归；e2e 新增对应用例。

## 二、批次与工具清单

### 第一批（第一档：营销＋供应链＋客户＋财务＋报表，租户域）

#### 营销域（前缀 `/api/admin/marketing`）

| # | 工具名 | 端点 | 方法 | 风险 | 写 | 优先级 |
|---|---|---|---|---|---|---|
| 1 | api_query_coupon_templates | /api/admin/marketing/coupons/templates | GET | low | 否 | P0 |
| 2 | api_create_coupon_template | /api/admin/marketing/coupons/templates | POST | medium | 是 | P0 |
| 3 | api_set_coupon_status | /api/admin/marketing/coupons/templates/:id/activate \| /pause | POST | medium | 是 | P1 |
| 4 | api_query_flash_sales | /api/admin/marketing/flash-sales | GET | low | 否 | P0 |
| 5 | api_create_flash_sale | /api/admin/marketing/flash-sales | POST | medium | 是 | P0 |
| 6 | api_query_full_reductions | /api/admin/marketing/full-reductions | GET | low | 否 | P0 |
| 7 | api_create_full_reduction | /api/admin/marketing/full-reductions | POST | medium | 是 | P1 |
| 8 | api_query_group_buys | /api/admin/marketing/group-buys | GET | low | 否 | P0 |
| 9 | api_create_group_buy | /api/admin/marketing/group-buys | POST | medium | 是 | P1 |
| 10 | api_query_limited_discounts | /api/admin/marketing/limited-discounts | GET | low | 否 | P1 |
| 11 | api_create_limited_discount | /api/admin/marketing/limited-discounts | POST | medium | 是 | P1 |
| 12 | api_query_gift_rules | /api/admin/marketing/gift-rules | GET | low | 否 | P1 |
| 13 | api_create_gift_rule | /api/admin/marketing/gift-rules | POST | medium | 是 | P1 |
| 14 | api_set_marketing_activity_status | /api/admin/marketing/{flash-sales\|full-reductions\|group-buys\|limited-discounts}/:id/{activate\|pause} | POST | medium | 是 | P1 |
| 15 | api_calculate_promotion | /api/admin/marketing/calculate | POST | low | 否 | P0 |
| 16 | api_query_marketing_overview | /api/admin/marketing/dashboard/overview | GET | low | 否 | P0 |
| 17 | api_query_marketing_activity_stats | /api/admin/marketing/dashboard/activity-stats/:activityId | GET | low | 否 | P1 |

#### 采购供应链域（前缀 `/api/admin/purchase-*`）

| # | 工具名 | 端点 | 方法 | 风险 | 写 | 优先级 |
|---|---|---|---|---|---|---|
| 18 | api_suggest_purchase_plan | /api/admin/purchase-plans/suggest | GET | low | 否 | P0 |
| 19 | api_create_purchase_plan | /api/admin/purchase-plans | POST | medium | 是 | P0 |
| 20 | api_convert_purchase_plan | /api/admin/purchase-plans/:planNo/convert | POST | medium | 是 | P0 |
| 21 | api_query_purchase_plans | /api/admin/purchase-plans | GET | low | 否 | P0 |
| 22 | api_query_purchase_payments | /api/admin/purchase-payments | GET | low | 否 | P0 |
| 23 | api_create_purchase_payment | /api/admin/purchase-payments | POST | medium | 是 | P1 |
| 24 | api_query_purchase_returns | /api/admin/purchase-returns | GET | low | 否 | P0 |
| 25 | api_create_purchase_return | /api/admin/purchase-returns | POST | medium | 是 | P1 |
| 26 | api_query_purchase_contracts | /api/admin/purchase-contracts | GET | low | 否 | P1 |
| 27 | api_create_purchase_contract | /api/admin/purchase-contracts | POST | medium | 是 | P1 |

#### 客户深度域

| # | 工具名 | 端点 | 方法 | 风险 | 写 | 优先级 |
|---|---|---|---|---|---|---|
| 28 | api_query_customer_segments | /api/admin/members/segments | GET | low | 否 | P0 |
| 29 | api_create_customer_segment | /api/admin/members/segments | POST | medium | 是 | P1 |
| 30 | api_query_care_rules | /api/admin/members/care/rules | GET | low | 否 | P0 |
| 31 | api_execute_care_rule | /api/admin/members/care/rules/:id/execute | POST | medium | 是 | P1 |
| 32 | api_query_customer_visits | /api/admin/customer-visits | GET | low | 否 | P0 |
| 33 | api_create_customer_visit | /api/admin/customer-visits | POST | medium | 是 | P1 |
| 34 | api_query_credit_list | /api/admin/credits | GET | low | 否 | P0 |
| 35 | api_adjust_credit_limit | /api/admin/credits/:customerId/limit | PUT | **high** | 是 | P0（强制审核） |
| 36 | api_query_overdue_collections | /api/admin/credits/collections/overdue | GET | low | 否 | P0 |
| 37 | api_auto_generate_collections | /api/admin/credits/collections/auto-generate | POST | medium | 是 | P1 |

#### 财务域

| # | 工具名 | 端点 | 方法 | 风险 | 写 | 优先级 |
|---|---|---|---|---|---|---|
| 38 | api_query_expenses | /api/admin/expenses | GET | low | 否 | P0 |
| 39 | api_create_expense | /api/admin/expenses | POST | medium | 是 | P1 |
| 40 | api_query_commission_records | /api/admin/commission/records | GET | low | 否 | P1 |
| 41 | api_calculate_commission | /api/admin/commission/calculate | POST | medium | 是 | P1 |
| 42 | api_query_reconciliation | /api/admin/reconciliation/customer | GET | low | 否 | P0 |
| 43 | api_query_receivable_aging | /api/admin/receivables/aging | GET | low | 否 | P0 |

#### 报表/仪表盘域（前缀 `/api/admin/reports`、`/api/admin/dashboard`）

| # | 工具名 | 端点 | 方法 | 风险 | 写 | 优先级 |
|---|---|---|---|---|---|---|
| 44 | api_get_business_overview | /api/admin/reports/business-overview | GET | low | 否 | P0 |
| 45 | api_get_sales_ranking | /api/admin/reports/sales-ranking | GET | low | 否 | P0 |
| 46 | api_get_sales_trend | /api/admin/reports/sales-trend | GET | low | 否 | P0 |
| 47 | api_get_customer_rfm | /api/admin/reports/customer/rfm | GET | low | 否 | P0 |
| 48 | api_get_inventory_turnover | /api/admin/reports/inventory-turnover | GET | low | 否 | P0 |
| 49 | api_get_dashboard_overview | /api/admin/dashboard/overview | GET | low | 否 | P0 |
| 50 | api_execute_custom_report | /api/admin/reports/:id/generate（custom-report-v2） | POST | medium | 是 | P1 |
| 51 | api_export_report | /api/admin/reports/export | POST | medium | 是 | P1 |

### 第二批（第二档：库存深度＋售后/异常＋审批，租户域）

| # | 工具名 | 端点（前缀） | 方法 | 风险 | 写 | 优先级 |
|---|---|---|---|---|---|---|
| 52 | api_query_inventory_batches | /api/admin/inventory-batch | GET | low | 否 | P1 |
| 53 | api_query_inventory_cost | /api/admin/inventory（inventory-cost） | GET | low | 否 | P1 |
| 54 | api_query_inventory_loss_gain | /api/admin/inventory（inventory-loss-gain） | GET | low | 否 | P1 |
| 55 | api_query_inventory_profit_loss | /api/admin/inventory（inventory-profit-loss） | GET | low | 否 | P1 |
| 56 | api_query_stock_warnings | /api/admin/stock-warnings | GET | low | 否 | P0 |
| 57 | api_query_inventory_share | /api/admin/inventory-share | GET | low | 否 | P2 |
| 58 | api_query_order_exceptions | /api/admin（order-exception） | GET | low | 否 | P1 |
| 59 | api_query_order_timeouts | /api/admin/order-timeout | GET | low | 否 | P1 |
| 60 | api_query_approvals | /api/admin/approval | GET | low | 否 | P1 |
| 61 | api_handle_approval | /api/admin/approval（审批动作） | POST | **high** | 是 | P1（强制审核） |
| 62 | api_query_operation_logs | /api/admin/operation-logs | GET | low | 否 | P2 |

### 第三批（第三档：仅总平台级，`requirePlatformAuth`，不给租户用）

| # | 工具名 | 端点 | 方法 | 风险 | 写 | 优先级 |
|---|---|---|---|---|---|---|
| 63 | api_platform_query_tenants | /api/platform/tenants | GET | low | 否 | P0 |
| 64 | api_platform_tenant_detail | /api/platform/tenants/:id | GET | low | 否 | P1 |
| 65 | api_platform_query_announcements | /api/platform/announcements | GET | low | 否 | P1 |
| 66 | api_platform_create_announcement | /api/platform/announcements | POST | medium | 是 | P1 |
| 67 | api_platform_query_subscription_applies | /api/platform/subscription-applies | GET | low | 否 | P1 |
| 68 | api_platform_handle_subscription_apply | /api/platform/subscription-applies（审核动作） | POST | medium | 是 | P1 |
| 69 | api_platform_query_settlements | /api/platform/settlements | GET | low | 否 | P1 |
| 70 | api_platform_query_audit_logs | /api/platform/audit-logs | GET | low | 否 | P1 |
| 71 | api_platform_query_error_logs | /api/platform（platform-error-log） | GET | low | 否 | P2 |
| 72 | api_platform_query_monitor | /api/platform/monitor | GET | low | 否 | P2 |
| 73 | api_platform_query_config | /api/platform/config | GET | low | 否 | P2 |

## 三、实施顺序

1. **第一批 P0（约 26 个，查询类为主）**：先登记 api-catalog 查询类（营销/采购/客户/财务/报表），再精调 P0 写操作（创建优惠券/闪购/采购计划/转单/信用额度调整）。
2. **第一批 P1（约 25 个）**：写操作批量精调（满减/拼团/赠品/采购付款退货/关怀执行/拜访/费用/佣金）。
3. **第二批（约 11 个）**：库存深度＋审批＋异常。
4. **第三批（约 11 个）**：总平台级，注册时限定 scope=platform（租户侧工具列表不出现）。

> 平台域工具注册后需在 `ToolRegistry` 的租户过滤逻辑中按 `systemScope` 隔离：租户侧 `toToolDefinitionsForTenant()` 不含 `api_platform_*`。

## 四、进度记录

- 2026-08-16：清单制定（第一批 P0/P1 端点已核对真实前缀）。
- 2026-08-16：**第一批完成**（44 个：24 查询目录 + 20 写操作精调）——commit 6290f993/33f06e5e/4224d006。
- 2026-08-16：**第二批完成**（13 个：12 查询目录 + 1 审批处理精调）——commit 6434565d。
- 2026-08-16：**第三批完成**（11 个总平台级：9 查询目录 + 2 写操作精调；ToolScope 隔离：platform 工具仅 scope=platform 总台对话暴露，租户侧绝不出现）——commit 63b4d3d0。
- 当前工具池：精调 51 + 目录 55（去重后约 96 个），ai-base 68 套件 707 用例全绿。
- 2026-08-16：**RAG 知识库就绪**——embedding 复用智谱 Key 指向 embedding-3（服务器零负载），9 份业务规则文档入库（10 分块无重复），文档级幂等支持增量扩充——commit bb3f409f/174718f7/eb530224。
- 2026-08-16：**端到端验收 15/15 通过**（服务器 e2e：健康/工具96/Provider/RAG 9 文档/LLM GLM/对话链路/审计/WebSocket/用量/外部模型/长期记忆/学习回流/进化门控/API目录55）——报告 docs/reports/ai-base-e2e-2026-08-16T01-41-06.md。
