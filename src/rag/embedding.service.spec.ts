/**
 * R70-21 EmbeddingService 单元测试
 *
 * 覆盖：
 * 1. isEnabled — 未配置 EMBEDDING_MODEL 降级禁用 / 配置后启用
 * 2. embed — 未配置抛 EmbeddingError
 * 3. embed — 成功返回向量（含 baseUrl 末尾斜杠去除、body/headers 校验）
 * 4. embed — 网络异常 / 服务返回 error / 空向量 / data 为空 均抛 EmbeddingError
 * 5. buildHeaders — 配置 API Key 时携带 Authorization / 未配置时不携带
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import { ConfigService } from '@nestjs/config';
import { EmbeddingError, EmbeddingService } from './embedding.service';

jest.mock('axios', () => ({
  post: jest.fn(),
}));

/** axios.post 调用签名：URL + body + 请求配置 */
type MockedPost = jest.Mock<
  Promise<unknown>,
  [string, unknown, { headers: Record<string, string>; timeout: number }]
>;

/** mock axios.post（requireMock 避免 unbound-method，类型化避免 no-unsafe） */
const mockedPost = jest.requireMock<{ post: unknown }>('axios')
  .post as MockedPost;

/** 构造 ConfigService mock（支持覆盖指定 key） */
function createConfigService(
  overrides: Record<string, unknown> = {},
): ConfigService {
  return {
    get: jest.fn((key: string, defaultValue?: unknown) =>
      key in overrides ? overrides[key] : defaultValue,
    ),
  } as unknown as ConfigService;
}

/** 默认配置：启用 embedding（model 非空） */
const ENABLED_CONFIG = { EMBEDDING_MODEL: 'nomic-embed-text' };

describe('R70-21 EmbeddingService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('isEnabled', () => {
    it('未配置 EMBEDDING_MODEL 时应降级禁用', () => {
      const service = new EmbeddingService(createConfigService());
      expect(service.isEnabled()).toBe(false);
    });

    it('配置 EMBEDDING_MODEL 后应启用', () => {
      const service = new EmbeddingService(createConfigService(ENABLED_CONFIG));
      expect(service.isEnabled()).toBe(true);
    });
  });

  describe('embed', () => {
    it('未配置模型应抛出 EmbeddingError', async () => {
      const service = new EmbeddingService(createConfigService());
      await expect(service.embed('查询')).rejects.toThrow(EmbeddingError);
      await expect(service.embed('查询')).rejects.toThrow(
        'EMBEDDING_MODEL 未配置',
      );
      expect(mockedPost).not.toHaveBeenCalled();
    });

    it('成功应返回向量，且 baseUrl 末尾斜杠被去除', async () => {
      mockedPost.mockResolvedValue({
        data: { data: [{ embedding: [0.1, 0.2, 0.3] }] },
      });
      const service = new EmbeddingService(
        createConfigService({
          ...ENABLED_CONFIG,
          EMBEDDING_BASE_URL: 'http://127.0.0.1:11434/v1/',
        }),
      );
      const vector = await service.embed('酒水库存');
      expect(vector).toEqual([0.1, 0.2, 0.3]);
      expect(mockedPost).toHaveBeenCalledWith(
        'http://127.0.0.1:11434/v1/embeddings',
        { model: 'nomic-embed-text', input: '酒水库存' },
        {
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          timeout: 30000,
        },
      );
    });

    it('网络异常应包装为 EmbeddingError', async () => {
      mockedPost.mockRejectedValue(new Error('ECONNREFUSED'));
      const service = new EmbeddingService(createConfigService(ENABLED_CONFIG));
      await expect(service.embed('查询')).rejects.toThrow(EmbeddingError);
      await expect(service.embed('查询')).rejects.toThrow(
        'embedding 服务调用失败',
      );
    });

    it('服务返回 error 字段应抛 EmbeddingError', async () => {
      mockedPost.mockResolvedValue({
        data: { error: { message: 'model not found' } },
      });
      const service = new EmbeddingService(createConfigService(ENABLED_CONFIG));
      await expect(service.embed('查询')).rejects.toThrow(
        'embedding 服务返回错误',
      );
    });

    it('返回空向量应抛 EmbeddingError', async () => {
      mockedPost.mockResolvedValue({
        data: { data: [{ embedding: [] }] },
      });
      const service = new EmbeddingService(createConfigService(ENABLED_CONFIG));
      await expect(service.embed('查询')).rejects.toThrow('返回空向量');
    });

    it('返回 data 为空应抛 EmbeddingError', async () => {
      mockedPost.mockResolvedValue({ data: { data: [] } });
      const service = new EmbeddingService(createConfigService(ENABLED_CONFIG));
      await expect(service.embed('查询')).rejects.toThrow(EmbeddingError);
    });
  });

  describe('buildHeaders（通过 embed 调用断言）', () => {
    it('配置 API Key 时应携带 Authorization', async () => {
      mockedPost.mockResolvedValue({
        data: { data: [{ embedding: [1] }] },
      });
      const service = new EmbeddingService(
        createConfigService({
          ...ENABLED_CONFIG,
          EMBEDDING_API_KEY: 'sk-test',
        }),
      );
      await service.embed('查询');
      const headers = mockedPost.mock.calls[0][2]?.headers;
      expect(headers.Authorization).toBe('Bearer sk-test');
    });

    it('未配置 API Key 时不应携带 Authorization', async () => {
      mockedPost.mockResolvedValue({
        data: { data: [{ embedding: [1] }] },
      });
      const service = new EmbeddingService(createConfigService(ENABLED_CONFIG));
      await service.embed('查询');
      const headers = mockedPost.mock.calls[0][2]?.headers;
      expect(headers.Authorization).toBeUndefined();
    });
  });
});
