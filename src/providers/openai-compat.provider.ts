/**
 * OpenAICompatProvider — 通用 OpenAI 兼容外部大模型 Provider
 *
 * 用途（完善度-外部大模型接入）：
 * 1. 平台可添加任意 OpenAI 兼容外部模型（自定义 base_url + api_key + 模型名）
 * 2. ProviderFactory.registerExternal() 动态创建本类实例，name 为外部模型唯一标识
 * 3. 协议处理与 GLM/DeepSeek 一致（POST {baseUrl}/chat/completions，支持流式 + Function Calling）
 *
 * 说明：
 * - 非 Injectable：由外部模型服务动态实例化，不进入 Nest 容器
 * - 不支持 embedding（外部模型一般无向量接口，RAG 向量继续用 Ollama/配置的 embedding 服务）
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-15
 */
import { Logger } from '@nestjs/common';
import axios, { AxiosResponse } from 'axios';
import type { Readable } from 'stream';
import {
  ChatMessage,
  ChatOptions,
  ChatResult,
  ConnectionTestResult,
  IModelProvider,
  ProviderConfig,
  ToolCall,
  ToolDefinition,
} from './provider.interface';
import { ProviderError } from './provider-error';

/** OpenAI 兼容请求体 */
interface OpenAICompatRequestBody {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  tools?: ToolDefinition[];
  stream?: boolean;
}

