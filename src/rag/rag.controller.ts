/**
 * RAG Controller — 知识库管理接口
 *
 * 职责：
 * 1. POST /api/rag/documents — 上传文档建立索引（解析 → 分块 → 向量化 → 入库）
 * 2. GET  /api/rag/search      — 向量检索 Top-K（query + tenantId）
 * 3. GET  /api/rag/knowledge   — 知识库列表（文档名 / 分块数 / 创建时间）
 *
 * 端点列表：
 * - POST /api/rag/documents  body: { filename, content(base64), tenantId? } → { success, docName, chunkCount, tenantId }
 * - GET  /api/rag/search?query=xxx&tenantId=yyy → { query, results: [{ text, score, docName, chunkIndex }] }
 * - GET  /api/rag/knowledge?tenantId=yyy → { knowledge: [{ docName, chunkCount, createdAt }] }
 *
 * 降级行为：
 * - embedding 未配置（EMBEDDING_MODEL 为空）时，上传文档返回 400 明确提示（无法生成向量），检索/列表正常返回
 * - 单文件大小限制：base64 解码后 ≤ 10MB（防滥用）
 *
 * 对应文档：
 * - docs/ai-base/智享AI底座-架构设计文档.md 第十八章 rag/（检索增强）
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../tenant/admin-auth.guard';
import { DocumentLoaderService } from './document-loader.service';
import { TextSplitterService } from './text-splitter.service';
import { EmbeddingService } from './embedding.service';
import { VectorStoreService } from './vector-store.service';
import { RetrieverService } from './retriever.service';
import { UploadDocumentDto } from './dto/upload-document.dto';

/** 单文件最大字节数（10MB） */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

@UseGuards(AdminGuard)
@Controller('rag')
export class RagController {
  private readonly logger = new Logger(RagController.name);

  constructor(
    private readonly loader: DocumentLoaderService,
    private readonly splitter: TextSplitterService,
    private readonly embedding: EmbeddingService,
    private readonly vectorStore: VectorStoreService,
    private readonly retriever: RetrieverService,
  ) {}

  /**
   * 上传文档建立索引
   *
   * POST /api/rag/documents
   * body: { filename, content(base64), tenantId? }
   */
  @Post('documents')
  async uploadDocument(@Body() dto: UploadDocumentDto): Promise<{
    success: boolean;
    docName: string;
    chunkCount: number;
    tenantId: string;
  }> {
    const tenantId = dto.tenantId ?? 'default';

    // 大小校验（base64 解码后）
    const buffer = Buffer.from(dto.content, 'base64');
    if (buffer.byteLength === 0) {
      throw new BadRequestException('文件内容为空（base64 解码后 0 字节）');
    }
    if (buffer.byteLength > MAX_FILE_BYTES) {
      throw new BadRequestException(
        `文件大小超过限制（最大 ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)}MB）`,
      );
    }

    // embedding 未配置时无法向量化，明确提示（RAG 上传前置条件）
    if (!this.embedding.isEnabled()) {
      throw new BadRequestException(
        'RAG 未启用：EMBEDDING_MODEL 未配置，无法生成文档向量（请在 .env 设置 embedding 模型后重试）',
      );
    }

    // 1. 解析文档 → 纯文本
    const text = await this.loader.loadFromBuffer(buffer, dto.filename);
    if (!text || text.length === 0) {
      throw new BadRequestException(
        `文档 ${dto.filename} 未解析出任何文本内容`,
      );
    }

    // 2. 文本分块（chunk_size=500, overlap=50）
    const chunks = this.splitter.split(text);

    // 3. 逐块向量化
    const embeddings = await Promise.all(
      chunks.map((chunk) => this.embedding.embed(chunk)),
    );

    // 4. 入库（内存 + MySQL 落盘）
    const chunkCount = await this.vectorStore.addChunks(
      tenantId,
      dto.filename,
      chunks.map((text, index) => ({ text, embedding: embeddings[index] })),
    );

    this.logger.log(
      `文档已建立索引：tenant=${tenantId} doc=${dto.filename} chunks=${chunkCount}`,
    );

    return {
      success: true,
      docName: dto.filename,
      chunkCount,
      tenantId,
    };
  }

  /**
   * 向量检索 Top-K
   *
   * GET /api/rag/search?query=xxx&tenantId=yyy&topK=3
   */
  @Get('search')
  async search(
    @Query('query') query?: string,
    @Query('tenantId') tenantId?: string,
    @Query('topK') topK?: string,
  ): Promise<{
    query: string;
    results: unknown[];
    tenantId: string;
  }> {
    if (!query || query.trim().length === 0) {
      throw new BadRequestException('query 不能为空');
    }
    const results = await this.retriever.search(
      query,
      tenantId ?? 'default',
      topK ? this.parseTopK(topK) : 3,
    );
    return { query, results, tenantId: tenantId ?? 'default' };
  }

  /**
   * 知识库列表
   *
   * GET /api/rag/knowledge?tenantId=yyy
   */
  @Get('knowledge')
  listKnowledge(@Query('tenantId') tenantId?: string): {
    knowledge: unknown[];
    tenantId: string;
  } {
    const tid = tenantId ?? 'default';
    return { knowledge: this.vectorStore.listKnowledge(tid), tenantId: tid };
  }

  /**
   * 解析 topK 参数（1~10，非法回退 3）
   */
  private parseTopK(raw: string): number {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) {
      return 3;
    }
    return Math.min(Math.max(parsed, 1), 10);
  }
}
