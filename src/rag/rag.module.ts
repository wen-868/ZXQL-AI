/**
 * RagModule — RAG 知识库引擎模块
 *
 * 注册服务：
 * - DocumentLoaderService：文档加载（PDF/Word/Markdown/Excel）
 * - TextSplitterService：文本分块（chunk_size=500, overlap=50）
 * - EmbeddingService：文本向量化（OpenAI 兼容，默认本地 Ollama，未配置降级禁用）
 * - VectorStoreService：内存向量库 + 可选 MySQL 落盘（t_ai_knowledge_chunks）
 * - RetrieverService：余弦相似度 Top-K 检索（未配置 embedding 时降级返回空）
 *
 * 对外导出：
 * - RetrieverService（供 BrainModule 的 ContextBuilder 注入，实现对话 RAG 增强）
 * - EmbeddingService / VectorStoreService（供管理接口 / 后续模块复用）
 *
 * 依赖：
 * - DatabaseModule（TypeORM DataSource，用于可选 MySQL 落盘）
 *
 * 被 AppModule 导入（R70-21），被 BrainModule 导入（获取 RetrieverService）。
 * 无循环依赖：RagModule 只依赖 DatabaseModule，不依赖 BrainModule。
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { DocumentLoaderService } from './document-loader.service';
import { TextSplitterService } from './text-splitter.service';
import { EmbeddingService } from './embedding.service';
import { VectorStoreService } from './vector-store.service';
import { RetrieverService } from './retriever.service';
import { RagController } from './rag.controller';
import { RagSeedService } from './rag-seed.service';

@Module({
  imports: [DatabaseModule],
  controllers: [RagController],
  providers: [
    DocumentLoaderService,
    TextSplitterService,
    EmbeddingService,
    VectorStoreService,
    RetrieverService,
    RagSeedService,
  ],
  exports: [RetrieverService, EmbeddingService, VectorStoreService],
})
export class RagModule {}
