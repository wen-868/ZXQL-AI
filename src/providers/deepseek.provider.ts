import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

/**
 * DeepSeek Provider 配置（运行时实际使用的配置）
 */
interface DeepSeekRuntimeConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

/**
 * DeepSeek API 请求体（OpenAI 兼容格式）
 */
interface DeepSeekRequestBody {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  tools?: ToolDefinition[];
  stream?: boolean;
}

/**
 * DeepSeek 非流式响应结构
 */
interface DeepSeekChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
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

/**
 * DeepSeek 流式响应 chunk 结构（部分字段可选）
 */
interface DeepSeekStreamChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index: number;
    delta: {
      role?: string;
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

/**
 * 流式 tool_calls 聚合中间结构（按 index 累加）
 */
interface ToolCallAccumulator {
  index: number;
  id?: string;
  type: 'function';
  name?: string;
  arguments: string;
}

/**
 * DeepSeek Provider 实现
 *
 * - API 文档：https://api-docs.deepseek.com/
 * - 协议：OpenAI 兼容（POST /v1/chat/completions）
 * - 支持 Function Calling（deepseek-chat 模型原生支持）
 * - 不支持 embedding（请用 Ollama）
 *
 * 流式实现：用 axios + responseType: 'stream' + for-await-of 解析 SSE。
 */
@Injectable()
export class DeepSeekProvider implements IModelProvider {
  readonly name = 'deepseek';
  private readonly logger = new Logger(DeepSeekProvider.name);

  /** 运行时配置（由 ConfigService 初始化，configure() 可覆盖） */
  private config!: DeepSeekRuntimeConfig;

  /** 是否已配置（用于推迟未配置 API Key 时的报错时机） */
  private configured = false;

  constructor(private readonly configService: ConfigService) {
    // 从环境变量读取默认配置
    const apiKey = this.configService.get<string>('DEEPSEEK_API_KEY', '');
    const baseUrl = this.configService.get<string>(
      'DEEPSEEK_BASE_URL',
      'https://api.deepseek.com',
    );
    const model = this.configService.get<string>(
      'DEEPSEEK_MODEL',
      'deepseek-chat',
    );
    const temperature = this.configService.get<number>(
      'DEFAULT_TEMPERATURE',
      0.3,
    );
    const maxTokens = this.configService.get<number>(
      'DEFAULT_MAX_TOKENS',
      2048,
    );
    const timeoutMs = this.configService.get<number>(
      'DEEPSEEK_TIMEOUT_MS',
      30000,
    );

    this.config = {
      apiKey,
      baseUrl,
      model,
      temperature,
      maxTokens,
      timeoutMs,
    };
    // 即使 API Key 为空也标记为已配置（推迟到调用时报错，便于 testConnection 给出友好提示）
    this.configured = true;
  }

  /**
   * 注入运行时配置（覆盖默认 env 配置）
   *
   * 由 ProviderFactory.create() 调用，支持不同租户使用不同 API Key/模型。
   */
  configure(config: ProviderConfig): void {
    this.config = {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? this.config.baseUrl,
      model: config.model,
      temperature: config.temperature ?? this.config.temperature,
      maxTokens: config.max_tokens ?? this.config.maxTokens,
      timeoutMs: config.timeoutMs ?? this.config.timeoutMs,
    };
    this.configured = true;
  }

  /**
   * 流式对话：逐 token 返回（SSE）
   *
   * @returns AsyncGenerator，每次 yield 一段增量文本，return 最终 ChatResult
   */
  async *chat(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): AsyncGenerator<string, ChatResult, unknown> {
    this.assertConfigured();
    const cfg = this.config;
    const requestBody: DeepSeekRequestBody = {
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
      `流式调用 DeepSeek：model=${cfg.model}, messages=${messages.length}条`,
    );

    let response: AxiosResponse<Readable>;
    try {
      response = await axios.post<Readable>(
        `${cfg.baseUrl}/v1/chat/completions`,
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

    // 流式聚合状态
    let contentBuf = '';
    const toolCallMap = new Map<number, ToolCallAccumulator>();
    let finishReason = 'stop';
    let promptTokens = 0;
    let completionTokens = 0;

    // SSE 解析：维护 buffer 处理跨 chunk 的换行
    let buffer = '';
    const stream = response.data;
    const decoder = new TextDecoder('utf-8');

    try {
      for await (const chunk of stream) {
        // 取消检查（AbortSignal 触发后 axios 会抛错，但兜底主动中断）
        if (options?.signal?.aborted) {
          stream.destroy();
          break;
        }

        buffer += decoder.decode(chunk as Buffer, { stream: true });

        // 按行处理（SSE 事件以 \n\n 分隔，但单行 data: 也需要处理）
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);

          if (!line) continue;
          if (line.startsWith(':')) continue; // SSE 注释行
          if (!line.startsWith('data:')) continue;

          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            // 流结束
            buffer = '';
            return this.buildResult(
              contentBuf,
              toolCallMap,
              finishReason,
              promptTokens,
              completionTokens,
            );
          }

          // 解析 JSON
          let parsed: DeepSeekStreamChunk;
          try {
            parsed = JSON.parse(data) as DeepSeekStreamChunk;
          } catch (err) {
            // 单行解析失败不中断整个流（部分 Provider 偶发心跳行）
            this.logger.warn(
              `SSE 行 JSON 解析失败，跳过：${data.slice(0, 100)}${err instanceof Error ? ` (${err.message})` : ''}`,
            );
            continue;
          }

          // 提取 token 用量（DeepSeek 在最后一片携带 usage）
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

          // 增量文本
          if (delta.content) {
            contentBuf += delta.content;
            yield delta.content;
          }

          // 增量 tool_calls（按 index 聚合）
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
      // 流读取异常（含 AbortSignal 取消）
      if (options?.signal?.aborted) {
        this.logger.warn('DeepSeek 流式调用已被取消');
      } else {
        if (err instanceof ProviderError) throw err;
        throw ProviderError.fromAxiosError(err, this.name);
      }
    }

    // 流正常结束（未收到 [DONE] 也走这里）
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
    const requestBody: DeepSeekRequestBody = {
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
      `非流式调用 DeepSeek：model=${cfg.model}, messages=${messages.length}条`,
    );

    let response: AxiosResponse<DeepSeekChatResponse>;
    try {
      response = await axios.post<DeepSeekChatResponse>(
        `${cfg.baseUrl}/v1/chat/completions`,
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

    const data = response.data;
    const choice = data.choices?.[0];
    if (!choice) {
      throw new ProviderError(
        'DeepSeek 返回结果为空（无 choices）',
        502,
        this.name,
        JSON.stringify(data),
      );
    }

    const toolCalls: ToolCall[] | undefined = choice.message.tool_calls?.map(
      (tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.function.name, arguments: tc.function.arguments },
      }),
    );

    return {
      content: choice.message.content ?? '',
      tool_calls: toolCalls,
      prompt_tokens: data.usage?.prompt_tokens ?? 0,
      completion_tokens: data.usage?.completion_tokens ?? 0,
      // DeepSeek 返回的 finish_reason 为 string，断言为字面量联合（运行时由解析层保证值域）
      finish_reason: choice.finish_reason as ChatResult['finish_reason'],
    };
  }

  /**
   * 文本嵌入（DeepSeek 暂不支持）
   *
   * RAG 场景请使用 Ollama Provider。
   */
  embedding(_text: string): Promise<number[]> {
    throw new ProviderError(
      'DeepSeek 暂不支持 embedding，请使用 Ollama Provider',
      501,
      this.name,
    );
  }

  /**
   * 连通性测试
   *
   * 发送一条最短消息验证 API Key + 网络连通性，返回成功/失败+延迟。
   */
  async testConnection(): Promise<ConnectionTestResult> {
    if (!this.config.apiKey) {
      return {
        success: false,
        message: '未配置 DEEPSEEK_API_KEY，请在 .env 中设置后重启服务',
        latencyMs: 0,
      };
    }

    const start = Date.now();
    try {
      const result = await this.chatSync(
        [
          {
            role: 'user',
            content: 'ping',
          },
        ],
        { max_tokens: 16, temperature: 0 },
      );
      const latencyMs = Date.now() - start;
      return {
        success: true,
        message: `DeepSeek 连接正常（model=${this.config.model}, reply="${result.content.slice(0, 50)}"）`,
        latencyMs,
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      if (err instanceof ProviderError) {
        return {
          success: false,
          message: err.message,
          latencyMs,
        };
      }
      return {
        success: false,
        message: `未知错误：${err instanceof Error ? err.message : String(err)}`,
        latencyMs,
      };
    }
  }

  /**
   * 构造请求头
   */
  private buildHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  /**
   * 断言已配置（推迟到调用时报错，便于 testConnection 给出友好提示）
   */
  private assertConfigured(): void {
    if (!this.configured) {
      throw new ProviderError(
        'DeepSeekProvider 尚未配置，请通过 ProviderFactory.create() 初始化',
        500,
        this.name,
      );
    }
    if (!this.config.apiKey) {
      throw new ProviderError(
        'DEEPSEEK_API_KEY 未配置，无法调用 LLM',
        401,
        this.name,
      );
    }
  }

  /**
   * 从流式聚合状态构造最终 ChatResult
   */
  private buildResult(
    contentBuf: string,
    toolCallMap: Map<number, ToolCallAccumulator>,
    finishReason: string,
    promptTokens: number,
    completionTokens: number,
  ): ChatResult {
    const toolCalls: ToolCall[] | undefined =
      toolCallMap.size > 0
        ? Array.from(toolCallMap.values())
            .sort((a, b) => a.index - b.index)
            .map((tc) => ({
              id: tc.id ?? `call_${tc.index}`,
              type: 'function' as const,
              function: {
                name: tc.name ?? '',
                arguments: tc.arguments,
              },
            }))
        : undefined;

    return {
      content: contentBuf,
      tool_calls: toolCalls,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      // finishReason 累加自流式 chunk，类型为 string，断言为字面量联合（运行时由解析层保证值域）
      finish_reason: finishReason as ChatResult['finish_reason'],
    };
  }
}
