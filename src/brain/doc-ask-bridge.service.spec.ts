/**
 * DocAskBridge 测试（AI-P1-3 · Brain→Tools 方向的接线）
 *
 * 反测目标（每条"改坏会红"）：
 * ① onModuleInit 把实现注册进 DocAskRunner（runner.isRegistered 前后变化）
 *    —— 忘注册 = 工具永远走"AI 不可用"降级，这是接线断掉的静默故障
 * ② prompt **关键内容**断言：system 含"只依据…原文片段/文档中未提及/不得脑补"，
 *    user 含问题 + 编号片段 [1] —— 这是"不编造"的提示词承重，不是断"调用过"
 * ③ RouteInput 装配含租户 resolved 配置 + systemScope（照 planner 范式；
 *    mutation：换成 getDefault()/缺 systemScope ⇒ 本例红）
 * ④ chatSync 参数：temperature/max_tokens 显式（问答要稳，不要高随机）
 * ⑤ LLM 返回经 fallback 元数据透传（provider/fallbackUsed 取 fallback.to/used）
 * ⑥ LLM 抛错 ⇒ 桥**原样抛出**，不吞成空串（吞了会被工具当"文档没答案"假成功）
 *
 * 负责人: 阿澈 | 创建日期: 2026-10-24
 */
import { DocAskRunner, DocAskInput } from '../tools/doc-ask-runner';
import { DocAskBridge } from './doc-ask-bridge.service';

const INPUT: DocAskInput = {
  tenantId: 't1',
  docId: '12',
  docTitle: '采购合同-A-2026',
  question: '关键付款条款？',
  passages: [
    { index: 1, chunkIndex: 0, text: '货到30天内付款' },
    { index: 2, chunkIndex: 3, text: '违约金每日0.1%' },
  ],
};

function createBridge(
  chatSync: jest.Mock = jest.fn().mockResolvedValue({
    content: '付款条款：货到30天内 [1]',
    fallback: { used: false, to: 'glm' },
  }),
) {
  const runner = new DocAskRunner();
  const router = {
    chatSyncWithFallback: chatSync,
    getSystemScope: jest.fn(() => 'mgmt'),
  };
  const aiConfig = {
    getResolvedConfig: jest.fn(() =>
      Promise.resolve({
        provider: 'glm',
        model: 'glm-4-flash',
        apiKeySet: true,
      }),
    ),
  };
  const bridge = new DocAskBridge(runner, router as never, aiConfig as never);
  return { bridge, runner, router, aiConfig, chatSync };
}

describe('DocAskBridge（AI-P1-3）', () => {
  it('① onModuleInit 注册执行器；注册前未装配、注册后可用', async () => {
    const h = createBridge();
    expect(h.runner.isRegistered()).toBe(false);
    await expect(h.runner.ask(INPUT)).rejects.toThrow('未注册');
    h.bridge.onModuleInit();
    expect(h.runner.isRegistered()).toBe(true);
    const out = await h.runner.ask(INPUT);
    expect(out.answer).toContain('货到30天内');
  });

  it('② prompt 关键内容：只依据原文/不得脑补/编号片段（“不编造”的承重提示词）', async () => {
    const h = createBridge();
    h.bridge.onModuleInit();
    await h.runner.ask(INPUT);
    const [messages] = h.chatSync.mock.calls[0] as [
      Array<{ role: string; content: string }>,
      never,
      never,
    ];
    const system = messages.find((m) => m.role === 'system')!.content;
    // 🔴 断内容不断形式：这三句缺一，"有据可查"就失守
    expect(system).toContain('只依据');
    expect(system).toContain('未提及');
    expect(system).toContain('不得脑补');
    expect(system).toContain('采购合同-A-2026');
    const user = messages.find((m) => m.role === 'user')!.content;
    expect(user).toContain('关键付款条款？');
    expect(user).toContain('[1] 货到30天内付款');
    expect(user).toContain('[2] 违约金每日0.1%');
  });

  it('③ RouteInput 装配：租户 resolved 配置 + systemScope（照 planner 范式）', async () => {
    const h = createBridge();
    h.bridge.onModuleInit();
    await h.runner.ask(INPUT);
    const [, , routeInput] = h.chatSync.mock.calls[0] as [
      never,
      never,
      { resolved: unknown; systemScope: string },
    ];
    // mutation：改用 getDefault() 环境基线（丢租户配置）⇒ resolved 断言红
    expect(routeInput.resolved).toEqual({
      provider: 'glm',
      model: 'glm-4-flash',
      apiKeySet: true,
    });
    expect(routeInput.systemScope).toBe('mgmt');
  });

  it('④ 调用参数：temperature/max_tokens 显式收紧（问答要稳）', async () => {
    const h = createBridge();
    h.bridge.onModuleInit();
    await h.runner.ask(INPUT);
    const [, options] = h.chatSync.mock.calls[0] as [
      never,
      Record<string, unknown>,
    ];
    expect(options.temperature).toBe(0.2);
    expect(options.max_tokens).toBe(1024);
  });

  it('⑤ 降级元数据透传：provider=fallback.to、fallbackUsed=fallback.used', async () => {
    const h = createBridge(
      jest.fn().mockResolvedValue({
        content: '答案',
        fallback: { used: true, to: 'ollama', from: 'glm' },
      }),
    );
    h.bridge.onModuleInit();
    const out = await h.runner.ask(INPUT);
    expect(out.provider).toBe('ollama');
    expect(out.fallbackUsed).toBe(true);
  });

  it('⑥ LLM 抛错原样上抛（不吞成空串⇒防"假成功"）', async () => {
    const h = createBridge(
      jest.fn().mockRejectedValue(new Error('所有 AI 服务商均不可用')),
    );
    h.bridge.onModuleInit();
    await expect(h.runner.ask(INPUT)).rejects.toThrow('所有 AI 服务商均不可用');
  });
});
