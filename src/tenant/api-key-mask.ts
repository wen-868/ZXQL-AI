/**
 * API Key 脱敏工具（独立文件，避免模块循环依赖）
 *
 * 背景：maskApiKey 曾定义在 ai-config-admin.service.ts，
 * 而 ExternalModelService 引入它后形成
 * ai-config → external-model → ai-config-admin → ai-config 的模块循环，
 * 导致 ExternalModelService 在 Nest 装饰器求值时未定义（启动崩溃）。
 * 提取为纯工具函数后切断循环。
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-15
 */

/**
 * 对 API Key 脱敏：保留前后 4 位，中间打码
 */
export function maskApiKey(key: string): string {
  if (key.length <= 8) {
    return '****';
  }
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}
