/**
 * RetrieverService — RAG 检索服务
 *
 * 职责：
 * 1. 将用户查询文本向量化（EmbeddingService）
 * 2. 在向量库中按余弦相似度检索 Top-K 相关分块（VectorStoreService）
 * 3. 未配置 embedding / 向量化失败 / 库为空时优雅降级返回空数组（不抛错，对话主流程不受影响）
 *
 * 降级策略：
 * - embedding 未配置（EMBEDDING_MODEL 为空）→ 跳过 RAG 增强，返回 []
 * - embed 调用失败（本地 Ollama 未启动等）→ warn + 返回 []
 * - 知识库为空 / 无匹配 → 返回 []
 *
 * 对应文档：
 * - docs/ai-base/智享AI底座-架构设计文档.md 第十八章 rag/（检索匹配）
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import { Injectable, Logger } from '@nestjs/common';
import { EmbeddingService } from './embedding.service';
import { RetrievalResult, VectorStoreService } from './vector-store.service';

@Injectable()
export class RetrieverService {
  private readonly logger = new Logger(RetrieverService.name);

  constructor(
    private readonly embeddingService: EmbeddingService,
    private readonly vectorStore: VectorStoreService,
  ) {}

  /**
   * 检索与查询文本最相关的知识库分块
   *
   * @param query 用户查询文本
   * @param tenantId 租户 ID（多租户隔离）
   * @param topK 返回条数（默认 3）
   * @returns 检索结果数组（降级场景返回空数组）
   */
  async search(
    query: string,
    tenantId: string,
    topK = 3,
  ): Promise<RetrievalResult[]> {
    // 未配置 embedding → 降级跳过 RAG 增强
    if (!this.embeddingService.isEnabled()) {
      this.logger.warn(
        'RAG 向量检索已降级禁用（EMBEDDING_MODEL 未配置），跳过知识库增强',
      );
      return [];
    }

    try {
      const queryEmbedding = await this.embeddingService.embed(query);
      return this.vectorStore.search(tenantId, queryEmbedding, topK);
    } catch (err) {
      this.logger.warn(
        `RAG 向量检索失败（跳过知识库增强）：${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }
}
