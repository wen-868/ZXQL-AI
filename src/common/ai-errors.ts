/**
 * AI 错误码规范（A3，文档 11.5）
 *
 * 统一错误响应结构：
 * { code: 'AI_xxx', message, detail?, suggestion?, timestamp }
 *
 * HTTP 状态映射：AI_001→401、AI_002/010→403、AI_011→428、AI_013→423、
 * AI_003→429、AI_004/008→503，其余按表。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */

/** AI 错误码定义 */
export const AI_ERRORS = {
  AI_001: { http: 401, message: 'JWT Token 无效或过期' },
  AI_002: { http: 403, message: '租户未启用 AI 功能' },
  AI_003: { http: 429, message: '请求频率超限' },
  AI_004: { http: 503, message: 'AI 服务商不可用' },
  AI_005: { http: 500, message: 'LLM 调用失败' },
  AI_006: { http: 500, message: 'Tool 执行失败' },
  AI_007: { http: 400, message: '消息内容为空' },
  AI_008: { http: 503, message: 'Redis 不可用（降级模式）' },
  AI_009: { http: 500, message: 'Agent 循环超限' },
  AI_010: { http: 403, message: '无权限执行此操作' },
  AI_011: { http: 428, message: '写操作令牌超时或确认缺失' },
  AI_012: { http: 409, message: '写操作被拒或令牌不匹配' },
  AI_013: { http: 423, message: '受控写通道被锁定' },
} as const;

export type AiErrorCode = keyof typeof AI_ERRORS;

/** AI 错误响应结构 */
export interface AiErrorResponse {
  code: AiErrorCode;
  message: string;
  detail?: string;
  suggestion?: string;
  timestamp: string;
}

/**
 * 构造 AI 错误响应
 */
export function aiError(
  code: AiErrorCode,
  options?: { detail?: string; suggestion?: string },
): AiErrorResponse {
  const def = AI_ERRORS[code];
  return {
    code,
    message: def.message,
    detail: options?.detail,
    suggestion: options?.suggestion,
    timestamp: new Date().toISOString(),
  };
}

/** 错误码 → HTTP 状态 */
export function aiErrorHttp(code: AiErrorCode): number {
  return AI_ERRORS[code].http;
}
