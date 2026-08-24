/**
 * Model Provider 抽象层接口定义
 *
 * 设计目标：一次编码，多 Provider 切换。
 * 无论用 DeepSeek、通义千问还是本地 Ollama，上层 Brain Engine 和 Gateway 代码完全不变。
 *
 * 对应文档：
 * - docs/ai-base/智享AI底座-架构设计文档.md 第五章 Model Provider 抽象层
 * - docs/ai-base/智享AI底座-开发文档.md 第六章 Provider 开发指南
 */

/**
 * 对话消息（OpenAI 兼容格式）
 */
export interface ChatMessage {
  /** 角色：system-系统提示词 / user-用户消息 / assistant-助手回复 / tool-工具返回结果 */
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** 消息内容（role=tool 时通常为工具返回的 JSON 字符串） */
  content: string;
  /** role=tool 时必填，标识本次返回是对应哪个 tool_call 的结果 */
  tool_call_id?: string;
  /** role=assistant 时携带，表示助手发起的工具调用 */
  tool_calls?: ToolCall[];
  /** role=tool 时可选，工具名称（部分 Provider 要求） */
  name?: string;
}

/**
 * 工具调用（LLM 决定调用某个工具时的请求结构）
 */
export interface ToolCall {
  /** 调用 ID（由 LLM 生成，用于关联 tool 角色消息） */
  id: string;
  /** 调用类型，目前 OpenAI 兼容协议仅支持 'function' */
  type: 'function';
  /** 工具调用详情 */
  function: {
    /** 工具名称（须与 ToolDefinition.function.name 对应） */
    name: string;
    /** 调用参数（JSON 字符串，需在使用侧 JSON.parse） */
    arguments: string;
  };
}

/**
 * Function Calling 工具定义（OpenAI 格式）
 *
 * 用于告诉 LLM 当前可调用哪些工具及其参数结构。
 */
export interface ToolDefinition {
  /** 工具类型，目前仅支持 'function' */
  type: 'function';
  /** 工具描述 */
  function: {
    /** 工具名称（唯一，全小写下划线或驼峰均可，建议统一风格） */
    name: string;
    /** 工具描述（LLM 据此判断何时调用） */
    description: string;
    /**
     * 参数 JSON Schema（OpenAI Function Calling 规范）
     * 例：{ type: 'object', properties: { name: { type: 'string', description: '...' } }, required: ['name'] }
     */
    parameters: object;
  };
}

/**
 * 调用选项（chat / chatSync 通用）
 */
export interface ChatOptions {
  /** 采样温度，0-2，越高越随机，默认 0.3（业务场景偏严谨） */
  temperature?: number;
  /** 最大生成 token 数，默认 2048 */
  max_tokens?: number;
  /** Function Calling 工具列表，传入后 LLM 可能返回 tool_calls */
  tools?: ToolDefinition[];
  /** 取消信号，传入后可通过 controller.abort() 中断流式生成 */
  signal?: AbortSignal;
}

/**
 * 非流式调用结果
 */
export interface ChatResult {
  /** 文本回复内容（仅 tool_calls 时可能为空字符串） */
  content: string;
  /** LLM 发起的工具调用列表（无则 undefined） */
  tool_calls?: ToolCall[];
  /** 输入 token 数（用于计费/统计） */
  prompt_tokens: number;
  /** 输出 token 数（用于计费/统计） */
  completion_tokens: number;
  /**
   * 结束原因：stop-正常结束 / tool_calls-工具调用 / length-达到 max_tokens
   *
   * 仅列出 OpenAI 兼容协议常见值，DeepSeek 实际返回值在运行时由解析层保证。
   */
  finish_reason?: 'stop' | 'tool_calls' | 'length';
}

/**
 * 流式分片（chat 流式生成器内部可使用的中间状态）
 *
 * 当前 chat() 直接 yield string 增量文本，此类型保留供内部解析使用，
 * 未来若需在流中传递 tool_calls 增量可扩展对外暴露。
 */
export interface ChatStreamChunk {
  /** 本片文本内容 */
  content: string;
  /** 增量 tool_calls（部分 Provider 流式返回，本项目首期不向调用方暴露） */
  tool_calls?: Partial<ToolCall>[];
  /** 结束原因（仅最后一片携带） */
  finish_reason?: string;
}

/**
 * Provider 运行时配置
 *
 * 用于 ProviderFactory.create() 注入租户级配置（覆盖默认 env 配置）。
 */
export interface ProviderConfig {
  /** API Key（必填） */
  apiKey: string;
  /** API 基础地址（可选，DeepSeek 默认 https://api.deepseek.com） */
  baseUrl?: string;
  /** 模型名称（必填，如 deepseek-chat） */
  model: string;
  /** 默认温度（可选） */
  temperature?: number;
  /** 默认最大 token 数（可选） */
  max_tokens?: number;
  /** 请求超时毫秒（可选，默认 30000） */
  timeoutMs?: number;
}

/**
 * 连通性测试结果
 */
export interface ConnectionTestResult {
  /** 是否成功 */
  success: boolean;
  /** 提示信息（失败时含错误原因，成功时含模型名+耗时） */
  message: string;
  /** 接口响应耗时（毫秒） */
  latencyMs: number;
}

/**
 * Model Provider 接口
 *
 * 所有 LLM 服务商实现此接口，由 ProviderFactory 创建并注入到 Brain Engine。
 */
export interface IModelProvider {
  /** Provider 名称（'deepseek' | 'ollama' | ...） */
  readonly name: string;

  /**
   * 流式对话：逐 token 返回（SSE）
   *
   * @param messages 对话消息列表
   * @param options  调用选项
   * @returns AsyncGenerator，每次 yield 一段增量文本，return 最终 ChatResult
   *
   * 用法：
   *   const gen = provider.chat(messages, opts);
   *   while (true) {
   *     const { value, done } = await gen.next();
   *     if (done) break;          // value 此时是 ChatResult
   *     process.stdout.write(value); // 增量文本
   *   }
   */
  chat(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): AsyncGenerator<string, ChatResult, unknown>;

  /**
   * 非流式对话：一次性返回完整结果
   *
   * @param messages 对话消息列表
   * @param options  调用选项
   * @returns 完整 ChatResult
   */
  chatSync(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult>;

  /**
   * 文本嵌入（向量化）— RAG 用
   *
   * DeepSeek 暂无 embedding API，由具体实现抛出 NotImplemented。
   *
   * @param text 待向量化的文本
   * @returns 向量数组
   */
  embedding(text: string): Promise<number[]>;

  /**
   * 连通性测试（验收用）
   *
   * 发送一条最短消息验证 API Key + 网络连通性，返回成功/失败+延迟。
   */
  testConnection(): Promise<ConnectionTestResult>;

  /**
   * 注入运行时配置（由 ProviderFactory.create() 调用）
   *
   * 支持运行时切换：不同租户可用不同 Provider / API Key / 模型。
   *
   * @param config Provider 配置
   */
  configure(config: ProviderConfig): void;
}
