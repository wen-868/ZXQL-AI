/**
 * VectorStoreService — 向量存储服务（内存 Map + 可选 MySQL 落盘）
 *
 * 职责：
 * 1. 内存 Map 保存租户隔离的知识库分块（tenantId → KnowledgeChunk[]）
 * 2. 可选 MySQL 落盘（t_ai_knowledge_chunks 表，直查 DataSource.query，不使用 TypeORM Entity）
 * 3. 余弦相似度检索 Top-K
 * 4. 知识库列表（文档名 / 分块数 / 创建时间）
 *
 * 存储设计：
 * - 内存为查询主存储（检索零延迟）；MySQL 为持久化兜底（重启后 loadAllFromDb 恢复）
 * - MySQL 不可用时静默降级为纯内存模式（warn 日志，不抛错，不影响检索）
 * - 同文档重复上传采用"覆盖"语义：先删旧分块再插入新分块
 *
 * 数据访问规范：this.dataSource.query<Row[]>(...) 泛型签名（Row = Record<string, unknown>），
 * 避免 no-unsafe-member-access 等 ESLint 严格检查。
 *
 * 对应文档：
 * - docs/ai-base/智享AI底座-架构设计文档.md 第十七章 16.2 RAG 存储选型（内存向量）
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';

/** 知识库分块（内存存储单元） */
export interface KnowledgeChunk {
  /** 分块唯一 ID */
  id: string;
  /** 租户 ID */
  tenantId: string;
  /** 文档名称（含扩展名） */
  docName: string;
  /** 分块序号（从 0 开始） */
  chunkIndex: number;
  /** 分块文本 */
  chunkText: string;
  /** 文本向量 */
  embedding: number[];
  /** 创建时间 */
  createdAt: Date;
}

/** 检索结果 */
export interface RetrievalResult {
  /** 分块文本 */
  text: string;
  /** 余弦相似度（0~1） */
  score: number;
  /** 文档名称 */
  docName: string;
  /** 分块序号 */
  chunkIndex: number;
}

/** 知识库文档元信息（列表展示用） */
export interface KnowledgeDocMeta {
  /** 文档名称 */
  docName: string;
  /** 分块数 */
  chunkCount: number;
  /** 首次入库时间 */
  createdAt: Date;
}

/** 新增分块入参 */
export interface AddChunkInput {
  /** 分块文本 */
  text: string;
  /** 文本向量 */
  embedding: number[];
}

/** DataSource.query 的行类型（避免 no-unsafe 严格检查） */
type Row = Record<string, unknown>;

/** MySQL 落盘表名 */
const TABLE_NAME = 't_ai_knowledge_chunks';

@Injectable()
export class VectorStoreService implements OnModuleInit {
  private readonly logger = new Logger(VectorStoreService.name);

  /** 内存向量库：tenantId → 分块列表（查询主存储） */
  private readonly store = new Map<string, KnowledgeChunk[]>();

  constructor(@Optional() private readonly dataSource?: DataSource) {}

  /**
   * 模块初始化：从 MySQL 加载历史分块到内存（DB 不可用时仅内存模式）
   */
  async onModuleInit(): Promise<void> {
    if (!this.dataSource) {
      return;
    }
    await this.loadAllFromDb();
  }

