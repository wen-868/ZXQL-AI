/**
 * R70-21 ContextBuilder 单元测试（RAG 注入点）
 *
 * 覆盖：
 * 1. build — RAG 检索到知识 → System Prompt 注入"知识库参考"段
 * 2. build — RAG 检索空结果 → 跳过注入，对话正常构建
 * 3. build — RAG 检索异常 → warn + 跳过注入（主流程不受影响）
 * 4. build — 过滤历史中的 system 消息
 * 5. buildSystemPrompt — 占位符替换 / 自定义提示词优先 / 工具列表 / ragContext 空白不注入
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import { RetrieverService } from '../rag/retriever.service';
import { LongTermMemoryService } from './memory/long-term-memory.service';
import {
  ContextBuilder,
  DEFAULT_SYSTEM_PROMPT,
} from './context-builder.service';
import type { ToolRegistry } from '../tools/tool-registry';

describe('R70-21 ContextBuilder', () => {
  const retriever = {
    search: jest.fn(),
  };
  const ltm = {
    getProfiles: jest.fn().mockResolvedValue([]),
    search: jest.fn().mockResolvedValue([]),
  };

  let builder: ContextBuilder;

  /** 构造 ToolRegistry mock（ContextBuilder 仅使用 list()） */
  function createRegistry(
    tools: Array<{ name: string; category: string; description: string }> = [],
  ): ToolRegistry {
    return { list: jest.fn(() => tools) } as unknown as ToolRegistry;
  }

  const baseParams = {
    tenantId: 'tenant-A',
    userId: 'user-1',
    role: '老板',
    userMessage: '五粮液多少钱',
    history: [],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    builder = new ContextBuilder(
      retriever as unknown as RetrieverService,
      ltm as unknown as LongTermMemoryService,
    );
  });

  describe('build（RAG 注入）', () => {
    it('检索到知识应注入 System Prompt 的"知识库参考"段', async () => {
      retriever.search.mockResolvedValue([
        {
          text: '五粮液参考价 4900 元',
          score: 0.98,
          docName: '价目表.xlsx',
          chunkIndex: 0,
        },
      ]);
      const messages = await builder.build(baseParams, createRegistry());
      const system = messages[0];
      expect(system.role).toBe('system');
      expect(system.content).toContain('## 知识库参考');
      expect(system.content).toContain(
        '【价目表.xlsx 第1段】(相关度 98%) 五粮液参考价 4900 元',
      );
    });

    it('检索无结果应跳过知识库注入', async () => {
      retriever.search.mockResolvedValue([]);
      const messages = await builder.build(baseParams, createRegistry());
      expect(messages[0].content).not.toContain('## 知识库参考');
    });

    it('检索异常应 warn 并跳过注入，对话仍正常构建', async () => {
      retriever.search.mockRejectedValue(new Error('Ollama 未启动'));
      const messages = await builder.build(baseParams, createRegistry());
      expect(messages).toHaveLength(2); // system + user
      expect(messages[0].content).not.toContain('## 知识库参考');
      expect(messages[1]).toEqual({ role: 'user', content: '五粮液多少钱' });
    });

    it('应过滤历史中的 system 消息并保留 user/assistant', async () => {
      retriever.search.mockResolvedValue([]);
      const messages = await builder.build(
        {
          ...baseParams,
          history: [
            { role: 'system', content: '旧系统提示' },
            { role: 'user', content: '上次问题' },
            { role: 'assistant', content: '上次回答' },
          ],
        },
        createRegistry(),
      );
      // system（新）+ user + assistant + user（当前）
      expect(messages).toHaveLength(4);
      expect(messages.map((m) => m.role)).toEqual([
        'system',
        'user',
        'assistant',
        'user',
      ]);
      expect(messages.map((m) => m.content)).not.toContain('旧系统提示');
    });
  });

  describe('buildSystemPrompt', () => {
    it('默认提示词应替换 tenantId/userId/role 占位符', () => {
      const prompt = builder.buildSystemPrompt(
        { ...baseParams, ragContext: undefined },
        createRegistry(),
      );
      expect(prompt).toContain('当前租户ID：tenant-A');
      expect(prompt).toContain('当前用户：user-1（角色：老板）');
      expect(prompt).not.toContain('{tenantId}');
    });

    it('缺少 userId/role 时应替换为"未知"', () => {
      const prompt = builder.buildSystemPrompt(
        {
          tenantId: 'tenant-A',
          userMessage: 'x',
          history: [],
        },
        createRegistry(),
      );
      expect(prompt).toContain('当前用户：未知（角色：未知）');
    });

    it('自定义 systemPrompt 应优先于默认提示词', () => {
      const custom = '你是专供提示词。{tenantId}';
      const prompt = builder.buildSystemPrompt(
        { ...baseParams, systemPrompt: custom },
        createRegistry(),
      );
      expect(prompt).toContain('专供提示词');
      expect(prompt).toContain('tenant-A');
      expect(prompt).not.toContain(DEFAULT_SYSTEM_PROMPT.slice(0, 20));
    });

    it('存在工具时应追加"当前可用工具"段', () => {
      const prompt = builder.buildSystemPrompt(
        { ...baseParams, ragContext: undefined },
        createRegistry([
          { name: 'queryInventory', category: '库存', description: '查询库存' },
        ]),
      );
      expect(prompt).toContain('## 当前可用工具');
      expect(prompt).toContain('- queryInventory（库存）：查询库存');
    });

    it('ragContext 为空白时不追加知识库段', () => {
      const prompt = builder.buildSystemPrompt(
        { ...baseParams, ragContext: '   ' },
        createRegistry(),
      );
      expect(prompt).not.toContain('## 知识库参考');
    });
  });
});
