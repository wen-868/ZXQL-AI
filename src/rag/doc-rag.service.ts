/**
 * DocRagService — 文档中心 ↔ RAG 贯通（**S3 关键件**；R101-AI-35）
 *
 * 职责：把 `t_ai_doc` 的一份文档内容喂进既有 RAG 管线，并把分块与文档**显式关联**。
 * - 分块：`TextSplitterService.split`（复用，不重造）
 * - 向量：`EmbeddingService.embed`（复用；`isEnabled()` 先判，未配置 ⇒ 直接 failed 不打网络）
 * - 落库：`VectorStoreService.addChunks`（复用，**零改动**）
 * - 关联（**方案 A**，凌舟裁定）：`doc_name = String(docId)`，随后
 *   `UPDATE t_ai_knowledge_chunks SET doc_id = ? WHERE tenant_id = ? AND doc_name = ?` 回填显式列
 *   ⇒ 既有 RAG 三服务零回归，且 `doc_id` 是**显式列**而非靠名字猜
 *
 * 🔴 **主次不能倒置**：RAG 是**增强**而非前提 ⇒ 本服务所有方法**绝不抛异常**；
 * 失败一律返回 `'failed'`，由调用方把文档标为 `ragStatus='failed'`（文档本身仍然入库成功）。
 *
 * 可重试（`reindexPending`）：从**已落库的 chunks**重算向量（`chunk_text` 已在库，无需原始正文）。
 * ⚠️ 边界（如实声明）：若失败发生在 `addChunks` **之前**（连分块都没落库），且该文档为
 * `source_type='generated'`（正文不在库里，`t_ai_doc` 无 content 列），则**无法自动重试** ——
 * 需后续补"正文持久化"或由来源系统重新投递（已在回传中报备）。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-15
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EmbeddingService } from './embedding.service';
import { TextSplitterService } from './text-splitter.service';
import { AddChunkInput, VectorStoreService } from './vector-store.service';

/** RAG 索引结果（对应 t_ai_doc.rag_status 的非 pending 取值） */
export type RagIndexStatus = 'ready' | 'failed';

/** 文档的最小入参（只需 id + tenantId；避免耦合实体全字段） */
interface RagDocRef {
  id: string;
  tenantId: string;
}

@Injectable()
export class DocRagService {
  private readonly logger = new Logger(DocRagService.name);

  constructor(
    private readonly splitter: TextSplitterService,
    private readonly embedding: EmbeddingService,
    private readonly vectorStore: VectorStoreService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * 把文档内容索引进 RAG（分块 → 向量化 → 落库带 doc_id）
   *
   * **绝不抛**：任何失败 ⇒ `'failed'`（文档仍视为入库成功）
   */
  async indexDoc(doc: RagDocRef, content: string): Promise<RagIndexStatus> {
    const docName = String(doc.id); // 方案 A：以 docId 作为 RAG 聚合键
    try {
      if (typeof content !== 'string' || content.trim().length === 0) {
        this.logger.warn(`RAG 索引跳过（正文为空）：doc=${docName}`);
        return 'failed';
      }
      if (!this.embedding.isEnabled()) {
        this.logger.warn(
          `RAG 索引失败（embedding 未启用/未配置）：doc=${docName}`,
        );
        return 'failed';
      }

      const chunks = this.splitter.split(content);
      if (chunks.length === 0) {
        this.logger.warn(`RAG 索引失败（分块为空）：doc=${docName}`);
        return 'failed';
      }

      const inputs: AddChunkInput[] = [];
      for (const text of chunks) {
        inputs.push({ text, embedding: await this.embedding.embed(text) });
      }

      const written = await this.vectorStore.addChunks(
        doc.tenantId,
        docName,
        inputs,
      );

      // 方案 A 的关键一步：把显式 doc_id 回填到刚写入的分块
      await this.dataSource.query(
        'UPDATE t_ai_knowledge_chunks SET doc_id = ? WHERE tenant_id = ? AND doc_name = ?',
        [doc.id, doc.tenantId, docName],
      );

      this.logger.log(
        `RAG 索引完成：doc=${docName} tenant=${doc.tenantId} 分块=${written}`,
      );
      return 'ready';
    } catch (err) {
      // 🔴 绝不外抛：RAG 失败不得影响文档入库
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `RAG 索引失败（不影响文档入库）：doc=${docName} err=${message}`,
      );
      return 'failed';
    }
  }

  /**
   * 重试：对 `rag_status IN ('pending','failed')` 且**已有 chunks** 的文档重算向量
   *
   * 为什么不需要原始正文：`t_ai_knowledge_chunks.chunk_text` 已在库 ⇒ 直接重算 embedding 并覆盖写回。
   *
   * **绝不抛**；返回 `{ retried, ready, failed }`。未落任何 chunk 的文档**无法**在此重试（见文件头边界说明）。
   */
  async reindexPending(
    tenantId: string,
    limit = 20,
  ): Promise<{ retried: number; ready: number; failed: number }> {
    let retried = 0;
    let ready = 0;
    let failed = 0;
    try {
      const docs = await this.dataSource.query<Array<{ id: string | number }>>(
        `SELECT id FROM t_ai_doc WHERE tenant_id = ? AND rag_status IN ('pending','failed') ORDER BY updated_at ASC LIMIT ${Math.max(1, Math.floor(limit))}`,
        [tenantId],
      );

      for (const row of docs) {
        const docId = String(row.id);
        const chunks = await this.dataSource.query<
          Array<{ chunk_index: number; chunk_text: string }>
        >(
          'SELECT chunk_index, chunk_text FROM t_ai_knowledge_chunks WHERE tenant_id = ? AND doc_name = ? ORDER BY chunk_index ASC',
          [tenantId, docId],
        );

        if (chunks.length === 0) {
          // 无分块可重算（失败发生在落块之前）⇒ 保持原状态，不计入失败（等待来源重投）
          this.logger.warn(`RAG 重试跳过（无已落库分块）：doc=${docId}`);
          continue;
        }

        retried += 1;
        const status = await this.indexDoc(
          { id: docId, tenantId },
          chunks.map((c) => c.chunk_text).join('\n'),
        );
        await this.dataSource.query(
          'UPDATE t_ai_doc SET rag_status = ? WHERE id = ? AND tenant_id = ?',
          [status, docId, tenantId],
        );
        if (status === 'ready') ready += 1;
        else failed += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`RAG 重试批量失败（不影响调用方）：${message}`);
    }
    return { retried, ready, failed };
  }
}
