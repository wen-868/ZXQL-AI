/**
 * R70-21 VectorStoreService 单元测试
 *
 * 覆盖：
 * 1. 内存模式（无 DataSource）— addChunks / removeDoc / search / listKnowledge / countChunks
 * 2. 覆盖语义 — 同名文档重复上传先删旧块
 * 3. MySQL 落盘模式 — loadAllFromDb 成功恢复 / 异常降级纯内存
 * 4. rowToChunk — 字段缺失跳过 / embedding JSON 解析失败降级空向量
 * 5. persistChunks / removeDoc 的 DELETE/INSERT 失败 warn 不抛错
 * 6. cosineSimilarity — 空向量 / 长度不等 / 零向量 / 相同 / 正交
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import { DataSource } from 'typeorm';
import { VectorStoreService } from './vector-store.service';

describe('R70-21 VectorStoreService', () => {
  describe('内存模式（无 DataSource）', () => {
    let store: VectorStoreService;

    beforeEach(() => {
      store = new VectorStoreService();
    });

    it('onModuleInit 无 DataSource 时直接返回', async () => {
      await expect(store.onModuleInit()).resolves.toBeUndefined();
    });

    it('addChunks 应写入内存并返回分块数', async () => {
      const count = await store.addChunks('tenant-A', '手册.pdf', [
        { text: '块一', embedding: [1, 0] },
        { text: '块二', embedding: [0, 1] },
      ]);
      expect(count).toBe(2);
      expect(store.countChunks('tenant-A')).toBe(2);
    });

    it('同名文档重复上传应覆盖旧分块', async () => {
      await store.addChunks('tenant-A', '手册.pdf', [
        { text: '旧块一', embedding: [1, 0] },
        { text: '旧块二', embedding: [0, 1] },
      ]);
      await store.addChunks('tenant-A', '手册.pdf', [
        { text: '新块一', embedding: [1, 1] },
      ]);
      expect(store.countChunks('tenant-A')).toBe(1);
      const results = store.search('tenant-A', [1, 1]);
      expect(results).toHaveLength(1);
      expect(results[0].text).toBe('新块一');
    });

    it('removeDoc 应删除指定文档', async () => {
      await store.addChunks('tenant-A', '手册.pdf', [
        { text: '块一', embedding: [1, 0] },
      ]);
      await store.addChunks('tenant-A', '价目表.xlsx', [
        { text: '块二', embedding: [0, 1] },
      ]);
      await store.removeDoc('tenant-A', '手册.pdf');
      expect(store.countChunks('tenant-A')).toBe(1);
      expect(store.listKnowledge('tenant-A')[0].docName).toBe('价目表.xlsx');
    });

    it('search 应按相似度降序返回 Top-K', async () => {
      await store.addChunks('tenant-A', '手册.pdf', [
        { text: '高度相关', embedding: [1, 0, 0] },
        { text: '中度相关', embedding: [0.5, 0.5, 0] },
        { text: '不相关', embedding: [0, 0, 1] },
      ]);
      const results = store.search('tenant-A', [1, 0, 0], 2);
      expect(results).toHaveLength(2);
      expect(results[0].text).toBe('高度相关');
      expect(results[1].text).toBe('中度相关');
      expect(results[0].score).toBeGreaterThan(results[1].score);
      expect(results[0].docName).toBe('手册.pdf');
      expect(results[0].chunkIndex).toBe(0);
    });

    it('search 无数据应返回空数组', () => {
      expect(store.search('tenant-Z', [1, 0])).toEqual([]);
    });

    it('listKnowledge 应按文档聚合分块数与创建时间', async () => {
      await store.addChunks('tenant-A', '手册.pdf', [
        { text: '块一', embedding: [1, 0] },
        { text: '块二', embedding: [0, 1] },
      ]);
      await store.addChunks('tenant-A', '价目表.xlsx', [
        { text: '块三', embedding: [1, 1] },
      ]);
      const knowledge = store.listKnowledge('tenant-A');
      expect(knowledge).toHaveLength(2);
      const doc = knowledge.find((k) => k.docName === '手册.pdf');
      expect(doc?.chunkCount).toBe(2);
      expect(doc?.createdAt).toBeInstanceOf(Date);
      expect(store.listKnowledge('tenant-B')).toEqual([]);
    });
  });

  describe('MySQL 落盘模式（带 DataSource）', () => {
    /** 构造 mock DataSource：按 SQL 前缀返回不同结果（参数类型化，避免 no-unsafe） */
    function createMockDataSource(options?: {
      selectRows?: Array<Record<string, unknown>>;
      selectError?: Error;
    }): { query: jest.Mock<Promise<unknown>, [string]> } {
      return {
        query: jest.fn((sql: string) => {
          if (String(sql).startsWith('SELECT')) {
            if (options?.selectError) {
              return Promise.reject(options.selectError);
            }
            return Promise.resolve(options?.selectRows ?? []);
          }
          return Promise.resolve();
        }) as jest.Mock<Promise<unknown>, [string]>,
      };
    }

    it('onModuleInit 应从数据库恢复分块', async () => {
      const ds = createMockDataSource({
        selectRows: [
          {
            tenant_id: 'tenant-A',
            doc_name: '手册.pdf',
            chunk_index: 0,
            chunk_text: '恢复块一',
            embedding: '[1,0,0]',
            created_at: '2026-08-01T00:00:00.000Z',
          },
          {
            tenant_id: 'tenant-A',
            doc_name: '手册.pdf',
            chunk_index: 1,
            chunk_text: '恢复块二',
            embedding: '[0,1,0]',
            created_at: '2026-08-01T00:00:00.000Z',
          },
        ],
      });
      const store = new VectorStoreService(ds as unknown as DataSource);
      await store.onModuleInit();
      expect(store.countChunks('tenant-A')).toBe(2);
      expect(store.search('tenant-A', [1, 0, 0], 1)[0].text).toBe('恢复块一');
    });

    it('loadAllFromDb 应跳过缺 tenant_id 与缺字段的行', async () => {
      const ds = createMockDataSource({
        selectRows: [
          {
            tenant_id: '',
            doc_name: 'x.pdf',
            chunk_text: '无租户',
            embedding: '[1]',
          },
          {
            tenant_id: 'tenant-A',
            doc_name: '',
            chunk_text: '无文档名',
            embedding: '[1]',
          },
          {
            tenant_id: 'tenant-A',
            doc_name: 'y.pdf',
            chunk_text: '',
            embedding: '[1]',
          },
          {
            tenant_id: 'tenant-A',
            doc_name: '正常.pdf',
            chunk_text: '有效块',
            embedding: '[0.5,0.5]',
            created_at: '2026-08-01T00:00:00.000Z',
          },
        ],
      });
      const store = new VectorStoreService(ds as unknown as DataSource);
      await store.loadAllFromDb();
      expect(store.countChunks('tenant-A')).toBe(1);
      expect(store.listKnowledge('tenant-A')[0].docName).toBe('正常.pdf');
    });

    it('loadAllFromDb 查询失败应 warn 降级为纯内存模式，不抛错', async () => {
      const ds = createMockDataSource({
        selectError: new Error('DB down'),
      });
      const store = new VectorStoreService(ds as unknown as DataSource);
      await expect(store.loadAllFromDb()).resolves.toBeUndefined();
      expect(store.countChunks('tenant-A')).toBe(0);
    });

    it('embedding JSON 解析失败的行应降级为空向量', async () => {
      const ds = createMockDataSource({
        selectRows: [
          {
            tenant_id: 'tenant-A',
            doc_name: '坏向量.pdf',
            chunk_text: '坏向量块',
            embedding: 'not-json',
            created_at: '2026-08-01T00:00:00.000Z',
          },
          {
            tenant_id: 'tenant-A',
            doc_name: '非数组.pdf',
            chunk_text: '非数组块',
            embedding: '"string"',
            created_at: '2026-08-01T00:00:00.000Z',
          },
        ],
      });
      const store = new VectorStoreService(ds as unknown as DataSource);
      await store.loadAllFromDb();
      // 两条均入库（空向量不影响入库），检索相关度为 0
      expect(store.countChunks('tenant-A')).toBe(2);
      expect(store.search('tenant-A', [1, 0], 1)[0].score).toBe(0);
    });

    it('兼容 mysql2 JSON 列解析后的数组 embedding 与 Date 时间', async () => {
      const ds = createMockDataSource({
        selectRows: [
          {
            tenant_id: 'tenant-A',
            doc_name: '真实场景.pdf',
            chunk_index: 0,
            chunk_text: '数组向量块',
            embedding: [0.1, 0.2],
            created_at: new Date('2026-08-01T00:00:00.000Z'),
          },
          {
            tenant_id: 'tenant-B',
            doc_name: '对象向量.xlsx',
            chunk_index: 1,
            chunk_text: '对象向量块',
            embedding: { foo: 1 },
            created_at: new Date('2026-08-01T00:00:00.000Z'),
          },
        ],
      });
      const store = new VectorStoreService(ds as unknown as DataSource);
      await store.loadAllFromDb();
      // 数组向量可正常检索
      expect(store.search('tenant-A', [0.1, 0.2], 1)[0].text).toBe(
        '数组向量块',
      );
      expect(store.listKnowledge('tenant-A')[0].createdAt).toBeInstanceOf(Date);
      // 对象向量降级为空向量，相关度为 0
      expect(store.search('tenant-B', [1, 0], 1)[0].score).toBe(0);
    });

    it('loadAllFromDb 兼容边界字段类型（null/bigint/boolean/对象）', async () => {
      const ds = createMockDataSource({
        selectRows: [
          {
            tenant_id: 'tenant-C',
            doc_name: 'null字段.pdf',
            chunk_text: 'null 字段',
            chunk_index: null,
            embedding: null,
            created_at: null,
          },
          {
            tenant_id: 'tenant-D',
            doc_name: '奇类型.docx',
            chunk_text: true,
            chunk_index: BigInt(2),
            embedding: true,
            created_at: {},
          },
        ],
      });
      const store = new VectorStoreService(ds as unknown as DataSource);
      await store.loadAllFromDb();
      expect(store.countChunks('tenant-C')).toBe(1);
      expect(store.countChunks('tenant-D')).toBe(1);
    });

    it('addChunks 应先删旧块再写内存并落盘 INSERT', async () => {
      const ds = createMockDataSource();
      const store = new VectorStoreService(ds as unknown as DataSource);
      const count = await store.addChunks('tenant-A', '手册.pdf', [
        { text: '块一', embedding: [1, 0] },
      ]);
      expect(count).toBe(1);
      // 覆盖语义：先 DELETE 旧块，再 INSERT 新块
      const calls = ds.query.mock.calls.map((c) => String(c[0]));
      expect(calls.some((sql) => sql.startsWith('DELETE'))).toBe(true);
      expect(calls.some((sql) => sql.startsWith('INSERT'))).toBe(true);
    });

    it('persistChunks 失败应 warn 不抛错，内存仍生效', async () => {
      const ds = {
        query: jest.fn((sql: string) => {
          if (String(sql).startsWith('SELECT')) {
            return Promise.resolve([]);
          }
          return Promise.reject(new Error('disk full'));
        }),
      };
      const store = new VectorStoreService(ds as unknown as DataSource);
      await expect(
        store.addChunks('tenant-A', '手册.pdf', [
          { text: '块一', embedding: [1, 0] },
        ]),
      ).resolves.toBe(1);
      expect(store.countChunks('tenant-A')).toBe(1);
    });

    it('removeDoc 的 DELETE 失败应 warn 不抛错', async () => {
      const ds = {
        query: jest.fn((sql: string) => {
          if (String(sql).startsWith('DELETE')) {
            return Promise.reject(new Error('lock timeout'));
          }
          return Promise.resolve();
        }),
      };
      const store = new VectorStoreService(ds as unknown as DataSource);
      await store.addChunks('tenant-A', '手册.pdf', [
        { text: '块一', embedding: [1, 0] },
      ]);
      await expect(
        store.removeDoc('tenant-A', '手册.pdf'),
      ).resolves.toBeUndefined();
    });
  });

  describe('cosineSimilarity 静态方法', () => {
    it('空向量 / 长度不等返回 0', () => {
      expect(VectorStoreService.cosineSimilarity([], [])).toBe(0);
      expect(VectorStoreService.cosineSimilarity([1, 0], [])).toBe(0);
      expect(VectorStoreService.cosineSimilarity([1], [1, 0])).toBe(0);
    });

    it('零向量返回 0', () => {
      expect(VectorStoreService.cosineSimilarity([0, 0], [1, 1])).toBe(0);
      expect(VectorStoreService.cosineSimilarity([1, 1], [0, 0])).toBe(0);
    });

    it('相同向量返回 1', () => {
      expect(VectorStoreService.cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(
        1,
      );
    });

    it('正交向量返回 0', () => {
      expect(VectorStoreService.cosineSimilarity([1, 0], [0, 1])).toBe(0);
    });

    it('普通向量按公式计算', () => {
      const score = VectorStoreService.cosineSimilarity([1, 1], [1, 0]);
      expect(score).toBeCloseTo(Math.SQRT1_2);
    });
  });
});
