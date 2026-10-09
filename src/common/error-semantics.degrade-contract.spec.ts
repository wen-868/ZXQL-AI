/**
 * degrade 迁移契约测试（阶段1-批次 P1-D 追加）
 *
 * 目的：给「可观测性」上测试保护。
 *
 * 背景：P1-D 把 9 个业务模块的降级类 catch 迁移到 degrade()，但业务 spec 只断言
 * 「返回值不变」——若有人把 degrade(...) 改回 try/catch + logger.warn，全部
 * 1264 个测试仍然全绿，迁移被静默回退无人发现。degrade 迁移的全部价值是统一
 * 日志 + 指标，因此必须有一条断言证明「业务模块真的调用了 degrade」。
 *
 * 覆盖（3 个不同模块的代表性迁移点，各含失败/成功双向断言）：
 * 1. rag.search —— RetrieverService 检索降级
 * 2. memory.loadHistory —— MemoryManager 记忆加载降级
 * 3. provider.parseSseLine —— OpenAICompatProvider SSE 单行解析降级
 *
 * 反测约定：把任一处 `expect(...fail).toBe(1)` 改成 `toBe(0)` 必须变红；
 * 否则说明该断言是零信号恒真，需要重写。
 *
 * 负责人: AI底座 | 创建日期: 2026-10-07
 */
import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';
import { MemoryManager } from '../brain/memory-manager.service';
import { RedisProvider } from './redis.provider';
import { RetrieverService } from '../rag/retriever.service';
import type { EmbeddingService } from '../rag/embedding.service';
import type { VectorStoreService } from '../rag/vector-store.service';
import { OpenAICompatProvider } from '../providers/openai-compat.provider';
import {
  errorSemanticsCount,
  resetErrorSemanticsMetrics,
} from './error-semantics';

/** 构造注入式 MemoryManager（绕过 onModuleInit 真实 Redis 连接，同 memory-manager.spec.ts 手法） */
function createMemoryManager(
  redisStub: Record<string, unknown>,
): MemoryManager {
  const svc = new MemoryManager(
    { get: () => undefined } as unknown as ConfigService,
    { save: jest.fn() } as never,
    // R101-AI-10：Redis 连接改由共享 provider 提供（本用例注入 Redis 桩，不建连）
    new RedisProvider({ get: () => undefined } as unknown as ConfigService),
  );
  const slot = svc as unknown as Record<string, unknown>;
  slot.redis = redisStub;
  slot.redisAvailable = true;
  return svc;
}

describe('degrade 迁移契约（业务模块确实走 degrade）', () => {
  beforeEach(() => {
    // 计数器是模块级单例，每条用例前清零（jest 各 spec 文件模块隔离，不跨文件污染）
    resetErrorSemanticsMetrics();
  });

  describe('rag.search（RetrieverService 检索降级）', () => {
    const embedding = {
      isEnabled: jest.fn(),
      embed: jest.fn(),
    };
    const vectorStore = { search: jest.fn() };
    const retriever = new RetrieverService(
      embedding as unknown as EmbeddingService,
      vectorStore as unknown as VectorStoreService,
    );

    beforeEach(() => {
      jest.clearAllMocks();
      embedding.isEnabled.mockReturnValue(true);
    });

    it('embed 失败：返回空数组（行为不变）且被 degrade 观测到 fail', async () => {
      embedding.embed.mockRejectedValue(new Error('Ollama 未启动'));

      const results = await retriever.search('五粮液多少钱', 'tenant-A');

      // 第一条：行为契约（迁移前后必须一致）
      expect(results).toEqual([]);
      expect(vectorStore.search).not.toHaveBeenCalled();
      // 第二条：可观测性契约（这才是本次迁移带来的东西）
      expect(errorSemanticsCount('degrade', 'rag.search', 'fail')).toBe(1);
    });

    it('embed 成功：返回检索结果且被 degrade 观测到 ok', async () => {
      embedding.embed.mockResolvedValue([1, 0, 0]);
      vectorStore.search.mockReturnValue([]);

      await retriever.search('五粮液多少钱', 'tenant-A');

      expect(vectorStore.search).toHaveBeenCalledWith('tenant-A', [1, 0, 0], 3);
      expect(errorSemanticsCount('degrade', 'rag.search', 'ok')).toBe(1);
    });
  });

  describe('memory.loadHistory（MemoryManager 记忆加载降级）', () => {
    it('Redis get 抛错：返回空历史（行为不变）且被 degrade 观测到 fail', async () => {
      const svc = createMemoryManager({
        get: jest.fn().mockRejectedValue(new Error('redis down')),
        unwatch: jest.fn(),
      });

      const loaded = await svc.loadHistory('t1', 'sess_1');

      expect(loaded).toEqual([]);
      expect(errorSemanticsCount('degrade', 'memory.loadHistory', 'fail')).toBe(
        1,
      );
    });

    it('Redis get 正常：返回历史且被 degrade 观测到 ok', async () => {
      const svc = createMemoryManager({
        get: jest
          .fn()
          .mockResolvedValue(
            JSON.stringify([{ role: 'user', content: '昨天卖了多少' }]),
          ),
        unwatch: jest.fn(),
      });

      const loaded = await svc.loadHistory('t1', 'sess_1');

      expect(loaded).toEqual([{ role: 'user', content: '昨天卖了多少' }]);
      expect(errorSemanticsCount('degrade', 'memory.loadHistory', 'ok')).toBe(
        1,
      );
    });
  });

  describe('provider.parseSseLine（SSE 单行解析降级）', () => {
    let postSpy: jest.SpyInstance;

    afterEach(() => {
      postSpy?.mockRestore();
    });

    it('非法 JSON 行被跳过（行为不变）且被 degrade 观测到 fail', async () => {
      // 第 2 行为非法 JSON：解析失败应跳过该行，整条流继续（不中断）
      const sse = [
        'data: {"choices":[{"delta":{"content":"你好"}}]}',
        'data: 这不是合法JSON（部分 Provider 的心跳行）',
        'data: [DONE]',
        '',
      ].join('\n');
      postSpy = jest.spyOn(axios, 'post').mockResolvedValue({
        data: Readable.from([Buffer.from(sse)]),
      });

      const provider = new OpenAICompatProvider('external_test', {
        baseUrl: 'https://example.com/v1',
        apiKey: 'sk-test',
        model: 'test-model',
      });

      const yielded: string[] = [];
      for await (const chunk of provider.chat([
        { role: 'user', content: '你好' },
      ])) {
        yielded.push(chunk);
      }

      // 行为契约：合法行照常产出，非法行被跳过且流未中断（[DONE] 正常收尾）
      expect(yielded).toEqual(['你好']);
      // 可观测性契约：1 次失败（非法行）+ 1 次成功（合法行）
      expect(
        errorSemanticsCount('degrade', 'provider.parseSseLine', 'fail'),
      ).toBe(1);
      expect(
        errorSemanticsCount('degrade', 'provider.parseSseLine', 'ok'),
      ).toBe(1);
    });
  });
});