  /**
   * 从 MySQL 全量加载分块到内存
   *
   * DB 异常时 warn 降级为纯内存模式，不抛错。
   */
  async loadAllFromDb(): Promise<void> {
    try {
      const rows = await this.dataSource!.query<Row[]>(
        `SELECT tenant_id, doc_name, chunk_index, chunk_text, embedding, created_at FROM ${TABLE_NAME}`,
      );
      const grouped = new Map<string, KnowledgeChunk[]>();
      for (const row of rows) {
        const tenantId = VectorStoreService.toStr(row.tenant_id);
        if (!tenantId) {
          continue;
        }
        const chunk = this.rowToChunk(row);
        if (!chunk) {
          continue;
        }
        const list = grouped.get(tenantId) ?? [];
        list.push(chunk);
        grouped.set(tenantId, list);
      }
      this.store.clear();
      for (const [tenantId, chunks] of grouped) {
        this.store.set(tenantId, chunks);
      }
      this.logger.log(
        `知识库已从数据库恢复：${grouped.size} 个租户，${rows.length} 个分块`,
      );
    } catch (err) {
      this.logger.warn(
        `从数据库加载知识库分块失败（降级为纯内存模式）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 批量新增分块（内存 + 可选 MySQL 落盘）
   *
   * 同文档重复上传采用覆盖语义：先删除该文档旧分块，再写入新分块。
   *
   * @param tenantId 租户 ID
   * @param docName 文档名称
   * @param chunks 分块列表
   * @returns 实际写入的分块数
   */
  async addChunks(
    tenantId: string,
    docName: string,
    chunks: AddChunkInput[],
  ): Promise<number> {
    const createdAt = new Date();
    const list = chunks.map((input, index) => ({
      id: randomUUID(),
      tenantId,
      docName,
      chunkIndex: index,
      chunkText: input.text,
      embedding: input.embedding,
      createdAt,
    }));

    // 覆盖语义：先删旧分块
    await this.removeDoc(tenantId, docName);

    // 写内存
    const existing = this.store.get(tenantId) ?? [];
    existing.push(...list);
    this.store.set(tenantId, existing);

    // 可选 MySQL 落盘（失败仅 warn，不影响内存检索）
    if (this.dataSource) {
      try {
        await this.persistChunks(list);
      } catch (err) {
        this.logger.warn(
          `知识库分块写入数据库失败（本次仅内存生效）：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    this.logger.debug(
      `知识库新增文档：tenant=${tenantId} doc=${docName} chunks=${list.length}`,
    );
    return list.length;
  }

  /**
   * 删除某租户的某个文档（内存 + MySQL）
   */
  async removeDoc(tenantId: string, docName: string): Promise<void> {
    const existing = this.store.get(tenantId) ?? [];
    this.store.set(
      tenantId,
      existing.filter((c) => c.docName !== docName),
    );

    if (this.dataSource) {
      try {
        await this.dataSource.query(
          `DELETE FROM ${TABLE_NAME} WHERE tenant_id = ? AND doc_name = ?`,
          [tenantId, docName],
        );
      } catch (err) {
        this.logger.warn(
          `删除数据库中的旧分块失败（忽略）：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * 余弦相似度检索 Top-K
   *
   * @param tenantId 租户 ID（多租户隔离）
   * @param queryEmbedding 查询向量
   * @param topK 返回条数（默认 3）
   * @returns 按相似度降序的检索结果
   */
  search(
    tenantId: string,
    queryEmbedding: number[],
    topK = 3,
  ): RetrievalResult[] {
    const chunks = this.store.get(tenantId) ?? [];
    const scored = chunks.map((c) => ({
      chunk: c,
      score: VectorStoreService.cosineSimilarity(queryEmbedding, c.embedding),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map((s) => ({
      text: s.chunk.chunkText,
      score: s.score,
      docName: s.chunk.docName,
      chunkIndex: s.chunk.chunkIndex,
    }));
  }

  /**
   * 知识库文档列表（按文档聚合）
   *
   * @param tenantId 租户 ID
   */
  listKnowledge(tenantId: string): KnowledgeDocMeta[] {
    const chunks = this.store.get(tenantId) ?? [];
    const byDoc = new Map<string, { count: number; createdAt: Date }>();
    for (const c of chunks) {
      const entry = byDoc.get(c.docName);
      if (entry) {
        entry.count += 1;
      } else {
        byDoc.set(c.docName, { count: 1, createdAt: c.createdAt });
      }
    }
    return Array.from(byDoc.entries()).map(([docName, v]) => ({
      docName,
      chunkCount: v.count,
      createdAt: v.createdAt,
    }));
  }

  /**
   * 获取租户分块总数（用于校验/统计）
   */
  countChunks(tenantId: string): number {
    return (this.store.get(tenantId) ?? []).length;
  }

  /**
   * 批量写入 MySQL（embedding 以 JSON 字符串存储，MySQL JSON 列）
   */
  private async persistChunks(chunks: KnowledgeChunk[]): Promise<void> {
    for (const c of chunks) {
      await this.dataSource!.query(
        `INSERT INTO ${TABLE_NAME} (tenant_id, doc_name, chunk_index, chunk_text, embedding, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          c.tenantId,
          c.docName,
          c.chunkIndex,
          c.chunkText,
          JSON.stringify(c.embedding),
          c.createdAt,
        ],
      );
    }
  }

  /**
   * 将 MySQL 行转换为内存分块（字段缺失/embedding 解析失败返回 null）
   */
  private rowToChunk(row: Row): KnowledgeChunk | null {
    const docName = VectorStoreService.toStr(row.doc_name);
    const chunkText = VectorStoreService.toStr(row.chunk_text);
    if (!docName || !chunkText) {
      return null;
    }
    return {
      id: `${docName}:${VectorStoreService.toStr(row.chunk_index, '0')}`,
      tenantId: VectorStoreService.toStr(row.tenant_id),
      docName,
      chunkIndex: Number(row.chunk_index ?? 0),
      chunkText,
      embedding: VectorStoreService.parseEmbedding(row.embedding),
      createdAt: new Date(
        VectorStoreService.toStr(row.created_at, String(Date.now())),
      ),
    };
  }

  /**
   * 解析 embedding 字段为向量数组
   *
   * 兼容两种存储形态：
   * - 字符串 JSON（如 '[0.1,0.2]'）
   * - MySQL JSON 列被 mysql2 自动解析后的 JS 数组
   *
   * 非法值 / 非数组返回空数组。
   */
  private static parseEmbedding(value: unknown): number[] {
    let parsed: unknown;
    if (typeof value === 'string') {
      try {
        parsed = JSON.parse(value);
      } catch {
        return [];
      }
    } else {
      parsed = value;
    }
    return Array.isArray(parsed) ? (parsed as number[]) : [];
  }

  /**
   * 将 unknown 值安全转为字符串（供数据库行字段使用，避免 no-base-to-string）
   *
   * 支持：string / number / bigint / boolean / Date；其余（含数组/对象）返回 fallback。
   */
  private static toStr(value: unknown, fallback = ''): string {
    if (value === null || value === undefined) {
      return fallback;
    }
    if (typeof value === 'string') {
      return value;
    }
    if (
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      typeof value === 'boolean'
    ) {
      return String(value);
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    return fallback;
  }

  /**
   * 余弦相似度（向量长度不等 / 零向量返回 0）
   */
  static cosineSimilarity(a: number[], b: number[]): number {
    if (a.length === 0 || b.length === 0 || a.length !== b.length) {
      return 0;
    }
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) {
      return 0;
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
