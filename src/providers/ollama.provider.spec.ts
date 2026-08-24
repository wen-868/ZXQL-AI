import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { Readable } from 'stream';
import { OllamaProvider } from './ollama.provider';

jest.mock('axios');

describe('OllamaProvider', () => {
  let provider: OllamaProvider;
  const mockPost = jest.fn();
  const mockGet = jest.fn();

  beforeEach(async () => {
    jest.clearAllMocks();
    (axios.post as jest.Mock) = mockPost;
    (axios.get as jest.Mock) = mockGet;
    const moduleRef = await Test.createTestingModule({
      providers: [
        OllamaProvider,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, fallback: unknown) => {
              const env: Record<string, unknown> = {
                OLLAMA_BASE_URL: 'http://127.0.0.1:11434/v1',
                OLLAMA_MODEL: 'qwen2.5:7b',
                OLLAMA_TIMEOUT_MS: 30000,
                DEFAULT_TEMPERATURE: 0.3,
                DEFAULT_MAX_TOKENS: 2048,
              };
              return env[key] ?? fallback;
            }),
          },
        },
      ],
    }).compile();
    provider = moduleRef.get(OllamaProvider);
  });

  it('chatSync 非流式返回内容与 token 统计', async () => {
    mockPost.mockResolvedValue({
      data: {
        model: 'qwen2.5:7b',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '你好' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
    });
    const result = await provider.chatSync([{ role: 'user', content: '你好' }]);
    expect(result.content).toBe('你好');
    expect(result.prompt_tokens).toBe(10);
    expect(result.completion_tokens).toBe(5);
    expect(mockPost).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/v1/chat/completions',
      expect.objectContaining({ stream: false }),
      expect.anything(),
    );
  });

  it('chatSync 解析 function calling 工具调用', async () => {
    mockPost.mockResolvedValue({
      data: {
        model: 'qwen2.5:7b',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'echo', arguments: '{"message":"hi"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    });
    const result = await provider.chatSync([{ role: 'user', content: 'hi' }], {
      tools: [{ name: 'echo', description: 'e', parameters: {} }],
    });
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls?.[0].function.name).toBe('echo');
    expect(result.finish_reason).toBe('tool_calls');
  });

  it('chatSync 空响应抛 502', async () => {
    mockPost.mockResolvedValue({ data: { choices: [] } });
    await expect(
      provider.chatSync([{ role: 'user', content: 'x' }]),
    ).rejects.toMatchObject({
      statusCode: 502,
      provider: 'ollama',
    });
  });

  it('chat 流式逐 token 输出并聚合适配', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    mockPost.mockResolvedValue({
      data: Readable.from(chunks.map((c) => Buffer.from(c))),
    });
    const it = provider.chat([{ role: 'user', content: 'hi' }]);
    const texts: string[] = [];
    let result: { content?: string } | undefined;
    let done = false;
    while (!done) {
      const next = await it.next();
      done = next.done;
      if (!done) texts.push(next.value as string);
      else result = next.value as { content?: string };
    }
    expect(texts.join('')).toBe('你好');
    expect(result?.content).toBe('你好');
  });

  it('embedding 返回向量', async () => {
    mockPost.mockResolvedValue({
      data: {
        data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
        model: 'qwen2.5:7b',
      },
    });
    const emb = await provider.embedding('测试文本');
    expect(emb).toHaveLength(3);
    expect(mockPost).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/v1/embeddings',
      { model: 'qwen2.5:7b', input: '测试文本' },
      expect.anything(),
    );
  });

  it('embedding 空结果抛 502', async () => {
    mockPost.mockResolvedValue({ data: { data: [] } });
    await expect(provider.embedding('x')).rejects.toMatchObject({
      statusCode: 502,
    });
  });

  it('testConnection 成功返回模型信息', async () => {
    mockGet.mockResolvedValue({ data: { models: [] } });
    const res = await provider.testConnection();
    expect(res.success).toBe(true);
    expect(res.message).toContain('qwen2.5:7b');
    expect(mockGet).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/v1/models',
      expect.anything(),
    );
  });

  it('testConnection 失败返回明确提示（不抛错）', async () => {
    mockGet.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await provider.testConnection();
    expect(res.success).toBe(false);
    expect(res.message).toContain('ollama serve');
  });
});
