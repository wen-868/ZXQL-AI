/**
 * Capture intent 归一纯函数（AI-P2-4-CAPTURE-INTENT-NORMALIZE-01）
 *
 * 统一 chat / agent / graph 三通道向进化飞轮提交的 capture intent：
 * `ai_sample.taskType` 与 `ai_experience.intent` 使用同一可消费口径，
 * 恢复 E3 few-shot 与 E5 评测的样本闭环。
 *
 * 归一公式：
 *   normalizeCaptureIntent(toolOrIntent, fallback = 'chat')
 *     = docTypeForTool(trimmed) ?? trimmed ?? fallback
 *
 * 口径铁律：
 * 1. 映射命中（docTypeForTool，以 write-schema-registry 为唯一映射真源）⇒
 *    写裸 docType（如 createSalesOrder ⇒ sales_order）；
 * 2. 未映射的工具名**保持原值**，不得擅自折叠成 chat（防样本误归）；
 * 3. 已有非工具意图（office_document / write / analysis / agent_plan / graph 等）
 *    保持原值——它们不在写 Schema 注册表里，规则推导会凭空造出假 docType；
 * 4. 空值/纯空白才回退 fallback（缺省 'chat'）；
 * 5. 原始工具名的审计语义由调用方的 toolCalls/trajectory/遥测审计保留，
 *    归一只作用于 capture 的 intent/taskType 字段。
 *
 * 负责人: 阿洲（AI协助）| 创建日期: 2026-11-06
 */
import { docTypeForTool } from '../brain/extraction/write-schema-registry';

/** 空值回退的缺省意图 */
export const CAPTURE_INTENT_FALLBACK = 'chat';

/**
 * 归一 capture intent / sample taskType（纯函数，三通道共用唯一口径）
 *
 * @param toolOrIntent 工具名或既有意图标签（可空）
 * @param fallback     空值回退（缺省 'chat'）
 * @returns 映射命中 → 裸 docType；未映射 → trim 后原值；空值 → fallback
 */
export function normalizeCaptureIntent(
  toolOrIntent?: string | null,
  fallback: string = CAPTURE_INTENT_FALLBACK,
): string {
  const trimmed = (toolOrIntent ?? '').trim();
  if (trimmed === '') {
    return fallback || CAPTURE_INTENT_FALLBACK;
  }
  return docTypeForTool(trimmed) ?? trimmed;
}
