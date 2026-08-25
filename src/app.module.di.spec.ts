/**
 * AppModule DI 解析门禁（启动门禁）
 *
 * 只 compile 不 init（不连数据库/Redis），用于捕获 Nest 依赖注入错误
 * （UnknownDependenciesException 等），防止"能 build 但一启动就崩"的回归。
 *
 * 背景：AiDbController 曾因 GatewayModule 未导入 EvolutionModule 导致生产启动崩环，
 * 且 e2e 启动测试需要真实 MySQL 无法在无库环境执行，故补此门禁。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-26
 */
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { AppModule } from './app.module';

/** 假 DataSource：拦截 TypeORM 连接（不触网），仓库返回空实现 */
function fakeDataSource() {
  const repos = new Map<object, unknown>();
  const emptyRepo = () => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn((e: unknown) => Promise.resolve(e)),
    create: jest.fn((e: unknown) => e),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    count: jest.fn().mockResolvedValue(0),
  });
  return {
    options: { type: 'mysql' },
    entityMetadatas: [],
    initialize: jest.fn().mockResolvedValue(undefined),
    destroy: jest.fn().mockResolvedValue(undefined),
    getRepository: jest.fn((entity: object) => {
      if (!repos.has(entity)) {
        repos.set(entity, emptyRepo());
      }
      return repos.get(entity);
    }),
  };
}

describe('AppModule DI 解析门禁', () => {
  const prevKey = process.env.ENCRYPTION_KEY;

  beforeAll(() => {
    // CryptoService 构造期要求 32 字节 hex 密钥（测试用占位即可，不落地真实密钥）
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
  });

  afterAll(() => {
    if (prevKey === undefined) {
      delete process.env.ENCRYPTION_KEY;
    } else {
      process.env.ENCRYPTION_KEY = prevKey;
    }
  });

  it('全部 Provider/Controller 依赖可解析（不连库）', async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(getDataSourceToken())
      .useValue(fakeDataSource())
      .overrideProvider(getDataSourceToken('ai_db'))
      .useValue(fakeDataSource())
      .compile();
    expect(moduleFixture).toBeDefined();
    await moduleFixture.close().catch(() => undefined);
  });
});
