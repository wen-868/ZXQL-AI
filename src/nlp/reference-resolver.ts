/**
 * Reference Resolver — 多轮指代消解（精准度优化）
 *
 * 用户说"上一单""那个客户""它"时，从对话历史提取最近实体
 * （单号/客户/商品），生成上下文提示注入当前消息，让 LLM 正确理解指代。
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-17
 */
import type { ChatMessage } from '../providers/provider.interface';

/** 指代触发词 */
const ORDER_REF_RE = /上一单|上单|刚才那单|刚才那笔|这笔单|这单|刚才那|上一笔/;
const CUSTOMER_REF_RE = /那个客户|这家|他们|这个客户|该客户/;
const PRODUCT_REF_RE = /它|这个|那个|这个商品|那个商品|刚才的|这款/;

/** 单号提取（XS/CG/FK/JH/TH 前缀 + 数字） */
const ORDER_NO_RE = /\b(XS|CG|FK|JH|TH|CGTH|XSHT)\d{8,}\d*\b/g;
/** 客户提取：给X送 / 向X采购 / 客户：X */
const CUSTOMER_RE =
  /(?:给|向)([^\s，,。]{2,20}?)(?:送|采购|开单|下单|发|订|结)/;
/** 商品提取：动作+数字单位+商品名 / 查询X的 / 来点X */
const PRODUCT_RE =
  /(?:送|买|开|订|查询|查|来|拿)\s*\d*[箱瓶件提扎]?\s*([\u4e00-\u9fa5A-Za-z0-9]{2,14}?)(?:的|库存|价格|还有|[，,。]|$)/;

/** 指代消解结果 */
export interface ReferenceResolution {
  /** 是否命中指代（无需消解时 false） */
  hasReference: boolean;
  /** 上下文提示（注入到系统/用户消息前） */
  context?: string;
}

/**
 * 从历史消息提取最近实体
 */
function extractEntities(history: ChatMessage[]): {
  orderNo?: string;
  customer?: string;
  product?: string;
} {
  const entities: { orderNo?: string; customer?: string; product?: string } =
    {};
  // 从最近消息反向扫描（最多 6 条）
  const recent = history.slice(-6);
  for (const msg of recent.reverse()) {
    const text = typeof msg.content === 'string' ? msg.content : '';
    if (!entities.orderNo) {
      const m = text.match(ORDER_NO_RE);
      if (m) entities.orderNo = m[m.length - 1];
    }
    if (!entities.customer) {
      const m = text.match(CUSTOMER_RE);
      if (m) entities.customer = m[1];
    }
    if (!entities.product) {
      const m = text.match(PRODUCT_RE);
      if (m) entities.product = m[1];
    }
    if (entities.orderNo && entities.customer && entities.product) break;
  }
  return entities;
}

/**
 * 解析当前消息中的指代，生成上下文提示
 *
 * @param userMessage 当前用户消息
 * @param history     对话历史（含最近工具结果/回复）
 * @returns 消解结果（命中指代时携带 context 提示）
 */
export function resolveReference(
  userMessage: string,
  history: ChatMessage[],
): ReferenceResolution {
  const text = userMessage.trim();
  if (!text || history.length === 0) return { hasReference: false };

  const hasOrder = ORDER_REF_RE.test(text);
  const hasCustomer = CUSTOMER_REF_RE.test(text);
  const hasProduct = PRODUCT_REF_RE.test(text);
  if (!hasOrder && !hasCustomer && !hasProduct) {
    return { hasReference: false };
  }

  const { orderNo, customer, product } = extractEntities(history);
  const hints: string[] = [];
  if (hasOrder) {
    hints.push(
      orderNo
        ? `用户说的「上一单」指最近提到的单号 ${orderNo}`
        : '用户提到上一单，但历史中未找到单号',
    );
  }
  if (hasCustomer) {
    hints.push(
      customer
        ? `用户说的「那个客户」指最近提到的客户 ${customer}`
        : '用户提到客户，但历史中未识别出客户名',
    );
  }
  if (hasProduct) {
    hints.push(
      product
        ? `用户说的「它/这个商品」指最近提到的商品 ${product}`
        : '用户提到商品，但历史中未识别出商品名',
    );
  }

  return {
    hasReference: true,
    context: `[多轮上下文] ${hints.join('；')}。请结合以上上下文理解用户意图，不要重复询问已提供的实体。`,
  };
}
