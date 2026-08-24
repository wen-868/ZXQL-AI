/**
 * RagSeedService — RAG 预置知识库加载（AI 底座完善度 P1）
 *
 * 职责：
 * 1. 服务启动时（embedding 已配置的前提下）检查默认租户知识库
 * 2. 知识库为空时，自动加载 knowledge/ 目录下的预置运营文档（单据编号规则、
 *    库存管理规则、系统功能说明、客户类型与等级），建立向量索引
 * 3. 单文档加载失败仅记日志并跳过，不阻塞服务启动；知识库已有内容时不重复加载
 *
 * 设计说明：
 * - 预置文档为真实运营规则（非示例假数据），解决"引擎就绪无知识内容"缺口
 * - 依赖 VectorStoreService 启动时已从 MySQL 恢复内存索引，因此以
 *   listKnowledge('default') 是否为空作为是否需要种子的判断
 * - embedding 未配置（EMBEDDING_MODEL 为空）时跳过，服务仍可正常启动
 *
 * 对应文档：
 * - docs/AI底座完善度分析报告.md 五、P1 RAG 知识库内容
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-15
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readdir } from 'fs/promises';
import { join } from 'path';
import { DocumentLoaderService } from './document-loader.service';
import { TextSplitterService } from './text-splitter.service';
import { EmbeddingService } from './embedding.service';
import { VectorStoreService } from './vector-store.service';

/** 默认租户 ID（与 RAG 接口 tenantId 默认值一致） */
const DEFAULT_TENANT_ID = 'default';
/** 预置知识目录（相对 ai-base 工作目录） */
const DEFAULT_KNOWLEDGE_DIR = 'knowledge';

@Injectable()
export class RagSeedService implements OnModuleInit {
  private readonly logger = new Logger(RagSeedService.name);
  private readonly knowledgeDir: string;

  constructor(
    private readonly loader: DocumentLoaderService,
    private readonly splitter: TextSplitterService,
    private readonly embedding: EmbeddingService,
    private readonly vectorStore: VectorStoreService,
  ) {
    this.knowledgeDir = join(process.cwd(), DEFAULT_KNOWLEDGE_DIR);
  }

  /**
   * 启动钩子：embedding 已配置时尝试加载预置知识库
   *
   * 所有异常均捕获并降级，绝不阻塞服务启动。
   */
  async onModuleInit(): Promise<void> {
    if (!this.embedding.isEnabled()) {
      this.logger.log(
        'RAG 未启用（EMBEDDING_MODEL 未配置），跳过预置知识库加载',
      );
      return;
    }

    try {
      const loaded = await this.seedFromDir(this.knowledgeDir);
      if (loaded > 0) {
        this.logger.log(`预置知识库加载完成：${loaded} 份文档已建立索引`);
      }
    } catch (err) {
      this.logger.warn(
        `预置知识库加载异常（不影响服务启动）：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * 从指定目录加载预置 markdown 文档到默认租户知识库
   *
   * @param dir 预置文档目录（含 .md 文件）
   * @returns 成功加载的文档数
   */
  async seedFromDir(dir: string): Promise<number> {
    // 文档级幂等：跳过已入库的同名文档，新增/更新文档正常加载
    const existing = this.vectorStore.listKnowledge(DEFAULT_TENANT_ID);
    const existingNames = new Set(
      existing
        .map((doc) => doc.docName)
        .filter((name): name is string => !!name),
    );

    let files: string[];
    try {
      files = (await readdir(dir))
        .filter((name) => name.endsWith('.md'))
        .sort();
    } catch (err) {
      this.logger.warn(
        `读取预置知识目录失败（${dir}）：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 0;
    }
    if (files.length === 0) {
      this.logger.log(`预置知识目录 ${dir} 无 markdown 文档，跳过`);
      return 0;
    }

    let loaded = 0;
    for (const file of files) {
      if (existingNames.has(file)) {
        this.logger.log(`预置知识文档已存在（跳过）：${file}`);
        continue;
      }
      try {
        const text = await this.loader.loadFromFile(join(dir, file));
        const chunks = this.splitter.split(text);
        if (chunks.length === 0) {
          this.logger.warn(`预置文档无有效内容（跳过）：${file}`);
          continue;
        }
        const embeddings = await Promise.all(
          chunks.map((chunk) => this.embedding.embed(chunk)),
        );
        await this.vectorStore.addChunks(
          DEFAULT_TENANT_ID,
          file,
          chunks.map((text, index) => ({
            text,
            embedding: embeddings[index],
          })),
        );
        loaded += 1;
        this.logger.log(`预置知识文档已加载：${file}（${chunks.length} 分块）`);
      } catch (err) {
        this.logger.warn(
          `预置知识文档加载失败（跳过）：${file}：${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return loaded;
  }
}
