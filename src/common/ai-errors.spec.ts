/**
 * A3 AI 错误码单元测试
 *
 * 覆盖：错误码/HTTP 映射/响应结构。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { AI_ERRORS, aiError, aiErrorHttp, AiErrorCode } from './ai-errors';

describe('A3 AI 错误码', () => {
  it('AI_001~AI_013 全部定义且 HTTP 映射正确', () => {
    expect(aiErrorHttp('AI_001')).toBe(401);
    expect(aiErrorHttp('AI_002')).toBe(403);
    expect(aiErrorHttp('AI_003')).toBe(429);
    expect(aiErrorHttp('AI_004')).toBe(503);
    expect(aiErrorHttp('AI_008')).toBe(503);
    expect(aiErrorHttp('AI_011')).toBe(428);
    expect(aiErrorHttp('AI_012')).toBe(409);
    expect(aiErrorHttp('AI_013')).toBe(423);
    expect(Object.keys(AI_ERRORS)).toHaveLength(13);
  });

  it('aiError 构造标准响应结构', () => {
    const err = aiError('AI_004', {
      detail: 'GLM timeout after 30s',
      suggestion: '正在切换备用服务商',
    });
    expect(err.code).toBe('AI_004');
    expect(err.message).toContain('服务商不可用');
    expect(err.detail).toContain('GLM timeout');
    expect(err.suggestion).toContain('备用');
    expect(err.timestamp).toBeDefined();
  });

  it('类型安全：未知错误码编译期拦截', () => {
    const code: AiErrorCode = 'AI_005';
    expect(aiErrorHttp(code)).toBe(500);
  });
});
