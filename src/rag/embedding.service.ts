/**
 * EmbeddingService — 文本向量化服务（OpenAI 兼容 embedding）
 *
 * 职责：
 * 1. 调用 OpenAI 兼容的 POST /embeddings 端点生成文本向量（默认指向本地 Ollama）
 * 2. 未配置 EMBEDDING_MODEL 时降级禁用（isEnabled() = false，不抛错，RAG 检索跳过增强）
 *
 * 环境变量：
 * - EMBEDDING_BASE_URL：embedding 服务基础地址（默认 http://localhost:11434/v1，即本地 Ollama 的 OpenAI 兼容端点）
 * - EMBEDDING_API_KEY：API Key（本地 Ollama 可留空）
 * - EMBEDDING_MODEL：embedding 模型名（如 nomic-embed-text）。为空时判定为"未配置"，RAG 降级禁用
 *
 * 降级策略（与 providers/ 层 assertConfigured 思路一致）：
 * - isEnabled() 不抛错，供调用方（RetrieverService / RagController）判断是否跳过 RAG
 * - embed() 在未配置时抛错（调用方捕获后降级返回空结果，保证对话主流程不受影响）
 *
 * 对应文档：
 * - docs/ai-base/智享AI底座-架构设计文档.md 第十七章 16.2 RAG 存储选型（内存向量）
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

/** embedding 服务默认基础地址（本地 Ollama 的 OpenAI 兼容端点） */
const DEFAULT_EMBEDDING_BASE_URL = 'http://localhost:11434/v1';

/** OpenAI 兼容 /embeddings 响应结构 */
interface EmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
  error?: { message?: string };
}

/**
 * embedding 调用异常（统一包装，便于调用方捕获降级）
 */
export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);

  /** 服务基础地址（OpenAI 兼容，末尾不带斜杠） */
  private readonly baseUrl: string;
  /** API Key（本地 Ollama 可留空） */
  private readonly apiKey: string;
  /** embedding 模型名（空 = 未配置，降级禁用） */
  private readonly model: string;
  /** 单次请求超时（毫秒） */
  private readonly timeoutMs: number;

  constructor(configService: ConfigService) {
    this.baseUrl = (
      configService.get<string>(
        'EMBEDDING_BASE_URL',
        DEFAULT_EMBEDDING_BASE_URL,
      ) ?? DEFAULT_EMBEDDING_BASE_URL
    ).replace(/\/+$/, '');
    this.apiKey = configService.get<string>('EMBEDDING_API_KEY', '') ?? '';
    this.model = configService.get<string>('EMBEDDING_MODEL', '') ?? '';
    this.timeoutMs = configService.get<number>('EMBEDDING_TIMEOUT_MS', 30000);
  }

  /**
   * 是否已配置可用的 embedding 模型
   *
   * 判定标准：EMBEDDING_MODEL 非空即视为已配置。
   * 未配置时 RAG 检索增强降级跳过（对话主流程不受影响）。
   */
  isEnabled(): boolean {
    return this.model.length > 0;
  }

  /**
   * 生成单条文本的向量
   *
   * @param text 待向量化文本
   * @returns 向量数组（number[]）
   * @throws EmbeddingError 未配置模型 / 服务返回空 / 网络异常
   */
  async embed(text: string): Promise<number[]> {
    if (!this.isEnabled()) {
      throw new EmbeddingError(
        'EMBEDDING_MODEL 未配置，RAG 向量检索已降级禁用（请在 .env 设置 embedding 模型后重启服务）',
      );
    }

    let response;
    try {
      response = await axios.post<EmbeddingResponse>(
        `${this.baseUrl}/embeddings`,
        {
          model: this.model,
          input: text,
        },
        {
          headers: this.buildHeaders(),
          timeout: this.timeoutMs,
        },
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(`embedding 服务调用失败（${this.baseUrl}）：${detail}`);
      throw new EmbeddingError(`embedding 服务调用失败：${detail}`);
    }

    if (response.data?.error?.message) {
      throw new EmbeddingError(
        `embedding 服务返回错误：${response.data.error.message}`,
      );
    }

    const first = response.data?.data?.[0];
    if (!first?.embedding || first.embedding.length === 0) {
      throw new EmbeddingError('embedding 服务返回空向量');
    }

    return first.embedding;
  }

  /**
   * 构造请求头（本地 Ollama 无 Key 时不带 Authorization）
   */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.apiKey.length > 0) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }
}
