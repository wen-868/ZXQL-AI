/**
 * IntentDetector — 用户意图 → 工具分类（prompt 减负核心）
 *
 * 按用户消息关键词识别业务意图，只向 LLM 注入相关域的工具定义，
 * 避免 96 个工具全量塞入 prompt（实测可达 7 万 tokens，LLM 响应 30-60s）。
 *
 * 规则：关键词命中 → 对应业务分类；多规则命中合并；无命中回退全量（保守兜底）。
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-17
 */
import { ToolCategory } from '../tools/tool.interface';

/** 意图规则：关键词（任一命中）→ 需要的工具分类 */
interface IntentRule {
  keywords: string[];
  categories: ToolCategory[];
}

const INTENT_RULES: IntentRule[] = [
  {
    keywords: [
      '库存',
      '还有多少',
      '剩多少',
      '够不够',
      '存量',
      '缺货',
      '批次',
      '盘点',
      '调拨',
      '预警',
      '保质期',
      '到期',
      '库存成本',
      '损溢',
      '共享库存',
      '有没有货',
      '还剩',
      '缺不缺',
      '仓库里',
      '仓里',
      '现货',
    ],
    categories: ['inventory', 'product'],
  },
  {
    keywords: [
      '开单',
      '下单',
      '销售',
      '订货',
      '送货',
      '配送',
      '拿货',
      '送',
      '卖货',
      '卖掉',
      '销售单',
      '订单',
      '退货',
      '退款',
      '收款',
      '挂单',
      '来点',
      '开一单',
      '拿几',
      '要货',
      '出货',
    ],
    categories: ['order', 'customer', 'product', 'inventory', 'delivery'],
  },
  {
    keywords: [
      '采购',
      '进货',
      '补货',
      '供应商',
      '采购付款',
      '采购退货',
      '采购合同',
      '采购计划',
      '入库',
    ],
    categories: ['purchase', 'inventory'],
  },
  {
    keywords: [
      '优惠',
      '优惠券',
      '秒杀',
      '满减',
      '拼团',
      '活动',
      '积分',
      '赠品',
      '折扣',
      '营销',
      '限量',
      '闪购',
      '发券',
      '发个券',
      '做活动',
    ],
    categories: ['marketing', 'product'],
  },
  {
    keywords: [
      '应收',
      '应付',
      '欠款',
      '欠',
      '收钱',
      '付款',
      '费用',
      '对账',
      '佣金',
      '利润',
      '账龄',
      '催收',
      '回款',
      '核销',
      '欠多少',
      '还欠',
      '结一下',
      '对个账',
    ],
    categories: ['finance', 'customer'],
  },
  {
    keywords: [
      '报表',
      '统计',
      '排行',
      '趋势',
      '销售额',
      '毛利',
      '分析',
      '对比',
      '仪表盘',
      '经营概览',
      '这月',
      '卖了',
      '业绩',
      '经营情况',
      '赚了',
    ],
    categories: ['report', 'order', 'inventory'],
  },
  {
    keywords: [
      '客户',
      '会员',
      '分群',
      '关怀',
      '拜访',
      '信用',
      '额度',
      '标签',
      '等级',
      '类型',
    ],
    categories: ['customer', 'finance'],
  },
  {
    keywords: ['租户', '订阅', '公告', '平台', '总台'],
    categories: ['platform'],
  },
];

/**
 * 从用户消息识别意图分类
 *
 * @param message 用户消息
 * @returns 匹配的工具分类集合；无命中返回 undefined（调用方回退全量）
 */
export function detectIntentCategories(
  message: string,
): ToolCategory[] | undefined {
  const text = message.trim();
  if (!text) return undefined;

  const matched = new Set<ToolCategory>();
  for (const rule of INTENT_RULES) {
    if (rule.keywords.some((kw) => text.includes(kw))) {
      for (const c of rule.categories) matched.add(c);
    }
  }

  // 常规咨询/综合问题（含多个业务词）→ 回退全量，避免漏工具
  if (matched.size === 0 || matched.size >= 6) return undefined;
  return Array.from(matched);
}
