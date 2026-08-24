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
} from './provider.interface';
import { ProviderError } from './provider-error';

/**
 * Ollama Provider（本地模型，OpenAI 兼容协议）
 *
 * - API 地址：默认 http://127.0.0.1:11434/v1（Ollama OpenAI 兼容端点）
 * - 支持 chat（流式/非流式，含 function calling）与 embedding
 * - 无 API Key 要求（本地服务），配置项 OLLAMA_BASE_URL / OLLAMA_MODEL
 */
interface OllamaRuntimeConfig {
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

interface OllamaChatResponse {
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
  usage?: { prompt_tokens: number; completion_tokens: number };
}

interface OllamaEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
}

interface OllamaStreamChunk {
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
}

interface ToolCallAccumulator {
  index: number;
  id?: string;
  type: 'function';
  name?: string;
  arguments: string;
}

@Injectable()
export class OllamaProvider implements IModelProvider {
  readonly name = 'ollama';
  private readonly logger = new Logger(OllamaProvider.name);

  private config!: OllamaRuntimeConfig;

  constructor(private readonly configService: ConfigService) {
    this.config = {
      baseUrl: this.configService.get<string>(
        'OLLAMA_BASE_URL',
        'http://127.0.0.1:11434/v1',
      ),
      model: this.configService.get<string>('OLLAMA_MODEL', 'qwen2.5:7b'),
      temperature: this.configService.get<number>('DEFAULT_TEMPERATURE', 0.3),
      maxTokens: this.configService.get<number>('DEFAULT_MAX_TOKENS', 2048),
      timeoutMs: this.configService.get<number>('OLLAMA_TIMEOUT_MS', 30000),
    };
  }

  configure(config: ProviderConfig): void {
    this.config = {
      baseUrl: config.baseUrl ?? this.config.baseUrl,
      model: config.model,
      temperature: config.temperature ?? this.config.temperature,
      maxTokens: config.max_tokens ?? this.config.maxTokens,
      timeoutMs: config.timeoutMs ?? this.config.timeoutMs,
    };
  }

  private buildResult(
    content: string,
    toolCallMap: Map<number, ToolCallAccumulator>,
    finishReason: string,
    promptTokens: number,
    completionTokens: number,
  ): ChatResult {
    const toolCalls: ToolCall[] = Array.from(toolCallMap.values()).map(
      (tc) => ({
        id: tc.id ?? `call_${tc.index}`,
        type: 'function',
        function: { name: tc.name ?? '', arguments: tc.arguments },
      }),
    );
    return {
      content,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      finish_reason:
        toolCalls.length > 0
          ? 'tool_calls'
          : ((finishReason as ChatResult['finish_reason']) ?? 'stop'),
    };
  }

  /**
   * 流式对话（SSE，OpenAI 兼容）
   */
  async *chat(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): AsyncGenerator<string, ChatResult, unknown> {
    const cfg = this.config;
    const requestBody: Record<string, unknown> = {
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
      `流式调用 Ollama：model=${cfg.model}, messages=${messages.length}条`,
    );

    let response: AxiosResponse<Readable>;
    try {
      response = await axios.post<Readable>(
        `${cfg.baseUrl}/chat/completions`,
        requestBody,
        {
          headers: { 'Content-Type': 'application/json' },
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
    const promptTokens = 0;
    const completionTokens = 0;
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
          if (!line || line.startsWith(':') || !line.startsWith('data:'))
            continue;
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
          let parsed: OllamaStreamChunk;
          try {
            parsed = JSON.parse(data) as OllamaStreamChunk;
          } catch {
            continue;
          }
          const choice = parsed.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;
          if (choice.delta?.content) {
            contentBuf += choice.delta.content;
            yield choice.delta.content;
          }
          for (const delta of choice.delta?.tool_calls ?? []) {
            let acc = toolCallMap.get(delta.index);
            if (!acc) {
              acc = { index: delta.index, type: 'function', arguments: '' };
              toolCallMap.set(delta.index, acc);
            }
            if (delta.id) acc.id = delta.id;
            if (delta.function?.name)
              acc.name = (acc.name ?? '') + delta.function.name;
            if (delta.function?.arguments)
              acc.arguments += delta.function.arguments;
          }
        }
      }
    } catch (err) {
      if (options?.signal?.aborted) {
        return this.buildResult(
          contentBuf,
          toolCallMap,
          'stop',
          promptTokens,
          completionTokens,
        );
      }
      throw ProviderError.fromAxiosError(err, this.name);
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
   * 非流式对话（OpenAI 兼容，含 function calling）
   */
  async chatSync(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): Promise<ChatResult> {
    const cfg = this.config;
    const requestBody: Record<string, unknown> = {
      model: cfg.model,
      messages,
      temperature: options?.temperature ?? cfg.temperature,
      max_tokens: options?.max_tokens ?? cfg.maxTokens,
      stream: false,
    };
    if (options?.tools && options.tools.length > 0) {
      requestBody.tools = options.tools;
    }
    try {
      const resp = await axios.post<OllamaChatResponse>(
        `${cfg.baseUrl}/chat/completions`,
        requestBody,
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: cfg.timeoutMs,
          signal: options?.signal,
        },
      );
      const choice = resp.data.choices?.[0];
      if (!choice) {
        throw new ProviderError('Ollama 返回空响应', 502, this.name);
      }
      const toolCallMap = new Map<number, ToolCallAccumulator>();
      (choice.message.tool_calls ?? []).forEach((tc, idx) => {
        toolCallMap.set(idx, {
          index: idx,
          id: tc.id,
          type: 'function',
          name: tc.function.name,
          arguments: tc.function.arguments,
        });
      });
      return this.buildResult(
        choice.message.content ?? '',
        toolCallMap,
        choice.finish_reason,
        resp.data.usage?.prompt_tokens ?? 0,
        resp.data.usage?.completion_tokens ?? 0,
      );
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw ProviderError.fromAxiosError(err, this.name);
    }
  }

  /**
   * 文本嵌入（OpenAI 兼容 /embeddings）
   */
  async embedding(text: string): Promise<number[]> {
    const cfg = this.config;
    try {
      const resp = await axios.post<OllamaEmbeddingResponse>(
        `${cfg.baseUrl}/embeddings`,
        { model: cfg.model, input: text },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: cfg.timeoutMs,
        },
      );
      const emb = resp.data.data?.[0]?.embedding;
      if (!emb) {
        throw new ProviderError('Ollama embedding 返回空结果', 502, this.name);
      }
      return emb;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw ProviderError.fromAxiosError(err, this.name);
    }
  }

  /**
   * 连通性测试：GET /models 验证本地 Ollama 可达
   */
  async testConnection(): Promise<ConnectionTestResult> {
    const cfg = this.config;
    const start = Date.now();
    try {
      await axios.get(`${cfg.baseUrl}/models`, {
        headers: { 'Content-Type': 'application/json' },
        timeout: Math.min(cfg.timeoutMs, 8000),
      });
      return {
        success: true,
        message: `Ollama 连接成功（model=${cfg.model}, baseUrl=${cfg.baseUrl}）`,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        message: `Ollama 连接失败：${err instanceof Error ? err.message : String(err)}（请确认本地已启动 ollama serve）`,
        latencyMs: Date.now() - start,
      };
    }
  }
}
