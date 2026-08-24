/**
 * R70-21 RetrieverService 单元测试
 *
 * 覆盖：
 * 1. embedding 未配置 → 降级返回空数组（不调用 embed / search）
 * 2. embed 调用失败 → warn + 返回空数组（对话主流程不受影响）
 * 3. embed 成功 → 返回向量库检索结果
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import { EmbeddingService } from './embedding.service';
import { RetrievalResult, VectorStoreService } from './vector-store.service';
import { RetrieverService } from './retriever.service';

describe('R70-21 RetrieverService', () => {
  const embeddingService = {
    isEnabled: jest.fn(),
    embed: jest.fn(),
  };
  const vectorStore = {
    search: jest.fn(),
  };

  let retriever: RetrieverService;

  beforeEach(() => {
    jest.clearAllMocks();
    retriever = new RetrieverService(
      embeddingService as unknown as EmbeddingService,
      vectorStore as unknown as VectorStoreService,
    );
  });

  it('embedding 未配置时应降级返回空数组，且不调用 embed/search', async () => {
    embeddingService.isEnabled.mockReturnValue(false);
    const results = await retriever.search('五粮液多少钱', 'tenant-A');
    expect(results).toEqual([]);
    expect(embeddingService.embed).not.toHaveBeenCalled();
    expect(vectorStore.search).not.toHaveBeenCalled();
  });

  it('embed 调用失败应 warn + 返回空数组', async () => {
    embeddingService.isEnabled.mockReturnValue(true);
    embeddingService.embed.mockRejectedValue(new Error('Ollama 未启动'));
    const results = await retriever.search('五粮液多少钱', 'tenant-A', 3);
    expect(results).toEqual([]);
    expect(vectorStore.search).not.toHaveBeenCalled();
  });

  it('embed 成功应返回向量库检索结果', async () => {
    embeddingService.isEnabled.mockReturnValue(true);
    embeddingService.embed.mockResolvedValue([1, 0, 0]);
    const mockResults: RetrievalResult[] = [
      {
        text: '五粮液参考价 4900 元',
        score: 0.98,
        docName: '价目表.xlsx',
        chunkIndex: 0,
      },
    ];
    vectorStore.search.mockReturnValue(mockResults);

    const results = await retriever.search('五粮液多少钱', 'tenant-A', 3);

    expect(embeddingService.embed).toHaveBeenCalledWith('五粮液多少钱');
    expect(vectorStore.search).toHaveBeenCalledWith('tenant-A', [1, 0, 0], 3);
    expect(results).toEqual(mockResults);
  });

  it('topK 参数应透传给向量库', async () => {
    embeddingService.isEnabled.mockReturnValue(true);
    embeddingService.embed.mockResolvedValue([0, 1]);
    vectorStore.search.mockReturnValue([]);
    await retriever.search('查询', 'tenant-A', 5);
    expect(vectorStore.search).toHaveBeenCalledWith('tenant-A', [0, 1], 5);
  });
});
