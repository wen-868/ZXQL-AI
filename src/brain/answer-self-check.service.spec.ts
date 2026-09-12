/**
 * S2 AnswerSelfCheckService 单元测试
 *
 * 覆盖：触发门控、核对提示词内容、判决解析（围栏/非法 JSON/ok 非布尔）、
 * verify 指标留痕（pass/corrected/skip/error）。
 *
 * 负责人: AI底座 | 创建日期: 2026-09-05
 */
import { MetricsService } from '../common/metrics.service';
import {
  AnswerSelfCheckService,
  SelfCheckToolResult,
} from './answer-self-check.service';

function createService() {
  const metrics = {
    recordAnswerSelfCheck: jest.fn(),
  } as never as MetricsService;
  return { service: new AnswerSelfCheckService(metrics), metrics };
}

const TOOLS: SelfCheckToolResult[] = [
  { tool: 'queryInventory', success: true, data: { qty: 12 } },
];

describe('S2 AnswerSelfCheckService', () => {
  it('shouldCheck：无工具结果或答案无数字 → 不触发', () => {
    const { service } = createService();
    expect(service.shouldCheck('', 3)).toBe(false);
    expect(service.shouldCheck('已为您处理完毕', 0)).toBe(false);
    expect(service.shouldCheck('共 12 瓶', 0)).toBe(false);
    expect(service.shouldCheck('共 12 瓶', 2)).toBe(true);
  });

  it('buildVerifyPrompt：包含工具摘要与回答，并声明口径换算不算错误', () => {
    const { service } = createService();
    const prompt = service.buildVerifyPrompt(TOOLS, '五粮液还有 12 瓶');
    expect(prompt).toContain('queryInventory（成功）');
    expect(prompt).toContain('"qty":12');
    expect(prompt).toContain('五粮液还有 12 瓶');
    expect(prompt).toContain('口径换算');
  });

  it('parseVerdict：合法 JSON / 围栏包裹 / ok 非布尔 / 非法 JSON', () => {
    const { service } = createService();
    expect(service.parseVerdict('{"ok":true}')).toEqual({ ok: true });
    expect(
      service.parseVerdict(
        '```json\n{"ok":false,"correction":"应为 12 箱"}\n```',
      ),
    ).toEqual({ ok: false, correction: '应为 12 箱' });
    expect(service.parseVerdict('{"ok":"yes"}')).toBeNull();
    expect(service.parseVerdict('不是 JSON')).toBeNull();
    expect(service.parseVerdict('{"ok":false}')).toBeNull(); // 无更正内容视为无结论
  });

  it('verify：判决通过 → 记 pass 返回 ok', async () => {
    const { service, metrics } = createService();
    const verdict = await service.verify(
      () => Promise.resolve('{"ok":true}'),
      TOOLS,
      '五粮液还有 12 瓶',
    );
    expect(verdict?.ok).toBe(true);
    expect(metrics.recordAnswerSelfCheck).toHaveBeenCalledWith('pass');
  });

  it('verify：判决失真 → 记 corrected 返回更正', async () => {
    const { service, metrics } = createService();
    const verdict = await service.verify(
      () =>
        Promise.resolve(
          '{"ok":false,"correction":"库存应为 12 瓶而非 120 瓶"}',
        ),
      TOOLS,
      '五粮液还有 120 瓶',
    );
    expect(verdict?.ok).toBe(false);
    expect(verdict?.correction).toContain('12 瓶');
    expect(metrics.recordAnswerSelfCheck).toHaveBeenCalledWith('corrected');
  });

  it('verify：未触发 → 记 skip 且不调 LLM', async () => {
    const { service, metrics } = createService();
    const chat = jest.fn();
    const verdict = await service.verify(chat, [], '寒暄一下');
    expect(verdict).toBeNull();
    expect(chat).not.toHaveBeenCalled();
    expect(metrics.recordAnswerSelfCheck).toHaveBeenCalledWith('skip');
  });

  it('verify：LLM 异常 → 记 error 且不抛出', async () => {
    const { service, metrics } = createService();
    const verdict = await service.verify(
      () => Promise.reject(new Error('llm down')),
      TOOLS,
      '共 12 瓶',
    );
    expect(verdict).toBeNull();
    expect(metrics.recordAnswerSelfCheck).toHaveBeenCalledWith('error');
  });
});