/** OpenAI 兼容非流式响应 */
interface OpenAICompatResponse {
  id?: string;
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** OpenAI 兼容流式 chunk */
interface OpenAICompatStreamChunk {
  choices?: Array<{
    delta: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** 流式 tool_calls 聚合中间结构 */
interface ToolCallAccumulator {
  index: number;
  id?: string;
  type: 'function';
  name?: string;
  arguments: string;
}

/** 运行时配置 */
interface RuntimeConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

export class OpenAICompatProvider implements IModelProvider {
  readonly name: string;
  private readonly logger: Logger;
  private config!: RuntimeConfig;

  constructor(name: string, config: ProviderConfig) {
    this.name = name;
    this.logger = new Logger(`OpenAICompat:${name}`);
    this.applyConfig(config);
  }

  /** 注入运行时配置（ProviderFactory.create() 调用） */
  configure(config: ProviderConfig): void {
    this.applyConfig(config);
  }

  private applyConfig(config: ProviderConfig): void {
    this.config = {
      apiKey: config.apiKey,
      baseUrl: (config.baseUrl ?? '').replace(/\/+$/, ''),
      model: config.model,
      temperature: config.temperature ?? 0.3,
      maxTokens: config.max_tokens ?? 2048,
      timeoutMs: config.timeoutMs ?? 30000,
    };
  }

  /**
   * 流式对话：逐 token 返回（SSE）
   */
  async *chat(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): AsyncGenerator<string, ChatResult, unknown> {
    this.assertConfigured();
    const cfg = this.config;
    const requestBody: OpenAICompatRequestBody = {
      model: cfg.model,
      messages,
      temperature: options?.temperature ?? cfg.temperature,
      max_tokens: options?.max_tokens ?? cfg.maxTokens,
      stream: true,
    };
    if (options?.tools && options.tools.length > 0) {
      requestBody.tools = options.tools;
    }

    this.logger.debug(
      `流式调用外部模型：model=${cfg.model}, messages=${messages.length}条`,
    );

    let response: AxiosResponse<Readable>;
    try {
      response = await axios.post<Readable>(
        `${cfg.baseUrl}/chat/completions`,
        requestBody,
        {
          headers: this.buildHeaders(),
          responseType: 'stream',
          timeout: cfg.timeoutMs,
          signal: options?.signal,
        },
      );
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw ProviderError.fromAxiosError(err, this.name);
    }

    let contentBuf = '';
    const toolCallMap = new Map<number, ToolCallAccumulator>();
    let finishReason = 'stop';
    let promptTokens = 0;
    let completionTokens = 0;
    let buffer = '';
    const stream = response.data;
    const decoder = new TextDecoder('utf-8');

    try {
      for await (const chunk of stream) {
        if (options?.signal?.aborted) {
          stream.destroy();
          break;
        }

        buffer += decoder.decode(chunk as Buffer, { stream: true });
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);

          if (!line || line.startsWith(':')) continue;
          if (!line.startsWith('data:')) continue;

          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            buffer = '';
            return this.buildResult(
              contentBuf,
              toolCallMap,
              finishReason,
              promptTokens,
              completionTokens,
            );
          }

          let parsed: OpenAICompatStreamChunk;
          try {
            parsed = JSON.parse(data) as OpenAICompatStreamChunk;
          } catch (err) {
            this.logger.warn(
              `SSE 行 JSON 解析失败，跳过：${data.slice(0, 100)}${err instanceof Error ? ` (${err.message})` : ''}`,
            );
            continue;
          }

          if (parsed.usage) {
            promptTokens = parsed.usage.prompt_tokens ?? 0;
            completionTokens = parsed.usage.completion_tokens ?? 0;
          }

          const choice = parsed.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
          }
          const delta = choice.delta;
          if (!delta) continue;

          if (delta.content) {
            contentBuf += delta.content;
            yield delta.content;
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const existing = toolCallMap.get(tc.index);
              if (!existing) {
                toolCallMap.set(tc.index, {
                  index: tc.index,
                  id: tc.id,
                  type: 'function',
                  name: tc.function?.name,
                  arguments: tc.function?.arguments ?? '',
                });
              } else {
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name = tc.function.name;
                if (tc.function?.arguments) {
                  existing.arguments += tc.function.arguments;
                }
              }
            }
          }
        }
      }
    } catch (err) {
      if (options?.signal?.aborted) {
        this.logger.warn(`${this.name} 流式调用已被取消`);
      } else {
        if (err instanceof ProviderError) throw err;
        throw ProviderError.fromAxiosError(err, this.name);
      }
    }

    return this.buildResult(
      contentBuf,
      toolCallMap,
      finishReason,
      promptTokens,
      completionTokens,
    );
  }

  /**
   * 非流式对话：一次性返回完整结果
   */
  async chatSync(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): Promise<ChatResult> {
    this.assertConfigured();
    const cfg = this.config;
    const requestBody: OpenAICompatRequestBody = {
      model: cfg.model,
      messages,
      temperature: options?.temperature ?? cfg.temperature,
      max_tokens: options?.max_tokens ?? cfg.maxTokens,
      stream: false,
    };
    if (options?.tools && options.tools.length > 0) {
      requestBody.tools = options.tools;
    }

    this.logger.debug(
      `非流式调用外部模型：model=${cfg.model}, messages=${messages.length}条`,
    );

    let response: AxiosResponse<OpenAICompatResponse>;
    try {
      response = await axios.post<OpenAICompatResponse>(
        `${cfg.baseUrl}/chat/completions`,
        requestBody,
        {
          headers: this.buildHeaders(),
          timeout: cfg.timeoutMs,
          signal: options?.signal,
        },
      );
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw ProviderError.fromAxiosError(err, this.name);
    }

    const choice = response.data.choices?.[0];
    const message = choice?.message;
    const usage = response.data.usage;

    const toolCalls: ToolCall[] | undefined = message?.tool_calls
      ?.filter((tc) => tc.function?.name)
      .map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments ?? '{}',
        },
      }));

    return {
      content: message?.content ?? '',
      tool_calls: toolCalls,
      prompt_tokens: usage?.prompt_tokens ?? 0,
      completion_tokens: usage?.completion_tokens ?? 0,
      finish_reason:
        (choice?.finish_reason as ChatResult['finish_reason']) ?? 'stop',
    };
  }

  /**
   * 外部模型默认不提供 embedding（RAG 向量继续用配置的 embedding 服务）
   */
  embedding(_text: string): Promise<number[]> {
    throw new ProviderError(
      `外部模型 ${this.name} 不提供 embedding 接口（RAG 向量请配置 EMBEDDING_MODEL）`,
      400,
      this.name,
    );
  }

  /**
   * 连通性测试：发送一条最短消息验证 API Key + 网络连通性
   */
  async testConnection(): Promise<ConnectionTestResult> {
    this.assertConfigured();
    const start = Date.now();
    try {
      const result = await this.chatSync([{ role: 'user', content: 'ping' }], {
        max_tokens: 1,
      });
      return {
        success: true,
        message: `连接成功：模型 ${this.config.model} 返回 ${result.content.slice(0, 50) || '(空)'}`,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      const message =
        err instanceof ProviderError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      return {
        success: false,
        message: `连接失败：${message}`,
        latencyMs: Date.now() - start,
      };
    }
  }

  /** 组装最终 ChatResult（流式结束 / [DONE] 时调用） */
  private buildResult(
    content: string,
    toolCallMap: Map<number, ToolCallAccumulator>,
    finishReason: string,
    promptTokens: number,
    completionTokens: number,
  ): ChatResult {
    const toolCalls: ToolCall[] | undefined =
      toolCallMap.size > 0
        ? [...toolCallMap.values()]
            .sort((a, b) => a.index - b.index)
            .filter((tc) => tc.name)
            .map((tc) => ({
              id: tc.id ?? `call_${tc.index}`,
              type: 'function' as const,
              function: {
                name: tc.name ?? '',
                arguments: tc.arguments || '{}',
              },
            }))
        : undefined;

    return {
      content,
      tool_calls: toolCalls,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      finish_reason: (finishReason as ChatResult['finish_reason']) ?? 'stop',
    };
  }

  private buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
    };
  }

  private assertConfigured(): void {
    if (!this.config.apiKey || !this.config.baseUrl || !this.config.model) {
      throw new ProviderError(
        `外部模型 ${this.name} 未完整配置（apiKey/baseUrl/model 缺失），请先在总台 AI 配置中添加`,
        400,
        this.name,
      );
    }
  }
}
