/**
 * 通用 AI 工具结果总结（api_* 目录生成工具）
 *
 * 目录生成工具（DynamicApiTool）数量多且返回原始 JSON，兜底摘要若只输出
 * 「「xxx」执行完成」对用户没有价值。本模块从返回数据中提取可读结论：
 * - 列表类（records/list/rows/items）→「已查询到 N 条记录，如…」
 * - 聚合类（total/count）→「共 N 条」
 * - 统计对象类（金额/数量字段）→ 输出关键指标
 * - 兜底 →「xxx 查询完成」
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-16
 */

/** 常见列表字段（兼容分页结构） */
const LIST_KEYS = ['records', 'list', 'rows', 'items'] as const;

/** 常见名称字段（取首条展示） */
const NAME_KEYS = [
  'skuName',
  'customerName',
  'supplierName',
  'templateName',
  'activityName',
  'productName',
  'name',
  'title',
] as const;

/** 常见统计字段 → 中文标签 */
const STAT_KEYS: Record<string, string> = {
  totalAmount: '总金额',
  totalSales: '总销售额',
  totalCount: '总数量',
  orderCount: '订单数',
  amount: '金额',
  count: '数量',
};

/** 从行对象提取可读名称 */
function extractName(row: unknown): string {
  if (!row || typeof row !== 'object') return '';
  const r = row as Record<string, unknown>;
  for (const key of NAME_KEYS) {
    const v = r[key];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return '';
}

/**
 * 生成 api_* 工具结果的可读总结
 *
 * @param toolName 工具名（如 api_query_coupon_templates）
 * @param data     工具返回 data
 * @returns 用户可读的总结文本
 */
export function buildApiToolSummary(toolName: string, data: unknown): string {
  const d = (data ?? {}) as Record<string, unknown>;

  // 1. 列表类
  for (const key of LIST_KEYS) {
    const arr = Array.isArray(d[key]) ? d[key] : undefined;
    if (arr && arr.length > 0) {
      const firstName = extractName(arr[0]);
      return firstName
        ? `已查询到 ${arr.length} 条记录，如「${firstName}」。`
        : `已查询到 ${arr.length} 条记录。`;
    }
    if (arr) return '未查询到相关记录。';
  }

  // 2. 聚合字段
  const total = Number(d.total ?? d.count ?? d.totalCount);
  if (Number.isFinite(total) && total > 0) {
    return `查询完成，共 ${total} 条。`;
  }

  // 3. 统计对象类：取前 3 个可读指标
  const statParts: string[] = [];
  for (const [key, label] of Object.entries(STAT_KEYS)) {
    const v = d[key];
    if (typeof v === 'string' || typeof v === 'number') {
      statParts.push(`${label} ${v}`);
      if (statParts.length >= 3) break;
    }
  }
  if (statParts.length > 0) return `查询完成：${statParts.join('，')}。`;

  return `「${toolName}」查询完成。`;
}
