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

/* ═══════════════════════════════════════════════════════════════
   意图分诊双通道（2026-09-05 超高智能升级）
   规则快车道（零开销）+ LLM 分诊兜底（新话术不再掉进全量工具集慢车道）
   ═══════════════════════════════════════════════════════════════ */

/** 业务域中文名（LLM 分诊提示词用） */
const CATEGORY_LABELS: Record<ToolCategory, string> = {
  order: '销售管理',
  inventory: '库存管理',
  product: '商品管理',
  customer: '客户管理',
  purchase: '采购管理',
  delivery: '配送管理',
  finance: '财务管理',
  report: '报表分析',
  marketing: '营销管理',
  platform: '总台/平台管理',
  system: '系统管理',
  utility: '工具类',
};

const ALL_CATEGORIES = Object.keys(CATEGORY_LABELS) as ToolCategory[];

/** 意图分诊缓存（消息原文 → 完整分诊结果），LRU 上限 200 */
const intentCache = new Map<string, IntentResolution>();
const INTENT_CACHE_MAX = 200;

/** 意图分诊结果
 *
 * - categories=undefined 且 lane=fallback：回退全量工具集
 * - lane=chat：纯寒暄/闲聊（分诊判定与业务无关），零工具直答（O6 性能优化）
 */
export interface IntentResolution {
  categories: ToolCategory[] | undefined;
  /** 命中通道：rules=关键词快车道 / llm=LLM 分诊 / chat=纯寒暄零工具 / fallback=全量回退 */
  lane: 'rules' | 'llm' | 'chat' | 'fallback';
}

/**
 * 意图分诊双通道：
 * 1. 关键词规则快车道（命中即返回，零额外开销）
 * 2. 规则未命中/综合问题 → LLM 分诊（3.5s 超时、输出校验、失败回退全量）；
 *    分诊判定纯寒暄 → lane=chat，主循环零工具直答（省 2 万+ token/次）
 *
 * @param message    用户消息（建议传指代消解后的文本）
 * @param classifier 可选 LLM 分诊器（返回业务域数组，含 "none"=纯寒暄；null/异常=放弃 LLM 通道）
 */
export async function resolveIntentCategories(
  message: string,
  classifier?: (msg: string) => Promise<string[] | null>,
): Promise<IntentResolution> {
  const text = (message ?? '').trim();
  if (!text) return { categories: undefined, lane: 'fallback' };

  // 注意用 has() 而非 get()!==undefined：缓存值可能是 undefined（fallback）
  if (intentCache.has(text)) {
    const cached = intentCache.get(text) as IntentResolution;
    // LRU 触碰
    intentCache.delete(text);
    intentCache.set(text, cached);
    return cached;
  }

  const ruleHits = detectIntentCategories(text);
  let result: IntentResolution;
  if (ruleHits !== undefined) {
    result = { categories: ruleHits, lane: 'rules' };
  } else if (classifier) {
    const llm = await classifyWithLlm(text, classifier);
    result = llm.chat
      ? { categories: [], lane: 'chat' }
      : llm.cats.length > 0
        ? { categories: llm.cats, lane: 'llm' }
        : { categories: undefined, lane: 'fallback' };
  } else {
    result = { categories: undefined, lane: 'fallback' };
  }

  if (intentCache.size >= INTENT_CACHE_MAX) {
    const oldest = intentCache.keys().next().value;
    if (oldest !== undefined) intentCache.delete(oldest);
  }
  intentCache.set(text, result);
  return result;
}

/** LLM 分诊：3.5s 超时 + 枚举校验 + 上限 4 个域，任何异常回退空（全量） */
async function classifyWithLlm(
  text: string,
  classifier: (msg: string) => Promise<string[] | null>,
): Promise<{ cats: ToolCategory[]; chat: boolean }> {
  try {
    const raw = await Promise.race([
      classifier(text),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3500)),
    ]);
    if (!Array.isArray(raw)) return { cats: [], chat: false };
    // O6：分诊判定纯寒暄/与业务无关 → chat 车道（零工具直答）
    if (raw.includes('none')) return { cats: [], chat: true };
    const valid = new Set<string>(ALL_CATEGORIES);
    return {
      cats: raw
        .filter((c): c is ToolCategory => typeof c === 'string' && valid.has(c))
        .slice(0, 4),
      chat: false,
    };
  } catch {
    return { cats: [], chat: false };
  }
}

/** 构建 LLM 分诊提示词（调用方用快速模型 + temperature 0 调用） */
export function buildLlmClassifierPrompt(message: string): string {
  const domainList = Object.entries(CATEGORY_LABELS)
    .map(([k, v]) => `${k}(${v})`)
    .join('、');
  return (
    '你是酒水进销存 SaaS 的意图分诊器。判断用户消息涉及哪些业务域，' +
    '输出 JSON 字符串数组（0-4 个，按可能性排序），只输出 JSON 数组本身，不要解释。\n' +
    `业务域：${domainList}\n` +
    '若消息是纯寒暄/闲聊/与业务无关的常识问答（不需要调用任何工具），输出 ["none"]。\n' +
    `用户消息：「${message}」\n` +
    '输出示例：["inventory","report"] 或 ["none"]'
  );
}
