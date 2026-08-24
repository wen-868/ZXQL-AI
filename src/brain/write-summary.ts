/**
 * 写操作工具结果通用总结
 *
 * 覆盖全部精调写操作工具：执行成功后按工具名 + 返回数据生成结构化结论，
 * 替代「「xxx」执行完成」空话（P0 汇总结果能力补齐）。
 *
 * 输出示例：
 * - createCouponTemplate → 已创建优惠券模板「满100减10」，有效期 2026-09-01 ~ 2026-09-30
 * - createPurchasePlan → 已创建采购计划 JH202608160001（3 种商品）
 * - adjustCreditLimit → 已调整客户 #88 授信额度为 50000 元
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-16
 */

/** 工具 → 操作名 + 摘要生成函数 */
interface WriteSummaryRule {
  /** 操作名（预览卡标题同源） */
  action: string;
  /** 从 data 提取关键信息生成摘要（返回 null 时用兜底模板） */
  build: (d: Record<string, unknown>) => string | null;
}

/** 从返回数据中提取首个字符串值（常见单据号/ID 字段） */
function firstString(
  d: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const v = d[key];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

/** 各写操作工具的成功摘要规则 */
const RULES: Record<string, WriteSummaryRule> = {
  api_create_coupon_template: {
    action: '创建优惠券模板',
    build: (d) => {
      const name = firstString(d, ['name']);
      const id = firstString(d, ['id', 'templateId']);
      return name
        ? `已创建优惠券模板「${name}」${id ? `（ID ${id}）` : ''}`
        : null;
    },
  },
  api_set_coupon_status: {
    action: '调整优惠券状态',
    build: (d) => {
      const id = firstString(d, ['id', 'templateId']);
      return id ? `优惠券模板 #${id} 状态已更新` : null;
    },
  },
  api_create_flash_sale: {
    action: '创建秒杀活动',
    build: (d) => {
      const name = firstString(d, ['name']);
      const id = firstString(d, ['id', 'activityId']);
      return name
        ? `已创建秒杀活动「${name}」${id ? `（ID ${id}）` : ''}`
        : null;
    },
  },
  api_create_full_reduction: {
    action: '创建满减活动',
    build: (d) => {
      const name = firstString(d, ['name']);
      return name ? `已创建满减活动「${name}」` : null;
    },
  },
  api_create_group_buy: {
    action: '创建拼团活动',
    build: (d) => {
      const name = firstString(d, ['name']);
      return name ? `已创建拼团活动「${name}」` : null;
    },
  },
  api_create_gift_rule: {
    action: '创建赠品规则',
    build: (d) => {
      const name = firstString(d, ['rule_name', 'name']);
      return name ? `已创建赠品规则「${name}」` : null;
    },
  },
  api_set_marketing_activity_status: {
    action: '调整营销活动状态',
    build: (d) => {
      const id = firstString(d, ['id', 'activityId']);
      return id ? `营销活动 #${id} 状态已更新` : null;
    },
  },
  api_create_limited_discount: {
    action: '创建限量折扣活动',
    build: (d) => {
      const name = firstString(d, ['name']);
      return name ? `已创建限量折扣活动「${name}」` : null;
    },
  },
  api_create_purchase_plan: {
    action: '创建采购计划',
    build: (d) => {
      const planNo = firstString(d, ['planNo', 'plan_no', 'id']);
      const count = firstString(d, ['itemsCount']);
      return planNo
        ? `已创建采购计划 ${planNo}${count ? `（${count} 种商品）` : ''}`
        : null;
    },
  },
  api_convert_purchase_plan: {
    action: '采购计划转采购单',
    build: (d) => {
      const no = firstString(d, ['orderNo', 'order_no', 'planNo', 'id']);
      return no ? `采购计划已成功转为采购单 ${no}` : null;
    },
  },
  api_create_purchase_payment: {
    action: '创建采购付款单',
    build: (d) => {
      const no = firstString(d, ['payment_no', 'paymentNo', 'id']);
      return no ? `已创建采购付款单 ${no}（待审批）` : null;
    },
  },
  api_create_purchase_return: {
    action: '创建采购退货单',
    build: (d) => {
      const no = firstString(d, ['return_no', 'returnNo', 'id']);
      return no ? `已创建采购退货单 ${no}（待审批）` : null;
    },
  },
  api_create_purchase_contract: {
    action: '创建采购合同',
    build: (d) => {
      const name = firstString(d, [
        'contractName',
        'contract_name',
        'contractNo',
      ]);
      return name ? `已登记采购合同「${name}」` : null;
    },
  },
  api_create_expense: {
    action: '创建费用单',
    build: (d) => {
      const no = firstString(d, ['expenseNo', 'expense_no', 'id']);
      return no ? `已创建费用单 ${no}（待审批）` : null;
    },
  },
  api_create_customer_segment: {
    action: '创建客户分群',
    build: (d) => {
      const name = firstString(d, ['segmentName', 'segment_name', 'id']);
      return name ? `已创建客户分群「${name}」` : null;
    },
  },
  api_execute_care_rule: {
    action: '执行客户关怀规则',
    build: (d) => {
      const count = firstString(d, ['affected', 'count', 'sent']);
      return count ? `客户关怀规则已执行，影响 ${count} 位客户` : null;
    },
  },
  api_create_customer_visit: {
    action: '创建客户拜访',
    build: (d) => {
      const no = firstString(d, ['visitNo', 'visit_no', 'id']);
      return no ? `已创建客户拜访记录 ${no}` : null;
    },
  },
  api_calculate_commission: {
    action: '计算销售佣金',
    build: (d) => {
      const count = firstString(d, ['recordCount', 'count']);
      return count ? `佣金计算完成，生成 ${count} 条记录` : null;
    },
  },
  api_auto_generate_collections: {
    action: '自动生成催收计划',
    build: (d) => {
      const count = firstString(d, ['generated', 'count']);
      return count ? `已自动生成 ${count} 条催收任务` : null;
    },
  },
  api_adjust_credit_limit: {
    action: '调整授信额度',
    build: (d) => {
      const id = firstString(d, ['customerId', 'customer_id', 'id']);
      const limit = firstString(d, ['creditLimit', 'credit_limit']);
      return id
        ? `已调整客户 #${id} 授信额度${limit ? `为 ${limit} 元` : ''}`
        : null;
    },
  },
  api_handle_approval: {
    action: '处理审批任务',
    build: (d) => {
      const id = firstString(d, ['taskId', 'task_id', 'id']);
      return id ? `审批任务 #${id} 已处理` : null;
    },
  },
  api_platform_create_announcement: {
    action: '创建平台公告',
    build: (d) => {
      const title = firstString(d, ['title']);
      return title ? `已发布平台公告「${title}」` : null;
    },
  },
  api_platform_handle_subscription_apply: {
    action: '审核订阅申请',
    build: (d) => {
      const id = firstString(d, ['applyId', 'apply_id', 'id']);
      return id ? `订阅申请 #${id} 审核完成` : null;
    },
  },
};

/**
 * 生成写操作工具成功后的可读总结
 *
 * @param toolName 工具名
 * @param data     工具返回 data
 * @returns 可读结论；无匹配规则时返回 null（调用方走通用兜底）
 */
export function buildWriteSummary(
  toolName: string,
  data: unknown,
): string | null {
  const rule = RULES[toolName];
  if (!rule) return null;
  const d = (data ?? {}) as Record<string, unknown>;
  const detail = rule.build(d);
  if (detail) return detail;
  return `${rule.action}成功。`;
}
